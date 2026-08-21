import { Engine } from "@babylonjs/core/Engines/engine";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Scene } from "@babylonjs/core/scene";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
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
  buildBoat,
  boatOrientation,
  HULL_LENGTH,
  HULL_BEAM,
  DEFAULT_SAILS,
  type Boat,
  type BoatSails,
} from "../render/boat";
import {
  chequerTexture,
  fitChequer,
  panelDetail,
  plasticDetail,
  startBannerTexture,
  waterColorDetail,
  woodDetail,
  type DetailMaps,
} from "../render/textures";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { getTheme, type Theme } from "../render/theme";
import { detectQuality, type QualitySettings } from "./quality";
import { BroadcastCamera, type CameraMode } from "./camera";
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

/** How far below the lowest point of the run its supporting surface sits. */
const TABLE_DROP = 14;

/**
 * Target size of one chequer cell, in cm — a bit larger than a marble, so the
 * flag reads as a flag at the distance the broadcast camera sits.
 */
const CHEQUER_CELL = 1.0;

/**
 * The ground plane's swell, as three overlapping sine waves at different
 * wavelengths, directions and speeds.
 *
 * Each wave's direction is an arbitrary unit vector rather than one of the
 * world axes (or their diagonal) — three waves running along x, z and x+z
 * are only 45 degrees apart and share every multiple of that angle, so the
 * troughs and crests they cast keep lining back up into the same few spots
 * as each other every so often, which reads as a repeating tile rather than
 * an irregular sea. Angles here are well off any of those alignments, and
 * the wavelengths avoid simple ratios with each other for the same reason —
 * two periodic patterns with a near-integer wavelength ratio re-align
 * regularly; ones that don't share a ratio drift in and out of phase with
 * each other indefinitely, so the combined pattern doesn't repeat within
 * any span you'd actually see at once.
 *
 * One dominant wave rather than three comparable ones, so the surface reads
 * as rolling ridges rather than an "egg carton" of isolated peaks — three
 * waves of similar strength interfere constructively at scattered points
 * and spike upward there instead of anywhere else. The secondary and
 * tertiary waves are a fraction of the first one's amplitude, just enough
 * to texture the ridge lines without competing with it for which one shapes
 * the silhouette. Kept subtle rather than sized boldly against the 16cm toy
 * boat as an earlier pass did — that read as dramatic rather than as water.
 */
const WATER_WAVES = [
  { amplitude: 1.75, frequency: 0.074, speed: 0.5, dirX: 0.956, dirZ: 0.292 },
  { amplitude: 0.625, frequency: 0.117, speed: -0.4, dirX: -0.225, dirZ: 0.974 },
  { amplitude: 0.3, frequency: 0.193, speed: 0.75, dirX: -0.857, dirZ: -0.515 },
] as const;

/**
 * Radius, in cm from the arena centre, within which the waves run at full
 * strength — generous over the arena itself (radius 260) and the boat's own
 * orbit (radius 140).
 */
const WATER_FALLOFF_INNER = 480;
/**
 * Radius the waves have faded to nothing by. Short of the animated ground
 * plane's own 800cm half-width on purpose, so there's a dead-flat margin
 * between where the waves end and where the plane itself does — the flat
 * horizon plane built alongside it (see `buildFloor`) starts from exactly
 * that same flatness, so the seam between the two is never a place either
 * one is actually moving.
 */
const WATER_FALLOFF_OUTER = 760;

/** 1 at the centre, smoothly down to 0 by `WATER_FALLOFF_OUTER`. */
function waterFalloff(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r <= WATER_FALLOFF_INNER) return 1;
  if (r >= WATER_FALLOFF_OUTER) return 0;
  const t = (r - WATER_FALLOFF_INNER) / (WATER_FALLOFF_OUTER - WATER_FALLOFF_INNER);
  return 1 - t * t * (3 - 2 * t);
}

/** Height of the water surface at a point, in local ground-plane cm. */
function waterHeight(x: number, z: number, t: number): number {
  let h = 0;
  for (const w of WATER_WAVES) {
    const phase = (x * w.dirX + z * w.dirZ) * w.frequency + t * w.speed;
    h += w.amplitude * Math.sin(phase);
  }
  return h * waterFalloff(x, z);
}

/**
 * The surface's slope at a point, as (dHeight/dx, dHeight/dz) — the analytic
 * derivative of `waterHeight`, used to build a normal without recomputing one
 * from the displaced mesh each frame.
 *
 * Approximate near the falloff band: this scales the waves' own slope by the
 * same radial falloff `waterHeight` uses but skips the (small, and only ever
 * relevant in a band that is fading to flat anyway) extra term from the
 * falloff's own gradient.
 */
function waterSlope(x: number, z: number, t: number): [number, number] {
  let dx = 0;
  let dz = 0;
  const falloff = waterFalloff(x, z);
  for (const w of WATER_WAVES) {
    const phase = (x * w.dirX + z * w.dirZ) * w.frequency + t * w.speed;
    const slope = w.amplitude * w.frequency * Math.cos(phase) * falloff;
    dx += slope * w.dirX;
    dz += slope * w.dirZ;
  }
  return [dx, dz];
}

/**
 * The toy boats' paths: slow circles centred near the middle of the arena.
 *
 * A track starts out near the arena's rim and spirals inward — see
 * `generateTrack` — so the interior tends to be the most open water going,
 * and the most likely to actually sit under a stretch of the run rather than
 * out past its edge. Not chosen from any given track's own footprint, on
 * purpose: a boat that had to dodge a specific seed's legs would need real
 * collision logic for something that is decoration and cannot affect a race
 * either way, and one seed's dodge is the next seed's detour into a clear
 * patch of water for no visible reason.
 *
 * A small fleet rather than one boat, each on its own radius and starting
 * angle so they never cross paths (a shared centre and evenly spread radii
 * guarantee that) and in a different pair of sail colours so they read as
 * separate boats at a glance rather than one boat seen three times.
 */
const BOAT_FLEET: ReadonlyArray<{
  orbitRadius: number;
  phase: number;
  angularSpeed: number;
  sails: BoatSails;
}> = [
  { orbitRadius: 140, phase: 0, angularSpeed: 0.05, sails: DEFAULT_SAILS },
  { orbitRadius: 100, phase: 2.35, angularSpeed: 0.042, sails: { main: Color3.FromHexString("#4a90d9"), jib: Color3.FromHexString("#f2c14e") } },
  { orbitRadius: 178, phase: 4.55, angularSpeed: 0.058, sails: { main: Color3.FromHexString("#c0392b"), jib: Color3.FromHexString("#8e6fc9") } },
];
/** How high the hull's deck line floats above the flat waterline, in cm. */
const BOAT_FREEBOARD = 1.1;
/** Steepest local wave slope the boat's tilt will follow — see `updateBoat`. */
const BOAT_MAX_TILT_SLOPE = 0.36;

/**
 * Where the gate stands, in centreline points past the start of the shelf.
 *
 * Close enough that the front row only creeps forward to reach it — at 1.2cm
 * per point, two points puts the bar's face about 1.4cm ahead of the leading
 * marble's surface, so the grid settles against it without the whole field
 * sliding out of the shot the camera framed.
 */
const GATE_INDEX_OFFSET = 2;
/**
 * Height of the drop bar, in cm.
 *
 * A marble is 1.6cm across and the bar sits flush with the channel floor, so
 * even the original 1.8cm covered one completely: nothing rolls under it, and
 * a marble would have to be lifted clear of the floor to get over. Doubled
 * from that floor-clearing minimum so the field queued against it — which
 * only ever reaches 1.6cm up the bar's face — covers no more than its bottom
 * half, leaving the "START" text in the top half always readable.
 */
const GATE_BAR_HEIGHT = 3.6;
/** How far the bar rises when it opens, in cm. */
const GATE_LIFT = 5.4;

/** How long the scene may fail to draw before it is treated as stuck. */
const STUCK_SECONDS = 5;

/** Half the widest part of a support leg, in cm. */
const SUPPORT_RADIUS = 0.9;
/** Slack on top of the geometric touching distance, so legs never graze. */
const SUPPORT_MARGIN = 1.2;
/**
 * How many frames either side of a leg count as the deck it is holding up
 * rather than an obstruction. Comfortably more than the track is wide.
 */
const SUPPORT_SELF_SPAN = 40;
/** A leg has to fall at least this far to be worth drawing. */
const SUPPORT_MIN_DROP = 6;

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
  /** Camera to open on, so a choice carries between races. */
  cameraMode?: CameraMode;
  /**
   * Called if the scene is still unable to draw well after it should be able
   * to. See `STUCK_SECONDS`.
   */
  onStuck?: () => void;
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
  private readonly extraTextures: BaseTexture[] = [];
  private glow: DefaultRenderingPipeline | null = null;
  private canvasObserver: ResizeObserver | null = null;
  private readonly onStuck: (() => void) | undefined;
  private stuckElapsed = 0;
  private stuckSettled = false;
  private endWall: PhysicsAggregate | null = null;
  private startGate: Mesh | null = null;
  private gateBody: PhysicsAggregate | null = null;
  private gateOpenAmount = 0;
  private running = false;
  private paused = false;
  private waterMesh: Mesh | null = null;
  private waterTime = 0;
  /** World Y the water plane's own local (unrippled) surface sits at. */
  private waterBaseY = 0;
  private boats: Boat[] = [];
  private boatTime = 0;
  private obstacleTime = 0;

  constructor(options: WorldOptions) {
    if (!havokInstance) {
      throw new Error("Physics not initialised — call initPhysics() first.");
    }

    this.headless = options.headless ?? false;
    this.onStuck = options.onStuck;
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
    if (!this.headless) {
      this.engine.setHardwareScalingLevel(this.quality.hardwareScaling);
      // Compile shaders synchronously rather than polling the driver for
      // completion.
      //
      // With KHR_parallel_shader_compile, Babylon holds a material unready
      // until the driver reports COMPLETION_STATUS_KHR, and on a number of
      // mobile GPUs that status never arrives. Every material stays unready,
      // every mesh is skipped, and the result is an empty canvas under a
      // perfectly working UI for the whole page — which is why reloading
      // sometimes clears it and sometimes has to be done several times.
      //
      // The extension only buys a little first-frame latency across the dozen
      // or so materials here. That is a cheap price for removing a failure
      // that makes the app unusable until it happens to load cleanly.
      this.engine.getCaps().parallelShaderCompile = undefined;
    }

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

    // The gate holds the field back until the flag, so it is a collider as well
    // as scenery and is built in the headless harness too — same reasoning as
    // the end wall above.
    this.buildStartGate();

    if (!this.headless) {
      this.buildFloor();
      this.buildFinishLine();
      if (this.quality.scenery) this.buildSupports();
      this.aimShadows();
    }

    // --- Race --------------------------------------------------------------
    this.camera = new BroadcastCamera(this.scene, this.geometry, options.cameraMode);
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
      // Pull the barrier out of the simulation the instant the race starts.
      // Done here, on a physics step, rather than in the render loop, so the
      // gate opens on the same step in the headless harness as it does on
      // screen and a seed still reproduces exactly.
      if (this.gateBody && this.race.state === "racing") {
        this.gateBody.dispose();
        this.gateBody = null;
      }
      // Its own clock, not the race's: `race.simTime` sits frozen at 0 until
      // the race actually starts (and holds at its final value once it
      // finishes), which left baffles and wedges motionless until the start
      // banner went up. This one advances on every physics step regardless
      // of race state, so the oscillation is already running the moment the
      // level loads, and — since physics stepping is fixed-step — stays just
      // as reproducible as everything else driven off it.
      this.obstacleTime += FIXED_STEP;
      this.obstacles.update(this.obstacleTime);
    });
    this.scene.onAfterPhysicsObservable.add(() => {
      this.race.postStep();
    });
  }

  /**
   * The starting gate: two uprights and a chequered drop bar that lifts
   * between them.
   *
   * It was a single slab the full width of the channel, and since the preview
   * camera sits low and close during the countdown, that slab filled the frame
   * — the first thing anyone saw of a race was a coloured rectangle. Splitting
   * it into a frame you can see the grid through fixes that, and it reads as a
   * piece of apparatus rather than a wall.
   *
   * Built to match the finish gantry rather than as its own thing — plain
   * posts in the theme's gate colour, and the crossbar wearing the same
   * chequer flag the finish banner does. Racing start and finish gates share a
   * visual language on a real track, and a plain slab of colour here read as a
   * different, cruder object next to the finish.
   *
   * The bar is a real barrier, not a prop. The marbles come alive when the
   * countdown starts, roll the last centimetre or so down the shelf and settle
   * against it, so by "GO" the field is packed against the gate the way it is
   * on an actual marble run — and the flag is the bar lifting out of their way
   * rather than eighteen marbles being switched on at once.
   */
  private buildStartGate(): void {
    const frame = this.geometry.frameAt(GATE_INDEX_OFFSET + this.plan.startIndex);
    const m = Matrix.Identity();
    Matrix.FromXYZAxesToRef(frame.right, frame.up, frame.tangent, m);
    const rotation = Quaternion.FromRotationMatrix(m);
    const span = frame.width * 2.5;

    if (!this.headless) {
      const postMaterial = createSurface(this.scene, "gate-mat", this.theme.decor.gate, {
        metallic: 0.15,
        roughness: 0.35,
        clearCoat: 0.4,
        glow: this.theme.bloom ? 0.7 : undefined,
      });

      for (const side of [-1, 1]) {
        const upright = CreateCylinder(
          "gate-post",
          { diameter: 0.6, height: 7, tessellation: 10 },
          this.scene,
        );
        upright.rotationQuaternion = rotation.clone();
        upright.position = frame.position
          .add(frame.right.scale(side * span * 0.5))
          .add(frame.up.scale(3.2));
        upright.material = postMaterial;
        upright.isPickable = false;
        this.decor.push(upright);
      }
    }

    // Tall enough to cover a whole marble and set flush with the floor, so
    // nothing rolls under it or hops over; wider than the channel, so nothing
    // slips down either side. Carries the collider only — see below for why
    // the visible banner lives on two separate planes rather than on this
    // mesh's own faces.
    const bar = CreateBox(
      "start-gate",
      { width: span, height: GATE_BAR_HEIGHT, depth: 0.45 },
      this.scene,
    );
    bar.rotationQuaternion = rotation.clone();
    bar.position = frame.position.add(frame.up.scale(GATE_BAR_HEIGHT / 2));
    bar.isPickable = false;
    if (!this.headless) {
      // Plain, not the banner: a box's two large faces share one texture
      // through opposite halves of its default UV, so putting the banner
      // here as well as on the planes below left one of the two nearly
      // coplanar with this mesh's own (partly mirrored) face, and they
      // z-fought — both rendered at once, tearing between them frame to
      // frame.
      bar.material = createSurface(this.scene, "gate-bar-core", this.theme.decor.gate, {
        metallic: 0.1,
        roughness: 0.4,
      });
    }
    this.startGate = bar;
    this.decor.push(bar);

    // The banner itself, on two independent planes rather than on the box's
    // own faces. A box's two large faces share one texture through opposite
    // halves of its default UV, so a word that reads correctly from one side
    // reads backwards from the other — invisible as long as only one side was
    // ever in shot, which stopped being true once the "oncoming" camera
    // started planting itself past the gate and looking back at it. Two
    // planes, each with its own independently correct copy of the texture,
    // sidesteps that UV relationship entirely instead of fighting it.
    if (!this.headless) {
      // Parented to the bar rather than positioned in world space: the bar
      // rises on `animateGate` when the race starts, and a banner placed by
      // its own absolute position at build time would just get left behind
      // at the old height instead of rising with it.
      const faceGap = 0.3;
      const upstream = CreatePlane(
        "start-gate-upstream",
        { width: span, height: GATE_BAR_HEIGHT },
        this.scene,
      );
      upstream.parent = bar;
      upstream.rotationQuaternion = Quaternion.Identity();
      upstream.position = new Vector3(0, 0, -faceGap);
      upstream.material = this.startGateMaterial(span, GATE_BAR_HEIGHT);
      upstream.isPickable = false;
      this.decor.push(upstream);

      const downstream = CreatePlane(
        "start-gate-downstream",
        { width: span, height: GATE_BAR_HEIGHT },
        this.scene,
      );
      downstream.parent = bar;
      // A 180° turn about the bar's own up axis — equivalent to the
      // (frame.right * -1, frame.up, frame.tangent * -1) frame this used to
      // be built with directly in world space, but expressed relative to the
      // parent so it still comes out right wherever the bar has moved to.
      downstream.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), Math.PI);
      downstream.position = new Vector3(0, 0, faceGap);
      downstream.material = this.startGateMaterial(span, GATE_BAR_HEIGHT);
      downstream.isPickable = false;
      this.decor.push(downstream);
    }

    this.gateBody = new PhysicsAggregate(
      bar,
      PhysicsShapeType.BOX,
      // Dead: a marble arriving at the gate should stop against it, not bounce
      // back into the field waiting behind it.
      { mass: 0, restitution: 0.02, friction: 0.4 },
      this.scene,
    );
  }

  /**
   * A chequered material fitted to one rectangular face.
   *
   * Shared by the finish banner and the finish deck stripe, so the two read as
   * one flag. Each gets its own texture instance rather than sharing one
   * because the tiling has to be worked out from that face's own proportions,
   * and the two are different shapes.
   */
  private flagMaterial(name: string, faceWidth: number, faceHeight: number, swap = false): PBRMaterial {
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
  }

  /**
   * The start gate's crossbar: "START" over diagonal racing stripes.
   *
   * Deliberately not the chequer the finish gantry wears — on a real course
   * chequer means the race is over, and putting it at the start as well as the
   * end says the wrong thing however good it looks. This is a different piece
   * of apparatus doing a different job, so it gets its own face.
   */
  private startGateMaterial(faceWidth: number, faceHeight: number): PBRMaterial {
    const banner = startBannerTexture(this.scene, faceWidth, faceHeight, this.theme.decor.gate);
    this.extraTextures.push(banner);
    const material = createSurface(this.scene, "gate-bar-mat", Color3.White(), {
      metallic: 0.05,
      roughness: 0.45,
      glow: this.theme.bloom ? 0.5 : undefined,
    });
    material.albedoTexture = banner;
    // A world-space gap between these planes and the box behind them is not
    // enough on its own: a standard perspective depth buffer loses precision
    // roughly with the square of distance, and this gate gets looked back at
    // from as far as the far end of the run — over a thousand centimetres on
    // a long track. At that range a few centimetres of separation falls
    // inside the buffer's precision, the depth test starts resolving
    // inconsistently pixel to pixel, and the box's own plain face shows
    // through in patches. `zOffset` biases the depth comparison directly
    // rather than the surface's actual position, so it stays reliable at any
    // distance instead of degrading with it.
    material.zOffset = -4;
    return material;
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
    banner.material = this.flagMaterial("finish-flag-mat", width, bannerHeight);
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
    stripe.material = this.flagMaterial("finish-stripe-mat", width, stripeDepth, true);
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
      // A leg drops straight down, and the run doubles back beneath itself, so
      // some of them would otherwise spear a lower stretch of track. Stop the
      // leg above whatever it would have hit.
      // Dropped rather than shortened into a stub: legs sit every 26 frames,
      // so missing one leaves a span the eye reads as ordinary.
      if (this.legWouldHitTrack(i)) continue;
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
   * Parks the shadow frustum over the whole run, once.
   *
   * A bounding box around every centreline frame, dropped to take in the legs
   * and grown by a few channel widths so the walls, obstacles and gantries at
   * the edge of the run are inside it too.
   */
  private aimShadows(): void {
    const frames = this.geometry.frames;
    if (!this.lighting || frames.length === 0) return;

    const min = frames[0].position.clone();
    const max = frames[0].position.clone();
    for (const frame of frames) {
      min.minimizeInPlace(frame.position);
      max.maximizeInPlace(frame.position);
    }
    // The legs hang from the deck down to the table, and they cast too.
    min.y -= TABLE_DROP;
    max.y += TRACK_CONSTANTS.wallHeight;

    const margin = TRACK_CONSTANTS.baseWidth * 3;
    min.x -= margin;
    min.z -= margin;
    max.x += margin;
    max.z += margin;

    this.lighting.coverRun(min, max);
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
   * Whether a leg dropped from `index` would pass through track lower down.
   *
   * The run coils back over itself, so a leg dropped from an upper stretch can
   * spear one below it. A leg is a vertical line, and the track it might hit is
   * a ribbon of known width, so this is a horizontal distance test against
   * every frame that sits lower down.
   *
   * Frames near the leg's own along-track neighbourhood are skipped: they are
   * the deck it is holding up, not something in its way.
   */
  private legWouldHitTrack(index: number): boolean {
    const frames = this.geometry.frames;
    const from = frames[index].position;

    for (let j = 0; j < frames.length; j++) {
      if (Math.abs(j - index) < SUPPORT_SELF_SPAN) continue;
      const other = frames[j];
      // Only what is genuinely underneath, with enough headroom that a leg
      // stopping here would have been worth drawing at all.
      if (other.position.y > from.y - SUPPORT_MIN_DROP) continue;

      // Half the channel, its shell, and half the leg — the point at which the
      // two would touch.
      const clearance =
        other.width + TRACK_CONSTANTS.shellThickness + SUPPORT_RADIUS + SUPPORT_MARGIN;
      const dx = other.position.x - from.x;
      const dz = other.position.z - from.z;
      if (dx * dx + dz * dz <= clearance * clearance) return true;
    }

    return false;
  }

  /**
   * The surface the run stands on: still water with a gentle ripple.
   *
   * Without some kind of ground the track floats in an empty sky, which reads
   * as a diagram rather than an object — a plain plane catches the shadows of
   * the run and its legs, and those shadows are most of what tells you how
   * high above it any part of the track is. Water rather than grass because
   * that was the request; it keeps the shadow-catching job the ground was
   * always doing, and a wet surface picks up the sky and the run's own
   * reflection in a way a matte lawn never did.
   */
  private buildFloor(): void {
    let lowest = Infinity;
    for (const frame of this.geometry.frames) lowest = Math.min(lowest, frame.position.y);

    // Subdivided rather than the single quad the grass version used: the
    // waves need vertices to displace. 110 works out to about 14.5cm a cell,
    // close to four samples across the shortest wave's own ~48cm wavelength
    // — coarser than that and the displacement itself starts faceting
    // rather than curving, on top of the per-vertex analytic normals that
    // keep the *shading* smooth however coarse the mesh is. That resolution
    // is only for "high": this mesh's whole geometry is re-touched and
    // re-uploaded every frame, which a weak phone's GPU driver feels a lot
    // more than the vertex count alone suggests, and "medium" covers most
    // phones this runs on — not just the "low" tier's weakest ones. Both get
    // a coarser (and by the same maths, flatter-looking) sea instead, rather
    // than paying a frame cost that scales with a detail level the tier
    // exists to turn down.
    const subdivisions = this.quality.tier === "high" ? 110 : this.quality.tier === "medium" ? 64 : 30;
    const floor = CreateGround(
      "floor",
      // Without `updatable: true` a mesh's vertex buffer is uploaded once
      // and never again — `updateWater`'s per-frame updateVerticesData calls
      // were mutating the CPU-side array in place (the same array object
      // getVerticesData had handed back) but never reaching the GPU, so the
      // rendered surface stayed exactly as flat as the moment it was built
      // no matter how the wave function above was tuned.
      { width: 1600, height: 1600, subdivisions, updatable: true },
      this.scene,
    );
    floor.position.y = lowest - TABLE_DROP;
    this.waterBaseY = floor.position.y;

    // White rather than a tinted colour: unlike every other surface here, the
    // water's colour is baked directly into the detail texture as real hue
    // variation (see `waterColorDetail`), not carried by the material and
    // multiplied through a greyscale map. A tint on top would just wash the
    // contrast back out.
    const floorMaterial = createSurface(this.scene, "floor-mat", Color3.White(), {
      metallic: 0.05,
      roughness: 0.12,
      environmentIntensity: 0.9,
    });
    const ripple = waterColorDetail(this.scene);
    this.textures.push(ripple);
    applyDetail(floorMaterial, ripple, this.quality.relief);
    // Tight relative to a plane this size, so the fine ripple detail reads at
    // a scale the run actually sits on instead of as one huge smear.
    ripple.albedo.uScale = 90;
    ripple.albedo.vScale = 90;
    ripple.normal.uScale = 90;
    ripple.normal.vScale = 90;
    floor.material = floorMaterial;
    floor.receiveShadows = true;
    floor.isPickable = false;
    // Not frozen, unlike every other static piece of decor: this mesh's own
    // vertex data moves every frame — see `updateWater`. Its transform never
    // changes though, so freezing that part would still be safe; it just
    // isn't worth a second flag for one mesh.
    this.waterMesh = floor;
    this.decor.push(floor);

    // A second, much bigger, flat plane surrounding the first, so the water
    // reaches convincingly to the horizon from any camera angle instead of
    // ending at a visible edge. Unsubdivided rather than another wavy mesh:
    // by the time a camera could see this far out, the waves have already
    // faded to nothing (`WATER_FALLOFF_OUTER`, comfortably inside this
    // plane's own inner edge), so there's nothing here that needs
    // displacing, and it shares the inner plane's exact material so the
    // seam between "waves fading out" and "no waves" is also a seam between
    // two patches of identical colour.
    const horizon = CreateGround(
      "floor-horizon",
      { width: 9000, height: 9000, subdivisions: 2 },
      this.scene,
    );
    // This plane's whole footprint sits underneath the animated one, not
    // just the ring outside it, so a flat plane at the animated plane's own
    // rest height pokes up through every trough the waves dip below zero —
    // which read as a rippled, banded tear where the two overlapped rather
    // than as one continuous sea. Dropped comfortably below the deepest
    // trough the waves can ever reach clears it everywhere they overlap; the
    // handful of centimetres that leaves showing at the animated plane's own
    // (already near-flat, per the falloff) edge is nowhere near enough to
    // read as a step at the distance and with the fog that edge sits behind.
    const maxWaveDepth = WATER_WAVES.reduce((sum, w) => sum + w.amplitude, 0);
    horizon.position.y = floor.position.y - maxWaveDepth - 2;
    horizon.material = floorMaterial;
    horizon.receiveShadows = false;
    horizon.isPickable = false;
    this.decor.push(horizon);

    // Fog, colour-matched to the sky's own horizon band, fading in well
    // short of the camera's 4000cm draw distance. Belt and braces alongside
    // the horizon plane above: it hides the far plane's own silhouette
    // against the sky (a dead flat edge reads as a horizon line even when
    // its colour matches), and it sells depth on anything else seen at
    // range, which a scene this size otherwise never has.
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogColor = this.theme.sky.horizon;
    this.scene.fogStart = 900;
    this.scene.fogEnd = 3200;

    // Purely for the look of it — see `buildBoat`'s own comment for why.
    this.boats = BOAT_FLEET.map((config) => buildBoat(this.scene, config.sails));
  }

  /**
   * Sails each toy boat slowly round its own circular path, riding the
   * current water height and slope at wherever it currently is rather than
   * floating dead flat through the swell.
   */
  private updateBoat(dt: number): void {
    if (this.boats.length === 0) return;
    this.boatTime += dt;
    const t = this.boatTime;

    for (let i = 0; i < this.boats.length; i++) {
      const boat = this.boats[i];
      const config = BOAT_FLEET[i];
      const angle = config.phase + t * config.angularSpeed;
      const x = Math.cos(angle) * config.orbitRadius;
      const z = Math.sin(angle) * config.orbitRadius;
      // Tangent to the circle — the direction of travel, for heading.
      const heading = new Vector3(-Math.sin(angle), 0, Math.cos(angle));
      const right = new Vector3(heading.z, 0, -heading.x);

      // Sampled at the hull's own bow/stern/port/starboard rather than once
      // at its centre: the waves are short enough relative to the hull now
      // that a single point can sit in a trough while the actual surface
      // right under the bow or a gunwale is a crest, and the rigid hull
      // would then render buried in water that, at its own single sample
      // point, claims to be lower than it is.
      const halfLength = HULL_LENGTH / 2;
      const halfBeam = HULL_BEAM / 2;
      const bowH = waterHeight(x + heading.x * halfLength, z + heading.z * halfLength, t);
      const sternH = waterHeight(x - heading.x * halfLength, z - heading.z * halfLength, t);
      const starboardH = waterHeight(x + right.x * halfBeam, z + right.z * halfBeam, t);
      const portH = waterHeight(x - right.x * halfBeam, z - right.z * halfBeam, t);
      const centreH = (bowH + sternH + starboardH + portH) / 4;
      const y = this.waterBaseY + centreH + BOAT_FREEBOARD;

      // The local gradient rebuilt from those same four points (a
      // directional derivative along heading and along right, which
      // together span the horizontal plane) rather than from
      // `waterSlope`'s single-point derivative — consistent with the
      // height sample above, and averaged over the hull's own footprint
      // instead of one instant of the curve.
      let dx = ((bowH - sternH) / HULL_LENGTH) * heading.x + ((starboardH - portH) / HULL_BEAM) * right.x;
      let dz = ((bowH - sternH) / HULL_LENGTH) * heading.z + ((starboardH - portH) / HULL_BEAM) * right.z;
      // The waves are sized against the boat's own length, not against a
      // real lake's, so their slope at a single sampled point can run
      // steep enough — several waves' worth of tilt stacking at once — to
      // pitch the boat onto its nose rather than rock it. Capping the tilt
      // this produces (not the height displacement itself, which is what
      // actually sells the waves) keeps the boat looking like it's riding
      // a chop instead of diving into it.
      const slope = Math.hypot(dx, dz);
      if (slope > BOAT_MAX_TILT_SLOPE) {
        const damp = BOAT_MAX_TILT_SLOPE / slope;
        dx *= damp;
        dz *= damp;
      }
      const up = new Vector3(-dx, 1, -dz).normalize();

      boat.root.position.set(x, y, z);
      boat.root.rotationQuaternion = boatOrientation(heading, up);
    }
  }

  /**
   * Displaces the water plane's vertices into a gentle swell each frame.
   *
   * Height and slope both come from the same closed-form sine sum
   * (`waterHeight` / `waterSlope`), so the normal is exact rather than
   * approximated from face averages afterwards — cheaper, and it keeps the
   * surface smoothly shaded at this subdivision instead of needing a denser
   * mesh to hide faceting.
   */
  private updateWater(dt: number): void {
    const mesh = this.waterMesh;
    if (!mesh) return;
    this.waterTime += dt;
    const t = this.waterTime;

    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
    if (!positions || !normals) return;

    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const z = positions[i + 2];
      positions[i + 1] = waterHeight(x, z, t);
      const [dx, dz] = waterSlope(x, z, t);
      const len = Math.hypot(dx, 1, dz);
      normals[i] = -dx / len;
      normals[i + 1] = 1 / len;
      normals[i + 2] = -dz / len;
    }

    // `true` here recomputes the mesh's bounding info from the new positions;
    // without it, the culler and anything else that reads the bounds keeps
    // using the box CreateGround built for a flat plane.
    mesh.updateVerticesData(VertexBuffer.PositionKind, positions, true);
    mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
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
   * Starts the countdown, camera already framed on the grid.
   *
   * This used to run a flythrough of the whole track first — sweep out,
   * sweep back — before the countdown began. It ran before every race,
   * including rematches on the same track already seen once, and added a
   * couple of seconds each time for a look that was over before it landed.
   */
  startCountdown(seconds = 3): void {
    if (!this.headless) {
      const { eye, look } = this.camera.gridFraming();
      this.camera.snapTo(eye, look);
    }
    this.race.beginCountdown(seconds);
  }

  /**
   * Toggles the whole race — physics, camera, clock — frozen or running.
   *
   * Skipping the render loop's body entirely rather than, say, zeroing the
   * physics timestep: nothing here has any per-frame state that needs to keep
   * ticking while paused (the stuck watchdog and the gate animation both work
   * in elapsed real time, which simply stops accumulating), and it means a
   * paused frame costs nothing beyond whatever the browser spends idling a
   * requestAnimationFrame loop.
   */
  togglePause(): boolean {
    this.paused = !this.paused;
    return this.paused;
  }

  /** Kicks off the render loop. */
  run(onFrame?: (dt: number) => void): void {
    if (this.running) return;
    this.running = true;
    this.engine.runRenderLoop(() => {
      if (this.paused) return;
      const dt = Math.min(0.1, this.engine.getDeltaTime() / 1000);

      if (this.race.state === "countdown") {
        // Hold the grid shot so the flag drops on a settled camera.
        const { eye, look } = this.camera.gridFraming();
        this.camera.snapTo(eye, look);
      } else if (this.race.state === "finished") {
        this.camera.finishShot(dt);
      } else if (this.race.state === "racing") {
        this.camera.update(this.race, dt);
      }

      this.checkStuck(dt);
      this.animateGate(dt);
      this.updateWater(dt);
      this.updateBoat(dt);
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

  /**
   * Watches for a scene that is running but cannot draw.
   *
   * The track is the one mesh guaranteed to be in shot for the whole race, so
   * its readiness stands in for the scene's. In a healthy build it reports
   * ready about 170ms after the world is created; five seconds is thirty times
   * that, far enough clear to never fire on a slow phone merely having a bad
   * moment.
   *
   * This exists because the failure it catches is silent — frames are drawn,
   * the loop is running, the UI is fine, and nothing appears. Recovering
   * automatically is worth it even without knowing the cause, since the
   * alternative a player has is reloading until it happens to work.
   */
  private checkStuck(dt: number): void {
    if (this.stuckSettled) return;
    this.stuckElapsed += dt;
    if (this.trackMeshes.shell.isReady(true)) {
      this.stuckSettled = true;
      return;
    }
    if (this.stuckElapsed < STUCK_SECONDS) return;
    this.stuckSettled = true;
    this.onStuck?.();
  }

  private observeCanvasSize(): void {
    const canvas = this.engine.getRenderingCanvas();
    if (!canvas || typeof ResizeObserver === "undefined") return;
    this.canvasObserver = new ResizeObserver(() => this.handleResize());
    this.canvasObserver.observe(canvas);
  }

  /**
   * Lifts the bar once the flag has dropped.
   *
   * Purely visual — the collider is already gone by the time this runs, so how
   * fast the bar travels cannot affect the race. Quick, because the marbles are
   * pressed against it and a bar that lingers looks like it is being dragged
   * through them.
   */
  private animateGate(dt: number): void {
    if (!this.startGate) return;
    const wantOpen = this.race.state === "racing" || this.race.state === "finished";
    const target = wantOpen ? 1 : 0;
    if (Math.abs(this.gateOpenAmount - target) < 0.001) return;
    this.gateOpenAmount += (target - this.gateOpenAmount) * Math.min(1, dt * 9);
    const frame = this.geometry.frameAt(GATE_INDEX_OFFSET + this.plan.startIndex);
    this.startGate.position = frame.position.add(
      frame.up.scale(GATE_BAR_HEIGHT / 2 + this.gateOpenAmount * GATE_LIFT),
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
    this.gateBody?.dispose();
    this.gateBody = null;
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
    this.waterMesh = null;
    for (const boat of this.boats) boat.dispose();
    this.boats = [];
    this.scene.dispose();
    this.engine.dispose();
  }
}
