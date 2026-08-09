/**
 * Level-of-detail selection.
 *
 * Implements the rule argued for in VIEWER-MODES.md section 3.2: every level from every module sits
 * on one axis, `max_geometric_error_m`, and a viewer mode is nothing more than a different
 * screen-space-error budget on that shared axis.
 *
 *     sse_px = (geometric_error_m / distance_m) * viewport_scale
 *     refine while sse_px > budget_px
 *
 * `viewport_scale = viewport_height_px / (2 * tan(fov_y / 2))`, the standard 3D Tiles formulation,
 * so that a level chosen here would be chosen identically by a 3D Tiles engine later.
 */

import type { LodLadder, LodLevel, ViewerMode } from '@d3d/contracts';

export interface ViewportState {
  /** Vertical field of view in radians. */
  fovY: number;
  /** Drawing buffer height in pixels. */
  heightPx: number;
}

export function viewportScale(viewport: ViewportState): number {
  return viewport.heightPx / (2 * Math.tan(viewport.fovY / 2));
}

export function screenSpaceError(
  geometricErrorM: number,
  distanceM: number,
  viewport: ViewportState,
): number {
  if (distanceM <= 0) return Number.POSITIVE_INFINITY;
  return (geometricErrorM / distanceM) * viewportScale(viewport);
}

export interface SelectOptions {
  /** Current viewer mode. Picks the budget from `mode_sse_budget_px`. */
  mode: ViewerMode;
  /** Level currently resident, if any. Enables hysteresis. */
  currentLevel?: number;
  /**
   * Hard cap imposed by a foreign module's `proxy.max_level`. The consuming viewer enforces it so a
   * neighbouring module can never blow the host's frame budget.
   */
  maxLevel?: number;
  /** Levels the host knows are actually available (e.g. built for this tile). */
  availableLevels?: number[];
}

export class LodSelector {
  readonly ladder: LodLadder;
  private readonly byLevel: Map<number, LodLevel>;
  /** Levels sorted coarse -> fine, i.e. descending geometric error. */
  private readonly sorted: LodLevel[];

  constructor(ladder: LodLadder) {
    if (!ladder.levels.length) throw new Error(`ladder '${ladder.ladder_id}' has no levels`);
    this.ladder = ladder;
    this.byLevel = new Map(ladder.levels.map((l) => [l.level, l]));
    this.sorted = [...ladder.levels].sort(
      (a, b) => b.max_geometric_error_m - a.max_geometric_error_m,
    );
  }

  level(level: number): LodLevel | undefined {
    return this.byLevel.get(level);
  }

  get levels(): LodLevel[] {
    return this.sorted;
  }

  budgetFor(mode: ViewerMode): number {
    return this.ladder.selection.mode_sse_budget_px?.[mode] ?? this.ladder.selection.default_sse_budget_px;
  }

  /**
   * Choose a level for something `distanceM` away.
   *
   * Walks coarse to fine and stops at the first level whose screen-space error is within budget.
   * Hysteresis widens the budget while a level is already resident, so a camera dithering on a
   * threshold does not thrash the loader.
   */
  select(distanceM: number, viewport: ViewportState, options: SelectOptions): LodLevel {
    const baseBudget = this.budgetFor(options.mode);
    const hysteresis = this.ladder.selection.hysteresis ?? 0.15;

    const available = options.availableLevels
      ? this.sorted.filter((l) => options.availableLevels!.includes(l.level))
      : this.sorted;

    const candidates = available.filter(
      (l) => options.maxLevel === undefined || l.level <= options.maxLevel,
    );
    if (!candidates.length) {
      // Nothing satisfies the cap; fall back to the coarsest thing that exists.
      return available[0] ?? this.sorted[0];
    }

    for (const candidate of candidates) {
      const budget =
        options.currentLevel === candidate.level ? baseBudget * (1 + hysteresis) : baseBudget;
      const sse = screenSpaceError(candidate.max_geometric_error_m, distanceM, viewport);
      if (sse <= budget) return candidate;
    }

    // Even the finest level exceeds the budget: that is as good as it gets.
    return candidates[candidates.length - 1];
  }

  /**
   * Distance at which a level first becomes acceptable under a mode's budget.
   * Used for prefetch planning and for explaining LOD decisions in a debug overlay.
   */
  switchDistance(level: number, viewport: ViewportState, mode: ViewerMode): number {
    const entry = this.byLevel.get(level);
    if (!entry) return Number.POSITIVE_INFINITY;
    const budget = this.budgetFor(mode);
    if (budget <= 0) return Number.POSITIVE_INFINITY;
    return (entry.max_geometric_error_m * viewportScale(viewport)) / budget;
  }
}
