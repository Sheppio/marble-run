import { Engine } from "@babylonjs/core/Engines/engine";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Scene } from "@babylonjs/core/scene";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import "@babylonjs/core/Physics/physicsEngineComponent";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import HavokPhysics from "@babylonjs/havok";
import havokWasmUrl from "@babylonjs/havok/lib/esm/HavokPhysics.wasm?url";

import { generateTrack } from "../track/generator";
import { TrackGeometry } from "../track/geometry";
import { buildTrackMesh, type TrackMeshes } from "../track/builder";
import { buildObstacles, frameRotation, type ObstacleSet } from "../track/obstacles";
import { hashSeed } from "../core/rng";
import { createEnvironment, type WorldLighting } from "../render/environment";
import { applyDetail, createSurface } from "../render/materials";
import {
  chequerTexture,
  fitChequer,
  grassDetail,
  panelDetail,
  plasticDetail,
  woodDetail,
  type DetailMaps,
} from "../render/textures";
import { getTheme, type Theme } from "../render/theme";
import { detectQuality, type QualitySettings } from "./quality";
import { BroadcastCamera } from "./camera";
import { Race, FIXED_STEP, type RaceEvents } from "./race";
import { smoothstep } from "./smoothing";
import type { Player } from "./marble";
import { GRAVITY, TRACK_CONSTANTS, type TrackPlan } from "../track/plan";

/**
 * Owns the Babylon engine, the physics world, and everything in it.
 *
 * A `World` is built once per race. Rebuilding from scratch for each new seed
 * is far simpler to reason about than mutating a track in place, and on a
 * phone the whole build takes well under a second.
 */

/** How far below the lowest point of the run its supporting surface sits. */
const TABLE_DROP = 14;

/**
 * Target size of one chequer cell, in cm — a bit larger than a marble, so the
 * flag reads as a flag at the distance the broadcast camera sits.
 */
const CHEQUER_CELL = 1.0;

/** Stages of the pre-race sequence. */
type IntroPhase = "none" | "sweep" | "return";

/**
 * How long the flythrough down the track takes, in seconds.
 *
 * Short on purpose. This runs before every race including rematches on the
 * same track, and the whole sequence — sweep, return, then a three-second
 * countdown — is about six seconds before anything moves.
 */
const SWEEP_SECONDS = 1.8;
/** How long the camera takes to come back to the grid afterwards. */
const RETURN_SECONDS = 0.9;

/**
 * Test hook letting the basin test build a run without its end wall.
 *
 * Only exists so that test can demonstrate it is not vacuous: with the wall in
 * place no marble leaves the track, which on its own would look identical to a
 * test that checks nothing. Without it, 28 of 32 finishers fall 2.6m off the
 * open end — which is what the game actually did before the wall was added.
 */
function skipEndWall(): boolean {
  return (globalThis as { __noEndWall?: boolean }).__noEndWall === true;
}

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
  /** Visual theme. Purely cosmetic — it cannot change a race's outcome. */
  themeId?: string;
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

  readonly theme: Theme;
  private readonly lighting: WorldLighting | null;
  readonly headless: boolean;
  private readonly trackMeshes: TrackMeshes;
  private readonly obstacles: ObstacleSet;
  private readonly decor: Mesh[] = [];
  private readonly textures: DetailMaps[] = [];
  private readonly trackDetail: DetailMaps | null;
  private readonly extraTextures: RawTexture[] = [];
  private glow: DefaultRenderingPipeline | null = null;
  private canvasObserver: ResizeObserver | null = null;
  private endWall: PhysicsAggregate | null = null;
  private startGate: Mesh | null = null;
  private gateOpenAmount = 0;
  private previewProgress = 0;
  private running = false;
  private intro: IntroPhase = "none";
  private introTime = 0;
  private introSeconds = 3;
  /** Camera pose at the moment the return leg began. */
  private returnFromEye = new Vector3();
  private returnFromLook = new Vector3();

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
    // Held only for the duration of the build, and released at the end of the
    // constructor. It suppresses the per-material dirty flags that would
    // otherwise be raised over and over while the run is assembled.
    //
    // It must not be left on. Materials here are finished after they are
    // constructed — detail and relief maps are hung on afterwards, marbles get
    // their texture and sheen afterwards — and with the mechanism blocked those
    // changes never mark the material for recompilation. The effect is then
    // built without the defines those textures need, the material never reports
    // ready, and Babylon silently skips every mesh using it. Left on, this
    // showed up as a blank canvas with a perfectly good UI over it, on the
    // first load and not reliably afterwards.
    this.scene.blockMaterialDirtyMechanism = true;

    const plugin = new HavokPlugin(false, havokInstance);
    this.scene.enablePhysics(new Vector3(0, -GRAVITY, 0), plugin);
    this.scene.getPhysicsEngine()?.setTimeStep(FIXED_STEP);

    // --- Track -------------------------------------------------------------
    this.plan = generateTrack(options.seed);
    this.geometry = new TrackGeometry(this.plan);

    const theme = getTheme(options.themeId);
    this.theme = theme;
    const paletteSeed = hashSeed(`${options.seed}:palette`);
    this.lighting = this.headless
      ? null
      : createEnvironment(this.scene, theme.sky, {
          shadows: this.quality.shadows,
          shadowMapSize: this.quality.shadowMapSize,
          ...theme.lighting,
        });

    // Generated once per race and shared by everything that wears them. The
    // headless harness renders nothing, so it skips the bake entirely.
    const trackDetail = this.headless ? null : this.makeDetail(theme.material);
    this.trackDetail = trackDetail;
    this.trackMeshes = buildTrackMesh(
      this.scene,
      this.geometry,
      theme.track(paletteSeed),
      theme.trackSurface,
      trackDetail,
      this.quality.relief,
    );
    this.obstacles = buildObstacles(
      this.scene,
      this.geometry,
      options.disableObstacles ? [] : this.plan.obstacles,
      theme,
      trackDetail,
      this.quality.relief,
    );

    // Built in the headless harness too. It is the only piece of scenery that
    // is also a collider, so leaving it out would let the tuning runs diverge
    // from the game they are meant to be measuring.
    if (!skipEndWall()) this.buildEndWall();

    if (!this.headless) {
      this.buildFloor();
      this.buildStartGate();
      this.buildFinishLine();
      if (this.quality.scenery) this.buildSupports();
    }

    // --- Race --------------------------------------------------------------
    this.camera = new BroadcastCamera(this.scene, this.geometry);
    // After the camera: the bloom pipeline attaches to it.
    if (!this.headless) this.buildGlow();
    this.race = new Race(
      this.scene,
      this.geometry,
      this.obstacles.zones,
      options.players,
      options.events,
      options.maxSpeed,
      theme,
      !this.headless,
    );

    if (this.lighting?.shadowGenerator) {
      const shadowMap = this.lighting.shadowGenerator.getShadowMap();
      // The run itself is the most important caster by far. Without it the
      // track hangs over an unbroken lawn with nothing tying the two together,
      // and no amount of surface detail fixes that — the shadow is what tells
      // you the run is an object standing above the ground rather than a
      // picture laid on top of it.
      shadowMap?.renderList?.push(this.trackMeshes.shell);
      for (const mesh of this.decor) shadowMap?.renderList?.push(mesh);
      for (const marble of this.race.marbles) shadowMap?.renderList?.push(marble.mesh);
      for (const caster of this.obstacles.shadowCasters) shadowMap?.renderList?.push(caster);
    }

    // Everything is built and every texture is attached, so material changes
    // can mark their own materials dirty again from here on.
    this.scene.blockMaterialDirtyMechanism = false;

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

  /**
   * The starting gate: two uprights and a drop bar that lifts between them.
   *
   * It was a single slab the full width of the channel, and since the preview
   * camera sits low and close during the countdown, that slab filled the frame
   * — the first thing anyone saw of a race was a coloured rectangle. Splitting
   * it into a frame you can see the grid through fixes that, and it reads as a
   * piece of apparatus rather than a wall.
   */
  private buildStartGate(): void {
    const frame = this.geometry.frameAt(this.plan.startIndex + 3);
    const m = Matrix.Identity();
    Matrix.FromXYZAxesToRef(frame.right, frame.up, frame.tangent, m);
    const rotation = Quaternion.FromRotationMatrix(m);
    const span = frame.width * 2.5;

    const material = createSurface(this.scene, "gate-mat", this.theme.decor.gate, {
      metallic: 0.35,
      roughness: 0.3,
      clearCoat: 0.5,
      glow: this.theme.bloom ? 0.7 : undefined,
    });

    for (const side of [-1, 1]) {
      const upright = CreateCylinder(
        "gate-post",
        { diameter: 0.55, height: 7, tessellation: 12 },
        this.scene,
      );
      upright.rotationQuaternion = rotation.clone();
      upright.position = frame.position
        .add(frame.right.scale(side * span * 0.5))
        .add(frame.up.scale(3.2));
      upright.material = material;
      upright.isPickable = false;
      this.decor.push(upright);
    }

    // Only the bar moves, so it is the one piece held on the field.
    const bar = CreateBox("start-gate", { width: span, height: 1.1, depth: 0.45 }, this.scene);
    bar.rotationQuaternion = rotation.clone();
    bar.material = material;
    bar.isPickable = false;
    // Purely visual: the marbles are kinematic until the flag drops, so the
    // gate never has to hold anything back.
    this.startGate = bar;
    this.decor.push(bar);
  }

  private buildFinishLine(): void {
    const frame = this.geometry.frameAt(this.plan.finishIndex);
    const m = Matrix.Identity();
    Matrix.FromXYZAxesToRef(frame.right, frame.up, frame.tangent, m);
    const rotation = Quaternion.FromRotationMatrix(m);

    const bannerMaterial = createSurface(this.scene, "finish-mat", this.theme.decor.banner, {
      metallic: 0.15,
      roughness: 0.35,
      clearCoat: 0.4,
      glow: this.theme.bloom ? 0.7 : undefined,
    });

    const width = frame.width * 2.6;

    // The posts stay plain; only the banner and the line on the deck are
    // chequered, so the flag reads without the whole gantry turning into a
    // pattern.
    //
    // They get a texture each rather than sharing one, because the tiling has
    // to be worked out from each face's own proportions and the two are
    // different shapes — the banner stands 2.1cm tall, the deck stripe is
    // 1.8cm deep.
    const flagMaterial = (name: string, faceWidth: number, faceHeight: number, swap = false) => {
      const chequer = chequerTexture(this.scene);
      fitChequer(chequer, faceWidth, faceHeight, CHEQUER_CELL, { swapAxes: swap });
      this.extraTextures.push(chequer);
      const material = createSurface(this.scene, name, Color3.White(), {
        metallic: 0.05,
        roughness: 0.45,
        glow: this.theme.bloom ? 0.5 : undefined,
      });
      material.albedoTexture = chequer;
      return material;
    };
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

    const bannerHeight = 2.1;
    const banner = CreateBox(
      "finish-banner",
      { width, height: bannerHeight, depth: 0.2 },
      this.scene,
    );
    banner.rotationQuaternion = rotation.clone();
    banner.position = frame.position.add(frame.up.scale(10));
    banner.material = flagMaterial("finish-flag-mat", width, bannerHeight);
    banner.isPickable = false;
    this.decor.push(banner);

    // A chequered strip on the floor, so the line reads from any angle. Its
    // visible face is the top, so the tiling is fitted to width x depth.
    const stripeDepth = 1.8;
    const stripe = CreateBox(
      "finish-stripe",
      { width, height: 0.1, depth: stripeDepth },
      this.scene,
    );
    stripe.rotationQuaternion = rotation.clone();
    stripe.position = frame.position.add(frame.up.scale(0.07));
    // Swapped: the deck strip is read off the box's top face, whose UVs run a
    // quarter turn from the upright faces the banner uses.
    stripe.material = flagMaterial("finish-stripe-mat", width, stripeDepth, true);
    stripe.isPickable = false;
    this.decor.push(stripe);
  }

  /** Thin pillars dropping away below the track, to sell the height. */
  private buildSupports(): void {
    const pillar = CreateCylinder(
      "support",
      { diameterTop: 0.9, diameterBottom: 1.8, height: 1, tessellation: 8 },
      this.scene,
    );
    const pillarMaterial = createSurface(this.scene, "support-mat", this.theme.decor.support, {
      // Non-metallic and barely reflective. At metallic 0.15 with a full share
      // of the environment, the legs mirrored the sky and came out lilac —
      // dark brown timber reading as scaffolding poles.
      metallic: 0.0,
      roughness: 0.8,
      environmentIntensity: 0.25,
    });
    applyDetail(pillarMaterial, this.trackDetail, this.quality.relief);
    pillar.material = pillarMaterial;
    pillar.isPickable = false;

    // Everything below the lowest point of the run is "the table".
    let tableY = Infinity;
    for (const frame of this.geometry.frames) tableY = Math.min(tableY, frame.position.y);
    tableY -= TABLE_DROP;

    const matrices: number[] = [];
    let count = 0;
    for (let i = 6; i < this.geometry.frames.length - 6; i += 26) {
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

  /** Bakes a detail map set and registers it for disposal. */
  private makeDetail(kind: Theme["material"]): DetailMaps {
    const maps =
      kind === "wood"
        ? woodDetail(this.scene)
        : kind === "plastic"
          ? plasticDetail(this.scene)
          : panelDetail(this.scene);
    this.textures.push(maps);
    return maps;
  }

  /**
   * Bloom for themes that light themselves.
   *
   * Only worth its cost where emission is doing real work: in Neon the glow is
   * how the shape of the run is read at all, since there is barely any sun.
   * The layer is skipped entirely otherwise rather than run at zero strength,
   * because it is a full-screen pass either way.
   */
  private buildGlow(): void {
    if (!this.theme.bloom || !this.quality.scenery) return;
    const pipeline = new DefaultRenderingPipeline("bloom", false, this.scene, [
      this.camera.camera,
    ]);
    pipeline.fxaaEnabled = false; // The engine's MSAA already handles edges.
    pipeline.bloomEnabled = true;
    // Threshold rather than emissive-driven, so the bloom follows what is
    // actually bright on screen: the lit walls and stripes bloom, the near-black
    // deck between them does not, and the track keeps its shape.
    pipeline.bloomThreshold = 0.5;
    pipeline.bloomWeight = this.theme.bloom;
    pipeline.bloomKernel = 48;
    pipeline.bloomScale = 0.5;
    this.glow = pipeline;
  }

  /**
   * The back wall of the catch basin.
   *
   * The generator lays out 55cm of run-off past the line and its comment says
   * marbles are stopped by the end wall of the basin — but no such wall was
   * ever built, so they rolled the length of the basin and dropped off the
   * open end. A finisher keeps rolling for a couple of seconds before it is
   * lifted off, which at racing pace is further than the basin is long, so
   * this happened on essentially every race.
   *
   * Placed a little inside the final frame rather than on the lip, so a marble
   * arriving fast is stopped by the wall rather than by the cap on the end of
   * the shell, which it could ride up and over.
   */
  private buildEndWall(): void {
    const frames = this.geometry.frames;
    const frame = frames[Math.max(0, frames.length - 3)];
    // Tall enough that a marble cannot climb it, and wider than the channel so
    // there is no gap at either side to squeeze through.
    const wall = CreateBox(
      "end-wall",
      { width: frame.width * 2 + TRACK_CONSTANTS.shellThickness * 2, height: 5, depth: 1.2 },
      this.scene,
    );
    wall.rotationQuaternion = frameRotation(frame);
    wall.position = frame.position.add(frame.up.scale(2.5));
    wall.isPickable = false;

    if (!this.headless) {
      wall.material = createSurface(this.scene, "end-wall-mat", this.theme.decor.support, {
        metallic: 0.0,
        roughness: 0.7,
        environmentIntensity: 0.3,
        glow: this.theme.bloom ? 0.5 : undefined,
      });
      applyDetail(wall.material as PBRMaterial, this.trackDetail, this.quality.relief);
      this.decor.push(wall);
    }

    this.endWall = new PhysicsAggregate(
      wall,
      PhysicsShapeType.BOX,
      // Barely bouncy: marbles should arrive and settle, not rebound back over
      // the line into the path of whoever is still racing.
      { mass: 0, restitution: 0.05, friction: 0.5 },
      this.scene,
    );
    if (this.headless) this.decor.push(wall);
  }

  /**
   * The surface the run stands on.
   *
   * Without it the track floats in an empty sky, which reads as a diagram
   * rather than an object. A plain ground plane catches the shadows of the run
   * and its legs, and those shadows are most of what tells you how high above
   * it any part of the track is.
   */
  private buildFloor(): void {
    let lowest = Infinity;
    for (const frame of this.geometry.frames) lowest = Math.min(lowest, frame.position.y);

    const floor = CreateGround("floor", { width: 1600, height: 1600, subdivisions: 1 }, this.scene);
    floor.position.y = lowest - TABLE_DROP;
    const floorMaterial = createSurface(this.scene, "floor-mat", this.theme.ground, {
      metallic: 0.0,
      roughness: 0.95,
      environmentIntensity: 0.35,
    });
    const grass = grassDetail(this.scene);
    this.textures.push(grass);
    applyDetail(floorMaterial, grass, this.quality.relief);
    // The plane is 1600cm across; without a heavy tile the grass is a single
    // smear. This puts a tile roughly every 25cm, about a hand's width.
    grass.albedo.uScale = 64;
    grass.albedo.vScale = 64;
    grass.normal.uScale = 64;
    grass.normal.vScale = 64;
    floor.material = floorMaterial;
    floor.receiveShadows = true;
    floor.isPickable = false;
    floor.freezeWorldMatrix();
    this.decor.push(floor);
  }

  /** Frames the top of the track before the race starts. */
  private positionPreviewCamera(): void {
    const frame = this.geometry.frameAt(this.plan.startIndex);
    this.camera.snapTo(
      frame.position.add(new Vector3(-90, 65, -90)),
      frame.position,
    );
  }

  /**
   * Runs the pre-race sequence: fly the track, come back to the grid, then
   * count down.
   *
   * These used to happen at once — the flythrough played *over* the countdown —
   * so at "GO" the camera was at the far end of the run and had to fly the
   * whole way back with the race already under way. The start was over before
   * you saw it. Doing it in order costs a couple of seconds but means the
   * countdown ends with the camera already pointed at the grid.
   */
  startCountdown(seconds = 3): void {
    this.previewProgress = 0;
    this.introSeconds = seconds;
    this.introTime = 0;
    if (this.headless) {
      // Nothing to look at, and the tuning harness runs thousands of these.
      this.race.beginCountdown(seconds);
      return;
    }
    this.intro = "sweep";
  }

  /**
   * Advances the pre-race sequence, returning true while it still owns the
   * camera.
   */
  private updateIntro(dt: number): boolean {
    if (this.intro === "none") return false;
    this.introTime += dt;

    if (this.intro === "sweep") {
      this.previewProgress = Math.min(1, this.introTime / SWEEP_SECONDS);
      this.camera.previewAt(this.previewProgress);
      if (this.previewProgress >= 1) {
        // Capture the pose the sweep ended on, so the return leg can ease out
        // of exactly where it is rather than jumping.
        this.returnFromEye.copyFrom(this.camera.camera.position);
        this.returnFromLook.copyFrom(this.camera.currentLook);
        this.intro = "return";
        this.introTime = 0;
      }
      return true;
    }

    // Returning: a straight eased blend back to the grid. Smoothstep rather
    // than a spring, because this has to *finish* — the countdown starts the
    // instant it does, and a spring only ever approaches its target.
    const t = smoothstep(this.introTime / RETURN_SECONDS);
    const { eye, look } = this.camera.gridFraming();
    this.camera.snapTo(
      Vector3.Lerp(this.returnFromEye, eye, t),
      Vector3.Lerp(this.returnFromLook, look, t),
    );

    if (this.introTime >= RETURN_SECONDS) {
      this.intro = "none";
      this.race.beginCountdown(this.introSeconds);
    }
    return true;
  }

  /** Kicks off the render loop. */
  run(onFrame?: (dt: number) => void): void {
    if (this.running) return;
    this.running = true;
    this.engine.runRenderLoop(() => {
      const dt = Math.min(0.1, this.engine.getDeltaTime() / 1000);

      if (this.updateIntro(dt)) {
        // The intro owns the camera until it hands over to the countdown.
      } else if (this.race.state === "countdown") {
        // Hold the grid shot so the flag drops on a settled camera.
        const { eye, look } = this.camera.gridFraming();
        this.camera.snapTo(eye, look);
      } else if (this.race.state === "finished") {
        this.camera.finishShot(dt);
      } else if (this.race.state === "racing") {
        this.camera.update(this.race, dt);
      }

      this.animateGate(dt);
      this.lighting?.followShadows(this.camera.camera.getTarget());
      onFrame?.(dt);
      this.scene.render();
    });

    // Babylon never re-reads the canvas on its own, and a window resize event
    // is not a reliable signal on a phone: entering a race usually collapses
    // the browser chrome, which changes the visual viewport — and in several
    // mobile browsers that resizes the canvas without firing `resize` on the
    // window. Watching the element itself catches every case, including the
    // first layout if it lands after the engine was created.
    this.observeCanvasSize();
    window.addEventListener("resize", this.handleResize);
    window.visualViewport?.addEventListener("resize", this.handleResize);
  }

  private observeCanvasSize(): void {
    const canvas = this.engine.getRenderingCanvas();
    if (!canvas || typeof ResizeObserver === "undefined") return;
    this.canvasObserver = new ResizeObserver(() => this.handleResize());
    this.canvasObserver.observe(canvas);
  }

  private animateGate(dt: number): void {
    if (!this.startGate) return;
    const wantOpen = this.race.state === "racing" || this.race.state === "finished";
    const target = wantOpen ? 1 : 0;
    if (Math.abs(this.gateOpenAmount - target) < 0.001) return;
    this.gateOpenAmount += (target - this.gateOpenAmount) * Math.min(1, dt * 5);
    const frame = this.geometry.frameAt(this.plan.startIndex + 3);
    this.startGate.position = frame.position.add(
      frame.up.scale(1.4 + this.gateOpenAmount * 5.4),
    );
  }

  private handleResize = (): void => {
    const canvas = this.engine.getRenderingCanvas();
    // A zero-sized canvas would leave a zero-sized drawing buffer behind, which
    // renders nothing at all rather than rendering badly. Skip and wait for a
    // layout that has a size.
    if (canvas && (canvas.clientWidth === 0 || canvas.clientHeight === 0)) return;
    this.engine.resize();
  };

  dispose(): void {
    this.running = false;
    this.canvasObserver?.disconnect();
    this.canvasObserver = null;
    window.removeEventListener("resize", this.handleResize);
    window.visualViewport?.removeEventListener("resize", this.handleResize);
    this.engine.stopRenderLoop();
    this.race.dispose();
    this.endWall?.dispose();
    this.glow?.dispose();
    for (const maps of this.textures) {
      maps.albedo.dispose();
      maps.normal.dispose();
    }
    this.textures.length = 0;
    for (const texture of this.extraTextures) texture.dispose();
    this.extraTextures.length = 0;
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
