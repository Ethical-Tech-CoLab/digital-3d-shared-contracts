/**
 * Module loading and cross-module asset resolution.
 *
 * Enforces the rule from VIEWER-MODES.md section 4: a module's manifest is its entire dependency
 * surface. Nothing here reaches into another project's source tree, and a missing optional
 * dependency degrades to a warning rather than a failure, so neither project can break the other's
 * build.
 */

import type {
  AssetMetadata,
  AssetRegistry,
  AssetUrn,
  Georeference,
  LodLadder,
  ModuleId,
  ModuleManifest,
  RegistryAsset,
  TileIndex,
} from '@d3d/contracts';
import { parseUrn } from '@d3d/contracts';
import type { EventBus, KernelEvents } from './bus.js';

export type Fetcher = (url: string) => Promise<unknown>;

export const defaultFetcher: Fetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

  // A dev server or SPA host commonly answers a missing file with 200 and index.html. Left alone
  // that surfaces as "Unexpected token '<'", which tells a reader nothing about what went wrong.
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !/json/i.test(contentType)) {
    throw new Error(
      `expected JSON but the server returned '${contentType.split(';')[0]}' — the file is probably missing`,
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(
      `response was not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
};

function resolveUrl(base: string, relative: string): string {
  if (/^([a-z]+:)?\/\//i.test(relative) || relative.startsWith('/')) return relative;
  const trimmed = base.replace(/[^/]*$/, '');
  return trimmed + relative;
}

export interface LoadedModule {
  manifest: ModuleManifest;
  manifestUrl: string;
  /** Absolute URL the asset registry was fetched from, used to resolve its base_url. */
  registryUrl: string | null;
  /** Absolute URL the tile index was fetched from, used to resolve its base_url. */
  tileIndexUrl: string | null;
  georeference: Georeference;
  ladder: LodLadder;
  registry: AssetRegistry | null;
  tileIndex: TileIndex | null;
  /** True when this module was loaded because another module depends on it. */
  isDependency: boolean;
}

export interface ModuleRegistryOptions {
  fetcher?: Fetcher;
  bus?: EventBus<KernelEvents>;
}

export class ModuleRegistry {
  private readonly fetcher: Fetcher;
  private readonly bus?: EventBus<KernelEvents>;
  private readonly modules = new Map<ModuleId, LoadedModule>();
  private readonly assets = new Map<AssetUrn, { module: LoadedModule; asset: RegistryAsset }>();
  private readonly missing = new Map<ModuleId, string>();

  constructor(options: ModuleRegistryOptions = {}) {
    this.fetcher = options.fetcher ?? defaultFetcher;
    this.bus = options.bus;
  }

  get loaded(): LoadedModule[] {
    return [...this.modules.values()];
  }

  get missingModules(): Array<{ moduleId: ModuleId; reason: string }> {
    return [...this.missing.entries()].map(([moduleId, reason]) => ({ moduleId, reason }));
  }

  module(moduleId: ModuleId): LoadedModule | undefined {
    return this.modules.get(moduleId);
  }

  /**
   * Load a manifest and, recursively, its declared dependencies.
   *
   * A dependency marked `required: false` that fails to load is recorded and announced on the bus,
   * but does not throw. That is deliberate: the district must still render when the bridge module
   * has not been published yet.
   */
  async load(manifestUrl: string, isDependency = false): Promise<LoadedModule> {
    const manifest = (await this.fetcher(manifestUrl)) as ModuleManifest;
    if (!manifest.module_id) {
      throw new Error(`${manifestUrl}: not a module manifest (no module_id)`);
    }

    const existing = this.modules.get(manifest.module_id);
    if (existing) return existing;

    const georeference =
      'url' in manifest.georeference
        ? ((await this.fetcher(resolveUrl(manifestUrl, manifest.georeference.url))) as Georeference)
        : manifest.georeference;

    const ladder =
      'url' in manifest.lod_ladder
        ? ((await this.fetcher(resolveUrl(manifestUrl, manifest.lod_ladder.url))) as LodLadder)
        : manifest.lod_ladder;

    const registryUrl = manifest.asset_registry_url
      ? resolveUrl(manifestUrl, manifest.asset_registry_url)
      : null;
    const registry = registryUrl ? ((await this.fetcher(registryUrl)) as AssetRegistry) : null;

    const tileIndexUrl = manifest.tile_index_url
      ? resolveUrl(manifestUrl, manifest.tile_index_url)
      : null;
    const tileIndex = tileIndexUrl ? ((await this.fetcher(tileIndexUrl)) as TileIndex) : null;

    const loaded: LoadedModule = {
      manifest,
      manifestUrl,
      registryUrl,
      tileIndexUrl,
      georeference,
      ladder,
      registry,
      tileIndex,
      isDependency,
    };
    this.modules.set(manifest.module_id, loaded);

    if (registry) {
      for (const asset of registry.assets) {
        this.assets.set(asset.asset_id, { module: loaded, asset });
      }
    }

    this.bus?.emit('module:loaded', { moduleId: manifest.module_id });

    for (const dependency of manifest.depends_on ?? []) {
      if (this.modules.has(dependency.module_id)) continue;
      const url = resolveUrl(manifestUrl, dependency.manifest_url);
      try {
        await this.load(url, true);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.missing.set(dependency.module_id, reason);
        this.bus?.emit('module:missing', { moduleId: dependency.module_id, url, reason });
        if (dependency.required) {
          throw new Error(
            `required dependency '${dependency.module_id}' could not be loaded from ${url}: ${reason}`,
          );
        }
        console.warn(
          `[d3d] optional module '${dependency.module_id}' unavailable (${reason}); ` +
            'continuing without it',
        );
      }
    }

    return loaded;
  }

  /** Resolve a URN to its registry entry, wherever it lives. */
  resolve(urn: AssetUrn): { module: LoadedModule; asset: RegistryAsset } | null {
    const direct = this.assets.get(urn);
    if (direct) return direct;

    // The asset may belong to a module that declares it but ships no registry entry, e.g. a proxy
    // named only in the manifest. Fall back to the manifest-level proxy declaration.
    const parsed = parseUrn(urn);
    if (!parsed) return null;
    const module = this.modules.get(parsed.moduleId);
    if (!module) return null;
    if (module.manifest.proxy?.asset_id === urn) {
      return {
        module,
        asset: { asset_id: urn, kind: 'proxy' },
      };
    }
    return null;
  }

  async metadataFor(urn: AssetUrn): Promise<AssetMetadata | null> {
    const entry = this.resolve(urn);
    if (!entry) return null;
    if (entry.asset.metadata) return entry.asset.metadata;
    if (!entry.asset.metadata_url) return null;
    return (await this.fetcher(this.urlFor(entry.module, entry.asset.metadata_url))) as AssetMetadata;
  }

  /**
   * The LOD cap a host must respect for a foreign module's content.
   * Returns undefined when the module is the host itself or declares no proxy cap.
   */
  proxyCapFor(moduleId: ModuleId, hostModuleId: ModuleId): number | undefined {
    if (moduleId === hostModuleId) return undefined;
    return this.modules.get(moduleId)?.manifest.proxy?.max_level;
  }

  /** Every attribution line that must be shown for the currently loaded modules. */
  attributions(): string[] {
    const out = new Set<string>();
    for (const module of this.modules.values()) {
      for (const line of module.manifest.attribution ?? []) out.add(line);
    }
    return [...out];
  }

  /**
   * Absolute URL for a payload declared relative to a module's registry or tile index.
   *
   * `base_url` is resolved against the document that declares it, not against the consuming page.
   * Getting this wrong is silent and total: every payload 404s while the manifest looks fine.
   */
  urlFor(module: LoadedModule, relative: string, kind: 'registry' | 'tiles' = 'registry'): string {
    const declaringUrl = (kind === 'tiles' ? module.tileIndexUrl : module.registryUrl) ?? module.manifestUrl;
    const declaredBase = kind === 'tiles' ? module.tileIndex?.base_url : module.registry?.base_url;
    const base = declaredBase ? resolveUrl(declaringUrl, declaredBase) : declaringUrl;
    return resolveUrl(base, relative);
  }
}
