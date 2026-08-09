/**
 * Coordinate frames, exactly as specified in COORDINATE-SYSTEM.md.
 *
 * This is the one place in the stack where geodetic maths happens. Both viewers use it, so both
 * viewers put the same object in the same place. The transform is rigorous (geodetic -> ECEF ->
 * local ENU basis), not a small-angle approximation, and round-trips to better than a micrometre
 * across the declared validity radius.
 */

import type {
  Georeference,
  Placement,
  Position,
  ScenePosition,
  Vec3,
  VerticalDatum,
} from '@d3d/contracts';
import { isAssetRef, isGeodetic, isScene } from '@d3d/contracts';

const DEG = Math.PI / 180;

export class FrameError extends Error {}

export interface Ellipsoid {
  a: number;
  f: number;
}

const WGS84: Ellipsoid = { a: 6378137.0, f: 1 / 298.257223563 };

/** Rigid transform of a module's local frame into the shared scene frame. */
export interface ResolvedPlacement {
  translation: Vec3;
  /** Row-major 3x3 rotation. */
  rotation: number[];
  scale: number;
}

export class Frame {
  readonly id: string;
  readonly doc: Georeference;

  private readonly ellipsoid: Ellipsoid;
  private readonly e2: number;
  private readonly b: number;
  private readonly origin: Vec3;
  private readonly east: Vec3;
  private readonly north: Vec3;
  private readonly up: Vec3;

  constructor(doc: Georeference) {
    if (doc.kind !== 'enu') {
      throw new FrameError(`unsupported frame kind '${doc.kind}'; v1 supports 'enu' only`);
    }
    if (doc.units !== 'meters') {
      throw new FrameError(`frame '${doc.frame_id}' must be in meters, got '${doc.units}'`);
    }
    this.id = doc.frame_id;
    this.doc = doc;

    this.ellipsoid = doc.ellipsoid
      ? { a: doc.ellipsoid.semi_major_axis_m, f: 1 / doc.ellipsoid.inverse_flattening }
      : WGS84;
    this.e2 = this.ellipsoid.f * (2 - this.ellipsoid.f);
    this.b = this.ellipsoid.a * (1 - this.ellipsoid.f);

    const { lon, lat, height_m = 0 } = doc.anchor;
    this.origin = this.geodeticToEcef(lon, lat, height_m);

    const lam = lon * DEG;
    const phi = lat * DEG;
    const sl = Math.sin(lam);
    const cl = Math.cos(lam);
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    this.east = [-sl, cl, 0];
    this.north = [-sp * cl, -sp * sl, cp];
    this.up = [cp * cl, cp * sl, sp];
  }

  private geodeticToEcef(lon: number, lat: number, h: number): Vec3 {
    const lam = lon * DEG;
    const phi = lat * DEG;
    const s = Math.sin(phi);
    const c = Math.cos(phi);
    const n = this.ellipsoid.a / Math.sqrt(1 - this.e2 * s * s);
    return [
      (n + h) * c * Math.cos(lam),
      (n + h) * c * Math.sin(lam),
      (n * (1 - this.e2) + h) * s,
    ];
  }

  /** Bowring's closed-form inversion. */
  private ecefToGeodetic(x: number, y: number, z: number): { lon: number; lat: number; height_m: number } {
    const lam = Math.atan2(y, x);
    const p = Math.hypot(x, y);
    if (p === 0) {
      return { lon: lam / DEG, lat: z >= 0 ? 90 : -90, height_m: Math.abs(z) - this.b };
    }
    const a = this.ellipsoid.a;
    const ep2 = (a * a - this.b * this.b) / (this.b * this.b);
    const theta = Math.atan2(z * a, p * this.b);
    const phi = Math.atan2(
      z + ep2 * this.b * Math.sin(theta) ** 3,
      p - this.e2 * a * Math.cos(theta) ** 3,
    );
    const s = Math.sin(phi);
    const n = a / Math.sqrt(1 - this.e2 * s * s);
    return { lon: lam / DEG, lat: phi / DEG, height_m: p / Math.cos(phi) - n };
  }

  /** WGS84 geodetic to scene ENU meters. */
  toScene(lon: number, lat: number, height_m = 0): Vec3 {
    const [x, y, z] = this.geodeticToEcef(lon, lat, height_m);
    const dx = x - this.origin[0];
    const dy = y - this.origin[1];
    const dz = z - this.origin[2];
    return [
      this.east[0] * dx + this.east[1] * dy + this.east[2] * dz,
      this.north[0] * dx + this.north[1] * dy + this.north[2] * dz,
      this.up[0] * dx + this.up[1] * dy + this.up[2] * dz,
    ];
  }

  /** Scene ENU meters back to WGS84 geodetic. */
  toGeodetic(x: number, y: number, z = 0): { lon: number; lat: number; height_m: number } {
    const ex = this.origin[0] + this.east[0] * x + this.north[0] * y + this.up[0] * z;
    const ey = this.origin[1] + this.east[1] * x + this.north[1] * y + this.up[1] * z;
    const ez = this.origin[2] + this.east[2] * x + this.north[2] * y + this.up[2] * z;
    return this.ecefToGeodetic(ex, ey, ez);
  }

  /**
   * Convert an elevation between vertical datums using the frame's declared offsets.
   *
   * This is the correction that keeps the Manhattan Bridge, authored against mean high water, from
   * sitting 0.59 m low against NAVD88 building data.
   */
  convertElevation(value: number, from: VerticalDatum, to: VerticalDatum): number {
    if (from === to) return value;
    const offsets = this.doc.vertical_datum_offsets_m;
    if (!offsets) {
      throw new FrameError(
        `frame '${this.id}' declares no vertical_datum_offsets_m, so ${from} -> ${to} cannot be resolved`,
      );
    }
    const fromOffset = offsets[from];
    const toOffset = offsets[to];
    if (fromOffset === undefined || toOffset === undefined) {
      throw new FrameError(
        `frame '${this.id}' has no offset for ${fromOffset === undefined ? from : to}`,
      );
    }
    // Offsets are heights of each datum above the frame's anchor datum.
    return value + fromOffset - toOffset;
  }

  /** Distance of a scene point from the frame anchor, for validity checks. */
  radiusOf(p: Vec3): number {
    return Math.hypot(p[0], p[1]);
  }

  isWithinValidRadius(p: Vec3): boolean {
    return this.radiusOf(p) <= this.doc.valid_radius_m;
  }

  /**
   * Scene (Z-up, ENU) to render (Y-up, glTF/three.js): (x, y, z) -> (x, z, -y).
   * Fixed by contract so nobody derives a mirrored scene.
   */
  static sceneToRender(p: Vec3): Vec3 {
    return [p[0], p[2], -p[1]];
  }

  static renderToScene(p: Vec3): Vec3 {
    return [p[0], -p[2], p[1]];
  }

  /** Compass heading (degrees clockwise from north) to a scene-space forward vector. */
  static headingToForward(headingDeg: number): Vec3 {
    const rad = headingDeg * DEG;
    return [Math.sin(rad), Math.cos(rad), 0];
  }

  static forwardToHeading(v: Vec3): number {
    const deg = Math.atan2(v[0], v[1]) / DEG;
    return (deg + 360) % 360;
  }
}

/** Build a 3x3 row-major rotation from a placement's quaternion or yaw. */
export function resolvePlacement(placement: Placement): ResolvedPlacement {
  const scale = placement.scale ?? 1;
  let rotation: number[];

  if (placement.rotation_quat) {
    const [x, y, z, w] = placement.rotation_quat;
    const n = Math.hypot(x, y, z, w) || 1;
    const [qx, qy, qz, qw] = [x / n, y / n, z / n, w / n];
    rotation = [
      1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
      2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
      2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
    ];
  } else {
    // yaw_deg carries the module's +X axis onto scene East, counter-clockwise looking down.
    const yaw = (placement.yaw_deg ?? 0) * DEG;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    rotation = [c, -s, 0, s, c, 0, 0, 0, 1];
  }

  return { translation: placement.translation_m, rotation, scale };
}

export function applyPlacement(placement: ResolvedPlacement, p: Vec3): Vec3 {
  const { rotation: r, scale, translation: t } = placement;
  const x = p[0] * scale;
  const y = p[1] * scale;
  const z = p[2] * scale;
  return [
    t[0] + r[0] * x + r[1] * y + r[2] * z,
    t[1] + r[3] * x + r[4] * y + r[5] * z,
    t[2] + r[6] * x + r[7] * y + r[8] * z,
  ];
}

/** Resolver used to turn asset-relative positions into scene coordinates. */
export type AnchorResolver = (position: Extract<Position, { asset: string }>) => Vec3 | null;

/**
 * Reduce any contract Position to scene coordinates in the given frame.
 *
 * Returns null for an asset reference the resolver cannot satisfy, so a caller can decide whether
 * that is fatal. Tour scripts lean on this heavily: they are authored geodetically for portability
 * and resolved into whatever frame the host scene happens to use.
 */
export function toSceneVec(
  position: Position,
  frame: Frame,
  resolveAsset?: AnchorResolver,
): Vec3 | null {
  if (isScene(position)) {
    if (position.frame !== frame.id) {
      throw new FrameError(
        `position is in frame '${position.frame}' but the scene is '${frame.id}'; ` +
          'cross-frame positions must be converted by their producer',
      );
    }
    return position.xyz;
  }
  if (isGeodetic(position)) {
    const datum = position.vertical_datum;
    let height = position.height_m ?? 0;
    if (datum && datum !== frame.doc.anchor.vertical_datum && datum !== 'scene_local') {
      height = frame.convertElevation(height, datum, frame.doc.anchor.vertical_datum);
    }
    return frame.toScene(position.lon, position.lat, height);
  }
  if (isAssetRef(position)) {
    if (!resolveAsset) return null;
    const base = resolveAsset(position);
    if (!base) return null;
    const offset = position.offset_m ?? [0, 0, 0];
    return [base[0] + offset[0], base[1] + offset[1], base[2] + offset[2]];
  }
  return null;
}

export function sceneVecToPosition(frame: Frame, xyz: Vec3): ScenePosition {
  return { frame: frame.id, xyz };
}
