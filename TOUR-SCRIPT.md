# Tour Script

**How external walking instructions drive the viewer.**

Normative schema: [`schemas/tour-script.schema.json`](schemas/tour-script.schema.json).

---

## 1. The idea

The viewer does not author routes. It **plays** them.

A tour script is a document produced somewhere else — a routing API, a content team, a script, an
LLM — that tells the viewer where to walk, where to stop, how long to linger, what to look at, and
when to take a photograph. The viewer's job is to execute it faithfully.

The format is deliberately shaped like a directions response from Google, Bing, Apple or OSRM:

```
tour
 ├── party            who is walking, and therefore how fast and how tall
 ├── defaults         dwell, camera rig, playback speed, time of day
 ├── stops[]          the A, B, C, D of the tour
 │    ├── position    geodetic, scene-space, or "that asset over there"
 │    ├── dwell_s     how long the party lingers
 │    └── on_arrive[] narrate, look_at, capture_photo, enter_inspect, wait_for_user…
 └── legs[]           travel between consecutive stops
      ├── path        polyline: geodetic, scene, or encoded polyline
      └── steps[]     maneuver + instruction + distance + duration
```

Everything above `stops` and `legs` is the experience layer. Everything inside them is a route. A
real directions payload maps onto `legs[].steps[]` field-for-field, which is the point: adapting a
provider is a rename, not a rewrite.

---

## 2. Minimum viable tour

A list of stops. That is all that is required.

```json
{
  "contract_version": "1.0.0",
  "tour_id": "quick-look",
  "title": "Quick look",
  "stops": [
    { "stop_id": "a", "name": "Start", "position": { "lon": -73.9951, "lat": 40.7033 } },
    { "stop_id": "b", "name": "Finish", "position": { "lon": -73.9896, "lat": 40.7032 } }
  ]
}
```

With no `legs`, the player asks its host for a route between consecutive stops. The DUMBO shell
supplies an A* router over the OpenStreetMap pedestrian network, so the party walks real streets. If
no router is available the player walks a straight line and emits a `tour.leg_unrouted` warning,
because silently walking through a building is worse than saying so.

---

## 3. Positions

Three forms, chosen per use:

```json
{ "lon": -73.98958, "lat": 40.7032, "height_m": 0, "vertical_datum": "NAVD88" }
{ "frame": "nyc-harbor-enu", "xyz": [-49.2, 22.1, 5.0] }
{ "asset": "urn:d3d:manhattan-bridge:bridge_proxy", "anchor": "bbox_center" }
```

Prefer **geodetic** for anything that should survive a change of scene frame or be shareable with a
mapping tool. Use **scene** when the author is working inside one specific frame. Use an **asset
URN** when the intent is "look at that thing", including things another module owns — which is how a
district tour points a camera at a bridge tower the district does not model.

Asset positions are resolved by a host-supplied callback, because only the shell knows where loaded
geometry ended up. An unresolvable asset produces a warning and the action is skipped; the tour
continues.

---

## 4. The action vocabulary

Small and closed, so any conforming player supports all of it.

| Action | Effect |
|---|---|
| `look_at` | Camera tracks a target for `duration_s`. |
| `pan` | Absolute heading and pitch. |
| `dwell` | Occupy time. |
| `narrate` | Emits `tour:narrate`. Duration defaults to reading time at 2.6 words/second. |
| `capture_photo` | Emits `tour:capture`; the shell grabs the framebuffer. |
| `group_photo` | As above, framed for the party. |
| `highlight` | Selects an asset, emitting `asset:selected`. |
| `show_metadata` | Selects and opens the metadata panel. |
| `set_mode` | Switches viewer mode, changing the LOD budget. |
| `enter_inspect` | Hands off to another module's inspect mode at a named entry point. |
| `exit_inspect` | Returns to the tour's default mode. |
| `set_time_of_day` | Emits `environment:changed`; drives sun position. |
| `set_speed` | Changes playback rate mid-tour. |
| `wait_for_user` | Blocks until the user continues. |

Actions are scheduled sequentially by default; `at_s` overrides. `blocking: false` lets a narration
play over walking rather than stopping the party.

**Dwell is a floor, not a cap.** If the scripted actions at a stop total more than `dwell_s`, the
player extends the dwell. An author who wrote four beats meant all four to happen.

---

## 5. Party

The party is not decoration. It changes the render.

```json
"party": {
  "size": 4,
  "label": "Family of 4",
  "members": [
    { "member_id": "adult_1", "role": "adult", "eye_height_m": 1.65 },
    { "member_id": "child_2", "role": "child", "eye_height_m": 1.15 }
  ],
  "point_of_view": "adult_1",
  "pace_mps": 1.05,
  "accessibility": { "avoid_stairs": true }
}
```

`point_of_view` sets camera height. `pace_mps` sets how long every unrouted leg takes. `accessibility`
is passed to the router, so a step-free tour genuinely avoids stairways rather than merely claiming
to. A family with small children walks at about 1.05 m/s; a commuter walks at 1.3.

---

## 6. Crossing modules

The most interesting thing a tour can do is leave the module it started in.

```json
{
  "type": "enter_inspect",
  "module_id": "manhattan-bridge",
  "entry_id": "brooklyn_anchorage",
  "target": { "asset": "urn:d3d:manhattan-bridge:anchorage_brooklyn" },
  "duration_s": 10
}
```

The player switches mode, which tightens the LOD budget from the walk value to the inspect value,
lifts the proxy cap on that module, and emits `handoff:enter`. The owning module's shell, if one is
loaded, takes over its own UI. `exit_inspect` reverses it. Because both modules share a frame, the
camera pose survives the transition and the user never loses their place.

`requires_modules` lets a tour state its dependencies up front. The player refuses to start with a
clear message rather than silently skipping stops it cannot reach.

---

## 7. Producing tours

`dumbo-district-3d/scripts/build_tour.py` is a worked example: it routes with A* over the district
walk network, splits the path into maneuver steps at turns over 35° and at street-name changes, and
phrases instructions the way a directions API does. Unnamed connector segments inherit the last known
street name, forwards only — a kerb cut between two blocks of Water Street is still Water Street, but
a park path is not.

To swap in a real provider, rewrite `route_leg` and change nothing else.

Authoring guidance:

- Keep `transition.kind` as `walk` for anything claiming to be a walkthrough. `cut`, `fade` and
  `teleport` are cinematic shortcuts and should be rare in a demo whose point is that you can walk it.
- Set `speed_multiplier` in `defaults` to fit the presentation. A 4× rate turns an 18-minute walk
  into four and a half minutes without pretending the walk is shorter than it is.
- Record `route_source`, including `attribution_text`. Most providers' directions data carries
  redistribution terms.

---

## 8. Player contract

`TourPlayer` from `@d3d/viewer-kernel` compiles the script once into a flat timeline of travel and
dwell phases. That makes total duration knowable up front, makes seeking possible, and lets the whole
future route be handed to the streaming manager.

```ts
const player = new TourPlayer(script, { frame, bus, resolveAsset, router, groundHeight });
player.play();

// each frame
const camera = player.update(deltaSeconds);
// camera.position, .headingDeg, .pitchDeg, .rig, .moving

// hand the future route to the streamer so geometry arrives before the party does
streamer.update(cameraState, viewport, mode, { plannedRoute: player.plannedRoute(500, 50) });
```

`plannedRoute` is the reason a scripted walk does not stutter: the streamer stops guessing from
heading alone and prefetches along a route it actually knows.
