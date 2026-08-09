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
  /** Current time in seconds, for retry backoff. Defaults to performance.now()/1000. */
  nowS?: number;
}

/** Retry schedule for a tile whose payload failed to load, in seconds. */
const RETRY_BACKOFF_S = [1, 3, 8, 20];

export class TileStreamer {
  private readonly index: TileIndex;
  private readonly selector: LodSelector;
  private residentIds = new Set<string>();
  /**
   * Level actually confirmed loaded per tile, NOT the level most recently chosen.
   *
   * The distinction matters: if the shell's fetch fails and the streamer has already recorded the
   * intended level, the tile is never offered again and stays a permanent hole in the world. So
   * nothing is recorded here until the shell calls markLoaded.
   */
  private confirmed = new Map<string, number>();
  /** Tiles currently being fetched by the shell, so they are not requested twice. */
  private inFlight = new Map<string, number>();
  /** Failure counts and the time after which a retry is allowed. */
  private failures = new Map<string, { count: number; retryAfterS: number }>();

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
        currentLevel: this.confirmed.get(tile.tile_id),
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

    const nowS = options.nowS ?? performance.now() / 1000;

    const added = decisions.filter((d) => {
      const id = d.tile.tile_id;
      // Already showing this exact level: nothing to do.
      if (this.confirmed.get(id) === d.level) return false;
      // Already being fetched at this level: do not ask twice.
      if (this.inFlight.get(id) === d.level) return false;
      // Failed recently: wait out the backoff rather than hammering a server that is down.
      const failure = this.failures.get(id);
      if (failure && nowS < failure.retryAfterS) return false;
      return true;
    });

    const removed = [...this.residentIds].filter((id) => !nextIds.has(id));
    for (const id of removed) {
      this.confirmed.delete(id);
      this.inFlight.delete(id);
      // Leaving the area clears the failure history: the next approach gets a clean try.
      this.failures.delete(id);
    }

    this.residentIds = nextIds;
    for (const decision of added) this.inFlight.set(decision.tile.tile_id, decision.level);

    const foreign = new Set<string>();
    for (const decision of decisions) {
      for (const urn of decision.tile.foreign_assets ?? []) foreign.add(urn);
    }

    return { resident: decisions, added, removed, foreignAssets: [...foreign] };
  }

  /**
   * The shell reports a payload that actually arrived and is now in the scene.
   *
   * Until this is called the tile is not considered present, so a silent fetch failure cannot
   * leave a permanent hole.
   */
  markLoaded(tileId: string, level: number): void {
    this.confirmed.set(tileId, level);
    this.inFlight.delete(tileId);
    this.failures.delete(tileId);
  }

  /**
   * The shell reports a payload that failed. The tile becomes eligible again after a backoff,
   * so a transient outage — a dev server restarting, a flaky connection — heals itself.
   */
  markFailed(tileId: string, nowS = performance.now() / 1000): void {
    this.inFlight.delete(tileId);
    const previous = this.failures.get(tileId);
    const count = (previous?.count ?? 0) + 1;
    const wait = RETRY_BACKOFF_S[Math.min(count - 1, RETRY_BACKOFF_S.length - 1)];
    this.failures.set(tileId, { count, retryAfterS: nowS + wait });
  }

  /** Tiles that have failed at least once and are waiting to be retried. */
  get retrying(): number {
    return this.failures.size;
  }

  /** Level confirmed present for a tile, or undefined if nothing has loaded yet. */
  levelOf(tileId: string): number | undefined {
    return this.confirmed.get(tileId);
  }

  reset(): void {
    this.residentIds.clear();
    this.confirmed.clear();
    this.inFlight.clear();
    this.failures.clear();
  }
}
