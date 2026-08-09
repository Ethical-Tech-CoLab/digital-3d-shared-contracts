/**
 * Tour player.
 *
 * Executes an externally authored tour script: a Maps-style route of legs and maneuver steps, plus
 * an experience layer of stops, dwell times, look-at targets, photo moments and narration.
 *
 * The player is a pure state machine. It owns no renderer and no scene graph. Each frame the shell
 * calls `update(dt)` and reads `cameraState`, then applies it to whatever camera it has. Everything
 * else the tour wants to happen is announced on the event bus, so a shell can implement as much or
 * as little of the action vocabulary as it supports.
 *
 * Compilation happens once, up front: the script becomes a flat timeline of travel and dwell
 * phases. That makes total duration knowable, makes seeking possible, and lets the streaming
 * manager be handed the whole future route rather than discovering it a step at a time.
 */

import type {
  AssetUrn,
  Position,
  TourAction,
  TourLeg,
  TourScript,
  TourStop,
  Vec3,
  ViewerMode,
} from '@d3d/contracts';
import type { EventBus, CapturedPhoto, KernelEvents } from '../bus.js';
import { Frame, toSceneVec, type AnchorResolver } from '../georef.js';
import { Polyline, easeValue, shortestAngleDelta } from './route.js';

export interface TourCameraState {
  /** Eye position in scene ENU meters. */
  position: Vec3;
  /** Point the camera is looking at, when the active behaviour tracks a target. */
  target: Vec3 | null;
  headingDeg: number;
  pitchDeg: number;
  fovDeg: number | null;
  rig: 'first_person' | 'over_shoulder' | 'drone' | 'fixed';
  /** Distance walked in the current leg; drives head bob in the shell. */
  travelledM: number;
  moving: boolean;
}

export type TourPhaseKind = 'travel' | 'dwell';

interface CompiledAction {
  action: TourAction;
  startS: number;
  durationS: number;
  fired: boolean;
}

interface CompiledPhase {
  kind: TourPhaseKind;
  stopIndex: number;
  legIndex: number | null;
  startS: number;
  durationS: number;
  polyline: Polyline | null;
  actions: CompiledAction[];
  /** Maneuver instructions, keyed by the distance along the leg at which they fire. */
  instructions: Array<{ atM: number; instruction: string; maneuver: string; streetName?: string; fired: boolean }>;
  stop: TourStop | null;
  leg: TourLeg | null;
}

export interface TourPlayerOptions {
  frame: Frame;
  bus: EventBus<KernelEvents>;
  /**
   * Resolves `{ asset: urn }` positions to scene coordinates. Supplied by the shell because only it
   * knows where loaded assets ended up. Without it, asset-relative targets are skipped with a
   * warning rather than crashing the tour.
   */
  resolveAsset?: AnchorResolver;
  /**
   * Optional street-network router. When a leg has no path, the player asks for one. Falling back to
   * a straight line is honest but walks through buildings, so a shell that has a walk graph should
   * supply this.
   */
  router?: (from: Vec3, to: Vec3) => Vec3[] | null;
  /** Ground height lookup, so the party's feet follow terrain rather than floating at z = 0. */
  groundHeight?: (x: number, y: number) => number;
}

const DEFAULT_DWELL_S = 20;
const DEFAULT_EYE_HEIGHT_M = 1.65;
const DEFAULT_PACE_MPS = 1.3;

export class TourPlayer {
  readonly script: TourScript;
  private readonly frame: Frame;
  private readonly bus: EventBus<KernelEvents>;
  private readonly options: TourPlayerOptions;

  private phases: CompiledPhase[] = [];
  private stopPositions: Vec3[] = [];
  private totalS = 0;
  private clockS = 0;

  private playing = false;
  private waitingForUser = false;
  private speed: number;
  private eyeHeight: number;

  private lookTarget: Vec3 | null = null;
  private lookUntilS = 0;
  private manualHeading: number | null = null;
  private manualPitch = 0;
  private currentPitch = 0;
  private currentHeading = 0;

  private mode: ViewerMode;
  private photos: CapturedPhoto[] = [];
  private captureCounter = 0;

  constructor(script: TourScript, options: TourPlayerOptions) {
    this.script = script;
    this.frame = options.frame;
    this.bus = options.bus;
    this.options = options;
    this.speed = script.defaults?.speed_multiplier ?? 1;
    this.eyeHeight = script.defaults?.eye_height_m ?? this.partyEyeHeight() ?? DEFAULT_EYE_HEIGHT_M;
    this.mode = (script.defaults?.viewer_mode as ViewerMode) ?? 'walk';
    this.compile();
  }

  // ------------------------------------------------------------------ compile

  private partyEyeHeight(): number | null {
    const party = this.script.party;
    if (!party?.members?.length) return null;
    const pov = party.point_of_view
      ? party.members.find((m) => m.member_id === party.point_of_view)
      : party.members.find((m) => m.role === 'adult') ?? party.members[0];
    return pov?.eye_height_m ?? null;
  }

  private pace(): number {
    return this.script.party?.pace_mps ?? DEFAULT_PACE_MPS;
  }

  private resolve(position: Position): Vec3 | null {
    try {
      return toSceneVec(position, this.frame, this.options.resolveAsset);
    } catch (error) {
      this.bus.emit('warning', {
        code: 'tour.position_unresolved',
        message: error instanceof Error ? error.message : String(error),
        detail: position,
      });
      return null;
    }
  }

  private compile(): void {
    const stops = this.script.stops;
    this.stopPositions = stops.map((stop, i) => {
      const resolved = this.resolve(stop.position);
      if (!resolved) {
        this.bus.emit('warning', {
          code: 'tour.stop_unresolved',
          message: `stop '${stop.stop_id}' could not be resolved to a scene position`,
        });
        return this.stopPositions[i - 1] ?? [0, 0, 0];
      }
      return resolved;
    });

    const legsByPair = new Map<string, TourLeg>();
    for (const leg of this.script.legs ?? []) {
      legsByPair.set(`${leg.from_stop}->${leg.to_stop}`, leg);
    }

    const phases: CompiledPhase[] = [];
    let cursor = 0;

    for (let i = 0; i < stops.length; i++) {
      if (i > 0) {
        const leg = legsByPair.get(`${stops[i - 1].stop_id}->${stops[i].stop_id}`) ?? null;
        const phase = this.compileTravel(i - 1, i, leg, cursor, (this.script.legs ?? []).indexOf(leg as TourLeg));
        phases.push(phase);
        cursor += phase.durationS;
      }
      const dwell = this.compileDwell(i, cursor);
      phases.push(dwell);
      cursor += dwell.durationS;
    }

    this.phases = phases;
    this.totalS = cursor;
  }

  private compileTravel(
    fromIndex: number,
    toIndex: number,
    leg: TourLeg | null,
    startS: number,
    legIndex: number,
  ): CompiledPhase {
    const from = this.stopPositions[fromIndex];
    const to = this.stopPositions[toIndex];

    let polyline: Polyline;
    if (leg?.path) {
      polyline = Polyline.fromPath(leg.path, this.frame);
    } else if (leg?.steps?.some((s) => s.path)) {
      polyline = Polyline.join(
        leg.steps.filter((s) => s.path).map((s) => Polyline.fromPath(s.path!, this.frame)),
      );
    } else {
      const routed = this.options.router?.(from, to);
      polyline = new Polyline(routed && routed.length > 1 ? routed : [from, to]);
      if (!routed) {
        this.bus.emit('warning', {
          code: 'tour.leg_unrouted',
          message:
            `leg ${fromIndex} -> ${toIndex} has no path and no router was supplied; ` +
            'walking a straight line, which may pass through buildings',
        });
      }
    }

    const transition = leg?.transition ?? this.script.defaults?.transition;
    const kind = transition?.kind ?? 'walk';
    let durationS: number;
    if (kind === 'cut') {
      durationS = 0;
    } else if (transition?.duration_s !== undefined) {
      durationS = transition.duration_s;
    } else if (leg?.duration_s !== undefined) {
      durationS = leg.duration_s;
    } else {
      durationS = polyline.length / this.pace();
    }

    const instructions: CompiledPhase['instructions'] = [];
    let atM = 0;
    for (const step of leg?.steps ?? []) {
      if (step.instruction) {
        instructions.push({
          atM,
          instruction: step.instruction,
          maneuver: step.maneuver,
          streetName: step.street_name,
          fired: false,
        });
      }
      atM += step.distance_m ?? 0;
    }

    const actions: CompiledAction[] = [];
    let actionCursor = 0;
    for (const step of leg?.steps ?? []) {
      for (const action of step.actions ?? []) {
        const duration = action.duration_s ?? 0;
        const at = action.at_s ?? actionCursor;
        actions.push({ action, startS: at, durationS: duration, fired: false });
        actionCursor = at + duration;
      }
    }

    return {
      kind: 'travel',
      stopIndex: toIndex,
      legIndex: legIndex >= 0 ? legIndex : null,
      startS,
      durationS,
      polyline,
      actions,
      instructions,
      stop: null,
      leg,
    };
  }

  private compileDwell(stopIndex: number, startS: number): CompiledPhase {
    const stop = this.script.stops[stopIndex];
    const actions: CompiledAction[] = [];
    let cursor = 0;

    for (const action of [...(stop.on_arrive ?? []), ...(stop.on_depart ?? [])]) {
      const duration = action.duration_s ?? defaultActionDuration(action);
      const at = action.at_s ?? cursor;
      actions.push({ action, startS: at, durationS: duration, fired: false });
      if (action.blocking !== false) cursor = at + duration;
    }

    const declared = stop.dwell_s ?? this.script.defaults?.dwell_s ?? DEFAULT_DWELL_S;
    // If the scripted actions run longer than the declared dwell, extend rather than truncate: an
    // author who wrote four beats meant all four to happen.
    const durationS = Math.max(declared, cursor);

    return {
      kind: 'dwell',
      stopIndex,
      legIndex: null,
      startS,
      durationS,
      polyline: null,
      actions,
      instructions: [],
      stop,
      leg: null,
    };
  }

  // ------------------------------------------------------------------ control

  play(): void {
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  toggle(): void {
    this.playing = !this.playing;
  }

  get isPlaying(): boolean {
    return this.playing && !this.waitingForUser;
  }

  get isWaiting(): boolean {
    return this.waitingForUser;
  }

  /** Release a `wait_for_user` action. */
  resume(): void {
    this.waitingForUser = false;
    this.playing = true;
  }

  setSpeed(multiplier: number): void {
    this.speed = Math.max(0.01, multiplier);
  }

  get speedMultiplier(): number {
    return this.speed;
  }

  get durationS(): number {
    return this.totalS;
  }

  get elapsedS(): number {
    return this.clockS;
  }

  get capturedPhotos(): CapturedPhoto[] {
    return [...this.photos];
  }

  get viewerMode(): ViewerMode {
    return this.mode;
  }

  /** Jump to a stop. Actions in skipped phases are marked fired so they do not replay. */
  seekToStop(stopIndex: number): void {
    const phase = this.phases.find((p) => p.kind === 'dwell' && p.stopIndex === stopIndex);
    if (!phase) return;
    this.seek(phase.startS);
  }

  seek(seconds: number): void {
    const target = Math.max(0, Math.min(this.totalS, seconds));
    for (const phase of this.phases) {
      const phaseEnd = phase.startS + phase.durationS;
      const passed = phaseEnd <= target;
      for (const action of phase.actions) action.fired = passed;
      for (const instruction of phase.instructions) instruction.fired = passed;
    }
    this.clockS = target;
    this.waitingForUser = false;
    this.emitProgress();
  }

  restart(): void {
    this.seek(0);
    this.photos = [];
    this.captureCounter = 0;
  }

  /** Scene positions along the remainder of the route, for streaming prefetch. */
  plannedRoute(lookaheadM = 400, spacingM = 40): Vec3[] {
    const out: Vec3[] = [];
    let budget = lookaheadM;
    for (const phase of this.phases) {
      if (phase.startS + phase.durationS < this.clockS) continue;
      if (!phase.polyline) {
        out.push(this.stopPositions[phase.stopIndex]);
        continue;
      }
      const startAt =
        phase.startS <= this.clockS && this.clockS < phase.startS + phase.durationS
          ? this.progressDistance(phase)
          : 0;
      for (let d = startAt; d <= phase.polyline.length && budget > 0; d += spacingM) {
        out.push(phase.polyline.sample(d).position);
        budget -= spacingM;
      }
      if (budget <= 0) break;
    }
    return out;
  }

  private progressDistance(phase: CompiledPhase): number {
    if (!phase.polyline || phase.durationS <= 0) return 0;
    const t = (this.clockS - phase.startS) / phase.durationS;
    const transition = phase.leg?.transition ?? this.script.defaults?.transition;
    const eased =
      transition?.kind && transition.kind !== 'walk'
        ? easeValue(t, transition.easing)
        : Math.max(0, Math.min(1, t));
    return eased * phase.polyline.length;
  }

  private phaseAt(seconds: number): CompiledPhase {
    for (const phase of this.phases) {
      if (seconds < phase.startS + phase.durationS) return phase;
    }
    return this.phases[this.phases.length - 1];
  }

  // ------------------------------------------------------------------- update

  /** Advance the tour. `dtSeconds` is real elapsed time; playback speed is applied here. */
  update(dtSeconds: number): TourCameraState {
    if (this.isPlaying && this.clockS < this.totalS) {
      this.clockS = Math.min(this.totalS, this.clockS + dtSeconds * this.speed);
    }

    const phase = this.phaseAt(this.clockS);
    const localS = this.clockS - phase.startS;

    this.fireInstructions(phase);
    this.fireActions(phase, localS);

    if (this.lookTarget && this.clockS > this.lookUntilS) this.lookTarget = null;

    const camera = this.cameraFor(phase);
    this.emitProgress();

    if (this.clockS >= this.totalS && this.playing) {
      this.playing = false;
      this.bus.emit('tour:finished', { tourId: this.script.tour_id, photos: this.capturedPhotos });
    }

    return camera;
  }

  private fireInstructions(phase: CompiledPhase): void {
    if (phase.kind !== 'travel') return;
    const travelled = this.progressDistance(phase);
    for (const instruction of phase.instructions) {
      if (instruction.fired || travelled < instruction.atM) continue;
      instruction.fired = true;
      this.bus.emit('tour:instruction', {
        instruction: instruction.instruction,
        maneuver: instruction.maneuver,
        streetName: instruction.streetName,
      });
    }
  }

  private fireActions(phase: CompiledPhase, localS: number): void {
    for (const compiled of phase.actions) {
      if (compiled.fired || localS < compiled.startS) continue;
      compiled.fired = true;
      this.runAction(compiled, phase);
    }
  }

  private runAction(compiled: CompiledAction, phase: CompiledPhase): void {
    const { action } = compiled;
    const stopId = phase.stop?.stop_id ?? null;

    switch (action.type) {
      case 'look_at': {
        const target = action.target ? this.resolve(action.target) : null;
        if (target) {
          this.lookTarget = target;
          this.lookUntilS = this.clockS + (compiled.durationS || 6);
          this.manualHeading = null;
        }
        break;
      }
      case 'pan': {
        if (action.heading_deg !== undefined) this.manualHeading = action.heading_deg;
        if (action.pitch_deg !== undefined) this.manualPitch = action.pitch_deg;
        this.lookTarget = null;
        break;
      }
      case 'narrate': {
        if (action.text) {
          this.bus.emit('tour:narrate', {
            text: action.text,
            durationS: compiled.durationS || estimateReadSeconds(action.text),
            stopId,
          });
        }
        break;
      }
      case 'capture_photo':
      case 'group_photo': {
        this.captureCounter += 1;
        const photo: CapturedPhoto = {
          filename:
            action.capture?.filename ??
            `${this.script.tour_id}-${String(this.captureCounter).padStart(2, '0')}.png`,
          width: action.capture?.width ?? 1600,
          height: action.capture?.height ?? 1000,
          label: action.label ?? phase.stop?.name,
          stopId,
        };
        if (action.target) {
          const target = this.resolve(action.target);
          if (target) {
            this.lookTarget = target;
            this.lookUntilS = this.clockS + Math.max(1.5, compiled.durationS);
          }
        }
        this.photos.push(photo);
        this.bus.emit('tour:capture', photo);
        break;
      }
      case 'highlight':
      case 'show_metadata': {
        const urn = action.target && 'asset' in action.target ? (action.target.asset as AssetUrn) : null;
        this.bus.emit('asset:selected', { assetId: urn, metadata: null });
        break;
      }
      case 'set_mode': {
        if (action.mode) {
          this.switchMode(action.mode as ViewerMode);
          // A tour switching to map mode usually wants a specific framing too, otherwise the map
          // opens wherever the user last left it.
          if (action.mode === 'map') this.emitMapFocus(action, phase, compiled.durationS);
        }
        break;
      }
      case 'map_focus': {
        this.emitMapFocus(action, phase, compiled.durationS);
        break;
      }
      case 'enter_inspect': {
        if (action.module_id && action.entry_id) {
          this.switchMode('inspect');
          this.bus.emit('handoff:enter', {
            moduleId: action.module_id,
            entryId: action.entry_id,
            focusAsset:
              action.target && 'asset' in action.target ? (action.target.asset as AssetUrn) : undefined,
          });
        }
        break;
      }
      case 'exit_inspect': {
        this.switchMode((this.script.defaults?.viewer_mode as ViewerMode) ?? 'walk');
        if (action.module_id) this.bus.emit('handoff:exit', { moduleId: action.module_id });
        break;
      }
      case 'set_time_of_day': {
        this.bus.emit('environment:changed', { timeOfDay: action.time_of_day });
        break;
      }
      case 'set_speed': {
        if (action.speed_multiplier) this.setSpeed(action.speed_multiplier);
        break;
      }
      case 'wait_for_user': {
        this.waitingForUser = true;
        this.bus.emit('tour:waiting', { reason: action.label ?? 'waiting for you', stopId });
        break;
      }
      case 'dwell':
      default:
        break;
    }
  }

  /**
   * Ask the host's map view to frame something.
   *
   * Falls back through target, then the current stop, then the party's position, so a bare
   * `map_focus` with no target still does something sensible.
   */
  private emitMapFocus(action: TourAction, phase: CompiledPhase, durationS: number): void {
    let center: [number, number] | null = null;

    if (action.target) {
      const resolved = this.resolve(action.target);
      if (resolved) center = [resolved[0], resolved[1]];
    }
    if (!center) {
      const stopPosition = this.stopPositions[phase.stopIndex];
      if (stopPosition) center = [stopPosition[0], stopPosition[1]];
    }
    if (!center) return;

    this.bus.emit('map:goto', {
      center,
      spanM: action.map_span_m,
      durationS: durationS || 1.6,
      easing: 'ease_in_out',
    });
  }

  private switchMode(mode: ViewerMode): void {
    if (mode === this.mode) return;
    const previous = this.mode;
    this.mode = mode;
    this.bus.emit('mode:changed', { mode, previous });
  }

  private cameraFor(phase: CompiledPhase): TourCameraState {
    const behaviour = {
      ...(this.script.defaults?.camera ?? {}),
      ...(phase.stop?.camera ?? {}),
    };
    const rig = behaviour.rig ?? 'first_person';

    let position: Vec3;
    let headingDeg: number;
    let travelledM = 0;
    let moving = false;

    if (phase.kind === 'travel' && phase.polyline) {
      travelledM = this.progressDistance(phase);
      const sample = phase.polyline.sample(travelledM);
      position = sample.position;
      headingDeg = sample.headingDeg;
      moving = this.isPlaying && phase.durationS > 0;
    } else {
      position = this.stopPositions[phase.stopIndex];
      headingDeg = phase.stop?.heading_deg ?? this.currentHeading;
    }

    const groundZ = this.options.groundHeight?.(position[0], position[1]) ?? position[2];
    const eye: Vec3 = [
      position[0],
      position[1],
      groundZ + this.eyeHeight + (behaviour.height_offset_m ?? 0),
    ];

    let pitchDeg = this.manualPitch;
    let target: Vec3 | null = null;

    const look = behaviour.look ?? (this.lookTarget ? 'at_target' : 'forward');
    if (this.lookTarget && look !== 'free' && look !== 'hold') {
      target = this.lookTarget;
      const dx = target[0] - eye[0];
      const dy = target[1] - eye[1];
      const dz = target[2] - eye[2];
      const planar = Math.hypot(dx, dy);
      headingDeg = (Math.atan2(dx, dy) * 180) / Math.PI;
      pitchDeg = (Math.atan2(dz, planar || 1e-6) * 180) / Math.PI;
    } else if (this.manualHeading !== null) {
      headingDeg = this.manualHeading;
    }

    headingDeg = (headingDeg + 360) % 360;

    // Smooth heading and pitch so scripted turns read as a head turn, not a snap.
    const blend = phase.kind === 'dwell' ? 0.08 : 0.2;
    this.currentHeading =
      (this.currentHeading + shortestAngleDelta(this.currentHeading, headingDeg) * blend + 360) % 360;
    this.currentPitch += (pitchDeg - this.currentPitch) * blend;

    return {
      position: eye,
      target,
      headingDeg: this.currentHeading,
      pitchDeg: this.currentPitch,
      fovDeg: behaviour.fov_deg ?? null,
      rig,
      travelledM,
      moving,
    };
  }

  private emitProgress(): void {
    const phase = this.phaseAt(this.clockS);
    const remaining = this.phases
      .filter((p) => p.kind === 'travel' && p.startS + p.durationS > this.clockS)
      .reduce((total, p) => {
        if (!p.polyline) return total;
        const done = p.startS <= this.clockS ? this.progressDistance(p) : 0;
        return total + Math.max(0, p.polyline.length - done);
      }, 0);

    // While travelling, `stopIndex` names the stop just left, not the one being approached. A UI
    // that offers "next stop" needs the origin, or pressing it once skips a stop entirely.
    const travelling = phase.kind === 'travel';
    const currentIndex = travelling ? Math.max(0, phase.stopIndex - 1) : phase.stopIndex;
    const nextIndex = travelling ? phase.stopIndex : null;

    this.bus.emit('tour:progress', {
      tourId: this.script.tour_id,
      stopIndex: currentIndex,
      stopId: this.script.stops[currentIndex]?.stop_id ?? null,
      stopName: this.script.stops[currentIndex]?.name ?? null,
      nextStopIndex: nextIndex,
      nextStopName: nextIndex === null ? null : this.script.stops[nextIndex]?.name ?? null,
      legIndex: phase.legIndex,
      phase: this.clockS >= this.totalS
        ? 'finished'
        : this.waitingForUser
          ? 'acting'
          : travelling
            ? 'travelling'
            : 'dwelling',
      instruction: null,
      elapsedS: this.clockS,
      totalS: this.totalS,
      distanceRemainingM: remaining,
    });
  }
}

function defaultActionDuration(action: TourAction): number {
  switch (action.type) {
    case 'narrate':
      return action.text ? estimateReadSeconds(action.text) : 4;
    case 'capture_photo':
    case 'group_photo':
      return 3;
    case 'look_at':
      return 5;
    case 'wait_for_user':
      return 0;
    default:
      return 1;
  }
}

/** Rough narration timing at a relaxed 2.6 words per second. */
function estimateReadSeconds(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return Math.max(2.5, words / 2.6);
}
