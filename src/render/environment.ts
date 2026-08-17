import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { RawCubeTexture } from "@babylonjs/core/Materials/Textures/rawCubeTexture";
import { BackgroundMaterial } from "@babylonjs/core/Materials/Background/backgroundMaterial";
import { Constants } from "@babylonjs/core/Engines/constants";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import type { Scene } from "@babylonjs/core/scene";

/**
 * Sky, lighting and reflections.
 *
 * The environment is generated rather than loaded: a gradient sky is baked
 * into a small cube texture at runtime and used both as the visible backdrop
 * and as the reflection source for the marbles. That keeps the whole app to
 * code with no binary assets to download on a phone connection, and the
 * marbles still pick up a believable sky reflection.
 */

export interface SkyPalette {
  zenith: Color3;
  horizon: Color3;
  ground: Color3;
  sun: Color3;
  /** Cloud cover, 0–1. Omit for a clear sky. */
  clouds?: number;
}

export const DEFAULT_SKY: SkyPalette = {
  zenith: Color3.FromHexString("#1b2b5c"),
  horizon: Color3.FromHexString("#79a7d8"),
  ground: Color3.FromHexString("#141a2a"),
  sun: Color3.FromHexString("#fff2d0"),
};

/**
 * Half-width the shadow frustum starts at, in cm, before the run is measured.
 *
 * Only ever used for the frame or two between the light being created and the
 * track handing over its actual bounds.
 */
const SHADOW_EXTENT = 110;
/** Never open the frustum tighter than this, however small the run. */
const SHADOW_MIN_EXTENT = 60;

/** Direction the key light comes from. */
const SUN_DIRECTION = new Vector3(-0.45, -1, 0.35).normalize();

/** Tiling value noise on the unit sphere, used for cloud cover. */
function cloudNoise(direction: Vector3, octaves: number): number {
  let total = 0;
  let amplitude = 1;
  let sum = 0;
  let frequency = 2.2;
  for (let o = 0; o < octaves; o++) {
    // Hashing the quantised direction gives a stable field over the sphere
    // without needing a UV parameterisation, so there is no pinching at the
    // poles the way a lat-long noise would give.
    const x = direction.x * frequency;
    const y = direction.y * frequency;
    const z = direction.z * frequency;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const fx = x - xi;
    const fy = y - yi;
    const fz = z - zi;
    const ease = (t: number) => t * t * (3 - 2 * t);
    const ex = ease(fx);
    const ey = ease(fy);
    const ez = ease(fz);

    const at = (ax: number, ay: number, az: number) => {
      const n = Math.sin(ax * 127.1 + ay * 311.7 + az * 74.7) * 43758.5453;
      return n - Math.floor(n);
    };
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const c00 = lerp(at(xi, yi, zi), at(xi + 1, yi, zi), ex);
    const c10 = lerp(at(xi, yi + 1, zi), at(xi + 1, yi + 1, zi), ex);
    const c01 = lerp(at(xi, yi, zi + 1), at(xi + 1, yi, zi + 1), ex);
    const c11 = lerp(at(xi, yi + 1, zi + 1), at(xi + 1, yi + 1, zi + 1), ex);
    total += lerp(lerp(c00, c10, ey), lerp(c01, c11, ey), ez) * amplitude;

    sum += amplitude;
    amplitude *= 0.5;
    frequency *= 2.1;
  }
  return total / sum;
}

function skyColor(direction: Vector3, palette: SkyPalette): Color3 {
  const y = direction.y;
  let color: Color3;
  if (y >= 0) {
    // Horizon fades into zenith; the exponent keeps the band near the horizon tight.
    const t = Math.pow(Math.min(1, y), 0.55);
    color = Color3.Lerp(palette.horizon, palette.zenith, t);
  } else {
    const t = Math.pow(Math.min(1, -y), 0.6);
    color = Color3.Lerp(palette.horizon, palette.ground, t);
  }

  // Cloud cover. The sky is both the backdrop and the reflection source, so
  // clouds do double duty: they stop the upper half of the frame being a flat
  // gradient, and they put structure into the highlight rolling across every
  // marble, which is most of what makes the glass read as glass.
  if (palette.clouds && y > 0) {
    const density = cloudNoise(direction, 4);
    // Fade out towards the horizon, where clouds would be edge-on anyway, and
    // sharpen the threshold so they read as distinct banks rather than haze.
    const band = Math.min(1, y * 3.2);
    const cover = Math.max(0, density - (1 - palette.clouds)) / Math.max(0.001, palette.clouds);
    const amount = Math.pow(cover, 1.6) * band;
    color = Color3.Lerp(color, new Color3(1, 1, 1), Math.min(0.92, amount));
  }

  // A soft sun disc and bloom around the key light direction.
  const toSun = Vector3.Dot(direction, SUN_DIRECTION.scale(-1));
  if (toSun > 0) {
    const glow = Math.pow(Math.max(0, toSun), 18) * 0.9 + Math.pow(Math.max(0, toSun), 3) * 0.16;
    color = color.add(palette.sun.scale(glow));
  }

  return color;
}

/** Direction vector for a texel on a given cube face. */
function faceDirection(face: number, u: number, v: number): Vector3 {
  // u, v in [-1, 1]. Face order matches WebGL: +X, -X, +Y, -Y, +Z, -Z.
  switch (face) {
    case 0:
      return new Vector3(1, -v, -u).normalize();
    case 1:
      return new Vector3(-1, -v, u).normalize();
    case 2:
      return new Vector3(u, 1, v).normalize();
    case 3:
      return new Vector3(u, -1, -v).normalize();
    case 4:
      return new Vector3(u, -v, 1).normalize();
    default:
      return new Vector3(-u, -v, -1).normalize();
  }
}

export function createSkyTexture(scene: Scene, palette: SkyPalette, size = 128): RawCubeTexture {
  const faces: Uint8Array[] = [];
  for (let face = 0; face < 6; face++) {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = ((x + 0.5) / size) * 2 - 1;
        const v = ((y + 0.5) / size) * 2 - 1;
        const color = skyColor(faceDirection(face, u, v), palette);
        const i = (y * size + x) * 4;
        data[i] = Math.min(255, Math.round(Math.sqrt(color.r) * 255));
        data[i + 1] = Math.min(255, Math.round(Math.sqrt(color.g) * 255));
        data[i + 2] = Math.min(255, Math.round(Math.sqrt(color.b) * 255));
        data[i + 3] = 255;
      }
    }
    faces.push(data);
  }

  const texture = new RawCubeTexture(
    scene,
    faces,
    size,
    Constants.TEXTUREFORMAT_RGBA,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    true,
    false,
    Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
  );
  texture.gammaSpace = true;
  return texture;
}

export interface WorldLighting {
  shadowGenerator: ShadowGenerator | null;
  sun: DirectionalLight;
  skybox: Mesh;
  /**
   * Parks the shadow frustum over the whole run, once. `min` and `max` are a
   * world-space bounding box around everything that should cast.
   */
  coverRun(min: Vector3, max: Vector3): void;
  dispose(): void;
}

export function createEnvironment(
  scene: Scene,
  palette: SkyPalette,
  options: {
    shadows: boolean;
    shadowMapSize: number;
    sunIntensity: number;
    ambientIntensity: number;
    environmentIntensity: number;
    shadowDarkness: number;
  },
): WorldLighting {
  const skyTexture = createSkyTexture(scene, palette);
  scene.environmentTexture = skyTexture;
  scene.environmentIntensity = options.environmentIntensity;

  // A big inverted sphere textured with the same sky, so backdrop and
  // reflections always agree.
  const skybox = CreateSphere("skybox", { diameter: 6000, segments: 12, sideOrientation: Mesh.BACKSIDE }, scene);
  const skyMaterial = new BackgroundMaterial("sky-mat", scene);
  skyMaterial.reflectionTexture = skyTexture.clone();
  skyMaterial.reflectionTexture!.coordinatesMode = Constants.TEXTURE_SKYBOX_MODE;
  skyMaterial.useRGBColor = false;
  skyMaterial.enableNoise = true;
  skybox.material = skyMaterial;
  skybox.infiniteDistance = true;
  skybox.isPickable = false;
  skybox.applyFog = false;

  const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
  ambient.intensity = options.ambientIntensity;
  ambient.diffuse = palette.horizon;
  ambient.groundColor = palette.ground;

  const sun = new DirectionalLight("sun", SUN_DIRECTION.clone(), scene);
  sun.intensity = options.sunIntensity;
  sun.diffuse = palette.sun;
  // Fixed extents, set once from the run's own bounds — see `coverRun`.
  // Babylon's automatic fit would size the frustum to the whole scene, and the
  // scene includes a ground plane many times the size of the track, which
  // spreads even a 2048 map so thin that the shadow becomes a shapeless blur.
  sun.autoUpdateExtends = false;
  sun.orthoLeft = -SHADOW_EXTENT;
  sun.orthoRight = SHADOW_EXTENT;
  sun.orthoBottom = -SHADOW_EXTENT;
  sun.orthoTop = SHADOW_EXTENT;
  sun.shadowMinZ = 5;
  sun.shadowMaxZ = 420;

  let shadowGenerator: ShadowGenerator | null = null;
  if (options.shadows) {
    shadowGenerator = new ShadowGenerator(options.shadowMapSize, sun);
    shadowGenerator.usePercentageCloserFiltering = true;
    shadowGenerator.filteringQuality = ShadowGenerator.QUALITY_LOW;
    shadowGenerator.bias = 0.0008;
    shadowGenerator.normalBias = 0.25;
    shadowGenerator.darkness = options.shadowDarkness;
    // Fade shadows out as they approach the edge of the shadow frustum.
    //
    // Babylon does not bounds-check the shadow lookup, so ground beyond the
    // frustum samples the map's clamped edge texels and comes out shadowed —
    // which paints large hard-edged blocks across the lawn wherever the camera
    // can see further than the map reaches. Fading to unshadowed at the
    // boundary removes them, and it also hides the seam where real shadows
    // stop.
    //
    // Kept small on purpose. Babylon ramps this from the centre of the
    // frustum outwards, so at 1.0 it fades nearly every shadow in the scene
    // rather than just the ones at the boundary — which looked like shadows
    // had been switched off altogether.
    shadowGenerator.frustumEdgeFalloff = 0.12;
    // Every other frame. The whole run is in the caster list, so this is the
    // most expensive draw in the scene, and both the camera and the light it
    // follows move slowly enough that a one-frame-old shadow map is not
    // detectable. Measured at roughly a third off total frame time.
    const shadowMap = shadowGenerator.getShadowMap();
    if (shadowMap) shadowMap.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYTWOFRAMES;
  }

  return {
    shadowGenerator,
    sun,
    skybox,
    coverRun(min: Vector3, max: Vector3) {
      // Set once, and then left alone for the rest of the race.
      //
      // This used to follow the camera, resized each frame to roughly what the
      // camera could see. That kept the map dense, but it meant the set of
      // things casting a shadow changed as the camera moved: track outside the
      // frustum cast nothing, and the moment it crossed the boundary it started
      // to. Following a marble down the run, the effect was a shadow being
      // painted onto the ground just ahead of the camera, over and over, for
      // the length of the track.
      //
      // A frustum big enough for the whole run has no boundary to cross, so
      // every part of it casts from the first frame to the last. The cost is
      // resolution, and a run is 5-7 metres across its footprint, so the fit
      // has to be a tight one.
      //
      // Hence the box rather than a bounding sphere. The frustum is
      // axis-aligned in *light* space, not world space, so the honest way to
      // fit it is to put the run's eight corners into light space and take
      // their extents there. A sphere avoids needing that basis but pays for it
      // everywhere: on a typical run it came out about a third wider than the
      // box on both axes, which is a third of the shadow's sharpness given away
      // for nothing.
      const centre = min.add(max).scale(0.5);
      const span = max.subtract(min).length();
      // Babylon builds the light's view matrix with LookAtLH and world up, so
      // the basis has to be derived the same way or the extents are fitted to
      // the wrong axes.
      const forward = SUN_DIRECTION;
      const right = Vector3.Cross(Vector3.Up(), forward).normalize();
      const up = Vector3.Cross(forward, right).normalize();

      // Far enough up-sun that the whole run sits in front of the near plane
      // whichever way it happens to lie.
      const eye = centre.subtract(forward.scale(span));
      sun.position.copyFrom(eye);

      let left = Infinity;
      let bottom = Infinity;
      let rightMost = -Infinity;
      let top = -Infinity;
      let near = Infinity;
      let far = -Infinity;
      for (let corner = 0; corner < 8; corner++) {
        const point = new Vector3(
          corner & 1 ? max.x : min.x,
          corner & 2 ? max.y : min.y,
          corner & 4 ? max.z : min.z,
        ).subtractInPlace(eye);
        const x = Vector3.Dot(point, right);
        const y = Vector3.Dot(point, up);
        const z = Vector3.Dot(point, forward);
        left = Math.min(left, x);
        rightMost = Math.max(rightMost, x);
        bottom = Math.min(bottom, y);
        top = Math.max(top, y);
        near = Math.min(near, z);
        far = Math.max(far, z);
      }

      // Babylon's frustum-edge falloff is measured from the centre of the
      // frustum, so a run sitting hard against one edge would have its shadows
      // faded. A little slack keeps everything clear of the boundary.
      const pad = Math.max(SHADOW_MIN_EXTENT * 0.15, span * 0.03);
      sun.orthoLeft = Math.min(-SHADOW_MIN_EXTENT, left - pad);
      sun.orthoRight = Math.max(SHADOW_MIN_EXTENT, rightMost + pad);
      sun.orthoBottom = Math.min(-SHADOW_MIN_EXTENT, bottom - pad);
      sun.orthoTop = Math.max(SHADOW_MIN_EXTENT, top + pad);
      sun.shadowMinZ = Math.max(1, near - pad);
      sun.shadowMaxZ = far + pad;
    },
    dispose() {
      shadowGenerator?.dispose();
      sun.dispose();
      ambient.dispose();
      skybox.material?.dispose();
      skybox.dispose();
      skyTexture.dispose();
    },
  };
}
