# Governance

Who owns what, and how a shared thing gets changed.

---

## 1. Ownership

The rule that makes this work is simple: **exactly one module is authoritative for any given thing,
and everybody else consumes it through the contract.**

| Domain | Authority | Everyone else |
|---|---|---|
| Bridge geometry, dimensions, component taxonomy, bridge photogrammetry | `manhattan-bridge-3d` | consume by URN through the bridge manifest |
| Neighbourhood buildings, streets, waterfront, terrain, property metadata, tile streaming, walking experience | `dumbo-district-3d` | consume by URN through the district manifest |
| Schemas, coordinate system, viewer kernel, tour player, **the bridge inspect shell** | `digital-3d-shared-contracts` | consume as a dependency, or vendor with `tools/sync_viewer_ui.mjs` |

Each module declares its own authority in `authoritative_for` in its manifest, so the boundary is
machine-readable rather than folklore.

### The anti-fork rule

> No module may keep its own copy of shared UI. The inspect shell is one codebase.

This rule is stated separately because it was already implied by the anti-duplication rule below
and was broken anyway. Three bridge repositories each grew their own viewer; when they were finally
compared, only 2 of 23 source files still matched. The damage was not duplicated code but divided
features -- each bridge had a panel the other two could not use, so a reader comparing two bridges
was comparing two different tools.

A rule nobody can check is a preference. So this one is mechanical:

- `packages/bridge-viewer-ui` is the only bridge inspect shell.
- `tools/sync_viewer_ui.mjs` vendors it into a module and writes `viewer/shared/VIEWER-UI.sha256`.
- `scripts/check_viewer_sync.mjs` in each module rehashes those files and **fails the build** if any
  was edited locally. It runs in CI, needs no cross-repository checkout, and so can never skip.
- A module not yet adopted declares `adopted: false` in `viewer/shared.lock.json` with a tracking
  issue, and the check warns loudly on every build.

New shared behaviour belongs in the shell, gated on data the module publishes -- a panel that mounts
only when its evidence document exists. That is how one viewer serves bridges with different
evidence without anyone needing to fork it. See `VIEWER-ADOPTION.md`.

### The anti-duplication rule

> No module may contain another module's geometry. Not a placeholder tower, not a simplified
> silhouette, not "just for now".

If you need to show something you do not own, consume its `proxy`. If no proxy exists, render an
obviously-not-real placeholder, label it as such in the UI, and open a request with the owner. The
DUMBO viewer does exactly this today: the Manhattan Bridge appears as a red wireframe envelope built
from the bridge team's own published control dimensions, with an integration notice explaining why.

The rule also applies **within** a module, and this is the case that actually bit us. DUMBO builds a
Manhattan skyline for its horizon from the same citywide footprint dataset it builds its own
buildings from. The horizon query box overlapped the district, so 226 buildings were emitted twice:
once as real, lit, surveyed geometry, and again as pale unlit far-field blocks drawn on top of
them — visible as white boxes standing in the middle of the street.

> Any generator that draws from a citywide dataset must subtract the region its own module already
> owns, and hold a minimum standoff distance from the camera's reachable area.

Whenever a module both *owns* a region and *approximates* the surroundings, name the region once and
have the approximation exclude it. The far-field builder now drops any block whose centroid falls
inside the district boundary ring, and any block closer than 700 m.

---

## 2. Changing a shared contract

A schema in this repository is a public interface between teams. Treat it like one.

**Additive change** — new optional field, new enum member, new schema.
Allowed within a major version. Open a PR, tag every module owner, merge once nobody objects.
Consumers that ignore the new field keep working.

**Breaking change** — removing a field, tightening a type, making an optional field required,
renaming anything.
Requires a major version bump and explicit sign-off from every module owner. Both `contract_version`
and the schema `$id` path change together.

**Frozen values** — the anchor of a published `georeference`.
Never change within a major version, for any reason. Every coordinate in every module is expressed
relative to it, so moving it silently invalidates every asset in the stack.

### Checklist for any contract PR

- [ ] `npm test` passes: fixtures validate, types check, and the unit tests in `tools/` are green.
- [ ] The TypeScript mirror in `packages/contracts` was updated too.
- [ ] A fixture in `examples/` exercises the new construct.
- [ ] Every affected module's build still validates against the new schema.
- [ ] The change is additive, or the major version was bumped and owners signed off.
- [ ] If a rule is implemented twice, in two languages, something checks that the two agree.

### When a rule lives in two languages

Some rules cannot live only in a schema, because they are behaviour rather than shape — what a
photograph's review categories permit you to derive, for instance. Those end up implemented once in
this repo's TypeScript and once in a module's Python build, and the two will drift.

The answer is not to pick a winner. It is to make the drift loud. `tools/check-photo-categories.mts`
takes a dump of the module's implementation and compares it against this repo's across every tag
combination:

```bash
# in the module repo, dump the reference
python -c "...; json.dump(out, open('catref.json','w'))"
# here, compare
node --experimental-strip-types tools/check-photo-categories.mts catref.json
```

It found a real divergence the first time it was run: `historic` is contagious in the module — one
archival tag suppresses every colour in the set — whereas the mirror had unioned it. The mirror was
wrong and the module was right, which is the usual direction, because the module is the one meeting
real data.

---

## 3. Extending without changing the contract

Most of the time you do not need a schema change. You need an extension slot.

`metadata` and `module-manifest` both carry `extensions`, keyed by the `module_id` that owns the
convention:

```json
"extensions": {
  "dumbo-district": {
    "placeholder_envelope": { "length_m": 2089.4, "tower_height_m": 98.1 }
  }
}
```

Consumers MUST ignore extensions they do not recognise. Inventing a top-level field instead will be
rejected by the validator, deliberately: `additionalProperties: false` is there so that private
conventions stay visibly private.

Promote an extension into the contract proper only once a second module wants it.

---

## 4. Cross-module dependencies

Declare them in `depends_on`, and **start every one as `required: false`.**

```json
"depends_on": [
  { "module_id": "manhattan-bridge",
    "manifest_url": "../modules/manhattan-bridge/bridge-manifest.json",
    "required": false }
]
```

An optional dependency that fails to load is announced on the event bus and logged, and the consumer
carries on without it. That property is what lets two teams work at different speeds without either
being able to break the other's build. Promote to `required: true` only when both sides are stable
and the consumer genuinely cannot function without it.

---

## 5. Provisional data

Sometimes a consumer needs a value the owner has not registered yet. The honest move is to publish a
proposal, clearly marked, rather than to guess quietly.

`placement` carries `provisional: true` and `open_questions` for exactly this. `dumbo-district-3d`
currently publishes a provisional placement for the Manhattan Bridge, derived from the bridge's
mapped centreline, tagged `OQ-009` and `DOQ-001`, graded `D`, with the derivation written into the
`notes` field. The bridge team can ratify it, correct it, or replace it. Nothing in the district
treats it as truth.

Rules for provisional data:

1. `confidence` is `D` unless the derivation genuinely supports better.
2. `provisional: true` is set.
3. `open_questions` names the owner's tracking ID.
4. `notes` states how it was derived and what would make it authoritative.
5. The consuming viewer surfaces it to the user rather than hiding it.

---

## 6. Attribution and licensing

Sources carry redistribution terms and they travel with the data.

Every entry in a `source-confidence` register states its `license`. Where
`attribution_required` is true, the exact `attribution_text` MUST be displayed by any viewer that
renders geometry derived from it. `ModuleRegistry.attributions()` collects these across every loaded
module so a shell can render them without knowing which sources exist.

The DUMBO district currently carries NYC Open Data terms and ODbL for OpenStreetMap. ODbL attribution
is mandatory and unconditional; the viewer shows it whether or not OSM-derived geometry is on screen.
