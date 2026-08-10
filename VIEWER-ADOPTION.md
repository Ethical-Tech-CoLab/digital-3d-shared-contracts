# Adopting the shared bridge inspect shell

`packages/bridge-viewer-ui` is the single React inspect shell for every bridge module. This document
records why it exists, what a module must publish to use it, and where each module currently stands.

## Why

Three bridge repositories each grew their own copy of the same viewer. Measured in February 2026 by
hashing every viewer source file across the three:

| | manhattan | brooklyn | williamsburg |
|---|---:|---:|---:|
| viewer source files | 20 | 17 | 16 |
| unique components | DimensionPanel, PresentationNotice, ReferencePanel, ViewBar | ComparePanel, CompareStage | PhotoGallery |
| files identical across all three | 2 of 23 | 2 of 23 | 2 of 23 |

Only `src/main.tsx` and `tsconfig.json` still matched. `App.tsx`, `BridgeViewer.tsx`, `model.ts`,
`styles.css`, `index.html`, `package.json` and `vite.config.ts` had diverged in all three. The
practical cost was not duplication but **asymmetric features**: Manhattan had a dimension panel, a
view bar, a presentation notice and a reference panel; Brooklyn had a compare-against-the-record
panel nobody else could use; Williamsburg had a photograph gallery nobody else could use, and no
provenance panel at all. A reader comparing two bridges was comparing two different tools.

This violated a rule that already existed. `GOVERNANCE.md` assigns the viewer kernel to this
repository and states an anti-duplication rule that applies within a module as well as across
modules. The forks were not a gap in policy; they were policy going unenforced. So the remedy is a
mechanical control, not a new rule.

## The root cause is the data contract, not the code

The viewers forked because the **data** forked. Each module's build script emits a different shape:

| | manhattan | brooklyn | williamsburg |
|---|---|---|---|
| config | `metadataUrl`, `camera`, `governance` | `assets`, `parts`, `build_report` | `asset`, `documents`, `provenance` |
| bounding box | `bbox_prototype_m: {min,max,size}` | `bbox_min_m` / `bbox_max_m` | *(absent)* |
| provenance field | `geometry_provenance` | `provenance` | `provenance` |
| controls | inline in `parts.json` | separate `controls.json` | inline in `parts.json` |

Unifying the UI while keeping three data shapes would only move the fork into three adapters. So
adoption means emitting the shared contract, which is the same discipline these projects already
apply to dimensions: one source of truth, and everything else derived from it.

The part records are already about 85% aligned — `part_id`, `system`, `subsystem`, `confidence`,
`source_basis`, `prototype_units`, `ho_scale_units`, `control_refs`, `material*`, `notes`,
`open_questions`, `review_status` and `last_modified_by_agent` are common to all three. What is
missing is mostly document-level scaffolding.

## What a module must publish

`viewer/public/model.config.json` conforming to `ViewerConfig`, and the document it names under
`metadataUrl` conforming to `PartsDocument`. Both are in
[`packages/bridge-viewer-ui/src/model.ts`](packages/bridge-viewer-ui/src/model.ts).

Per part, beyond the common fields:

- `bbox_prototype_m: { min, max, size }` — used for framing and the selection box
- `bbox_ho_mm: { size }`
- `geometry_provenance` — one of `measured` / `documented` / `inferred` / `assumed`
- `basis_confidence`, `material_sources`, `geometry_kinds`, `scale`

Per document:

- `control_document: { path, sha256 }` — the provenance hash shown in the footer
- `coordinate_system`, `confidence_colors`, `taxonomy`, `stations`, `elevations`, `controls`,
  `measures`

Optional, and the reason no module loses a feature by adopting:

- `referenceViewsUrl` → mounts the compare-against-the-record panel (Brooklyn's feature)
- `photoManifestUrl` → mounts the photograph rail (Williamsburg's feature)
- `references` → mounts the outbound reference panel (Manhattan's feature)

A module that omits an optional document simply does not get that panel. Absence is a statement
about that module's sources, not a missing feature, so the viewer says nothing rather than
presenting an empty shelf.

## How to adopt

```powershell
# 1. vendor the shell
node tools/sync_viewer_ui.mjs --to c:\Dev\<module-repo>

# 2. point the module entry point at it, and delete the local fork
#    viewer/src/main.tsx imports { App } from '../shared'
#    viewer/tsconfig.json includes "shared" instead of "components"

# 3. prove it
cd c:\Dev\<module-repo>\viewer; npx tsc --noEmit; npm run build
cd c:\Dev\<module-repo>; node scripts\check_viewer_sync.mjs
```

Then set `adopted: true` in `viewer/shared.lock.json` and add the check to the Pages workflow:

```yaml
- name: Check the shared viewer has not been forked
  run: node scripts/check_viewer_sync.mjs
```

## The control

`scripts/check_viewer_sync.mjs` recomputes the hashes in `viewer/shared/VIEWER-UI.sha256` and fails
the build if any vendored file was edited locally. It needs nothing but the module repository, so it
runs in CI whether or not this repository is checked out — which matters, because the schema
validator already has to skip for exactly that reason, and a control that skips is not a control.

Line endings are normalised to LF before hashing. That is not fussiness: this stack has already lost
a build to a control document that hashed one way on Windows and another on a Linux runner.

## Status

| module | state | notes |
|---|---|---|
| manhattan-bridge-3d | **adopted** | reference implementation; 103 parts, renders with no console errors |
| brooklyn-bridge-3d | not adopted | needs the document-level fields above; has `reference-views.json` already, so it keeps its compare panel on adoption |
| williamsburg-bridge-3d | not adopted | needs per-part bounding boxes, which its build script does not currently emit; gains a provenance panel on adoption |

Unadopted modules declare themselves in `viewer/shared.lock.json` with `adopted: false` and a
tracking issue. The check then warns loudly on every build instead of failing, so adoption is
deliberate rather than something that breaks a live site the day this lands — and so it cannot
quietly become permanent.
