# Scene Dressing

**How to make a district feel like a place, without the viewer knowing anything about that place.**

Normative schema: [`schemas/scene-props.schema.json`](schemas/scene-props.schema.json).
Runtime helpers live in each shell; the vocabulary is shared.

---

## 1. The problem

Extruded footprints on a flat plane read as a *diagram*. Correct, traceable, and lifeless. A visitor
standing on Water Street cannot tell how wide the street is, where the kerb runs, or whether a
building is a warehouse or an office block.

The naive fixes are both wrong:

- **Model it by hand.** Does not scale past one block, and the result has no provenance.
- **Put the props in the viewer.** Fast, and it permanently welds the tool to one neighbourhood.

> **Recommendation: dress the scene with *data*, generated from registered sources, living in the
> module. The viewer learns a small vocabulary of prop kinds and how to draw a paved quad. It never
> learns what a London plane tree is, or that DUMBO has warehouses.**

Point the same viewer at another district's `props.json`, `paving.json` and `facades.json` and it
dresses that district instead. That is the test: if a change would break when you swap districts,
it belongs in the module, not the viewer.

---

## 2. What goes where

| | Module (`dumbo-district-3d`) | Viewer / kernel |
|---|---|---|
| Which trees exist and where | ✅ `props.json`, from the tree census | ✗ |
| What a "tree" is | ✗ | ✅ `kind: "tree"` in the vocabulary |
| Street widths and kerb lines | ✅ `paving.json` | ✗ |
| How to draw a paved quad | ✗ | ✅ |
| Which buildings are warehouses | ✅ `facades.json`, from PLUTO class | ✗ |
| How to shade a window band | ✗ | ✅ |
| Species palette, brick colours | ✅ | ✗ |

The dividing line: **the module owns *what is there*, the viewer owns *how to draw that kind of
thing*.**

---

## 3. Derive dressing from sources you already hold

The most valuable insight from building DUMBO's dressing is that almost none of it needed new
modelling. Three existing datasets carried enough signal:

| Dressing | Derived from | Result |
|---|---|---|
| **1,252 street trees** | NYC Forestry census: position, species, trunk diameter | Real positions, ten genera, per-tree scale from actual DBH |
| **1,986 paved surfaces** | OSM centrelines + typical half-widths by street class | Roadway, sidewalk strips, kerb edges |
| **381 facades** | PLUTO building class + year built | Material family, base colour, glazing ratio, era |

Nobody modelled anything. The district looks inhabited because the *city already published* what is
in it.

**Variation must be meaningful, not random.** Trunk diameter drives tree scale, so a street is a row
of individuals of different ages rather than a row of clones. Building class drives glazing, so a
1900s warehouse gets deep brick with sparse punched openings and a modern office gets a high glazing
ratio. Random jitter would look equally varied and would tell the viewer nothing true.

---

## 4. Grade dressing honestly

Decorative geometry is where source discipline usually collapses. It should not.

Apply the same A–D model, and be precise about *which part* is graded:

> A street tree's **position and species are grade A** — they come from the Forestry census. Its
> **canopy shape is grade C** — a plausible form for the genus, not a measurement of that tree.
> So the prop is graded **C**, by the weakest-link rule.

DUMBO's dressing carries three new open questions rather than quietly pretending:

| ID | What is inferred |
|---|---|
| `DOQ-006` | Paving widths are typical values by street class, not traced kerb lines |
| `DOQ-007` | Facade appearance describes the *kind* of building, not that building's actual facade |
| `DOQ-003` | Ground height is interpolated, so props sit on an inferred surface |

**Dressing must never influence geometry, dimensions or metadata.** It is appearance only. A grade C
canopy sitting next to a grade A building must not drag the building's grade down, and must never be
citable as a measurement. Keeping props in a *separate document* from the asset registry is what
enforces this structurally: props have no `asset_id`, no metadata panel, and cannot be selected.

---

## 5. Procedural fallback is a feature, not a placeholder

Every prototype declares a `kind` from a closed vocabulary. When `url` is absent, the viewer draws
its own geometry for that kind:

```json
{ "prototype_id": "tree_platanus", "kind": "tree", "format": "procedural",
  "size_m": [11.5, 11.5, 10.0], "confidence": "C" }
```

This matters for three reasons:

1. **The district looks inhabited from the first build**, before anyone models an asset.
2. **Upgrading is a one-field change.** Set `url` to a GLB and the same instances render the real
   model. No code change, no schema change.
3. **A missing asset degrades to a plausible shape** rather than a hole in the world.

Keep procedural geometry deliberately cheap. A street tree at walking distance is mostly silhouette:
DUMBO's is a five-sided trunk and two icosahedra, and it reads correctly.

---

## 6. Instancing is not optional

A district has thousands of props. Rendering them individually will not hold frame rate.

DUMBO's numbers, measured in the running viewer:

```
1,252 tree instances  ->  30 draw calls  ->  60 fps
```

One `InstancedMesh` per prototype *part*, with per-instance transform carrying position, yaw and
scale. Ten genera × three parts is thirty draw calls regardless of how many trees exist.

Rules that follow:
- **Group by prototype**, and keep the prototype count small. Ten tree species is fine; a thousand
  bespoke trees is not.
- **Bake variation into the instance transform** (yaw, scale), not into unique geometry.
- **Tag instances with their tile** so props can stream with the tile rather than all at once.
- **Billboard distant vegetation** if the count grows; the schema has a `billboard` flag for it.

---

## 7. Facades without textures

Texturing a district properly means street-level imagery, licensing, UV work and a large asset
budget. There is a much cheaper intermediate that gets most of the perceptual benefit.

**Split each wall into horizontal courses and shade window bands procedurally.**

```ts
const courses = Math.max(4, Math.min(28, Math.round(height / 1.75)));
// ...per course:
const band = facadeBandFactor(heightFraction, style, height);
color.setHex(tint).multiplyScalar(orientationShade * band);
```

No texture, no UVs, no image requests — just more vertices in the wall and a per-course colour. The
inputs come from the module's `facades.json`: glazing ratio, storey count, era, material family.

Two details that made the difference in practice:

- **A wall of two triangles cannot show banding at all.** The subdivision is the enabling step, and
  it is easy to overlook while wondering why the shading has no effect.
- **Floor the contrast.** Scaling window depth purely by glazing ratio made low-glazing warehouses
  invisible; measured wall-luminance spread was 0.066, which reads as a flat box. Flooring it
  (`0.18 + glazing × 0.5`) lifted it to 0.112 and the storeys became legible. A warehouse with 10%
  glazing still has clearly punched openings.

Cost: DUMBO's LOD0 tiles went from ~2,600 to ~10,000 vertices per tile, still 60 fps, still under
half a megabyte for the district.

---

## 8. Paving: the cheapest big win

Widening street centrelines into quads, with a sidewalk strip either side of vehicular streets,
costs almost nothing and changes the read of the scene completely. **Kerbs give the eye the edges it
needs to judge distance while walking** — without them a pedestrian view has no sense of scale.

Practical notes:

- **Sidewalks slightly above the roadway** (0.14 m vs 0.02 m) so the kerb line is visible.
- **Use polygon offset**, not just a height difference, or paving z-fights with terrain.
- **Match the terrain's winding.** The ENU-to-render conversion flips handedness; get the triangle
  order wrong and every surface is back-faced and invisible. This is the single most common bug in
  this whole area, and it fails silently.
- **Junctions overlap** rather than resolving into a single surface. At walking distance nobody
  notices; record it as an open question rather than pretending otherwise.

---

## 9. Checklist

- [ ] All dressing lives in the module, as data, validating against a shared schema.
- [ ] The viewer contains no district-specific names, species, colours or widths.
- [ ] Props are declared as prototypes plus instances, not as thousands of objects.
- [ ] Instanced rendering; draw calls scale with prototype count, not instance count.
- [ ] Variation is derived from real attributes, not random jitter.
- [ ] Every prototype carries `source_basis`, `source_refs` and an honest `confidence`.
- [ ] Inferred dressing is registered as an open question.
- [ ] Dressing never affects geometry, dimensions, metadata or an asset's confidence grade.
- [ ] Props are not selectable and carry no metadata panel.
- [ ] Procedural fallbacks exist for every `kind` used, so a missing payload degrades gracefully.
- [ ] Attribution for dressing sources is added to the module manifest.
