/**
 * Typed event bus shared by every shell.
 *
 * Selection, metadata, mode changes and tour progress all travel through here, which is what lets a
 * district shell and a bridge shell coexist without importing each other: they both talk to the bus.
 */

import type { AssetMetadata, AssetUrn, ModuleId, Vec3, ViewerMode } from '@d3d/contracts';

export interface TourProgress {
  tourId: string;
  /** Index of the stop the party is at, or has most recently left while travelling. */
  stopIndex: number;
  stopId: string | null;
  stopName: string | null;
  /** Destination stop index while travelling; null while dwelling. */
  nextStopIndex: number | null;
  nextStopName: string | null;
  legIndex: number | null;
  phase: 'idle' | 'travelling' | 'dwelling' | 'acting' | 'finished';
  instruction: string | null;
  elapsedS: number;
  totalS: number;
  distanceRemainingM: number;
}

export interface CapturedPhoto {
  filename: string;
  width: number;
  height: number;
  label?: string;
  stopId: string | null;
  /** Data URL, populated by the shell that owns the renderer. */
  dataUrl?: string;
}

export interface KernelEvents {
  'asset:selected': { assetId: AssetUrn | null; metadata: AssetMetadata | null };
  'asset:hovered': { assetId: AssetUrn | null };
  'mode:changed': { mode: ViewerMode; previous: ViewerMode };
  'module:loaded': { moduleId: ModuleId };
  'module:missing': { moduleId: ModuleId; url: string; reason: string };
  'tiles:changed': { resident: string[]; added: string[]; removed: string[] };
  'handoff:enter': { moduleId: ModuleId; entryId: string; focusAsset?: AssetUrn };
  'handoff:exit': { moduleId: ModuleId };
  'camera:goto': { position: Vec3; target?: Vec3; durationS: number; easing: string };
  'environment:changed': { timeOfDay?: string; weather?: string };
  'tour:progress': TourProgress;
  'tour:narrate': { text: string; durationS: number; stopId: string | null };
  'tour:capture': CapturedPhoto;
  'tour:instruction': { instruction: string; maneuver: string; streetName?: string };
  'tour:waiting': { reason: string; stopId: string | null };
  'tour:finished': { tourId: string; photos: CapturedPhoto[] };
  'warning': { code: string; message: string; detail?: unknown };
}

type Handler<T> = (payload: T) => void;

export class EventBus<Events = KernelEvents> {
  private handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => {
      set!.delete(handler as Handler<never>);
    };
  }

  once<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as Handler<Events[K]>)(payload);
      } catch (error) {
        // A misbehaving listener must not take down the frame loop.
        console.error(`[d3d] listener for '${String(event)}' threw`, error);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
