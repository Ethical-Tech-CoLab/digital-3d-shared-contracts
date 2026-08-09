# Viewer API

What `@d3d/viewer-kernel` provides, and what a module shell must implement itself.

---

## 1. Boundary

The kernel is **framework-agnostic**: no React, no three.js, no scene graph, no DOM beyond `fetch`.
It decides *what* should be true. A shell makes it true with whatever renderer it likes.

Dependency direction is one-way and enforced by it: shells import the kernel, the kernel imports no
shell.

| Kernel | Shell |
|---|---|
| `Frame` — geodetic ↔ scene ENU, datum conversion, render convention | camera, materials, meshes |
| `ModuleRegistry` — manifests, URN resolution, optional dependencies | fetching and parsing payloads into geometry |
| `LodSelector` — screen-space error selection, per-mode budgets | applying the chosen level |
| `TileStreamer` — which tiles are resident, and at which level | loading, unloading, disposing |
| `TourPlayer` — the whole tour state machine | applying camera state, grabbing photos |
| `EventBus` — typed selection, mode, tour and warning events | rendering the UI those events imply |

---

## 2. Frame

```ts
const frame = new Frame(georeferenceDocument);

frame.toScene(lon, lat, heightM);      // → [x, y, z] scene ENU meters
frame.toGeodetic(x, y, z);             // → { lon, lat, height_m }
frame.convertElevation(z, 'MHW', 'NAVD88');
frame.isWithinValidRadius(p);

Frame.sceneToRender([x, y, z]);        // → [x, z, -y]   Z-up ENU to Y-up glTF
Frame.renderToScene([x, y, z]);
Frame.headingToForward(headingDeg);    // compass degrees → scene forward vector
Frame.forwardToHeading(v);
```

The transform is rigorous — geodetic to ECEF to local ENU basis — and round-trips to better than a
micrometre across the declared validity radius. Do all of it in float64 on the CPU and upload
float32; see [COORDINATE-SYSTEM.md](COORDINATE-SYSTEM.md) §5 for why that ordering matters.

`resolvePlacement` and `applyPlacement` compose a module's private engineering frame into the shared
one, for a module like the bridge that keeps its own origin.

---

## 3. Module registry

```ts
const registry = new ModuleRegistry({ bus });
const district = await registry.load('district/district-manifest.json');

registry.resolve('urn:d3d:manhattan-bridge:bridge_proxy');
registry.proxyCapFor('manhattan-bridge', 'dumbo-district');   // → max level a host may refine to
registry.attributions();                                       // → credit lines to display
registry.urlFor(district, 'tiles/t_6_5.lod0.json', 'tiles');
registry.missingModules;                                       // optional deps that failed
```

`load` follows `depends_on` recursively. A dependency marked `required: false` that fails is recorded,
emitted as `module:missing`, and does not throw — the whole point of the optional-first rule in
[GOVERNANCE.md](GOVERNANCE.md) §4.

`urlFor` resolves a payload path against the document that declared the `base_url`, not against the
page. Getting that wrong is silent and total: every payload 404s while the manifest looks perfectly
healthy.

---

## 4. LOD selection

```ts
const selector = new LodSelector(ladder);
const level = selector.select(distanceM, { fovY, heightPx }, {
  mode: 'walk',
  currentLevel,        // enables hysteresis
  maxLevel,            // a foreign module's proxy cap
  availableLevels,     // what this tile actually shipped
});
selector.budgetFor('inspect');            // → 2 px
selector.switchDistance(0, viewport, 'walk');
```

Selection is screen-space error, in the standard 3D Tiles formulation, so a level chosen here would
be chosen identically by a 3D Tiles engine later:

```
sse_px = (geometric_error_m / distance_m) * (viewport_height_px / (2 * tan(fov_y / 2)))
refine while sse_px > budget_px
```

A viewer mode is only a budget. `inspect: 2` and `walk: 12` on the same ladder is the entire
difference between examining a gusset plate and walking past a warehouse.

---

## 5. Tile streaming

```ts
const streamer = new TileStreamer(tileIndex, selector);
const { resident, added, removed, foreignAssets } =
  streamer.update({ position, forward }, viewport, mode, {
    plannedRoute: player?.plannedRoute(500, 50),
  });
```

Pure decision logic; it never touches a renderer. The shell loads `added`, disposes `removed`, and
ensures anything in `foreignAssets` is resident — which is how the bridge appears from a DUMBO street
without the district owning a triangle of it.

Load and unload radii differ, giving a hysteresis band so a camera loitering on a tile boundary does
not thrash. `plannedRoute` replaces heading-guessing with a route the player actually knows.

### The shell must report what actually happened

`update()` returns an *intention*. Only the shell knows whether the fetch succeeded, so it must say
so:

```ts
for (const t of added) {
  try {
    await load(t);   streamer.markLoaded(t.tileId, t.level);
  } catch (err) {
    streamer.markFailed(t.tileId, t.level, err);
  }
}
```

A streamer that recorded residency from its own decisions would believe a failed tile was loaded and
never offer it again — one dropped request became a permanent hole in the city. Residency is
therefore recorded only on `markLoaded`. `markFailed` schedules a retry on an exponential backoff
(1 s, 3 s, 8 s, 20 s, then every 20 s), and the tile is not re-offered while a request is in flight
or a backoff is pending.

`streamer.retrying` is the number of tiles currently in that failed-and-waiting state. It is the
honest signal for a "still loading" or "connection trouble" indicator, and its fall to zero is how a
shell knows an outage has healed and it can clear a transient warning.

---

## 6. Events

```ts
bus.on('asset:selected', ({ assetId, metadata }) => …);
bus.on('mode:changed',   ({ mode, previous }) => …);
bus.on('module:missing', ({ moduleId, reason }) => …);
bus.on('tiles:changed',  ({ resident, added, removed }) => …);
bus.on('handoff:enter',  ({ moduleId, entryId, focusAsset }) => …);
bus.on('tour:progress',  (p) => …);
bus.on('tour:narrate',   ({ text, durationS }) => …);
bus.on('tour:instruction', ({ instruction, maneuver, streetName }) => …);
bus.on('tour:capture',   (photo) => …);
bus.on('tour:waiting',   ({ reason }) => …);
bus.on('environment:changed', ({ timeOfDay, weather }) => …);
bus.on('warning',        ({ code, message, detail }) => …);
```

A listener that throws is caught and logged; one bad panel must not take down the frame loop.

---

## 7. What a shell must implement

A conforming shell:

1. Renders `TileStreamer`'s resident set at the level it asked for.
2. Reports every load outcome back with `markLoaded` / `markFailed`.
3. Applies the fixed scene-to-render conversion, and does not invent its own.
4. Renders the shared metadata contract for any selected asset.
5. Displays every line from `registry.attributions()`.
6. Surfaces `module:missing` and `warning` to the user rather than swallowing them.
7. Groups repeated warnings by `code` rather than printing one line per occurrence, and clears
   transient ones once the underlying condition has cleared.
8. Supplies `TourPlayer` with `resolveAsset`, and ideally `router` and `groundHeight`.
9. Implements `tour:capture` by grabbing its own framebuffer.

Optionally it may implement its own mode — the bridge's `inspect`, with its part tree, dimension
panel and exploded view — and advertise it in `handoff.ui_url`.

---

## 8. Reference implementation

`dumbo-district-3d/viewer` is a complete shell in about 1,400 lines:

| File | Role |
|---|---|
| `App.tsx` | wiring, frame loop, mode and tour orchestration |
| `DistrictScene.ts` | three.js: terrain, extrusion, picking, the bridge placeholder |
| `WalkControls.ts` | pointer-lock first-person movement |
| `WalkRouter.ts` | A* over the pedestrian network, supplied to the tour player |
| `GroundGrid.ts` | bilinear ground-height sampling |
| `FrameLoop.ts` | rAF with a hidden-document fallback, so capture works headless |
| `components/` | metadata panel, tour panel, HUD, map view, photo strip |

None of it knows anything about the Manhattan Bridge beyond a URN and a manifest.
