# Basemap Layers

**How to put a map behind a district view without inheriting a vendor's architecture or breaking
their terms.**

Normative schema: [`schemas/basemap.schema.json`](schemas/basemap.schema.json).
Runtime: `BasemapController` and the tile helpers in `@d3d/viewer-kernel`.

---

## 1. The recommendation

> **Implement the tile protocol, not a vendor SDK. Declare layers as data. Never commit a key.
> Default to a layer that needs no key at all.**

Users expect the Google/Bing/Apple idiom: a switcher offering **street**, **terrain**, **satellite**,
sometimes **hybrid**. That expectation is about the *user interface*, not about which company serves
the pixels — and the two are easy to conflate in a way that is expensive to undo.

Almost every raster provider — Google, Bing, Apple, Esri, USGS, OpenStreetMap, Mapbox, MapTiler,
Carto, Stadia — serves 256 or 512 pixel tiles addressed by `z/x/y` in Web Mercator (EPSG:3857). That
shared protocol is the leverage. Implement it once in the kernel, and a provider becomes a URL
template in a config file.

```
   BAD                                    GOOD
   ───                                    ────
   viewer imports @vendor/maps-sdk        viewer implements z/x/y tiles
   vendor's map owns the canvas           your scene owns the canvas
   swapping provider = rewrite            swapping provider = edit one string
   key compiled into the bundle           key injected from the environment
   attribution as an afterthought         attribution required by the contract
```

---

## 2. Why not just use a mapping SDK

A mapping SDK is the right answer when the map *is* the application. It is the wrong answer here,
for four reasons:

1. **It wants to own the viewport.** These viewers already have a 3D scene with its own camera,
   coordinate frame and LOD system. Handing the viewport to a map library means synchronising two
   camera models forever.
2. **It brings a coordinate system with it.** The stack already has one, declared in
   [COORDINATE-SYSTEM.md](COORDINATE-SYSTEM.md), and it is the thing that keeps two independently
   built modules agreeing about where objects are. Adopting a second is how a bridge ends up 0.59 m
   into the ground.
3. **It is a licensing commitment in code form.** Several providers' terms require that their tiles
   be displayed *only* through their SDK. Depending on the SDK makes switching providers a rewrite
   at the exact moment you are least able to afford one.
4. **Weight.** A full mapping SDK is comparable in size to the entire district viewer, for a plan
   view that is one of three modes.

The escape hatch stays open: because layers are data, a module that genuinely needs vector tiles or
turn-by-turn rendering can add a `custom` layer or mount an SDK in its own shell without changing
the contract.

---

## 3. Licensing is the actual constraint

This is the part that is easy to get wrong quietly, and expensive to discover late.

| Provider | Key | Commercial use | Notes |
|---|---|---|---|
| **USGS The National Map** | none | **permitted** | Public domain US Government work. No restrictions; USGS requests acknowledgement. US coverage only. |
| **OpenStreetMap** (`tile.openstreetmap.org`) | none | **restricted** | ODbL. Community servers on donated capacity. Heavy use, *including distributing an app that fetches them*, is forbidden without permission. Fine for development; not for production. |
| **Esri World Imagery** | none to fetch | **prohibited without licence** | Looks free because the endpoint answers. It is not: it requires an ArcGIS licence and is not available for commercial use. A trap worth naming. |
| **Google Map Tiles API** | required | permitted, paid | Must display the Google logo and attribution. Session-token flow. |
| **Bing Maps** | required | permitted, paid | Metadata endpoint returns the tile URL and required attributions. |
| **Mapbox / MapTiler / Stadia / Carto** | required | permitted, paid | Straightforward `{key}` templates; each has its own attribution string. |

**Three rules follow:**

1. **The default layer must need no credential.** A fresh clone should render a map. If the default
   requires a signup, the project is broken for every new contributor and every CI run.
2. **`commercial_use` is a required judgement, recorded in the data.** `BasemapController` surfaces
   a warning when a `restricted` or `prohibited` layer is selected. Nobody should have to read terms
   of service to discover that the demo they shipped was never licensed.
3. **An endpoint answering `200` is not permission.** Esri World Imagery serves tiles to anonymous
   requests and still forbids the use. Check terms, not status codes.

### What DUMBO actually ships

All five layers are credential-free by design:

| Layer | Source | Licence |
|---|---|---|
| Street | OpenStreetMap | ODbL, restricted to low volume |
| Satellite | USGS Imagery Only | public domain |
| Terrain | USGS Topo | public domain |
| Hybrid | USGS Imagery+Topo | public domain |
| Plain | none | renders no tiles; works offline |

`Plain` is not filler. It exists so the district's own tile grid and fidelity zones can be read
without imagery competing with them, and so the map view works with no network at all.

---

## 4. Credentials

**Never in the basemap document.** The schema carries `credential_hint` — the *name* of the variable
to read — and never a value:

```json
{
  "layer_id": "satellite_hd",
  "requires_credential": true,
  "credential_hint": "VITE_BASEMAP_KEY_MAPTILER",
  "url_template": "https://api.maptiler.com/tiles/satellite/{z}/{x}/{y}.jpg?key={key}"
}
```

The viewer collects matching variables from its build environment and hands them to the controller:

```ts
const credentials: Record<string, string> = {};
for (const [key, value] of Object.entries(import.meta.env)) {
  if (key.startsWith('VITE_BASEMAP_KEY_') && typeof value === 'string') credentials[key] = value;
}
new BasemapController(set, credentials);
```

A layer whose credential is absent is **filtered out of the switcher** rather than offered and then
failing. `BasemapController` throws only if *no* layer is usable, which given rule 1 above cannot
happen for a correctly authored set.

Note the tradeoff being made explicitly: any key bundled into a browser build is visible to users.
That is inherent to client-side mapping, and the mitigations are provider-side — HTTP referrer
restrictions, key scoping, usage caps — not code-side. For a server-rendered or proxied deployment,
put the key behind your own tile proxy and point `url_template` at that instead.

---

## 5. Projection: the part that silently looks wrong

Basemap tiles are **Web Mercator**. The scene is a **local ENU tangent plane**. These are not the
same, and the difference is not subtle.

Mercator's scale factor is `1/cos(latitude)`. At New York's 40.7°, that is **1.32**. Paste Mercator
tiles onto ENU coordinates by naive scaling and the imagery is stretched by a third in one axis:
streets drift from buildings, and the error grows toward the edges of the view.

The kernel avoids the problem rather than approximating it. Each tile's corners are converted to
lon/lat, then through the frame's own rigorous geodetic transform:

```ts
const [westLon, northLat] = tileToLonLat(tx, ty, z);
const [eastLon, southLat] = tileToLonLat(tx + 1, ty + 1, z);
const sw = frame.toScene(westLon, southLat, 0);
const ne = frame.toScene(eastLon, northLat, 0);
```

Every tile is then placed by its own scene-space corners. Imagery lines up with geometry by
construction, using the same transform the buildings used, and there is no separate projection
approximation to drift.

The visible confirmation in the DUMBO viewer: the red dashed corridor marking tiles that declare the
Manhattan Bridge sits exactly over the real bridge in both the OSM street layer and the USGS
satellite layer. That is a free, continuous check on the module's georeferencing — and one reason to
add a basemap even to a project that does not strictly need one.

---

## 6. Choosing a zoom level

Do not hard-code one. Derive it from the resolution actually being displayed:

```ts
const metersPerPixel = 1 / Math.min(viewportWidth / sceneWidth, viewportHeight / sceneHeight);
const z = zoomForResolution(metersPerPixel, anchorLatitude, tileSize, minZoom, maxZoom);
```

A fixed level is blurry when the user zooms in and wasteful when they zoom out. Deriving it also
keeps the request count stable as the view changes; `tileCoverage` additionally takes a `maxTiles`
cap so a wide view cannot fire hundreds of requests.

Two conventions to respect, both of which fail silently:

- **`{y}` ordering.** XYZ counts rows from the north; TMS counts from the south. Get it wrong and
  the map is mirrored vertically — which looks plausible enough to ship. Declare `protocol`.
- **Axis order in the path.** ArcGIS REST services use `{z}/{y}/{x}`, not `{z}/{x}/{y}`. The USGS
  layers in the DUMBO config show this.

---

## 7. Attribution is not optional chrome

Every provider in the table above requires visible credit while their imagery is on screen; several
also require their logo. ODbL requires it unconditionally.

The contract makes `attribution_text` a **required** field, and the controller exposes exactly what
must be shown right now:

```ts
basemap.activeAttribution();   // active layer plus any visible overlays
```

Render it into the map view itself, not into an "about" dialog. In the DUMBO viewer it sits in the
lower-right corner of the map and changes as layers change.

---

## 8. Checklist

- [ ] Layers are declared as data, validating against `basemap.schema.json`.
- [ ] The default layer requires no credential.
- [ ] No credential value appears anywhere in the repository.
- [ ] Each layer records `license`, `commercial_use` and a plain-language `usage_policy`.
- [ ] Attribution is displayed in the map view whenever a layer is active.
- [ ] Tiles are placed by per-tile geodetic corners, not by a global Mercator-to-scene scale.
- [ ] Zoom is derived from displayed resolution, with a tile-count cap.
- [ ] `protocol` and path axis order are declared, and were verified against a real tile.
- [ ] An offline or `plain` option exists, so the view works with no network.
- [ ] Before public deployment, any low-volume community endpoint is swapped for a self-hosted or
      commercial one — a change to `url_template` and `attribution_text` only.
