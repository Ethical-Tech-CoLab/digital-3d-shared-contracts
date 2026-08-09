/**
 * Route geometry for tour playback.
 *
 * Turns the three interchangeable `path` representations of tour-script.schema.json into one
 * arc-length parameterised polyline in scene coordinates, so the player can ask "where is the party
 * after walking 37.2 m?" without caring how the author expressed the route.
 */

import type { LonLat, TourPath, Vec3 } from '@d3d/contracts';
import type { Frame } from '../georef.js';

/** Decode a Google encoded polyline (precision 5) into [lon, lat] pairs. */
export function decodePolyline(encoded: string, precision = 5): LonLat[] {
  const factor = 10 ** precision;
  const out: LonLat[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    out.push([lon / factor, lat / factor]);
  }
  return out;
}

export function pathToScene(path: TourPath, frame: Frame): Vec3[] {
  if ('geodetic' in path) {
    return path.geodetic.map(([lon, lat]) => frame.toScene(lon, lat, 0));
  }
  if ('encoded_polyline' in path) {
    return decodePolyline(path.encoded_polyline).map(([lon, lat]) => frame.toScene(lon, lat, 0));
  }
  return path.scene.map((p) => [p[0], p[1], p.length > 2 ? (p[2] as number) : 0] as Vec3);
}

export interface SampledPoint {
  position: Vec3;
  /** Unit forward vector along the polyline at this point. */
  forward: Vec3;
  /** Compass heading, degrees clockwise from north. */
  headingDeg: number;
}

/** An arc-length parameterised polyline in scene coordinates. */
export class Polyline {
  readonly points: Vec3[];
  /** Cumulative planar distance at each vertex. */
  readonly cumulative: number[];
  readonly length: number;

  constructor(points: Vec3[]) {
    this.points = points.length ? points : [[0, 0, 0]];
    this.cumulative = [0];
    let total = 0;
    for (let i = 1; i < this.points.length; i++) {
      const a = this.points[i - 1];
      const b = this.points[i];
      total += Math.hypot(b[0] - a[0], b[1] - a[1]);
      this.cumulative.push(total);
    }
    this.length = total;
  }

  static fromPath(path: TourPath, frame: Frame): Polyline {
    return new Polyline(pathToScene(path, frame));
  }

  /** Concatenate, dropping a duplicated joint vertex where two runs meet. */
  static join(parts: Polyline[]): Polyline {
    const points: Vec3[] = [];
    for (const part of parts) {
      for (const point of part.points) {
        const last = points[points.length - 1];
        if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) < 1e-6) continue;
        points.push(point);
      }
    }
    return new Polyline(points);
  }

  /** Position and heading after walking `distance` meters from the start. */
  sample(distance: number): SampledPoint {
    if (this.points.length === 1 || this.length === 0) {
      return { position: this.points[0], forward: [0, 1, 0], headingDeg: 0 };
    }
    const clamped = Math.max(0, Math.min(this.length, distance));

    let hi = 1;
    while (hi < this.cumulative.length - 1 && this.cumulative[hi] < clamped) hi++;
    const lo = hi - 1;

    const segmentLength = this.cumulative[hi] - this.cumulative[lo];
    const t = segmentLength > 0 ? (clamped - this.cumulative[lo]) / segmentLength : 0;
    const a = this.points[lo];
    const b = this.points[hi];

    const position: Vec3 = [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];

    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const norm = Math.hypot(dx, dy) || 1;
    const forward: Vec3 = [dx / norm, dy / norm, 0];
    const headingDeg = (Math.atan2(forward[0], forward[1]) * 180) / Math.PI;

    return { position, forward, headingDeg: (headingDeg + 360) % 360 };
  }

  /** Evenly spaced samples, used to hand a tour's future route to the streaming manager. */
  resample(spacingM: number): Vec3[] {
    if (this.length === 0) return [this.points[0]];
    const out: Vec3[] = [];
    for (let d = 0; d <= this.length; d += spacingM) out.push(this.sample(d).position);
    const end = this.sample(this.length).position;
    if (out.length === 0 || out[out.length - 1] !== end) out.push(end);
    return out;
  }
}

export function shortestAngleDelta(fromDeg: number, toDeg: number): number {
  let delta = ((toDeg - fromDeg + 180) % 360) - 180;
  if (delta < -180) delta += 360;
  return delta;
}

export function easeValue(t: number, easing: string | undefined): number {
  const x = Math.max(0, Math.min(1, t));
  switch (easing) {
    case 'linear':
      return x;
    case 'ease_in':
      return x * x;
    case 'ease_out':
      return 1 - (1 - x) * (1 - x);
    case 'ease_in_out':
    default:
      return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
  }
}
