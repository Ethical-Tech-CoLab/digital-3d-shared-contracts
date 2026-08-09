# Coordinate System

**Status:** normative, v1.0.0

Every module in this stack expresses geometry in a declared frame. This document defines the frame types,
the transform chain and the datum rules. It is the companion to
[`schemas/georeference.schema.json`](schemas/georeference.schema.json).

---

## 1. Why this document exists

The Manhattan Bridge model is authored with its origin at the main-span midpoint, `+X` toward Brooklyn,
`+Z` up, meters, with `z = 0` at **mean high water**. That is a good engineering frame and it should not
change.

The DUMBO district is built from NYC open data, which is published in New York State Plane (EPSG:2263) with
elevations in **NAVD88**, in feet.

Neither frame is wrong. But "z = 0" means two different surfaces, `+X` means two different directions, and
one dataset is in feet. Put them in one scene without a written contract and the result is a bridge that is
0.59 m too high, rotated by an unrecorded angle, next to buildings that are 3.28 times too tall.

---

## 2. The frame chain

```
  WGS84 geodetic  (lon, lat, h)          interchange only, never used for rendering
        │
        │  rigorous, via ECEF
        ▼
  scene frame  "nyc-harbor-enu"          meters, right-handed, Z-up, East/North/Up
        │                                THE shared world. All modules meet here.
        │  placement: translate + rotate (+ scale, display only)
        ▼
  module local frame                     e.g. bridge: origin at main-span midpoint
        │
        │  (x, y, z) -> (x, z, -y)
        ▼
  render frame                           glTF / three.js, Y-up
```

### 2.1 Geodetic

WGS84, EPSG:4326. Used for interchange, for anything a map or a routing provider produces, and for tour
scripts that must stay portable across scene frames. Order is always `[longitude, latitude]`, per
RFC 7946. Never render from geodetic coordinates: at NYC latitudes a float32 longitude has roughly 8 m of
quantisation.

### 2.2 Scene frame

A local East-North-Up tangent plane, defined by a geodetic anchor.

| Property | Value |
|---|---|
| `frame_id` | `nyc-harbor-enu` |
| Units | meters |
| `+X` | East |
| `+Y` | North |
| `+Z` | Up |
| Handedness | right-handed |
| Anchor | `-73.9890, 40.7030`, height `0` |
| Anchor vertical datum | NAVD88 |
| Validity radius | 4000 m |
| Flat-plane drop at radius | 1.26 m |

The anchor is **frozen by convention**. It is not a survey monument and claims nothing about the world; it
was chosen as a round number near the district centroid so coordinates stay small and float32 stays
comfortable. It is normative because everything depends on it, and it may not change within a contract
major version.

The transform is **rigorous**, not a small-angle approximation: geodetic to ECEF, then a rotation into the
local ENU basis. It round-trips to better than a micrometre across the whole validity radius. The only
thing a flat scene loses is that the curved Earth falls away from the `z = 0` plane with distance:

| Distance from anchor | Drop below the plane |
|---|---|
| 250 m | 0.005 m |
| 500 m | 0.020 m |
| 1000 m | 0.078 m |
| 4000 m | 1.257 m |

Across the district this is smaller than the ±0.61 m positional accuracy of the building footprint source,
so a flat ground plane is defensible. It is recorded rather than assumed, and it sets the honest limit: do
not make an A-grade vertical claim about something 4 km away using this frame.

### 2.3 Module local frames

A module authored in its own frame keeps it and publishes a `placement`:

```
p_scene = translation + rotation * (scale * p_local)
```

`scale` MUST be `1` for georeferenced delivery. Non-unit scale is reserved for display scales such as
HO 1:87.1, which is a viewer concern and never a data concern.

For the pure-heading case, `yaw_deg` may be supplied instead of a quaternion: the rotation about `+Z` that
carries the module's `+X` axis onto scene East, counter-clockwise looking down.

A module authored directly in the scene frame — as `dumbo-district-3d` is — omits `placement` entirely.

### 2.4 Render frame

glTF and three.js are Y-up. The conversion is fixed and both viewers MUST apply exactly this:

```
(x_scene, y_scene, z_scene)  ->  (x_scene, z_scene, -y_scene)
```

East stays `+X`, Up becomes `+Y`, North becomes `-Z`. Stated here so no one derives it twice and gets a
mirrored scene.

---

## 3. Vertical datums

**Rule: every elevation states its datum. There is no default.**

Supported values: `NAVD88`, `MHW`, `MSL`, `MLLW`, `ellipsoid_wgs84`, `scene_local`.

The georeference document carries `vertical_datum_offsets_m`, giving the height of each named datum above
the frame's anchor datum. For `nyc-harbor-enu`, anchored on NAVD88:

| Datum | Offset above NAVD88 | Source |
|---|---:|---|
| NAVD88 | 0.00 m | definition |
| MHW | **+0.59 m** | NOAA CO-OPS station 8518750 (The Battery, NY), epoch 1983-2001 |
| MSL | −0.07 m | same station and epoch |
| MLLW | −0.85 m | same station and epoch |

Derivation of the MHW figure, from NOAA's published datums for station 8518750 relative to that station's
own datum, in meters: `MHW = 2.44`, `NAVD88 = 1.85`, so `MHW − NAVD88 = 0.59 m`. Independently
corroborated at 0.596 m by a New York State surveyors' datum sheet for the same station.

### 3.1 The conversion every consumer needs

To place Manhattan Bridge geometry, authored against MHW, into the district frame:

```
z_scene = z_bridge_mhw + 0.59
```

Skipping this puts the entire bridge 0.59 m low relative to the buildings it lands between. That is larger
than the footprint data's own accuracy, and it is visible where the bridge meets the anchorage plaza.

The Battery is about 3 km from the anchor. Tidal datum separation varies slowly along the East River, so
transferring a Battery-derived offset introduces far less error than the 0.59 m it corrects. Tracked as
`DOQ-004` in `dumbo-district-3d`; retire it with a VDatum-derived local offset before making an A-grade
vertical claim about the waterfront.

---

## 4. Horizontal source conversions

| Source | Native CRS | Units | Conversion |
|---|---|---|---|
| NYC Building Footprints | EPSG:2263 natively; EPSG:4326 as published on Open Data | degrees as consumed | geodetic to ENU |
| NYC MapPLUTO | EPSG:2263 natively; lat/lon columns are EPSG:4326 | degrees as consumed | geodetic to ENU |
| OpenStreetMap | EPSG:4326 | degrees | geodetic to ENU |
| Routing providers | EPSG:4326 | degrees | geodetic to ENU |

Attribute units are a separate hazard from coordinate units. NYC footprint `height_roof` and
`ground_elevation` are **feet**, and `height_roof` is a height *above the local ground elevation*, not an
elevation. Use the international foot, `0.3048 m`, for these published attribute values; the US survey foot
`0.3048006096 m` applies only to native EPSG:2263 coordinates.

---

## 5. Precision

Browsers render in float32, which holds about 7 significant decimal digits.

| Approach | Worst-case quantisation in DUMBO |
|---|---|
| ECEF coordinates in float32 | ~0.5 m — unusable |
| Geodetic degrees in float32 | ~8 m — unusable |
| Scene ENU meters in float32 | ~0.0001 m — fine |

This is the practical reason the scene frame exists, independent of any bookkeeping argument. Keep all
per-vertex data in scene meters. Do transforms in float64 on the CPU, upload float32.

For tiled content, mesh vertices SHOULD be stored relative to the tile origin and the tile placed by a
node transform. At 128 m tiles that keeps vertex magnitudes under ~91 m and quantisation near 10⁻⁵ m.

---

## 6. Conformance checklist

A module conforms when:

- [ ] It publishes exactly one `georeference` document, or references a shared one by `frame_id`.
- [ ] Every payload it publishes names the `frame_id` its coordinates are in.
- [ ] Every elevation it publishes names its `vertical_datum`.
- [ ] If authored in a private frame, it publishes a `placement` with an honest `confidence`, and marks it
      `provisional: true` until the owning team ratifies it.
- [ ] It applies the fixed scene-to-render conversion and does not invent its own.
- [ ] It states `valid_radius_m` and does not place geometry outside it.
