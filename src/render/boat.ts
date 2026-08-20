import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { ExtrudeShapeCustom } from "@babylonjs/core/Meshes/Builders/shapeBuilder";
import type { Scene } from "@babylonjs/core/scene";
import { createSurface } from "./materials";

/**
 * A small toy sailboat, drifting across the water.
 *
 * Purely decorative — no physics body, and nothing about a race can be
 * affected by it. Exists because a still, empty sheet of water reads as flat
 * no matter how much ripple it carries; one small moving thing gives the eye
 * somewhere to follow and sells the idea that the water is really there
 * rather than a backdrop painted in underneath the track.
 *
 * Modelled after the wooden toy sailboats it's standing in for: an open
 * hollow hull rather than a solid block, one mast, two triangular sails in
 * contrasting colours, and a bead at the masthead.
 */

/** Overall length of the hull, in cm — small against the track, big against a marble. */
export const HULL_LENGTH = 16;
export const HULL_BEAM = 6;
const HULL_DEPTH = 2.4;

const HULL_COLOUR = Color3.FromHexString("#d8c39a");
const MAST_COLOUR = Color3.FromHexString("#8a6a45");
const MAIN_SAIL_COLOUR = Color3.FromHexString("#e8703a");
const JIB_SAIL_COLOUR = Color3.FromHexString("#3fa77a");
const MASTHEAD_COLOUR = Color3.FromHexString("#d4453f");

export interface Boat {
  /** Root transform: move and rotate this to pose the whole boat. */
  root: TransformNode;
  dispose(): void;
}

/** A flat, double-sided triangular sail. */
function createSail(name: string, base: number, height: number, colour: Color3, scene: Scene): Mesh {
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  // Tack at the mast base, head at the masthead, clew out at the boom. The
  // triangle lies in the mast's own vertical plane (X held at 0 throughout)
  // rather than flat on the deck, so its face — and its normal — point out
  // to the side, which is the side the boat is meant to be seen from. Two
  // copies wound in opposite directions rather than a backface-culling
  // toggle, so it still shades correctly (with its own normal) when seen
  // from either beam instead of going flat and dark from one side.
  data.positions = [
    0, 0, 0, 0, height, 0, 0, 0, base,
    0, 0, 0, 0, 0, base, 0, height, 0,
  ];
  data.indices = [0, 1, 2, 3, 4, 5];
  data.normals = [
    -1, 0, 0, -1, 0, 0, -1, 0, 0,
    1, 0, 0, 1, 0, 0, 1, 0, 0,
  ];
  data.uvs = [0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1];
  data.applyToMesh(mesh);

  const material = createSurface(scene, `${name}-mat`, colour, {
    metallic: 0.0,
    roughness: 0.6,
  });
  mesh.material = material;
  mesh.isPickable = false;
  return mesh;
}

/** The hollow hull: an open, boat-shaped shell, wide amidships and pointed at the bow. */
function createHull(scene: Scene): Mesh {
  const halfBeam = HULL_BEAM / 2;

  // Half-round cross-section, open along the top edge (no segment closes it
  // back from the right gunwale to the left) — a solid, closed profile would
  // extrude into a rod, not a boat you can see down into.
  const shape = [
    new Vector3(-halfBeam, 0, 0),
    new Vector3(-halfBeam * 0.92, -HULL_DEPTH * 0.5, 0),
    new Vector3(-halfBeam * 0.4, -HULL_DEPTH, 0),
    new Vector3(0, -HULL_DEPTH * 1.08, 0),
    new Vector3(halfBeam * 0.4, -HULL_DEPTH, 0),
    new Vector3(halfBeam * 0.92, -HULL_DEPTH * 0.5, 0),
    new Vector3(halfBeam, 0, 0),
  ];

  const half = HULL_LENGTH / 2;
  const path = [-half, -half * 0.55, 0, half * 0.5, half * 0.82, half].map(
    (z) => new Vector3(0, 0, z),
  );
  // Close to full beam at the stern, tapering sharply only at the bow — real
  // hull proportions, not a symmetric lozenge pinched at both ends. Never
  // quite zero at the bow tip: a fully degenerate ring of coincident points
  // is exactly the kind of zero-area geometry that renders as a lit speck or
  // a stray normal on some GPUs.
  const scales = [0.85, 0.97, 1.0, 0.9, 0.55, 0.05];
  const hull = ExtrudeShapeCustom(
    "boat-hull",
    {
      shape,
      path,
      scaleFunction: (i) => scales[Math.min(i, scales.length - 1)],
      cap: Mesh.CAP_START,
      sideOrientation: Mesh.DOUBLESIDE,
      // The path runs straight along Z, so Path3D needs an explicit normal
      // to build a frame at all. ExtrudeShapeCustom places each shape point
      // at normal*x + binormal*y, and binormal = cross(tangent, normal) —
      // with tangent along Z, a normal of (0,1,0) makes the binormal
      // (-1,0,0), which swaps the shape's beam (its x) onto world Y and its
      // depth (its y) onto world X: the hull built lying on its side. A
      // normal of (1,0,0) gives binormal (0,1,0), the mapping the shape was
      // actually authored for (x = beam, y = depth, keel down).
      firstNormal: new Vector3(1, 0, 0),
    },
    scene,
  );
  hull.material = createSurface(scene, "boat-hull-mat", HULL_COLOUR, {
    // Low environment share, same reasoning as the track's own support legs:
    // a light, barely-reflective colour under a full share of a bright sky
    // washes out towards white rather than reading as painted wood.
    metallic: 0.0,
    roughness: 0.75,
    environmentIntensity: 0.3,
  });
  hull.isPickable = false;
  return hull;
}

export function buildBoat(scene: Scene): Boat {
  const root = new TransformNode("toy-boat", scene);

  const hull = createHull(scene);
  hull.parent = root;

  const mastHeight = 11;
  const mast = CreateCylinder(
    "boat-mast",
    { diameterTop: 0.25, diameterBottom: 0.45, height: mastHeight, tessellation: 8 },
    scene,
  );
  mast.material = createSurface(scene, "boat-mast-mat", MAST_COLOUR, {
    metallic: 0.0,
    roughness: 0.7,
  });
  // Based at the deck (the hull's local y=0, its open top edge), not at the
  // keel — CreateCylinder centres on its own middle, so it needs lifting by
  // half its height to stand on the deck rather than growing through it.
  mast.position.y = mastHeight / 2;
  mast.isPickable = false;
  mast.parent = root;

  const masthead = CreateSphere("boat-masthead", { diameter: 0.9, segments: 8 }, scene);
  masthead.material = createSurface(scene, "boat-masthead-mat", MASTHEAD_COLOUR, {
    metallic: 0.0,
    roughness: 0.4,
  });
  masthead.position.y = mastHeight;
  masthead.isPickable = false;
  masthead.parent = root;

  // Main sail's boom swings aft, the smaller jib's swings forward — the
  // two-sail silhouette every reference for this had in common — and both
  // are fanned out a little from dead fore-and-aft, as if actually holding a
  // breath of wind rather than hanging limp against the mast.
  const main = createSail("boat-main-sail", 5.5, mastHeight * 0.82, MAIN_SAIL_COLOUR, scene);
  main.rotation.y = Math.PI + 0.16;
  main.position.set(0, 0.4, -0.05);
  main.parent = root;

  const jib = createSail("boat-jib-sail", 3.4, mastHeight * 0.6, JIB_SAIL_COLOUR, scene);
  jib.rotation.y = -0.22;
  jib.position.set(0, 0.4, 0.05);
  jib.parent = root;

  return {
    root,
    dispose() {
      for (const mesh of [hull, mast, masthead, main, jib]) {
        mesh.material?.dispose();
        mesh.dispose();
      }
      root.dispose();
    },
  };
}

/**
 * Builds the rotation that stands a boat upright and pointed the way it's
 * travelling, tilted by the water's own local slope so it looks like it's
 * actually riding the surface rather than floating dead level through it.
 */
export function boatOrientation(heading: Vector3, up: Vector3): Quaternion {
  const right = Vector3.Cross(up, heading).normalize();
  const trueHeading = Vector3.Cross(right, up).normalize();
  const m = Matrix.Identity();
  Matrix.FromXYZAxesToRef(right, up, trueHeading, m);
  return Quaternion.FromRotationMatrix(m);
}
