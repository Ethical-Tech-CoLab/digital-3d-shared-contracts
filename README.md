# Digital 3D — Shared Contracts

Shared contracts and viewer tooling for a stack of independently owned 3D modules.

**This repository contains no module data.** No buildings, no bridge geometry, no tiles, no tours.
Only the things that must be agreed once and used by everyone: schemas, the documents that explain
them, and the runtime packages both viewers consume.

| Repository | Owns |
|---|---|
| `digital-3d-shared-contracts` | schemas, coordinate system, viewer kernel, tour player |
| `manhattan-bridge-3d` | the bridge: geometry, dimensions, component taxonomy, inspect UI |
| `dumbo-district-3d` | the neighbourhood: buildings, streets, terrain, streaming, walk UI |

---

## Start here

| Document | Question it answers |
|---|---|
| [VIEWER-MODES.md](VIEWER-MODES.md) | How can one application be both a CAD inspector and a district walkthrough without forking? |
| [COORDINATE-SYSTEM.md](COORDINATE-SYSTEM.md) | Where is anything, and which zero is `z = 0`? |
| [BASEMAP-LAYERS.md](BASEMAP-LAYERS.md) | How do you put terrain/street/satellite behind a view without inheriting a vendor's architecture? |
| [SCENE-DRESSING.md](SCENE-DRESSING.md) | How do you make a district feel like a place while the viewer stays generic? |
| [TOUR-SCRIPT.md](TOUR-SCRIPT.md) | How do external walking instructions drive the viewer? |
| [VIEWER-API.md](VIEWER-API.md) | What does the shared runtime expose, and what must a shell implement? |
| [GOVERNANCE.md](GOVERNANCE.md) | Who may change what, and how does a contract change get made? |

---

## Layout

```
schemas/                 JSON Schema 2020-12, the normative contracts
  common.defs            shared primitives: URNs, positions, confidence, placement
  georeference           a scene frame and its binding to the Earth
  source-confidence      the evidence model, A to D
  metadata               what every selectable object carries
  lod                    a module's level-of-detail ladder
  asset-registry         the catalogue of what a module publishes
  tile-index             the spatial index for streamed content
  module-manifest        the single entry point one module publishes for another
  tour-script            externally authored walking instructions
  basemap                raster map layers behind a plan view, provider-agnostic
  scene-props            instanced environmental dressing: trees, benches, lamps

frames/                  published frame instances, frozen and shared
  nyc-harbor-enu.json    the canonical scene frame for the New York Harbour modules

packages/
  contracts/             TypeScript types mirroring every schema, plus helpers
  viewer-kernel/         framework-agnostic runtime: frames, registry, LOD,
                         streaming, event bus, tour player

examples/                tiny synthetic fixtures, used only to self-test the schemas
tools/validate.mjs       schema compiler and document validator
```

### `frames/` is not module data

A frame is a shared decision, like a schema: it is agreed once and every module depends on it.
`nyc-harbor-enu.json` is the canonical instance. Modules **copy it byte-for-byte and reference it**;
they do not author their own. The anchor is frozen for the life of contract major version 1, because
every asset coordinate in every module is expressed relative to it.

Consuming builds should verify against it. `dumbo-district-3d` fails its build if the frame generated
from its own control document drifts from this file.

---

## Using it

Validate a document a module produced:

```bash
npm install
node tools/validate.mjs ../dumbo-district-3d/viewer/public/district/district-manifest.json
node tools/validate.mjs --schema tour-script path/to/tour.json
node tools/validate.mjs            # self-test the bundled fixtures
```

Consume the runtime from a module viewer. The packages are plain TypeScript, so a bundler can take
them directly; `dumbo-district-3d/viewer/vite.config.ts` aliases them from the sibling checkout:

```ts
import { Frame, LodSelector, ModuleRegistry, TileStreamer, TourPlayer } from '@d3d/viewer-kernel';
import type { ModuleManifest, TourScript } from '@d3d/contracts';

const registry = new ModuleRegistry({ bus });
const district = await registry.load('district/district-manifest.json');
const frame = new Frame(district.georeference);
```

---

## The three ideas worth knowing

**One frame.** Every module declares a `georeference` and expresses coordinates in it. A module with
its own engineering frame keeps it and publishes a `placement`. Vertical datums are named, never
assumed, which is what stops a bridge authored against mean high water from sitting 0.59 m into
buildings authored against NAVD88.

**One LOD axis.** Every level from every module is placed on `max_geometric_error_m`. A viewer mode
is not a separate ladder; it is a different screen-space-error budget on the shared one. That single
number is the whole difference between CAD inspection and an efficient walkthrough.

**One dependency surface.** A module manifest is everything a consumer may know about a producer.
No source-tree access, no shared geometry, no duplicated towers. A `proxy` makes a neighbouring
module cheap to show; a `handoff` makes it possible to stop showing it and start inspecting it.

---

## Versioning

`contract_version` is `1.0.0` and appears in every document. Within a major version, additions are
allowed and removals are not. The frame anchor in a published `georeference` is frozen for the life
of a major version, because every coordinate in every module depends on it.

See [GOVERNANCE.md](GOVERNANCE.md) for the change process.
