/**
 * Tile streaming.
 *
 * Decides which tiles should be resident given where the camera is, where it is heading, and which
 * mode it is in. Pure decision logic: it never touches a renderer. The shell subscribes to the
 * resulting add/remove sets and does the actual loading, which is what keeps this package free of
 * three.js.
 *
 * Prefetch is heading-aware, and a tour player can additionally declare a known future route, which
 * removes the usual walk-mode failure of arriving somewhere before its geometry does.
 */

import type { Tile, TileIndex, Vec3, ViewerMode } from '@d3d/contracts';
import type { LodSelector, ViewportState } from './lod.js';

export interface StreamingCamera {
  /** Scene ENU position, meters. */
  position: Vec3;
  /** Scene-space unit forward vector. */
  forward: Vec3;
}

export interface TileDecision {
  tile: Tile;
  distanceM: number;
  level: number;
  /** Priority for the fetch queue; lower is more urgent. */
  priority: number;
}

export interface StreamingUpdate {
  resident: TileDecision[];
  added: TileDecision[];
  removed: string[];
  /** Foreign module assets that overlap resident tiles and must therefore be loaded. */
  foreignAssets: string[];
}

export interface StreamerOptions {
  /** Extra prefetch distance along the camera heading, beyond the index's own advice. */
  extraPrefetchM?: number;
  /** Points on a known future route. Tiles near these are treated as if the camera were there. */
  plannedRoute?: Vec3[];
}

export class TileStreamer {
  private readonly index: TileIndex;
  private readonly selector: LodSelector;
  private residentIds = new Set<string>();
  private residentLevels = new Map<string, number>();

  constructor(index: TileIndex, selector: LodSelector) {
    this.index = index;
    this.selector = selector;
  }

  get tileIndex(): TileIndex {
    return this.index;
  }

  get resident(): string[] {
    return [...this.residentIds];
  }

  /** Tile ID containing a scene position, derived rather than looked up. */
  tileIdAt(position: Vec3): string {
    const { tile_size_m, origin_xy_m } = this.index.scheme;
    const col = Math.floor((position[0] - origin_xy_m[0]) / tile_size_m);
    const row = Math.floor((position[1] - origin_xy_m[1]) / tile_size_m);
    return `t_${col}_${row}`;
  }

  private static distanceToBox(p: Vec3, min: Vec3, max: Vec3): number {
    const dx = Math.max(min[0] - p[0], 0, p[0] - max[0]);
    const dy = Math.max(min[1] - p[1], 0, p[1] - max[1]);
    const dz = Math.max(min[2] - p[2], 0, p[2] - max[2]);
    return Math.hypot(dx, dy, dz);
  }

  /**
   * Recompute the resident set.
   *
   * Load and unload radii differ (DCTL-041 / DCTL-042 in the district's control document), giving a
   * hysteresis band so a camera loitering on a tile boundary does not thrash.
   */
  update(
    camera: StreamingCamera,
    viewport: ViewportState,
    mode: ViewerMode,
    options: StreamerOptions = {},
  ): StreamingUpdate {
    const { load_radius_m, unload_radius_m, prefetch_along_heading_m = 0 } = this.index.streaming;
    const prefetch = prefetch_along_heading_m + (options.extraPrefetchM ?? 0);

    // Sample points that count as "near": the camera, a point ahead along the heading, and any
    // planned route positions a tour has declared.
    const probes: Vec3[] = [camera.position];
    if (prefetch > 0) {
      probes.push([
        camera.position[0] + camera.forward[0] * prefetch,
        camera.position[1] + camera.forward[1] * prefetch,
        camera.position[2] + camera.forward[2] * prefetch,
      ]);
    }
    for (const point of options.plannedRoute ?? []) probes.push(point);

    const nextIds = new Set<string>();
    const decisions: TileDecision[] = [];

    for (const tile of this.index.tiles) {
      if (!tile.content.length) continue;
      const min = tile.bbox.min;
      const max = tile.bbox.max;

      let nearest = Number.POSITIVE_INFINITY;
      for (const probe of probes) {
        nearest = Math.min(nearest, TileStreamer.distanceToBox(probe, min, max));
        if (nearest === 0) break;
      }

      const wasResident = this.residentIds.has(tile.tile_id);
      const threshold = wasResident ? unload_radius_m : load_radius_m;
      if (nearest > threshold) continue;

      // Distance for LOD purposes is from the real camera, not from a prefetch probe: a tile we are
      // loading ahead of time should still arrive at the level it will need on arrival, not a finer
      // one.
      const cameraDistance = TileStreamer.distanceToBox(camera.position, min, max);
      const availableLevels = tile.content.map((c) => c.level);
      const chosen = this.selector.select(Math.max(cameraDistance, 1), viewport, {
        mode,
        currentLevel: this.residentLevels.get(tile.tile_id),
        availableLevels,
      });

      nextIds.add(tile.tile_id);
      decisions.push({
        tile,
        distanceM: cameraDistance,
        level: chosen.level,
        priority: cameraDistance + (tile.zone === 'hero' ? 0 : 50),
      });
    }

    decisions.sort((a, b) => a.priority - b.priority);

    const added = decisions.filter(
      (d) => !this.residentIds.has(d.tile.tile_id) || this.residentLevels.get(d.tile.tile_id) !== d.level,
    );
    const removed = [...this.residentIds].filter((id) => !nextIds.has(id));

    this.residentIds = nextIds;
    this.residentLevels = new Map(decisions.map((d) => [d.tile.tile_id, d.level]));

    const foreign = new Set<string>();
    for (const decision of decisions) {
      for (const urn of decision.tile.foreign_assets ?? []) foreign.add(urn);
    }

    return { resident: decisions, added, removed, foreignAssets: [...foreign] };
  }

  reset(): void {
    this.residentIds.clear();
    this.residentLevels.clear();
  }
}
