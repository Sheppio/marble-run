import { Constants } from "@babylonjs/core/Engines/constants";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";

/**
 * Procedurally generated textures.
 *
 * Every surface in the app is untextured flat colour without these, which is
 * what makes an otherwise well-lit scene read as a diagram. Real materials have
 * detail at a scale below the geometry — grain in timber, blades in grass, the
 * swirl inside a marble — and it is that detail, more than the polygon count,
 * that decides whether a render looks like an object or a shape.
 *
 * They are computed into raw pixel buffers at load rather than downloaded. The
 * whole app stays a single JS bundle with no image assets, which is the point:
 * on a phone connection an atlas of PBR maps would cost more than everything
 * else here combined. Generation runs once per race build and costs a few
 * milliseconds at these sizes.
 */

/** Detail maps tile heavily, so they can be small. */
const DETAIL_SIZE = 256;

/** How strongly generated normal maps perturb the surface. */
const NORMAL_STRENGTH = 2.4;

/** A surface's colour variation and its matching relief. */
export interface DetailMaps {
  albedo: RawTexture;
  normal: RawTexture;
}

// --- Noise -----------------------------------------------------------------

/** Deterministic hash → [0, 1). Same input always gives the same value. */
function hash2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise, tiling with period `period` so the texture wraps seamlessly. */
function valueNoise(x: number, y: number, period: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  // Wrapping the lattice coordinates is what makes the result tileable; without
  // it every texture shows a visible seam where it repeats.
  const wrap = (v: number) => ((v % period) + period) % period;
  const x0 = wrap(xi);
  const y0 = wrap(yi);
  const x1 = wrap(xi + 1);
  const y1 = wrap(yi + 1);

  const u = smoothstep(xf);
  const v = smoothstep(yf);

  const a = hash2(x0, y0);
  const b = hash2(x1, y0);
  const c = hash2(x0, y1);
  const d = hash2(x1, y1);

  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Sum of octaves. `scale` is the period of the first octave, in texels. */
function fbm(x: number, y: number, scale: number, octaves: number): number {
  let total = 0;
  let amplitude = 1;
  let sum = 0;
  let period = scale;
  for (let o = 0; o < octaves; o++) {
    total += valueNoise(x * period, y * period, period) * amplitude;
    sum += amplitude;
    amplitude *= 0.5;
    period *= 2;
  }
  return total / sum;
}

// --- Baking ----------------------------------------------------------------

/**
 * A height field, sampled in [0, 1]² and returning height plus a brightness
 * multiplier for that point.
 */
type Field = (u: number, v: number) => { height: number; shade: number };

function bake(scene: Scene, name: string, size: number, field: Field): DetailMaps {
  const albedoData = new Uint8Array(size * size * 4);
  const normalData = new Uint8Array(size * size * 4);
  const heights = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const { height, shade } = field(x / size, y / size);
      const i = y * size + x;
      heights[i] = height;
      const s = Math.max(0, Math.min(1, shade));
      const byte = Math.round(s * 255);
      albedoData[i * 4] = byte;
      albedoData[i * 4 + 1] = byte;
      albedoData[i * 4 + 2] = byte;
      albedoData[i * 4 + 3] = 255;
    }
  }

  // Central differences on the baked height field, wrapping at the edges so the
  // relief tiles as seamlessly as the colour does.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const left = heights[y * size + ((x - 1 + size) % size)];
      const right = heights[y * size + ((x + 1) % size)];
      const up = heights[((y - 1 + size) % size) * size + x];
      const down = heights[((y + 1) % size) * size + x];

      const dx = (right - left) * NORMAL_STRENGTH;
      const dy = (down - up) * NORMAL_STRENGTH;
      const length = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      normalData[i] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
      normalData[i + 1] = Math.round(((-dy / length) * 0.5 + 0.5) * 255);
      normalData[i + 2] = Math.round((1 / length) * 0.5 * 255 + 127.5);
      normalData[i + 3] = 255;
    }
  }

  const albedo = raw(scene, `${name}-albedo`, albedoData, size);
  const normal = raw(scene, `${name}-normal`, normalData, size);
  return { albedo, normal };
}

function raw(scene: Scene, name: string, data: Uint8Array, size: number): RawTexture {
  const texture = new RawTexture(
    data,
    size,
    size,
    Constants.TEXTUREFORMAT_RGBA,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  texture.name = name;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  // Visible at the grazing angles the broadcast camera uses. Held at 4 rather
  // than the usual 8 because the ground plane is enormous and tiled 64 times
  // across, so every extra sample there is paid over most of the screen.
  texture.anisotropicFilteringLevel = 4;
  return texture;
}

// --- Surfaces --------------------------------------------------------------

/**
 * Varnished timber.
 *
 * Grain runs along V, which the track's UVs lay out down the length of the
 * run, so the boards read as boards rather than as a pattern stuck on them. The
 * lines are a warped sine rather than noise alone: real grain is banded, and
 * pure noise reads as dirt.
 */
export function woodDetail(scene: Scene): DetailMaps {
  return bake(scene, "wood", DETAIL_SIZE, (u, v) => {
    // Warp the coordinate before banding it, which is what turns concentric
    // rings into the wandering lines you get from a flat-sawn board.
    const warp = fbm(u, v, 3, 4) * 0.8 + fbm(u, v, 11, 3) * 0.18;
    const rings = Math.sin((u * 6 + warp * 5) * Math.PI * 2) * 0.5 + 0.5;
    const grain = Math.pow(rings, 1.7);

    // Fine lengthwise fibres over the top of the banding.
    const fibre = fbm(u * 4, v * 0.35, 26, 2);

    // Relief is allowed a wide range because it only tilts the normal; colour
    // is kept to a narrow band around mid-grey. Tuned by eye from renders: a
    // wide colour range gave sharply banded zebra stripes rather than timber,
    // since the vertex colours it multiplies are already carrying the contrast
    // between floor, wall and stripe.
    const height = grain * 0.6 + fibre * 0.4;
    const shade = 0.76 + grain * 0.2 + fibre * 0.1;
    return { height, shade };
  });
}

/**
 * Moulded plastic, for the cartoon theme: no grain, just the faint orange-peel
 * of an injection moulding so the surface is not perfectly dead flat.
 */
export function plasticDetail(scene: Scene): DetailMaps {
  return bake(scene, "plastic", DETAIL_SIZE, (u, v) => {
    const peel = fbm(u, v, 14, 3);
    return { height: peel * 0.35, shade: 0.86 + peel * 0.16 };
  });
}

/**
 * Brushed dark panel with a lit grid, for the neon theme.
 *
 * The grid is what gives a near-black deck any sense of speed at all — without
 * it the marbles appear to hover over nothing.
 */
export function panelDetail(scene: Scene): DetailMaps {
  return bake(scene, "panel", DETAIL_SIZE, (u, v) => {
    const lineU = Math.min(fract(u * 4), 1 - fract(u * 4));
    const lineV = Math.min(fract(v * 4), 1 - fract(v * 4));
    const grid = Math.max(step(lineU, 0.02), step(lineV, 0.02));
    const brush = fbm(u * 0.2, v * 6, 30, 2);
    const height = grid * 0.5 + brush * 0.15;
    return { height, shade: 0.5 + grid * 0.45 + brush * 0.12 };
  });
}

/**
 * Mown grass.
 *
 * The ground plane fills most of the frame from the broadcast camera, so a
 * single flat green is the largest untextured area in the scene and the thing
 * that most makes it look unfinished. Two scales of noise: blades, and the
 * broad patchiness of a real lawn.
 */
export function grassDetail(scene: Scene): DetailMaps {
  return bake(scene, "grass", DETAIL_SIZE, (u, v) => {
    const blades = fbm(u, v, 48, 3);
    const patches = fbm(u, v, 4, 3);
    // Mower stripes. A lawn with none reads as moss; these give the ground a
    // sense of scale and direction, which is most of what stops it looking
    // like a flat green backdrop behind the run.
    const mown = Math.sin(v * Math.PI * 2 * 2) * 0.5 + 0.5;
    const height = blades * 0.85 + patches * 0.15;
    return { height, shade: 0.42 + blades * 0.42 + patches * 0.22 + mown * 0.1 };
  });
}

function fract(x: number): number {
  return x - Math.floor(x);
}

function step(value: number, edge: number): number {
  return value < edge ? 1 : 0;
}

/** How many distinct marble patterns exist. See `marbleTexture`. */
export const MARBLE_PATTERNS = 4;

/**
 * The face of a marble: a base colour carrying a pattern in a contrasting
 * accent.
 *
 * Two jobs. The first is that a plain coloured sphere is the most toy-like
 * thing in the scene, and a uniform sphere looks motionless however fast it is
 * actually rolling — it is the markings turning that make the roll readable.
 *
 * The second matters more with a big field. Colour alone is one axis, and a
 * dozen marbles drawn from one wheel are only 30° of hue apart, which is not
 * enough to tell two greens apart on a phone at the distance the broadcast
 * camera sits. Giving each marble a pattern as well as a hue makes identity
 * two-dimensional: neighbours in the palette always differ in pattern, so two
 * similar colours are still separable at a glance.
 *
 * The base stays the dominant colour so the marble still matches its swatch on
 * the scoreboard; the accent only marks it.
 */
export function marbleTexture(
  scene: Scene,
  id: number,
  base: Color3,
  pattern: number,
): RawTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);

  // White on anything dark, near-black on the pale ones — otherwise the
  // markings on the white marble are invisible and it reads as a blank sphere.
  const luminance = base.r * 0.2126 + base.g * 0.7152 + base.b * 0.0722;
  const accent =
    luminance > 0.55 ? new Color3(0.09, 0.09, 0.13) : new Color3(0.97, 0.97, 1);

  const kind = ((pattern % MARBLE_PATTERNS) + MARBLE_PATTERNS) % MARBLE_PATTERNS;
  // Rotates each marble's markings so two with the same pattern still differ.
  const phase = (id * 2.399) % (Math.PI * 2);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;

      let mark = 0;
      switch (kind) {
        case 0: {
          // Cane swirl: two ribbons twisting from pole to pole.
          const twist = Math.sin(u * Math.PI * 4 + phase + v * 2.2);
          mark = smoothstep(Math.max(0, Math.min(1, (Math.abs(twist) - 0.6) / 0.25)));
          break;
        }
        case 1: {
          // Banded, like a beach ball: stripes of latitude.
          const band = Math.sin((v + phase * 0.1) * Math.PI * 5);
          mark = smoothstep(Math.max(0, Math.min(1, (Math.abs(band) - 0.55) / 0.2)));
          break;
        }
        case 2: {
          // Spotted. Distance to the nearest cell centre in a coarse grid,
          // jittered so the dots do not line up into rows.
          const cells = 5;
          const cx = Math.floor(u * cells);
          const cy = Math.floor(v * cells);
          const jitterX = hash2(cx + phase, cy) * 0.5 + 0.25;
          const jitterY = hash2(cy, cx + phase) * 0.5 + 0.25;
          const dx = (u * cells - cx - jitterX) / cells;
          // Latitude is squeezed near the poles on a sphere; without this the
          // dots stretch into ovals top and bottom.
          const dy = ((v * cells - cy - jitterY) / cells) * 0.6;
          mark = Math.hypot(dx, dy) < 0.085 ? 1 : 0;
          break;
        }
        default: {
          // Segmented, like a beach ball. Narrow stripes rather than equal
          // halves: at 50% coverage the accent became the marble's dominant
          // colour and every segmented one read as white, which breaks the
          // match to its swatch on the scoreboard.
          const segment = u * 6 + phase;
          mark = segment - Math.floor(segment) < 0.36 ? 1 : 0;
          break;
        }
      }

      // A little mottle everywhere, so the glass has depth rather than reading
      // as painted plastic.
      const cloud = fbm(u, v, 6, 3) * 0.16 + 0.92;
      const r = (base.r * (1 - mark) + accent.r * mark) * cloud;
      const g = (base.g * (1 - mark) + accent.g * mark) * cloud;
      const b = (base.b * (1 - mark) + accent.b * mark) * cloud;

      const i = (y * size + x) * 4;
      data[i] = Math.round(Math.max(0, Math.min(1, r)) * 255);
      data[i + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
      data[i + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
      data[i + 3] = 255;
    }
  }

  return raw(scene, `marble-${id}`, data, size);
}

/**
 * A chequered flag, for the finish gantry and the line on the deck.
 *
 * Returned as a colour map rather than a greyscale detail map, because unlike
 * grain or grass this is meant to override the surface's colour entirely.
 *
 * Two squares by default — the smallest repeating unit of a chequer — because
 * the number of cells that end up on a face is set by tiling it with
 * `fitChequer`, not by the resolution of the texture.
 */
export function chequerTexture(scene: Scene, squares = 2): RawTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  const cell = size / squares;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dark = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      // Not pure black: a flat 0 reads as a hole punched in the banner once the
      // scene's own light falls on it.
      const value = dark ? 26 : 245;
      const i = (y * size + x) * 4;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }

  return raw(scene, "chequer", data, size);
}

/**
 * Tiles a chequer so its cells come out square on a face of `width` x `height`
 * world units.
 *
 * A box gives every face the same 0..1 UV square regardless of its proportions,
 * so a texture laid on the finish banner — twenty centimetres wide and two
 * high — arrives stretched about ten to one, and the chequer reads as stripes.
 * Repeats are rounded to whole numbers so the pattern still wraps without a cut
 * cell at the seam, which leaves the cells within a few percent of square
 * rather than exactly square. That is far below what the eye picks up; a
 * visible seam is not.
 */
export function fitChequer(
  texture: RawTexture,
  width: number,
  height: number,
  targetCell: number,
  options: { swapAxes?: boolean; squares?: number } = {},
): void {
  const squares = options.squares ?? 2;
  const rows = Math.max(1, Math.round(height / (squares * targetCell)));
  const cell = height / (squares * rows);
  const columns = Math.max(1, Math.round(width / (squares * cell)));
  // A box's upright faces run U across their width and V up their height, but
  // its top face runs U along the depth and V along the width — a quarter turn
  // from the others. Determined by rendering it: fitted the same way as the
  // banner, the strip on the deck came out as fine lines along the track
  // instead of squares across it.
  if (options.swapAxes) {
    texture.uScale = rows;
    texture.vScale = columns;
  } else {
    texture.uScale = columns;
    texture.vScale = rows;
  }
}
