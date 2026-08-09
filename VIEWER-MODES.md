# Viewer Modes

**Status:** recommendation, v1.0.0
**Applies to:** `manhattan-bridge-3d`, `dumbo-district-3d`, and any module added later.

---

## 1. The problem

Two teams are building two viewers with genuinely different jobs.

| | Manhattan Bridge | DUMBO District |
|---|---|---|
| Question the user asks | "What *is* this member, and how big is it?" | "What is it like to *be* here?" |
| Camera | orbit a fixed subject | first-person, moving |
| Extent | one structure, ~2 km | a district, ~1.5 km square, 381 buildings |
| Geometry budget | as much as the truth requires | as little as the illusion allows |
| Failure mode | a wrong dimension | a stutter |
| Authority | bridge geometry and dimensions | neighbourhood, terrain, streets, streaming |

The instinct is to build these separately, because the requirements really do conflict. The instinct is
wrong, and so is the opposite instinct of merging them into one application with a mode flag.

**Two separate viewers** duplicate the coordinate system, the metadata panel, the confidence overlay, the
asset registry, the picking logic and the loader. Worse, they duplicate them *slightly differently*, and
then the bridge is 0.6 m too high in the district scene and nobody can say which viewer is wrong.

**One merged viewer** forces every change to the bridge's exploded-part view through a codebase that is
also trying to hold 60 fps while streaming a neighbourhood, and it gives two teams one release train.

---

## 2. Recommendation

> Build **one viewer kernel** and **two mode shells**. Ship the kernel from
> `digital-3d-shared-contracts`. Each project ships only its own shell and its own data.

```
                 ┌──────────────────────────────────────────────┐
                 │            @d3d/viewer-kernel                │
                 │  georeference · asset registry · URN resolve │
                 │  LOD selection · tile streaming · event bus  │
                 │  tour player                                 │
                 └───────────────┬──────────────┬───────────────┘
                                 │              │
             ┌───────────────────┴──┐        ┌──┴──────────────────────┐
             │  inspect shell       │        │  walk / map shell       │
             │  manhattan-bridge-3d │        │  dumbo-district-3d      │
             │  part tree           │        │  street navigation      │
             │  dimension panel     │        │  tour HUD               │
             │  exploded view       │        │  map overlay            │
             └──────────────────────┘        └─────────────────────────┘
```

The kernel is framework-agnostic TypeScript with no React and no three.js scene-graph assumptions. Each
shell owns its own rendering and its own UI. Neither shell imports the other. Neither team reviews the
other's UI code.

### What lives where

| Concern | Owner | Why |
|---|---|---|
| Coordinate frames, datum conversion | **kernel** | One implementation, or the bridge floats. |
| Asset registry, URN resolution | **kernel** | Cross-module references must resolve identically. |
| LOD selection | **kernel** | A shared scene must agree on what is resident. |
| Tile streaming, prefetch | **kernel** | The district needs it; the bridge benefits at LOD2. |
| Selection and metadata events | **kernel** | Both shells render the same metadata contract. |
| Tour playback | **kernel** | A tour crosses modules; it cannot live in one shell. |
| Confidence overlay colours | **kernel** | Same evidence model, same colours, both viewers. |
| Part tree, dimensions, exploded view | **bridge shell** | Nobody else needs them. |
| Street navigation, walk controls, map | **district shell** | Nobody else needs them. |
| Building metadata panel content | **district shell** | PLUTO fields are district-specific. |

---

## 3. The three mechanisms that make it work

The split above is only an org chart. Three technical mechanisms do the actual work.

### 3.1 One frame, declared not assumed

Both modules express everything in a shared local East-North-Up frame, `nyc-harbor-enu`, defined once in
[COORDINATE-SYSTEM.md](COORDINATE-SYSTEM.md) and published as a `georeference` document.

A module authored in its own engineering frame does not have to abandon it. The bridge keeps its origin at
the main-span midpoint with `+X` toward Brooklyn, exactly as `GEOMETRY-CONTROL.md` specifies, and publishes
a `placement` describing where that frame sits in the shared one. The kernel composes the transform. The
bridge team changes no geometry and no build script.

This is also where the **datum bug** gets caught. The bridge's `z = 0` is mean high water. NYC's building
data is NAVD88. Those differ by 0.59 m in New York Harbor. Without a declared frame the bridge sits 0.59 m
wrong against the anchorage plaza and nobody notices until someone walks there. The georeference document
carries `vertical_datum_offsets_m` so the correction is a field read, not a discovery.

### 3.2 One LOD ladder, two error budgets

This is the core insight, and it is what dissolves the apparent conflict.

"CAD detail" and "walkthrough efficiency" look like different *kinds* of representation. They are not. They
are different points on one axis: **maximum geometric error in meters**, the deviation of a representation
from the module's control geometry.

```
  max_geometric_error_m
   0.01 ──── bridge LOD0   cad_solid          inspect: measure a gusset plate
   0.05 ──── bridge LOD1   segmented_mesh     inspect at range
   0.20 ──── district LOD0 extruded_footprint hero zone, standing on Washington St
   0.50 ──── bridge LOD2   mesh               the bridge seen from a DUMBO street
   2.00 ──── district LOD1 extruded_footprint walkable district
   8.00 ──── district LOD2 block              context buildings
  25.00 ──── district LOD3 map_polygon        silhouette
```

Every level, from both modules, sits on the same axis. The kernel selects by **screen-space error**: refine
while `geometric_error / distance * viewport_scale > budget_px`. Because the axis is shared, a bridge tower
250 m away and a warehouse 30 m away are compared by the same rule and resolve consistently.

A *mode* is then not a different ladder. A mode is **a different budget on the same ladder**:

```json
"mode_sse_budget_px": { "inspect": 2, "walk": 12, "map": 48, "tour": 8 }
```

Inspect mode refines aggressively and will pull bridge LOD0. Walk mode refines lazily and will settle on
LOD2 for the same tower at the same distance. Same code path, same data, one number different. That single
number is the entire technical difference between "examine the bridge down to detailed CAD drawings" and
"walk through a digital neighbourhood efficiently in a browser".

The consequence worth stating plainly: **you do not need two viewers, you need two numbers.**

### 3.3 Proxy and handoff

A pedestrian on Washington Street must see the Manhattan Bridge. The DUMBO team must not model it. Both
are satisfied by two declarations in the bridge's manifest.

**Proxy.** The bridge publishes a cheap stand-in with a `max_level` cap:

```json
"proxy": {
  "asset_id": "urn:d3d:manhattan-bridge:bridge_proxy",
  "max_level": 2
}
```

The district's tile index lists the bridge URN in `foreign_assets` on the tiles it overhangs. When such a
tile becomes resident, the kernel ensures the bridge module's content is loaded, capped at level 2. The
district never owns a bridge triangle, and the bridge team cannot accidentally blow the district's frame
budget, because the cap is enforced by the consumer.

**Handoff.** When the user wants to actually inspect the bridge, the manifest declares how:

```json
"handoff": {
  "supported": true,
  "target_mode": "inspect",
  "preserve_camera": true,
  "entry_points": [
    { "entry_id": "brooklyn_tower", "label": "Inspect the Brooklyn tower",
      "focus_asset": "urn:d3d:manhattan-bridge:tower_brooklyn_envelope" }
  ]
}
```

The kernel raises the error budget to the inspect value, lifts the proxy cap, loads the bridge's own shell
if one is supplied, and keeps the world camera pose so the user never loses their place. Walking backwards
out of the entry volume reverses it.

Because `preserve_camera` is only meaningful when both modules share a frame, mechanism 3.3 depends on
3.1, and the cap in 3.3 is expressed in the units of 3.2. The three mechanisms are one design.

---

## 4. What this forbids

Rules are only useful if they rule things out.

1. **Neither module may contain the other's geometry.** Not a placeholder tower, not a simplified
   silhouette, not "just for now". Consume the proxy.
2. **Neither module may reach into the other's source tree.** The module manifest is the entire
   dependency surface. If something is needed and not in the manifest, the fix is a manifest change,
   requested from the owner.
3. **No module may publish coordinates in an undeclared frame.** Every payload names its `frame_id`.
4. **No cross-module dependency may be `required: true` at first.** Start optional so neither project can
   break the other's build. Promote only once both sides are stable.
5. **Modes may not fork the ladder.** If a mode needs different geometry, that is a new LOD level with an
   honest `max_geometric_error_m`, not a mode-specific asset path.
6. **The kernel may not import from any shell.** Enforced by the dependency direction: shells depend on
   `@d3d/viewer-kernel`, never the reverse.

---

## 5. Migration

Neither team has to stop work. Ordered by dependency, each step is independently useful.

### For `dumbo-district-3d` — done in this phase
1. Adopt `nyc-harbor-enu` as the authoring frame. *(done)*
2. Publish `georeference`, `lod`, `tile-index`, `asset-registry`, `district-manifest`. *(done)*
3. Consume `@d3d/viewer-kernel` for streaming, LOD and tours. *(done)*
4. Reference the bridge only by URN, through an optional dependency that degrades to a placeholder when
   the bridge manifest is absent. *(done)*

### For `manhattan-bridge-3d` — proposed, no geometry changes required
1. **Publish `bridge-manifest.json`.** Roughly 60 lines. Declares ownership, modes, the existing LOD
   intent, and the handoff entry points. Nothing else changes.
2. **Add a `placement`.** Resolves `OQ-009` by registering the bridge's real-world position and azimuth.
   `dumbo-district-3d` publishes a *provisional* placement (`DOQ-001`) so integration can be exercised
   today; ratifying or correcting it is a bridge-team decision and a one-line edit.
3. **Adopt the vertical datum offset.** Read `MHW = +0.59 m` from the shared georeference rather than
   assuming `z = 0` means the same thing in both repositories.
4. **Map `parts.json` onto `metadata.schema.json`.** The existing fields map one-to-one; the HO-specific
   fields move under `extensions["manhattan-bridge"]`. The bridge's own panels keep reading them; the
   district's shared panel can now read the common core.
5. **Export a level-2 proxy.** One decimated GLB of the whole bridge. This is the single highest-value
   artefact for the district, because it is what a visitor actually sees.
6. **Optionally, replace the viewer's bespoke loader with `@d3d/viewer-kernel`.** Worth doing when
   Milestone 5 LOD switching lands, since the kernel already implements it.

Steps 1 and 5 alone deliver most of the integration value.

---

## 6. Why not the alternatives

| Alternative | Why not |
|---|---|
| One repository, one app | Couples release trains and review load. The teams have genuinely different cadences and skills. |
| Two independent viewers, glTF exchange only | glTF carries geometry but not evidence, LOD policy, or datum. The 0.59 m error is invisible in a GLB. |
| 3D Tiles for everything | Right answer for the district at scale, wrong answer for CAD inspection, and a heavy dependency to impose on a repository that currently needs none. The tile index is deliberately 3D-Tiles-shaped so this stays open. |
| CesiumJS or Google Photorealistic Tiles as the host | Solves streaming and terrain, but subordinates both models to a third party's frame and licensing, and does not solve inspect mode at all. |
| Defer integration until both are finished | The datum mismatch and the frame convention are exactly the decisions that are cheap now and expensive later. |

---

## 7. Acceptance

The design is working when all of these hold:

- [x] The district viewer renders a bridge it does not own, from a manifest, by URN.
- [x] Removing the bridge manifest degrades the district to a labelled placeholder and logs a warning,
      rather than failing.
- [x] Switching a single budget number visibly changes how aggressively the scene refines.
- [x] A tour authored as external walking instructions drives the camera across both modules.
- [x] No file in either module contains a coordinate in an undeclared frame.
- [ ] The bridge team has ratified or corrected the provisional placement (`DOQ-001`).
- [ ] A level-2 bridge proxy exists and replaces the district's placeholder.
