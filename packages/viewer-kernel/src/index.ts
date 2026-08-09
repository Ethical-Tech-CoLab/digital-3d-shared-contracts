/**
 * @d3d/viewer-kernel
 *
 * The shared runtime for every Digital 3D module viewer. Framework-agnostic: no React, no three.js,
 * no DOM beyond `fetch`. Shells depend on this package; this package depends on no shell.
 *
 * See VIEWER-MODES.md for why this boundary exists and what belongs on each side of it.
 */

export { Frame, FrameError, resolvePlacement, applyPlacement, toSceneVec, sceneVecToPosition } from './georef.js';
export type { AnchorResolver, Ellipsoid, ResolvedPlacement } from './georef.js';

export { EventBus } from './bus.js';
export type { KernelEvents, TourProgress, CapturedPhoto } from './bus.js';

export { LodSelector, screenSpaceError, viewportScale } from './lod.js';
export type { SelectOptions, ViewportState } from './lod.js';

export {
  BasemapController,
  lonLatToMercator,
  mercatorToLonLat,
  lonLatToTile,
  tileToLonLat,
  metersPerPixel,
  zoomForResolution,
  tileUrl,
  tileCoverage,
} from './basemap.js';
export type { TileAddress, TileQuad, TileCoverageOptions } from './basemap.js';

export { ModuleRegistry, defaultFetcher } from './registry.js';
export type { Fetcher, LoadedModule, ModuleRegistryOptions } from './registry.js';

export { TileStreamer } from './streaming.js';
export type { StreamerOptions, StreamingCamera, StreamingUpdate, TileDecision } from './streaming.js';

export { Polyline, decodePolyline, pathToScene, easeValue, shortestAngleDelta } from './tour/route.js';
export type { SampledPoint } from './tour/route.js';

export { TourPlayer } from './tour/player.js';
export type { TourCameraState, TourPlayerOptions, TourPhaseKind } from './tour/player.js';

export { MapCamera } from './mapcamera.js';
export type { MapView, MapCameraLimits, Easing } from './mapcamera.js';
