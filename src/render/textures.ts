import { Constants } from "@babylonjs/core/Engines/constants";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
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
 * A lacquered maple lane, like a bowling alley floor.
 *
 * Narrow boards laid along the run with dark seams between them, each cut from
 * a different part of the log so it carries its own tone and its own grain
 * offset. The grain within a board is close, straight and only slightly warped:
 * a lane is quarter sawn and sanded flat, which is a quite different surface
 * from the wandering rings of a flat-sawn plank.
 *
 * The boards run along V, which the track's UVs lay down the length of the run,
 * so they read as strips laid end to end rather than as a pattern stuck on top.
 */
export function woodDetail(scene: Scene): DetailMaps {
  return bake(scene, "wood", DETAIL_SIZE, (u, v) => {
    // Boards run the length of the run, so the seams between them are lines of
    // constant U. Seven across a 16cm tile makes each board about 2.3cm, which
    // puts roughly three of them across a standard 7.2cm channel floor.
    //
    // Sixteen was the first attempt and far too fine: a board narrower than a
    // marble reads as corduroy rather than as floorboards.
    const boards = 7;
    const along = u * boards;
    const board = Math.floor(along);
    const across = along - board;

    // Each board is cut from a different part of the log, so its grain is
    // offset and its tone shifted. Without this the lane reads as one printed
    // sheet rather than as strips laid side by side.
    const shift = hash2(board, 3.1);
    const boardTone = (hash2(board, 7.7) - 0.5) * 0.16;

    // Fine grain running lengthwise, barely warped. A bowling lane is quarter
    // sawn and sanded flat, so the lines are close, straight and even — quite
    // unlike the wandering rings of a flat-sawn board, which is what this
    // texture used to draw.
    const warp = fbm(u * 3, v * 0.5, 9, 3) * 0.25;
    const grain = Math.abs(Math.sin((across * 7 + shift * 12 + warp) * Math.PI));
    const fibre = fbm(u * 6, v * 0.3, 40, 2);

    // The seam itself: a dark line where two boards meet.
    const seam = Math.min(across, 1 - across);
    const inSeam = 1 - smoothstep(Math.min(1, seam / 0.035));

    // Relief is almost flat — the surface is lacquered — except at the seams,
    // which are the only thing that catches the light.
    const height = inSeam * 0.9 + grain * 0.06 + fibre * 0.04;
    const shade = 0.86 + boardTone + grain * 0.07 + fibre * 0.05 - inSeam * 0.5;
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

/**
 * How far a plain marble's tonal swirl shifts towards its accent, 0-1.
 *
 * Enough to read the spin at broadcast distance, little enough that the marble
 * still says one colour at a glance.
 */
const TONE_DEPTH = 0.26;

/**
 * How many marble finishes exist: plain glass, then two patterned variants.
 * See `marbleTexture`.
 */
export const MARBLE_PATTERNS = 3;

/**
 * The face of a marble: a base colour carrying a pattern in a contrasting
 * accent.
 *
 * Two jobs. The first is that a plain coloured sphere is the most toy-like
 * thing in the scene, and a uniform sphere looks motionless however fast it is
 * actually rolling — it is the markings turning that make the roll readable.
 *
 * The second matters more with a big field. Colour alone is one axis and it
 * runs out: there are nine colours that stay at least ΔE 25 apart, and past
 * that the wheel has nothing left to give. Rather than squeeze a tenth
 * indistinguishable hue out of it, the colours come round again wearing a
 * pattern, which is a second axis and a much cheaper one. Fields of nine or
 * fewer — nearly all of them — are plain glass throughout.
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
        default:
          // Plain glass. Most fields never get past the solid colours, so this
          // is the common case and it is deliberately unmarked.
          break;
      }

      // A broad tonal swirl under everything, in the marble's own colour
      // rather than its accent — a shade of red on red, not white on red.
      //
      // This is what makes a plain marble's roll readable. A uniform sphere
      // looks motionless however fast it is actually turning, and the solid
      // colours are most of the field, so without this most of the race has no
      // visible spin at all. It has to stay tonal: pushed up into real contrast
      // it reads as a third pattern and undoes the distinction between the
      // plain marbles and the marked ones.
      const swirl = Math.abs(Math.sin(u * Math.PI * 2 + phase * 0.7 + v * 1.6));
      const tone = smoothstep(Math.max(0, Math.min(1, (swirl - 0.2) / 0.55))) * TONE_DEPTH;

      // Blending towards the accent gets the direction right for free: pale
      // marbles darken, dark ones lighten, so the black and white ones are not
      // left as the two that still look static.
      const shade = mark + (1 - mark) * tone;

      // A little mottle everywhere, so the glass has depth rather than reading
      // as painted plastic.
      const cloud = fbm(u, v, 6, 3) * 0.16 + 0.92;
      const r = (base.r * (1 - shade) + accent.r * shade) * cloud;
      const g = (base.g * (1 - shade) + accent.g * shade) * cloud;
      const b = (base.b * (1 - shade) + accent.b * shade) * cloud;

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

/**
 * "START" on a diagonal racing-stripe banner, for the crossbar of the start
 * gate.
 *
 * The gate used to wear the same chequered flag as the finish, which reads
 * wrong at that end of the track — chequer means "the race is over" wherever
 * it appears on a real course, not "line up here". This says what it is
 * instead: bold text over the diagonal stripes a rally start banner actually
 * uses, in the theme's own gate colour so it still belongs to the rest of the
 * apparatus.
 *
 * The word sits in the top portion rather than centred on the bar. The bar
 * itself is now taller than the field waiting against it — see
 * `GATE_BAR_HEIGHT` in world.ts — precisely so the grid's own heads cover only
 * the lower part of it and the word stays clear above them.
 *
 * Drawn on a real 2D canvas rather than baked pixel by pixel like the rest of
 * this file's textures — those are all repeating surface detail with no
 * layout to speak of, where a formula is simpler than an image. Text has
 * glyphs, and a canvas already knows how to set them.
 */
export function startBannerTexture(
  scene: Scene,
  faceWidth: number,
  faceHeight: number,
  accent: Color3,
): DynamicTexture {
  const height = 256;
  // Sized to the face's own proportions rather than a fixed square, or the
  // banner's aspect ratio would fight the mesh's and either the stripes or
  // the text would come out stretched. Capped well under the platform's
  // texture size ceiling even at the widest gate this ever draws for.
  const width = Math.max(256, Math.min(2048, Math.round((height * faceWidth) / faceHeight)));

  const texture = new DynamicTexture("start-banner", { width, height }, scene, true);
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.hasAlpha = false;

  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const dark = accent.scale(0.55);
  const light = new Color3();
  accent.scale(1.25).clampToRef(0, 1, light);

  // Diagonal stripes, alternating the theme's gate colour with white — the
  // same device an actual start banner uses so the eye reads "line forms
  // here" before it reads the word.
  const stripe = height * 0.62;
  ctx.save();
  ctx.fillStyle = "#f4f4f4";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = dark.toHexString();
  const diagonal = Math.max(width, height) * 2;
  for (let x = -diagonal; x < diagonal; x += stripe * 2) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + stripe, 0);
    ctx.lineTo(x + stripe - height, height);
    ctx.lineTo(x - height, height);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Text sits high in the top portion, clear of where the queued field's own
  // heads reach — see the function comment above. Pulled close to the top
  // edge rather than centred on the top half, which is what leaves room for
  // as big a word as fits above the marbles.
  const textY = height * 0.19;

  // A soft highlight behind the text, so it sits on its own patch of light
  // rather than straddling a stripe seam wherever the layout happens to land.
  const gradient = ctx.createRadialGradient(width / 2, textY, 0, width / 2, textY, width * 0.32);
  gradient.addColorStop(0, "rgba(255,255,255,0.85)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `900 ${Math.round(height * 0.42)}px Arial, sans-serif`;
  ctx.lineJoin = "round";
  ctx.lineWidth = height * 0.06;
  ctx.strokeStyle = "#1a1a1a";
  ctx.strokeText("START", width / 2, textY);
  ctx.fillStyle = light.toHexString();
  ctx.fillText("START", width / 2, textY);

  // DynamicTexture's canvas has row 0 at the top, but a texture's V=0 is
  // conventionally its bottom — `update()` inverts on upload by default to
  // reconcile the two. An earlier version passed `false` here and turned the
  // banner upside down; leaving the argument off takes the default.
  texture.update();
  return texture;
}
