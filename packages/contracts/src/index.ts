/**
 * TypeScript mirror of the Digital 3D shared contract schemas.
 *
 * Hand-written rather than generated so the types stay readable and can carry the same explanatory
 * comments the schemas do. `tools/check-parity.mjs` verifies that every schema has a corresponding
 * exported type, so the two cannot silently drift.
 *
 * Source of truth remains the JSON Schema files in ../../schemas.
 */

export const CONTRACT_VERSION = '1.0.0';

// ---------------------------------------------------------------- common.defs

export type Confidence = 'A' | 'B' | 'C' | 'D';

export type SourceBasis =
  | 'official_dataset'
  | 'drawing'
  | 'official_facts'
  | 'survey'
  | 'lidar'
  | 'photo'
  | 'imagery'
  | 'mesh_reference'
  | 'photogrammetry'
  | 'control_dimension'
  | 'procedural'
  | 'inferred';

export type ReviewStatus = 'unreviewed' | 'agent_reviewed' | 'human_reviewed' | 'rejected';

export type VerticalDatum = 'NAVD88' | 'MHW' | 'MSL' | 'MLLW' | 'ellipsoid_wgs84' | 'scene_local';

export type Vec3 = [number, number, number];
export type Quaternion = [number, number, number, number];
export type LonLat = [number, number];

/** urn:d3d:<module_id>:<local_id> */
export type AssetUrn = string;
export type ModuleId = string;

export interface GeodeticPosition {
  lon: number;
  lat: number;
  height_m?: number;
  vertical_datum?: VerticalDatum;
}

export interface ScenePosition {
  frame: string;
  xyz: Vec3;
}

export interface AssetPosition {
  asset: AssetUrn;
  anchor?: 'centroid' | 'bbox_center' | 'bbox_top' | 'entrance' | 'origin';
  offset_m?: Vec3;
}

export type Position = GeodeticPosition | ScenePosition | AssetPosition;

export function isGeodetic(p: Position): p is GeodeticPosition {
  return typeof (p as GeodeticPosition).lat === 'number';
}
export function isScene(p: Position): p is ScenePosition {
  return Array.isArray((p as ScenePosition).xyz);
}
export function isAssetRef(p: Position): p is AssetPosition {
  return typeof (p as AssetPosition).asset === 'string';
}

export interface BBoxScene {
  frame: string;
  min: Vec3;
  max: Vec3;
}

export type BBoxGeodetic = number[];

export interface Placement {
  frame: string;
  translation_m: Vec3;
  rotation_quat?: Quaternion;
  yaw_deg?: number;
  scale?: number;
  confidence: Confidence;
  provisional?: boolean;
  open_questions?: string[];
  notes?: string;
}

export interface Provenance {
  module_id: ModuleId;
  generated_by: string;
  generated_at: string;
  source_documents?: Array<{ path: string; sha256?: string }>;
}

// --------------------------------------------------------------- georeference

export interface Georeference {
  contract_version: string;
  frame_id: string;
  kind: 'enu';
  units: 'meters';
  axes: { x: 'east'; y: 'north'; z: 'up'; handedness: 'right' };
  anchor: {
    lon: number;
    lat: number;
    height_m?: number;
    vertical_datum: VerticalDatum;
    horizontal_crs?: string;
    rationale?: string;
  };
  vertical_datum_offsets_m?: Record<string, number>;
  valid_radius_m: number;
  max_planar_error_m?: number;
  ellipsoid?: { name: 'WGS84'; semi_major_axis_m: number; inverse_flattening: number };
  render_convention: { gltf_up_axis: 'Y'; scene_to_render: string };
  source_refs?: string[];
  confidence: Confidence;
  notes?: string;
  provenance?: Provenance;
}

// ----------------------------------------------------------------- confidence

export interface SourceEntry {
  source_id: string;
  title: string;
  tier: 'A' | 'B' | 'C';
  publisher?: string;
  url?: string;
  accessed?: string;
  license: string;
  attribution_required?: boolean;
  attribution_text?: string;
  native_crs?: string;
  vertical_datum?: VerticalDatum;
  units?: string;
  positional_accuracy_m?: number;
  grants_confidence: Confidence;
  verified?: boolean;
  notes?: string;
}

export interface SourceRegister {
  contract_version: string;
  module_id: ModuleId;
  grades: Record<Confidence, string>;
  weakest_link_rule: true;
  tier_rule?: string;
  sources: SourceEntry[];
  provenance?: Provenance;
}

// ------------------------------------------------------------------- metadata

export type AssetCategory =
  | 'building'
  | 'structure'
  | 'bridge_component'
  | 'terrain'
  | 'street'
  | 'sidewalk'
  | 'waterfront'
  | 'water'
  | 'park'
  | 'streetscape'
  | 'landmark'
  | 'reference'
  | 'annotation';

export interface AssetMetadata {
  asset_id: AssetUrn;
  module_id: ModuleId;
  local_id: string;
  display_name?: string;
  category: AssetCategory;
  taxonomy?: { system?: string; subsystem?: string | null; path?: string[] };
  source_basis: SourceBasis[];
  source_refs?: string[];
  confidence: Confidence;
  basis_confidence?: Confidence;
  control_refs?: string[];
  open_questions?: string[];
  review_status: ReviewStatus;
  last_modified_by: string;
  units?: 'meters';
  bbox?: BBoxScene;
  anchor?: ScenePosition;
  attributes?: Record<string, string | number | boolean | null>;
  extensions?: Record<string, Record<string, unknown>>;
  notes?: string;
}

// ------------------------------------------------------------------------ LOD

export type PayloadFormat = 'glb' | 'gltf' | '3dtiles' | 'geojson' | 'json' | 'ktx2' | 'none';

export type LodIntent = 'inspect' | 'traverse' | 'context' | 'silhouette';

export type Representation =
  | 'cad_solid'
  | 'segmented_mesh'
  | 'mesh'
  | 'extruded_footprint'
  | 'block'
  | 'impostor'
  | 'billboard'
  | 'point_cloud'
  | 'line_skeleton'
  | 'map_polygon';

export interface LodLevel {
  level: number;
  name: string;
  intent: LodIntent;
  max_geometric_error_m: number;
  representation: Representation;
  payload_format: PayloadFormat;
  triangle_budget?: number | null;
  selectable?: boolean;
  carries_metadata?: boolean;
  streamed?: boolean;
  typical_distance_m?: { min: number; max?: number | null };
  notes?: string;
}

export type ViewerMode = 'inspect' | 'walk' | 'map' | 'tour';

export interface LodLadder {
  contract_version: string;
  module_id: ModuleId;
  ladder_id: string;
  levels: LodLevel[];
  selection: {
    policy: 'screen_space_error' | 'distance_band';
    default_sse_budget_px: number;
    mode_sse_budget_px?: Partial<Record<ViewerMode, number>>;
    hysteresis?: number;
  };
  notes?: string;
}

// ------------------------------------------------------------- asset registry

export interface AssetVariant {
  level: number;
  url?: string;
  format: PayloadFormat;
  byte_size?: number;
  triangle_count?: number;
  max_geometric_error_m?: number;
  node_name?: string;
  sha256?: string;
}

export interface RegistryAsset {
  asset_id: AssetUrn;
  kind: 'single' | 'aggregate' | 'tileset' | 'proxy';
  represents?: AssetUrn;
  metadata?: AssetMetadata;
  metadata_url?: string;
  bbox?: BBoxScene;
  bbox_geodetic?: BBoxGeodetic;
  placement?: Placement;
  variants?: AssetVariant[];
  tile_index_url?: string;
  tags?: string[];
}

export interface AssetRegistry {
  contract_version: string;
  module_id: ModuleId;
  frame_id: string;
  ladder_id: string;
  base_url?: string;
  assets: RegistryAsset[];
  provenance?: Provenance;
}

// ----------------------------------------------------------------- tile index

export type TileZone = 'hero' | 'walkable' | 'context' | 'outside';

export interface TileContent {
  level: number;
  url: string;
  format: PayloadFormat;
  byte_size?: number;
  max_geometric_error_m?: number;
  sha256?: string;
}

export interface Tile {
  tile_id: string;
  col: number;
  row: number;
  bbox: BBoxScene;
  bbox_geodetic?: BBoxGeodetic;
  zone: TileZone;
  asset_count?: number;
  content: TileContent[];
  foreign_assets?: AssetUrn[];
}

export interface TileIndex {
  contract_version: string;
  module_id: ModuleId;
  frame_id: string;
  ladder_id: string;
  base_url?: string;
  scheme: {
    kind: 'planar_grid';
    tile_size_m: number;
    origin_xy_m: [number, number];
    grid_size: [number, number];
    id_pattern: 't_{col}_{row}';
  };
  streaming: {
    load_radius_m: number;
    unload_radius_m: number;
    prefetch_along_heading_m?: number;
    max_concurrent_requests?: number;
  };
  tiles: Tile[];
  provenance?: Provenance;
}

// ------------------------------------------------------------ module manifest

export interface CameraPose {
  position: Position;
  target?: Position;
  fov_deg?: number;
}

export interface HandoffEntryPoint {
  entry_id: string;
  label: string;
  focus_asset?: AssetUrn;
  camera?: CameraPose;
  trigger_volume?: BBoxScene;
}

export interface ModuleManifest {
  contract_version: string;
  module_id: ModuleId;
  title: string;
  subtitle?: string;
  module_version: string;
  owner: { team: string; repository: string };
  authoritative_for: string[];
  depends_on?: Array<{
    module_id: ModuleId;
    manifest_url: string;
    required?: boolean;
    min_module_version?: string;
  }>;
  georeference: Georeference | { url: string };
  placement?: Placement;
  lod_ladder: LodLadder | { url: string };
  asset_registry_url?: string;
  tile_index_url?: string;
  source_register_url?: string;
  modes: ViewerMode[];
  proxy?: {
    asset_id: AssetUrn;
    max_level: number;
    bbox_geodetic?: BBoxGeodetic;
    notes?: string;
  };
  handoff?: {
    supported: boolean;
    target_mode?: ViewerMode;
    entry_points?: HandoffEntryPoint[];
    preserve_camera?: boolean;
    ui_url?: string;
  };
  attribution?: string[];
  extensions?: Record<string, Record<string, unknown>>;
  not_implemented_yet?: string[];
  provenance?: Provenance;
}

// ----------------------------------------------------------------- tour script

export type ManeuverType =
  | 'depart'
  | 'continue'
  | 'turn-left'
  | 'turn-right'
  | 'turn-slight-left'
  | 'turn-slight-right'
  | 'turn-sharp-left'
  | 'turn-sharp-right'
  | 'uturn'
  | 'cross-street'
  | 'enter-park'
  | 'board-elevator'
  | 'stairs-up'
  | 'stairs-down'
  | 'ramp-up'
  | 'ramp-down'
  | 'arrive';

export type ActionType =
  | 'look_at'
  | 'pan'
  | 'dwell'
  | 'narrate'
  | 'capture_photo'
  | 'group_photo'
  | 'highlight'
  | 'show_metadata'
  | 'set_mode'
  | 'enter_inspect'
  | 'exit_inspect'
  | 'set_time_of_day'
  | 'wait_for_user'
  | 'set_speed'
  | 'map_focus';

export interface TourAction {
  type: ActionType;
  at_s?: number;
  duration_s?: number;
  blocking?: boolean;
  target?: Position;
  text?: string;
  audio_url?: string;
  framing?: 'wide' | 'normal' | 'tele' | 'portrait' | 'selfie';
  capture?: { width?: number; height?: number; filename?: string; include_party?: boolean };
  mode?: 'walk' | 'inspect' | 'map';
  entry_id?: string;
  module_id?: ModuleId;
  time_of_day?: string;
  speed_multiplier?: number;
  map_span_m?: number;
  heading_deg?: number;
  pitch_deg?: number;
  label?: string;
}

export interface CameraBehaviour {
  rig?: 'first_person' | 'over_shoulder' | 'drone' | 'fixed';
  look?: 'forward' | 'at_target' | 'free' | 'hold';
  height_offset_m?: number;
  distance_m?: number;
  fov_deg?: number;
  bob?: boolean;
}

export interface Transition {
  kind?: 'walk' | 'ease' | 'cut' | 'fade' | 'teleport';
  duration_s?: number;
  easing?: 'linear' | 'ease_in' | 'ease_out' | 'ease_in_out';
}

export interface PartyMember {
  member_id: string;
  name?: string;
  role: 'adult' | 'child' | 'guide' | 'companion';
  eye_height_m?: number;
  pace_mps?: number;
}

export interface Party {
  size: number;
  label?: string;
  members?: PartyMember[];
  point_of_view?: string;
  pace_mps?: number;
  accessibility?: {
    avoid_stairs?: boolean;
    avoid_steep_grades?: boolean;
    max_grade_percent?: number;
  };
}

export interface TourDefaults {
  dwell_s?: number;
  eye_height_m?: number;
  camera?: CameraBehaviour;
  transition?: Transition;
  viewer_mode?: 'walk' | 'inspect' | 'map';
  speed_multiplier?: number;
  time_of_day?: string;
  weather?: 'clear' | 'overcast' | 'rain' | 'snow' | 'fog';
}

export type TourPath =
  | { geodetic: LonLat[] }
  | { scene: Array<[number, number] | [number, number, number]> }
  | { encoded_polyline: string };

export interface TourStop {
  stop_id: string;
  name: string;
  position: Position;
  heading_deg?: number;
  dwell_s?: number;
  viewer_mode?: 'walk' | 'inspect' | 'map';
  camera?: CameraBehaviour;
  on_arrive?: TourAction[];
  on_depart?: TourAction[];
  optional?: boolean;
  tags?: string[];
  notes?: string;
}

export interface TourStep {
  step_id?: string;
  maneuver: ManeuverType;
  instruction?: string;
  street_name?: string;
  distance_m?: number;
  duration_s?: number;
  path?: TourPath;
  actions?: TourAction[];
}

export interface TourLeg {
  leg_id?: string;
  from_stop: string;
  to_stop: string;
  distance_m?: number;
  duration_s?: number;
  transition?: Transition;
  path?: TourPath;
  steps?: TourStep[];
}

export interface TourScript {
  contract_version: string;
  tour_id: string;
  title: string;
  description?: string;
  locale?: string;
  frame_id?: string;
  requires_modules?: ModuleId[];
  party?: Party;
  defaults?: TourDefaults;
  route_source?: {
    provider:
      | 'manual'
      | 'google_maps'
      | 'bing_maps'
      | 'apple_maps'
      | 'osrm'
      | 'valhalla'
      | 'graphhopper'
      | 'internal_router';
    profile?: 'walking' | 'wheelchair' | 'cycling';
    generated_at?: string;
    attribution_text?: string;
    notes?: string;
  };
  stops: TourStop[];
  legs?: TourLeg[];
  totals?: {
    distance_m?: number;
    walking_duration_s?: number;
    dwell_duration_s?: number;
    estimated_duration_s?: number;
  };
}

// ------------------------------------------------------------------ basemap

export type BasemapKind =
  | 'street'
  | 'terrain'
  | 'satellite'
  | 'hybrid'
  | 'labels'
  | 'transit'
  | 'custom';

export interface BasemapLayer {
  layer_id: string;
  label: string;
  kind: BasemapKind;
  protocol?: 'xyz' | 'tms' | 'wmts';
  url_template: string;
  subdomains?: string[];
  tile_size_px?: 256 | 512;
  min_zoom?: number;
  max_zoom?: number;
  requires_credential?: boolean;
  /** Name of the env var or config field holding the credential. Never the value itself. */
  credential_hint?: string;
  attribution_text: string;
  attribution_url?: string;
  license: string;
  terms_url?: string;
  usage_policy?: string;
  commercial_use?: 'permitted' | 'restricted' | 'prohibited' | 'unknown';
  opacity?: number;
  notes?: string;
}

export interface BasemapSet {
  contract_version: string;
  module_id: ModuleId;
  default_layer: string;
  layers: BasemapLayer[];
  overlays?: BasemapLayer[];
  notes?: string;
  provenance?: Provenance;
}

// -------------------------------------------------------------- scene props

export type PropKind =
  | 'tree'
  | 'shrub'
  | 'bench'
  | 'lamp'
  | 'traffic_light'
  | 'bollard'
  | 'planter'
  | 'hydrant'
  | 'sign'
  | 'kiosk'
  | 'bin'
  | 'fence'
  | 'wall'
  | 'awning'
  | 'parked_vehicle'
  | 'person'
  | 'custom';

export interface ScenePrototype {
  prototype_id: string;
  kind: PropKind;
  label?: string;
  url?: string;
  format?: 'glb' | 'gltf' | 'procedural';
  size_m?: Vec3;
  billboard?: boolean;
  casts_shadow?: boolean;
  source_basis: SourceBasis[];
  source_refs?: string[];
  confidence: Confidence;
  notes?: string;
}

export interface PropInstance {
  /** prototype_id */
  p: string;
  /** [x, y] in scene meters */
  xy: [number, number];
  z?: number;
  /** yaw, degrees */
  r?: number;
  /** uniform scale */
  s?: number;
  tile?: string;
}

export interface ScenePropSet {
  contract_version: string;
  module_id: ModuleId;
  frame_id: string;
  prototypes: ScenePrototype[];
  instances: PropInstance[];
  provenance?: Provenance;
}

// ------------------------------------------------------------- photo survey

export type PhotoCategory =
  | 'facade'
  | 'surface'
  | 'greenery'
  | 'furniture'
  | 'landmark'
  | 'bridge'
  | 'historic'
  | 'context'
  | 'waterside'
  | 'lawn'
  | 'railing';

export type PhotoAspect =
  | 'facade_material'
  | 'facade_colour'
  | 'window_pattern'
  | 'storefront'
  | 'awning'
  | 'signage'
  | 'roofline'
  | 'entrance'
  | 'paving_material'
  | 'kerb'
  | 'street_furniture'
  | 'tree_size'
  | 'tree_species'
  | 'condition'
  | 'other';

export type PhotoUsage = 'reference_only' | 'derive_appearance' | 'redistribute';

export type PhotoReviewStatus =
  | 'submitted'
  | 'auto_screened'
  | 'human_reviewed'
  | 'accepted'
  | 'rejected'
  | 'superseded';

export interface PhotoSubject {
  asset_id: AssetUrn;
  aspect: PhotoAspect[];
  visibility?: 'clear' | 'partial' | 'obstructed';
  distance_m?: number;
}

export interface PhotoQuality {
  pixels_long_edge?: number;
  sharpness?: 'sharp' | 'acceptable' | 'soft';
  lighting?: 'even' | 'harsh_shadow' | 'backlit' | 'night' | 'overcast';
  obstruction?: 'none' | 'vehicles' | 'foliage' | 'scaffolding' | 'people' | 'heavy';
  rectified?: boolean;
  /**
   * A measurement, not a test. Across a real corpus interiors scored 0.16-0.79 and
   * exteriors 0.51-1.00, so no threshold separates them. Publish the number and let
   * a human decide.
   */
  sky_fraction?: number;
}

export interface PhotoReview {
  status: PhotoReviewStatus;
  reviewer?: string;
  reviewed_at?: string;
  /** Photographs alone never grant A. */
  grants_confidence?: Confidence;
  notes?: string;
}

export interface PhotoObservation {
  observation_id: string;
  image_url?: string;
  thumbnail_url?: string;
  sha256?: string;
  position: Position;
  position_source?:
    | 'exif_gps'
    | 'device_gps'
    | 'geocoded_address'
    | 'manual_placement'
    | 'photogrammetric_solve'
    | 'unknown';
  position_accuracy_m?: number;
  bearing_deg?: number;
  bearing_source?: 'exif_compass' | 'device_compass' | 'inferred_from_subject' | 'manual' | 'unknown';
  pitch_deg?: number;
  hfov_deg?: number;
  captured_at?: string;
  captured_precision?: 'exact' | 'day' | 'month' | 'year' | 'decade' | 'unknown';
  season?: 'winter' | 'spring' | 'summer' | 'autumn';
  observes?: PhotoSubject[];
  quality?: PhotoQuality;
  license: string;
  license_url?: string;
  attribution_text?: string;
  rights_holder?: string;
  usage: PhotoUsage;
  contains_people?: boolean;
  privacy_reviewed?: boolean;
  contributor?: {
    handle?: string;
    role?: 'volunteer' | 'staff' | 'archive' | 'third_party';
    contact?: string;
  };
  source_collection?: string;
  /** The primary subject: the first entry of `categories`. */
  category?: PhotoCategory;
  /** Every subject the frame contains. Permissions are the union — see photoCategoryGrants. */
  categories?: PhotoCategory[];
  review: PhotoReview;
  supersedes?: string;
  notes?: string;
}

export interface PhotoSurvey {
  contract_version: string;
  module_id: ModuleId;
  frame_id: string;
  campaign?: {
    campaign_id: string;
    title: string;
    opened?: string;
    closed?: string;
    contact?: string;
    guidance_url?: string;
  };
  observations: PhotoObservation[];
  provenance?: Provenance;
}

// ------------------------------------------------------------------- helpers

/**
 * What each review category permits a photograph to inform.
 *
 * Two axes, because they answer different questions. `aspects` is what the observation
 * may be recorded as evidence FOR; `materials` is the narrower set of palettes whose
 * colour it may actually be measured into; `attaches` is whether it may be bound to one
 * specific building.
 *
 * `bridge` yields no materials on purpose: a neighbouring module owns that subject, and a
 * bridge's paint averaged onto a warehouse is exactly the mistake this prevents. `historic`
 * is the deliberate near-miss — it carries aspects but no materials, because an archival
 * wall may have been repainted twice since the shutter closed.
 *
 * Mirrors REVIEW_CATEGORIES in the district's build_photo_corpus.py.
 */
export interface PhotoCategoryGrant {
  aspects: PhotoAspect[];
  /** Palette keys whose colour may be measured from this photograph. */
  materials: string[];
  /** Whether the photograph may be bound to one specific building. */
  attaches: boolean;
  /** True when another module owns the subject. */
  foreign?: boolean;
  /** True when the photograph describes a past state. */
  historic?: boolean;
}

export const PHOTO_CATEGORY_GRANTS: Record<PhotoCategory, PhotoCategoryGrant> = {
  facade: {
    // A building shot from the street necessarily contains the street, so paving is included.
    aspects: ['facade_material', 'facade_colour', 'window_pattern', 'storefront', 'awning', 'signage', 'roofline', 'entrance'],
    materials: ['brick', 'paving'],
    attaches: true,
  },
  surface: { aspects: ['paving_material', 'kerb'], materials: ['paving'], attaches: false },
  greenery: { aspects: ['tree_size', 'tree_species'], materials: ['foliage', 'paving'], attaches: false },
  furniture: { aspects: ['street_furniture'], materials: ['paving'], attaches: false },
  landmark: { aspects: ['condition', 'other'], materials: ['brick'], attaches: true },
  bridge: { aspects: ['other'], materials: [], attaches: false, foreign: true },
  historic: { aspects: ['condition', 'other'], materials: [], attaches: false, historic: true },
  context: { aspects: ['other'], materials: [], attaches: false },
  waterside: { aspects: ['paving_material', 'condition'], materials: ['riprap'], attaches: false },
  lawn: { aspects: ['tree_size', 'condition'], materials: ['grass', 'foliage'], attaches: false },
  railing: { aspects: ['street_furniture'], materials: [], attaches: false },
};

export const DEFAULT_PHOTO_CATEGORY: PhotoCategory = 'facade';

/**
 * The permissions of a tag set: the union of its members', with one exception.
 *
 * Union is what lets the awkward pairs resolve themselves rather than needing a rule each.
 * `[bridge, facade]` yields exactly the facade's permissions, because bridge contributes
 * nothing to add.
 *
 * `historic` is the exception, and it is contagious rather than unioned: one historic tag
 * suppresses every material in the set. The aspects survive, so the photograph can still
 * say what a building looked like, but no colour may be measured from it — a wall in an
 * archival frame may have been repainted twice since.
 */
export function photoCategoryGrants(categories: PhotoCategory[] | undefined): PhotoCategoryGrant {
  const tags = categories?.length ? categories : [DEFAULT_PHOTO_CATEGORY];
  const aspects = new Set<PhotoAspect>();
  const materials = new Set<string>();
  let attaches = false;
  const historic = tags.some((t) => PHOTO_CATEGORY_GRANTS[t]?.historic === true);
  for (const tag of tags) {
    const grant = PHOTO_CATEGORY_GRANTS[tag];
    if (!grant) continue;
    for (const aspect of grant.aspects) aspects.add(aspect);
    if (!historic) for (const material of grant.materials) materials.add(material);
    attaches = attaches || grant.attaches;
  }
  return {
    aspects: [...aspects],
    materials: [...materials],
    attaches,
    // Foreign only when there is nothing else in the frame we are allowed to look at.
    foreign: tags.every((t) => PHOTO_CATEGORY_GRANTS[t]?.foreign === true),
    historic,
  };
}

/** Confidence colours, shared so both viewers grade identically. */
export const CONFIDENCE_COLORS: Record<Confidence, string> = {
  A: '#2e9e4f',
  B: '#3b7dd8',
  C: '#d89a3b',
  D: '#c4453c',
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  A: 'A · official dimension, drawing or authoritative dataset',
  B: 'B · consistent photos or imagery plus control geometry',
  C: 'C · aligned mesh, photogrammetry or reconstructed value',
  D: 'D · inferred, decorative or placeholder',
};

const CONFIDENCE_ORDER: Confidence[] = ['A', 'B', 'C', 'D'];

/** The weakest-link rule from source-confidence.schema.json, as code. */
export function weakestConfidence(...grades: Array<Confidence | undefined>): Confidence {
  let worst = 0;
  for (const grade of grades) {
    if (!grade) continue;
    worst = Math.max(worst, CONFIDENCE_ORDER.indexOf(grade));
  }
  return CONFIDENCE_ORDER[worst];
}

export function parseUrn(urn: AssetUrn): { moduleId: ModuleId; localId: string } | null {
  const match = /^urn:d3d:([a-z0-9-]+):(.+)$/.exec(urn);
  return match ? { moduleId: match[1], localId: match[2] } : null;
}

export function makeUrn(moduleId: ModuleId, localId: string): AssetUrn {
  return `urn:d3d:${moduleId}:${localId}`;
}
