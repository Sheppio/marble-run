import { Engine } from "@babylonjs/core/Engines/engine";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Scene } from "@babylonjs/core/scene";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import "@babylonjs/core/Physics/physicsEngineComponent";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import HavokPhysics from "@babylonjs/havok";
import havokWasmUrl from "@babylonjs/havok/lib/esm/HavokPhysics.wasm?url";

import { generateTrack } from "../track/generator";
import { TrackGeometry } from "../track/geometry";
import { buildTrackMesh, derivePalette, type TrackMeshes } from "../track/builder";
import { buildObstacles, type ObstacleSet } from "../track/obstacles";
import { hashSeed } from "../core/rng";
import { createEnvironment, DEFAULT_SKY, type WorldLighting } from "../render/environment";
import { detectQuality, type QualitySettings } from "./quality";
import { BroadcastCamera } from "./camera";
import { Race, FIXED_STEP, type RaceEvents } from "./race";
import type { Player } from "./marble";
import { GRAVITY, TRACK_CONSTANTS, type TrackPlan } from "../track/plan";

/**
 * Owns the Babylon engine, the physics world, and everything in it.
 *
 * A `World` is built once per race. Rebuilding from scratch for each new seed
 * is far simpler to reason about than mutating a track in place, and on a
 * phone the whole build takes well under a second.
 */

let havokInstance: unknown = null;

/** Loads and caches the Havok WASM module. */
export async function initPhysics(): Promise<void> {
  if (havokInstance) return;
  const response = await fetch(havokWasmUrl);
  const wasmBinary = await response.arrayBuffer();
  havokInstance = await HavokPhysics({ wasmBinary });
}

export interface WorldOptions {
  canvas: HTMLCanvasElement | null;
  seed: string;
  players: Player[];
  events?: RaceEvents;
  /**
   * Simulation without rendering: no lights, sky, scenery or camera work.
   * Used by the tuning harness to run hundreds of races quickly.
   */
  headless?: boolean;
  /** Tuning knobs — omit both outside the diagnostic harness. */
  disableObstacles?: boolean;
  maxSpeed?: number;
}

export class World {
  readonly engine: AbstractEngine;
  readonly scene: Scene;
  readonly quality: QualitySettings;
  readonly plan: TrackPlan;
  readonly geometry: TrackGeometry;
  readonly race: Race;
  readonly camera: BroadcastCamera;

  private readonly lighting: WorldLighting | null;
  readonly headless: boolean;
  private readonly trackMeshes: TrackMeshes;
  private readonly obstacles: ObstacleSet;
  private readonly decor: Mesh[] = [];
  private startGate: Mesh | null = null;
  private gateOpenAmount = 0;
  private previewProgress = 0;
  private running = false;

  constructor(options: WorldOptions) {
    if (!havokInstance) {
      throw new Error("Physics not initialised — call initPhysics() first.");
    }

    this.headless = options.headless ?? false;
    this.quality = detectQuality();

    this.engine = this.headless
      ? new NullEngine({
          renderWidth: 1,
          renderHeight: 1,
          textureSize: 4,
          deterministicLockstep: true,
          lockstepMaxSteps: 1,
        })
      : new Engine(options.canvas, this.quality.antialias, {
          // Fixed-step simulation with catch-up, which is what makes a seeded
          // race reproduce identically regardless of the device's framerate.
          deterministicLockstep: true,
          // Enough catch-up steps to hold real-time pace down to about 12fps.
          // Below that the race runs in slow motion rather than skipping
          // physics, which is the right trade: the result stays correct.
          lockstepMaxSteps: 20,
          timeStep: FIXED_STEP,
          powerPreference: "high-performance",
          preserveDrawingBuffer: false,
          stencil: false,
          alpha: false,
        });
    if (!this.headless) this.engine.setHardwareScalingLevel(this.quality.hardwareScaling);

    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.05, 0.07, 0.13, 1);
    this.scene.ambientColor = new Color3(0.1, 0.12, 0.18);
    this.scene.skipPointerMovePicking = true;
    this.scene.autoClearDepthAndStencil = true;
    this.scene.blockMaterialDirtyMechanism = true;

    const plugin = new HavokPlugin(false, havokInstance);
    this.scene.enablePhysics(new Vector3(0, -GRAVITY, 0), plugin);
    this.scene.getPhysicsEngine()?.setTimeStep(FIXED_STEP);

    // --- Track -------------------------------------------------------------
    this.plan = generateTrack(options.seed);
    this.geometry = new TrackGeometry(this.plan);

    const hue = hashSeed(`${options.seed}:palette`) % 360;
    this.lighting = this.headless
      ? null
      : createEnvironment(this.scene, DEFAULT_SKY, {
          shadows: this.quality.shadows,
          shadowMapSize: this.quality.shadowMapSize,
        });

    this.trackMeshes = buildTrackMesh(this.scene, this.geometry, derivePalette(hue));
    this.obstacles = buildObstacles(
      this.scene,
      this.geometry,
      options.disableObstacles ? [] : this.plan.obstacles,
    );

    if (!this.headless) {
      this.buildStartGate();
      this.buildFinishLine();
      if (this.quality.scenery) this.buildSupports();
    }

    // --- Race --------------------------------------------------------------
    this.camera = new BroadcastCamera(this.scene, this.geometry);
    this.race = new Race(
      this.scene,
      this.geometry,
      this.obstacles.zones,
      options.players,
      options.events,
      options.maxSpeed,
    );

    if (this.lighting?.shadowGenerator) {
      const shadowMap = this.lighting.shadowGenerator.getShadowMap();
      for (const marble of this.race.marbles) shadowMap?.renderList?.push(marble.mesh);
      for (const caster of this.obstacles.shadowCasters) shadowMap?.renderList?.push(caster);
    }

    this.hookSimulation();
    if (!this.headless) this.positionPreviewCamera();
  }

  /** Wires the race's fixed-step logic into the physics loop. */
  private hookSimulation(): void {
    this.scene.onBeforePhysicsObservable.add(() => {
      this.race.step();
      this.obstacles.update(Math.max(0, this.race.simTime));
    });
    this.scene.onAfterPhysicsObservable.add(() => {
      this.race.postStep();
    });
  }

  private buildStartGate(): void {
    const frame = this.geometry.frameAt(this.plan.startIndex + 3);
    const gate = CreateBox(
      "start-gate",
      { width: frame.width * 2.4, height: 4, depth: 0.4 },
      this.scene,
    );
    const material = new PBRMaterial("gate-mat", this.scene);
    material.albedoColor = Color3.FromHexString("#ff3d6e");
    material.emissiveColor = Color3.FromHexString("#ff3d6e").scale(0.3);
    material.metallic = 0.2;
    material.roughness = 0.4;
    gate.material = material;

    const m = Matrix.Identity();
    Matrix.FromXYZAxesToRef(frame.right, frame.up, frame.tangent, m);
    gate.rotationQuaternion = Quaternion.FromRotationMatrix(m);
    gate.position = frame.position.add(frame.up.scale(2));
    gate.isPickable = false;
    // Purely visual: the marbles are kinematic until the flag drops, so the
    // gate never has to hold anything back.
    this.startGate = gate;
    this.decor.push(gate);
  }

  private buildFinishLine(): void {
    const frame = this.geometry.frameAt(this.plan.finishIndex);
    const m = Matrix.Identity();
    Matrix.FromXYZAxesToRef(frame.right, frame.up, frame.tangent, m);
    const rotation = Quaternion.FromRotationMatrix(m);

    const bannerMaterial = new PBRMaterial("finish-mat", this.scene);
    bannerMaterial.albedoColor = Color3.FromHexString("#f5f7ff");
    bannerMaterial.emissiveColor = Color3.FromHexString("#8fd3ff").scale(0.35);
    bannerMaterial.metallic = 0.1;
    bannerMaterial.roughness = 0.5;

    const width = frame.width * 2.6;
    for (const side of [-1, 1]) {
      const post = CreateCylinder(
        "finish-post",
        { diameter: 0.6, height: 11, tessellation: 10 },
        this.scene,
      );
      post.rotationQuaternion = rotation.clone();
      post.position = frame.position
        .add(frame.right.scale(side * width * 0.5))
        .add(frame.up.scale(5.5));
      post.material = bannerMaterial;
      post.isPickable = false;
      this.decor.push(post);
    }

    const banner = CreateBox("finish-banner", { width, height: 2.1, depth: 0.2 }, this.scene);
    banner.rotationQuaternion = rotation.clone();
    banner.position = frame.position.add(frame.up.scale(10));
    banner.material = bannerMaterial;
    banner.isPickable = false;
    this.decor.push(banner);

    // A chequered strip on the floor, so the line reads from any angle.
    const stripe = CreateBox("finish-stripe", { width, height: 0.1, depth: 1.8 }, this.scene);
    stripe.rotationQuaternion = rotation.clone();
    stripe.position = frame.position.add(frame.up.scale(0.07));
    stripe.material = bannerMaterial;
    stripe.isPickable = false;
    this.decor.push(stripe);
  }

  /** Thin pillars dropping away below the track, to sell the height. */
  private buildSupports(): void {
    const pillar = CreateCylinder(
      "support",
      { diameterTop: 0.5, diameterBottom: 1.1, height: 1, tessellation: 6 },
      this.scene,
    );
    const material = new PBRMaterial("support-mat", this.scene);
    material.albedoColor = Color3.FromHexString("#39435c");
    material.metallic = 0.4;
    material.roughness = 0.65;
    pillar.material = material;
    pillar.isPickable = false;

    // Everything below the lowest point of the run is "the table".
    let tableY = Infinity;
    for (const frame of this.geometry.frames) tableY = Math.min(tableY, frame.position.y);
    tableY -= 6;

    const matrices: number[] = [];
    let count = 0;
    for (let i = 6; i < this.geometry.frames.length - 6; i += 14) {
      if (this.geometry.isInGap(i)) continue;
      const frame = this.geometry.frames[i];
      // Legs run down to the table the whole run stands on.
      const height = Math.max(2, frame.position.y - tableY);
      const top = frame.position.subtract(frame.up.scale(TRACK_CONSTANTS.shellThickness));
      const matrix = Matrix.Compose(
        new Vector3(1, height, 1),
        Quaternion.Identity(),
        new Vector3(top.x, top.y - height / 2, top.z),
      );
      matrix.copyToArray(matrices, count * 16);
      count++;
    }

    if (count === 0) {
      pillar.dispose();
      return;
    }
    pillar.thinInstanceSetBuffer("matrix", new Float32Array(matrices), 16);
    pillar.thinInstanceRefreshBoundingInfo(false);
    this.decor.push(pillar);
  }

  /** Frames the top of the track before the race starts. */
  private positionPreviewCamera(): void {
    const frame = this.geometry.frameAt(this.plan.startIndex);
    this.camera.snapTo(
      frame.position.add(new Vector3(-90, 65, -90)),
      frame.position,
    );
  }

  startCountdown(seconds = 3): void {
    this.previewProgress = 0;
    this.race.beginCountdown(seconds);
  }

  /** Kicks off the render loop. */
  run(onFrame?: (dt: number) => void): void {
    if (this.running) return;
    this.running = true;
    this.engine.runRenderLoop(() => {
      const dt = Math.min(0.1, this.engine.getDeltaTime() / 1000);

      if (this.race.state === "countdown") {
        // Fly the length of the track while the countdown runs.
        this.previewProgress = Math.min(1, this.previewProgress + dt * 0.34);
        this.camera.previewAt(this.previewProgress);
      } else if (this.race.state === "finished") {
        this.camera.finishShot(dt);
      } else if (this.race.state === "racing") {
        this.camera.update(this.race, dt);
      }

      this.race.updateVisuals(dt);
      this.animateGate(dt);
      this.lighting?.followShadows(this.camera.camera.getTarget());
      onFrame?.(dt);
      this.scene.render();
    });

    window.addEventListener("resize", this.handleResize);
  }

  private animateGate(dt: number): void {
    if (!this.startGate) return;
    const wantOpen = this.race.state === "racing" || this.race.state === "finished";
    const target = wantOpen ? 1 : 0;
    if (Math.abs(this.gateOpenAmount - target) < 0.001) return;
    this.gateOpenAmount += (target - this.gateOpenAmount) * Math.min(1, dt * 5);
    const frame = this.geometry.frameAt(this.plan.startIndex + 3);
    this.startGate.position = frame.position.add(
      frame.up.scale(2 + this.gateOpenAmount * 7),
    );
  }

  private handleResize = (): void => {
    this.engine.resize();
  };

  dispose(): void {
    this.running = false;
    window.removeEventListener("resize", this.handleResize);
    this.engine.stopRenderLoop();
    this.race.dispose();
    this.obstacles.dispose();
    this.trackMeshes.dispose();
    this.lighting?.dispose();
    for (const mesh of this.decor) {
      mesh.material?.dispose();
      mesh.dispose();
    }
    this.decor.length = 0;
    this.scene.dispose();
    this.engine.dispose();
  }
}
