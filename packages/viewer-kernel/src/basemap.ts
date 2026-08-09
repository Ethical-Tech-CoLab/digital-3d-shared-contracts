/**
 * Basemap tiling.
 *
 * Web maps are standardised in a way 3D scenes are not: essentially every raster provider —
 * Google, Bing, Apple, Esri, USGS, OpenStreetMap, MapTiler, Carto — serves 256 or 512 pixel tiles
 * addressed by z/x/y in Web Mercator (EPSG:3857). So the kernel implements *the protocol*, and a
 * module supplies a URL template. No vendor SDK, no vendor lock-in, and swapping providers is a
 * configuration change rather than a rewrite.
 *
 * This file is deliberately free of any provider name. See BASEMAP-LAYERS.md for why that matters
 * and for the licensing obligations that come with each one.
 */

import type { BasemapLayer, BasemapSet } from '@d3d/contracts';
import type { Frame } from './georef.js';

const EARTH_RADIUS_M = 6378137.0;
const ORIGIN_SHIFT = Math.PI * EARTH_RADIUS_M;

export interface TileAddress {
  z: number;
  x: number;
  y: number;
}

export interface TileQuad extends TileAddress {
  url: string;
  /** Tile corners in scene ENU meters: [minX, minY, maxX, maxY]. */
  bounds: [number, number, number, number];
}

/** Longitude/latitude to Web Mercator meters. */
export function lonLatToMercator(lon: number, lat: number): [number, number] {
  const x = (lon * ORIGIN_SHIFT) / 180;
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const y =
    (Math.log(Math.tan(((90 + clamped) * Math.PI) / 360)) / (Math.PI / 180)) * (ORIGIN_SHIFT / 180);
  return [x, y];
}

export function mercatorToLonLat(x: number, y: number): [number, number] {
  const lon = (x / ORIGIN_SHIFT) * 180;
  let lat = (y / ORIGIN_SHIFT) * 180;
  lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
  return [lon, lat];
}

export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

export function tileToLonLat(x: number, y: number, z: number): [number, number] {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return [lon, (latRad * 180) / Math.PI];
}

/** Ground resolution in meters per pixel at a given latitude and zoom. */
export function metersPerPixel(lat: number, z: number, tileSizePx = 256): number {
  return (
    (Math.cos((lat * Math.PI) / 180) * 2 * Math.PI * EARTH_RADIUS_M) / (tileSizePx * 2 ** z)
  );
}

/**
 * Zoom level whose ground resolution best matches a desired meters-per-pixel.
 *
 * This is what keeps basemap sharpness tied to how far the user has actually zoomed, rather than
 * to a hard-coded level that is blurry when close and wasteful when far.
 */
export function zoomForResolution(
  targetMetersPerPixel: number,
  lat: number,
  tileSizePx = 256,
  minZoom = 0,
  maxZoom = 19,
): number {
  const z = Math.log2(
    (Math.cos((lat * Math.PI) / 180) * 2 * Math.PI * EARTH_RADIUS_M) /
      (tileSizePx * targetMetersPerPixel),
  );
  return Math.max(minZoom, Math.min(maxZoom, Math.round(z)));
}

/**
 * Build a tile URL from a template.
 *
 * Handles the two conventions that differ between providers: `{y}` ordering (XYZ counts rows from
 * the north, TMS from the south) and `{s}` subdomain rotation. `{key}` is substituted from a
 * credential the caller holds — it is never read from the layer document.
 */
export function tileUrl(
  layer: BasemapLayer,
  address: TileAddress,
  credential?: string,
): string {
  const n = 2 ** address.z;
  const y = layer.protocol === 'tms' ? n - 1 - address.y : address.y;

  let url = layer.url_template
    .replace('{z}', String(address.z))
    .replace('{x}', String(address.x))
    .replace('{y}', String(y));

  if (url.includes('{s}')) {
    const subdomains = layer.subdomains?.length ? layer.subdomains : ['a', 'b', 'c'];
    // Deterministic pick, so the same tile always resolves to the same host and stays cacheable.
    const index = Math.abs(address.x + address.y) % subdomains.length;
    url = url.replace('{s}', subdomains[index]);
  }

  if (url.includes('{key}')) {
    if (!credential) {
      throw new Error(
        `basemap layer '${layer.layer_id}' requires a credential (${layer.credential_hint ?? 'unknown config key'}) but none was supplied`,
      );
    }
    url = url.replace('{key}', encodeURIComponent(credential));
  }

  return url;
}

export interface TileCoverageOptions {
  /** Scene-space area to cover: [minX, minY, maxX, maxY] in ENU meters. */
  bounds: [number, number, number, number];
  /** Desired ground resolution; drives zoom selection. */
  metersPerPixel: number;
  /** Hard cap on tiles returned, so a wide view cannot issue thousands of requests. */
  maxTiles?: number;
}

/**
 * Tiles covering a scene-space rectangle, with their corners projected back into scene meters.
 *
 * The projection matters and is easy to get wrong. Basemap tiles are Web Mercator; the scene is a
 * local ENU tangent plane. Over a district these differ by a scale factor of roughly 1/cos(lat)
 * — about 1.32 at NYC's latitude — so pasting Mercator tiles onto ENU coordinates without
 * converting stretches the imagery north-south by a third. Rather than approximate, each tile's
 * corners are taken to lon/lat and then through the frame's own rigorous transform, which makes
 * the imagery line up with the geometry by construction.
 */
export function tileCoverage(
  layer: BasemapLayer,
  frame: Frame,
  options: TileCoverageOptions,
  credential?: string,
): TileQuad[] {
  const [minX, minY, maxX, maxY] = options.bounds;
  const tileSize = layer.tile_size_px ?? 256;
  const anchorLat = frame.doc.anchor.lat;

  const z = zoomForResolution(
    options.metersPerPixel,
    anchorLat,
    tileSize,
    layer.min_zoom ?? 0,
    layer.max_zoom ?? 19,
  );

  // Scene corners to geodetic, then to fractional tile coordinates.
  const corners: Array<[number, number]> = [
    [minX, minY],
    [maxX, minY],
    [minX, maxY],
    [maxX, maxY],
  ];
  let tileMinX = Infinity;
  let tileMaxX = -Infinity;
  let tileMinY = Infinity;
  let tileMaxY = -Infinity;
  for (const [x, y] of corners) {
    const geo = frame.toGeodetic(x, y, 0);
    const t = lonLatToTile(geo.lon, geo.lat, z);
    tileMinX = Math.min(tileMinX, t.x);
    tileMaxX = Math.max(tileMaxX, t.x);
    tileMinY = Math.min(tileMinY, t.y);
    tileMaxY = Math.max(tileMaxY, t.y);
  }

  const x0 = Math.floor(tileMinX);
  const x1 = Math.floor(tileMaxX);
  const y0 = Math.floor(tileMinY);
  const y1 = Math.floor(tileMaxY);

  const maxTiles = options.maxTiles ?? 64;
  const quads: TileQuad[] = [];
  const n = 2 ** z;

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (quads.length >= maxTiles) return quads;
      // Wrap in X, clamp in Y: the world repeats east-west but not north-south.
      const wrappedX = ((tx % n) + n) % n;
      if (ty < 0 || ty >= n) continue;

      const [westLon, northLat] = tileToLonLat(tx, ty, z);
      const [eastLon, southLat] = tileToLonLat(tx + 1, ty + 1, z);

      const sw = frame.toScene(westLon, southLat, 0);
      const ne = frame.toScene(eastLon, northLat, 0);

      quads.push({
        z,
        x: wrappedX,
        y: ty,
        url: tileUrl(layer, { z, x: wrappedX, y: ty }, credential),
        bounds: [sw[0], sw[1], ne[0], ne[1]],
      });
    }
  }

  return quads;
}

/**
 * Resolve a basemap set into something a viewer can drive, and enforce the obligations that come
 * with it: a credential-free default, and attribution for whatever is on screen.
 */
export class BasemapController {
  readonly set: BasemapSet;
  private readonly credentials: Record<string, string>;
  private activeId: string;

  constructor(set: BasemapSet, credentials: Record<string, string> = {}) {
    this.set = set;
    this.credentials = credentials;

    const usable = set.layers.filter((l) => this.isUsable(l));
    if (!usable.length) {
      throw new Error(
        'no usable basemap layer: every declared layer requires a credential that was not supplied',
      );
    }
    const preferred = set.layers.find((l) => l.layer_id === set.default_layer);
    this.activeId =
      preferred && this.isUsable(preferred) ? preferred.layer_id : usable[0].layer_id;
  }

  /** A layer is usable when it needs no credential, or the credential is actually present. */
  isUsable(layer: BasemapLayer): boolean {
    if (!layer.requires_credential) return true;
    return Boolean(layer.credential_hint && this.credentials[layer.credential_hint]);
  }

  get layers(): BasemapLayer[] {
    return this.set.layers;
  }

  get usableLayers(): BasemapLayer[] {
    return this.set.layers.filter((l) => this.isUsable(l));
  }

  get active(): BasemapLayer {
    return this.set.layers.find((l) => l.layer_id === this.activeId)!;
  }

  select(layerId: string): boolean {
    const layer = this.set.layers.find((l) => l.layer_id === layerId);
    if (!layer || !this.isUsable(layer)) return false;
    this.activeId = layerId;
    return true;
  }

  credentialFor(layer: BasemapLayer): string | undefined {
    return layer.credential_hint ? this.credentials[layer.credential_hint] : undefined;
  }

  coverage(frame: Frame, options: TileCoverageOptions): TileQuad[] {
    const layer = this.active;
    return tileCoverage(layer, frame, options, this.credentialFor(layer));
  }

  /**
   * Attribution lines that MUST be displayed right now: the active basemap plus any overlays.
   * Every major provider requires this, and several also require their logo.
   */
  activeAttribution(): string[] {
    const lines = [this.active.attribution_text];
    for (const overlay of this.set.overlays ?? []) {
      if (this.isUsable(overlay)) lines.push(overlay.attribution_text);
    }
    return [...new Set(lines)];
  }

  /** Warn when the selected layer is not cleared for commercial use. */
  commercialWarning(): string | null {
    const layer = this.active;
    if (layer.commercial_use === 'prohibited' || layer.commercial_use === 'restricted') {
      return `Basemap '${layer.label}' is ${layer.commercial_use} for commercial use: ${layer.usage_policy ?? 'see terms'}`;
    }
    return null;
  }
}
