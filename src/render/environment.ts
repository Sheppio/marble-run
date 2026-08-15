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
}

export const DEFAULT_SKY: SkyPalette = {
  zenith: Color3.FromHexString("#1b2b5c"),
  horizon: Color3.FromHexString("#79a7d8"),
  ground: Color3.FromHexString("#141a2a"),
  sun: Color3.FromHexString("#fff2d0"),
};

/** Direction the key light comes from. */
const SUN_DIRECTION = new Vector3(-0.45, -1, 0.35).normalize();

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

export function createSkyTexture(scene: Scene, palette: SkyPalette, size = 64): RawCubeTexture {
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
  /** Keeps the shadow map centred on the action. */
  followShadows(target: Vector3): void;
  dispose(): void;
}

export function createEnvironment(
  scene: Scene,
  palette: SkyPalette,
  options: { shadows: boolean; shadowMapSize: number },
): WorldLighting {
  const skyTexture = createSkyTexture(scene, palette);
  scene.environmentTexture = skyTexture;
  scene.environmentIntensity = 1.0;

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
  ambient.intensity = 0.42;
  ambient.diffuse = palette.horizon;
  ambient.groundColor = palette.ground;

  const sun = new DirectionalLight("sun", SUN_DIRECTION.clone(), scene);
  sun.intensity = 2.8;
  sun.diffuse = palette.sun;
  sun.autoUpdateExtends = false;
  sun.shadowMinZ = 5;
  sun.shadowMaxZ = 420;

  let shadowGenerator: ShadowGenerator | null = null;
  if (options.shadows) {
    shadowGenerator = new ShadowGenerator(options.shadowMapSize, sun);
    shadowGenerator.usePercentageCloserFiltering = true;
    shadowGenerator.filteringQuality = ShadowGenerator.QUALITY_LOW;
    shadowGenerator.bias = 0.0015;
    shadowGenerator.normalBias = 0.4;
    shadowGenerator.darkness = 0.25;
  }

  return {
    shadowGenerator,
    sun,
    skybox,
    followShadows(target: Vector3) {
      // Park the light just up-sun of whatever we're watching so the shadow
      // frustum stays tight and the shadows stay crisp.
      sun.position.copyFrom(target.subtract(SUN_DIRECTION.scale(160)));
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
