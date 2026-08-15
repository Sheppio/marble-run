import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type { Scene } from "@babylonjs/core/scene";
import { TRACK_CONSTANTS } from "./plan";
import type { TrackGeometry } from "./geometry";
import { createTrackMaterial, type SurfaceOptions, type TimberPalette } from "../render/materials";

/**
 * Sweeps the channel cross-section along the centreline to produce one solid
 * shell mesh, which doubles as the static collision mesh.
 *
 * The cross-section is a rounded trough with vertical side walls. Inner and
 * outer surfaces are swept together and stitched into a closed solid — a
 * single-sided ribbon would let fast marbles clip straight through the floor.
 */

/** Chamfer at the floor-to-wall joint, in cm. */
const FLOOR_CHAMFER = 0.35;

interface Profile {
  /** Lateral offsets, metres from the channel centre. */
  x: number[];
  /** Heights above the channel floor, metres. */
  y: number[];
}

/**
 * The channel cross-section: a flat floor with a vertical wall up each side.
 *
 * Deliberately plain. Earlier versions rounded the floor and curled the top of
 * the walls inward, which contained marbles well but read as a tube rather
 * than a track, and the curved floor funnelled every marble into the middle so
 * the field never spread out. A flat bottom lets marbles run side by side and
 * makes the racing legible.
 *
 * `expand` offsets the section outward to produce the outer surface of the
 * shell, so the two sweep together into a solid.
 */
function buildProfile(halfWidth: number, wallHeight: number, expand: number): Profile {
  const w = halfWidth + expand;
  const floorY = -expand;
  // A small chamfer where the floor meets the wall. The floor still reads as
  // flat — this is under half a marble radius — but a hard 90° internal corner
  // grips a marble between its two faces and can hold it against a gradient
  // that would otherwise roll it away.
  const c = FLOOR_CHAMFER;

  // Left wall top, down the chamfer, across the floor, and up the right wall.
  return {
    x: [-w, -w, -w + c, w - c, w, w],
    y: [wallHeight, floorY + c, floorY, floorY, floorY + c, wallHeight],
  };
}

export interface TrackMeshes {
  shell: Mesh;
  aggregate: PhysicsAggregate;
  dispose(): void;
}

export function buildTrackMesh(
  scene: Scene,
  geometry: TrackGeometry,
  palette: TimberPalette,
  surface: SurfaceOptions,
): TrackMeshes {
  const { frames } = geometry;
  const { shellThickness } = TRACK_CONSTANTS;

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // Each ring is inner profile (left→right) followed by outer profile
  // (right→left), forming one closed loop around the cross-section.
  const inner = buildProfile(frames[0].width, frames[0].wallHeight, 0);
  const profileCount = inner.x.length;
  const ringSize = profileCount * 2;

  /** True where the floor is deliberately missing (jump gaps). */
  const gapAt = new Uint8Array(frames.length);
  for (const gap of geometry.plan.gaps) {
    for (let i = gap.startIndex; i <= gap.endIndex; i++) gapAt[i] = 1;
  }

  const ringBase: number[] = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const innerProfile = buildProfile(frame.width, frame.wallHeight, 0);
    const outerProfile = buildProfile(frame.width, frame.wallHeight, shellThickness);

    ringBase.push(positions.length / 3);

    // A brighter band every so often gives a sense of speed and distance.
    const stripe = i % 16 < 2;

    const push = (px: number, py: number, isOuter: boolean, profileIndex: number) => {
      const p = frame.position
        .add(frame.right.scale(px))
        .add(frame.up.scale(py));
      positions.push(p.x, p.y, p.z);

      // The outer two points on each side are wall; the rest is floor.
      const onWall = profileIndex < 2 || profileIndex >= profileCount - 2;
      let c: Color3;
      if (isOuter) c = palette.underside;
      else if (onWall) c = palette.wall;
      else if (stripe) c = palette.stripe;
      else c = palette.floor;
      colors.push(c.r, c.g, c.b, 1);
    };

    for (let k = 0; k < profileCount; k++) push(innerProfile.x[k], innerProfile.y[k], false, k);
    for (let k = profileCount - 1; k >= 0; k--) push(outerProfile.x[k], outerProfile.y[k], true, k);
  }

  const quad = (a: number, b: number, c: number, d: number) => {
    indices.push(a, b, c, a, c, d);
  };

  // Longitudinal stitching.
  for (let i = 0; i < frames.length - 1; i++) {
    if (gapAt[i] || gapAt[i + 1]) continue;
    const base0 = ringBase[i];
    const base1 = ringBase[i + 1];
    for (let k = 0; k < ringSize; k++) {
      const k2 = (k + 1) % ringSize;
      quad(base0 + k, base0 + k2, base1 + k2, base1 + k);
    }
  }

  // Cap the open cross-sections at track ends and either side of every gap.
  const capRing = (ringIndex: number, flip: boolean) => {
    const base = ringBase[ringIndex];
    for (let k = 0; k < profileCount - 1; k++) {
      const innerA = base + k;
      const innerB = base + k + 1;
      const outerA = base + ringSize - 1 - k;
      const outerB = base + ringSize - 2 - k;
      if (flip) quad(innerA, innerB, outerB, outerA);
      else quad(innerA, outerA, outerB, innerB);
    }
  };

  capRing(0, false);
  capRing(frames.length - 1, true);
  for (const gap of geometry.plan.gaps) {
    if (gap.startIndex - 1 >= 0) capRing(gap.startIndex - 1, true);
    if (gap.endIndex + 1 < frames.length) capRing(gap.endIndex + 1, false);
  }

  const shell = new Mesh("track-shell", scene);
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.colors = colors;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  vertexData.normals = normals;
  vertexData.applyToMesh(shell, false);

  // Sanity check the winding: the floor of the first ring must face upward.
  // If the sweep came out inside-out, flip every triangle and recompute.
  if (!floorFacesUp(normals, ringBase[2], profileCount, frames[2])) {
    for (let i = 0; i < indices.length; i += 3) {
      const tmp = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = tmp;
    }
    VertexData.ComputeNormals(positions, indices, normals);
    vertexData.indices = indices;
    vertexData.normals = normals;
    vertexData.applyToMesh(shell, false);
  }

  const material = createTrackMaterial(scene, "track-mat", surface);
  material.backFaceCulling = true;
  shell.material = material;
  shell.useVertexColors = true;
  shell.receiveShadows = true;
  shell.isPickable = false;
  // The track is one huge mesh; freezing its transform saves per-frame matrix work.
  shell.freezeWorldMatrix();

  const aggregate = new PhysicsAggregate(
    shell,
    PhysicsShapeType.MESH,
    { mass: 0, restitution: 0.18, friction: 0.22 },
    scene,
  );

  return {
    shell,
    aggregate,
    dispose() {
      aggregate.dispose();
      shell.material?.dispose();
      shell.dispose();
    },
  };
}

/** Checks the normal at the middle of a ring's floor points up along the frame. */
function floorFacesUp(
  normals: number[],
  ringStart: number,
  profileCount: number,
  frame: { up: Vector3 },
): boolean {
  const mid = ringStart + Math.floor(profileCount / 2);
  const n = new Vector3(normals[mid * 3], normals[mid * 3 + 1], normals[mid * 3 + 2]);
  return Vector3.Dot(n, frame.up) > 0;
}

/** Convenience for building Color4 without importing math.color everywhere. */
export function rgba(color: Color3, alpha: number): Color4 {
  return new Color4(color.r, color.g, color.b, alpha);
}
