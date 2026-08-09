/**
 * Map camera.
 *
 * A 2D view over the scene plane: where it is centred, how much ground it spans, and how it
 * animates between views. Lives in the kernel rather than a shell because two different things
 * need to drive it — a user with a mouse or a finger, and a tour script that wants to open zoomed
 * out over the whole district and then fly in to stop A.
 *
 * Units are scene meters throughout. The camera knows nothing about pixels; a shell divides span
 * by viewport size when it needs a scale.
 */

import type { Vec3 } from '@d3d/contracts';

export interface MapView {
  /** Scene-space centre, meters. */
  center: [number, number];
  /** Ground distance across the shorter viewport axis, meters. Smaller means zoomed in. */
  spanM: number;
}

export interface MapCameraLimits {
  minSpanM: number;
  maxSpanM: number;
  /** Optional bounds the centre is clamped to: [minX, minY, maxX, maxY]. */
  bounds?: [number, number, number, number];
}

export type Easing = 'linear' | 'ease_in' | 'ease_out' | 'ease_in_out';

function ease(t: number, kind: Easing): number {
  const x = Math.max(0, Math.min(1, t));
  switch (kind) {
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

interface Flight {
  from: MapView;
  to: MapView;
  durationS: number;
  elapsedS: number;
  easing: Easing;
  resolve?: () => void;
}

export class MapCamera {
  private view: MapView;
  private flight: Flight | null = null;
  readonly limits: MapCameraLimits;

  constructor(initial: MapView, limits: MapCameraLimits) {
    this.limits = limits;
    this.view = this.clamp(initial);
  }

  get current(): MapView {
    return { center: [...this.view.center] as [number, number], spanM: this.view.spanM };
  }

  get isFlying(): boolean {
    return this.flight !== null;
  }

  private clamp(view: MapView): MapView {
    const spanM = Math.max(this.limits.minSpanM, Math.min(this.limits.maxSpanM, view.spanM));
    let [x, y] = view.center;
    if (this.limits.bounds) {
      const [minX, minY, maxX, maxY] = this.limits.bounds;
      // Allow the centre to reach the bounds themselves; padding by half the span would make a
      // fully zoomed-out view impossible to centre.
      x = Math.max(minX, Math.min(maxX, x));
      y = Math.max(minY, Math.min(maxY, y));
    }
    return { center: [x, y], spanM };
  }

  /** Jump immediately, cancelling any flight. */
  setView(view: Partial<MapView>): void {
    this.flight = null;
    this.view = this.clamp({
      center: view.center ?? this.view.center,
      spanM: view.spanM ?? this.view.spanM,
    });
  }

  /**
   * Animate to a view.
   *
   * Zoom is interpolated logarithmically. Linear interpolation of span looks wrong: going from
   * 4000 m to 100 m spends most of the animation crawling through the last few hundred metres.
   * Log interpolation gives the constant-perceived-speed zoom every mapping application uses.
   */
  flyTo(target: Partial<MapView>, durationS = 1.6, easing: Easing = 'ease_in_out'): Promise<void> {
    const to = this.clamp({
      center: target.center ?? this.view.center,
      spanM: target.spanM ?? this.view.spanM,
    });

    if (durationS <= 0) {
      this.setView(to);
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.flight = {
        from: this.current,
        to,
        durationS,
        elapsedS: 0,
        easing,
        resolve,
      };
    });
  }

  /** Advance any in-flight animation. Returns true when the view changed this frame. */
  update(dtSeconds: number): boolean {
    if (!this.flight) return false;

    this.flight.elapsedS += dtSeconds;
    const t = ease(this.flight.elapsedS / this.flight.durationS, this.flight.easing);

    const { from, to } = this.flight;
    // Logarithmic zoom, linear pan.
    const spanM = Math.exp(Math.log(from.spanM) + (Math.log(to.spanM) - Math.log(from.spanM)) * t);
    const center: [number, number] = [
      from.center[0] + (to.center[0] - from.center[0]) * t,
      from.center[1] + (to.center[1] - from.center[1]) * t,
    ];
    this.view = this.clamp({ center, spanM });

    if (this.flight.elapsedS >= this.flight.durationS) {
      this.view = this.flight.to;
      this.flight.resolve?.();
      this.flight = null;
    }
    return true;
  }

  /** Pan by a scene-space delta. Cancels any flight, because the user has taken over. */
  panBy(dx: number, dy: number): void {
    this.flight = null;
    this.view = this.clamp({
      center: [this.view.center[0] + dx, this.view.center[1] + dy],
      spanM: this.view.spanM,
    });
  }

  /**
   * Zoom by a multiplicative factor, optionally keeping a scene point fixed under the cursor.
   *
   * The anchor maths is what makes wheel-zoom feel right: without it the view zooms to its centre
   * and the thing the user was pointing at slides away.
   */
  zoomBy(factor: number, anchor?: [number, number]): void {
    this.flight = null;
    const nextSpan = Math.max(
      this.limits.minSpanM,
      Math.min(this.limits.maxSpanM, this.view.spanM * factor),
    );
    if (!anchor) {
      this.view = this.clamp({ center: this.view.center, spanM: nextSpan });
      return;
    }
    const ratio = nextSpan / this.view.spanM;
    const center: [number, number] = [
      anchor[0] + (this.view.center[0] - anchor[0]) * ratio,
      anchor[1] + (this.view.center[1] - anchor[1]) * ratio,
    ];
    this.view = this.clamp({ center, spanM: nextSpan });
  }

  /** Frame a rectangle with padding, e.g. a whole district or a tour's extent. */
  frameBounds(
    bounds: [number, number, number, number],
    padding = 1.1,
    durationS = 0,
  ): Promise<void> {
    const [minX, minY, maxX, maxY] = bounds;
    const span = Math.max(maxX - minX, maxY - minY) * padding;
    const target: MapView = {
      center: [(minX + maxX) / 2, (minY + maxY) / 2],
      spanM: span,
    };
    return durationS > 0 ? this.flyTo(target, durationS) : (this.setView(target), Promise.resolve());
  }

  /** Frame a set of scene points, e.g. every stop on a tour. */
  framePoints(points: Array<[number, number] | Vec3>, padding = 1.25, durationS = 0): Promise<void> {
    if (!points.length) return Promise.resolve();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    return this.frameBounds([minX, minY, maxX, maxY], padding, durationS);
  }

  /** Viewport rectangle in scene meters, given an aspect ratio. */
  viewportBounds(aspect: number): [number, number, number, number] {
    const halfShort = this.view.spanM / 2;
    const halfW = aspect >= 1 ? halfShort * aspect : halfShort;
    const halfH = aspect >= 1 ? halfShort : halfShort / aspect;
    return [
      this.view.center[0] - halfW,
      this.view.center[1] - halfH,
      this.view.center[0] + halfW,
      this.view.center[1] + halfH,
    ];
  }
}
