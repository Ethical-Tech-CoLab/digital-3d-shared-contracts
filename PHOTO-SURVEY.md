# Photo Survey

**How to crowdsource photographs that actually improve a digital twin, rather than accumulating an
album nobody can use.**

Normative schema: [`schemas/photo-survey.schema.json`](schemas/photo-survey.schema.json).

---

## 1. The recommendation, in one line

> **Treat a photograph as an *observation*, not an image.** It is evidence that a specific asset,
> seen from a specific place, in a specific direction, at a specific moment, looked a specific way —
> under a specific licence. Everything else follows from that.

The failure mode this avoids is the common one: a shared drive of ten thousand nice pictures of the
neighbourhood, none of which can be tied to a building, none of which have a known licence, and none
of which can therefore change a single pixel of the model.

### Why this matters here specifically

The DUMBO twin currently infers appearance rather than observing it. Three open questions say so:

| | What is inferred today |
|---|---|
| `DOQ-007` | Facades describe the *kind* of building (from PLUTO class and year), not that building |
| `DOQ-006` | Paving widths are typical values by street class, not traced kerbs |
| props | Tree canopy is a plausible form for the genus, not that tree |

Every one of those is a question a photograph can answer. That is the point of the campaign: not
prettier screenshots, but **grade promotion**, from `C` inferred to `B` observed.

---

## 2. What makes a photo usable

Four fields, in descending order of how often they are missing:

1. **Licence.** Required. An image whose licence is unknown cannot be used, however good it is. This
   is the single biggest reason found photography is unusable.
2. **Bearing.** Which way the camera faced. Without it a photo says what a place looks like but not
   *from where*, and cannot be attached to a particular facade.
3. **Capture date, and its precision.** Not upload date. An archival photo is valuable *as history*
   and dangerous *as current condition*; `captured_precision` keeps the two apart.
4. **Subject.** Which assets it observes, and for which *aspect*. A wide streetscape may be
   excellent evidence for paving and tree size while being useless for one building's windows. The
   schema models that: `observes[].aspect` is a list, per asset.

Position matters less than people expect. Consumer GPS in a street canyon is routinely 10–30 m out,
which is wider than the street. **A photo with a good bearing and a named subject is worth more than
one with a precise coordinate and neither.**

---

## 3. Found photography: a starting point, with two traps

Most of the initial corpus will be found online and somewhat dated. That is fine, and it is the
right way to bootstrap — but two traps are worth naming before anyone starts collecting.

### Trap 1: the licence usually forbids what you want to do

| Source | Licence | Usable for |
|---|---|---|
| **Mapillary** | CC BY-SA 4.0 imagery, street-level, bearing included | derive appearance; share-alike obligations flow downstream |
| **Wikimedia Commons** | mixed, mostly CC BY-SA / CC0, per-file | derive appearance; **check each file** |
| **Flickr, filtered to CC** | per-photo | varies; verify per photo, do not trust search filters alone |
| **NYC Municipal Archives** | public domain for much historic material | historic reference, era evidence |
| **Google Street View / Bing Streetside** | proprietary | **nothing.** Viewing in their own product only. Do not trace, derive from, or store. |
| **Real-estate listings, social media** | all rights reserved by default | **nothing**, absent explicit permission |

The `usage` field encodes the distinction that matters in practice:

- `reference_only` — a human may look at it. Nothing may be derived, and it is never published.
- `derive_appearance` — colours, materials and proportions may be derived; the image itself stays
  internal.
- `redistribute` — the image may be served to end users.

Most found photography lands in the middle tier. That is still enough to fix `DOQ-007`, because what
you want from it is "this facade is painted brick with six bays of double-hung windows and a green
awning", not the pixels.

### Trap 2: dated photos silently become claims about now

DUMBO has changed enormously since 2010. A 2014 photo showing a vacant storefront is not evidence
about today's storefront. Three defences, all in the schema:

- `captured_at` plus `captured_precision` — an archival image dated only to a decade is marked so.
- `supersedes` — a current photo explicitly retires a dated one of the same subject.
- `review.grants_confidence` — a reviewer caps what the observation may justify. Dated imagery
  typically grants `C`: better than inference, not equal to observation.

**Photographs never grant grade `A`.** Grade A is reserved for official dimensions, archival
drawings and authoritative datasets. A photograph is excellent evidence of *appearance* and poor
evidence of *dimension*.

---

## 4. Pipeline

Ingestion is continuous, not a one-off import.

```
  contribute ──▶ auto-screen ──▶ human review ──▶ derive ──▶ rebuild
   volunteer      EXIF, dedupe,   subject, licence,  appearance   assets get
   or found       blur faces,     grade cap          attributes   new grades
                  geocode
```

**Auto-screen** rejects cheaply and early: no licence, no date, long edge under ~1200 px, GPS
outside the district, near-duplicate of an existing accepted observation, faces or plates detected
and not yet blurred.

**Human review** does the part a machine should not: confirming which asset is actually in frame,
whether scaffolding is hiding the subject, and what confidence the observation may grant.

### What a reviewer records

A verdict — keep or skip — and, if kept, **every subject the frame contains**. Not the most
important one: all of them. A DUMBO street view is a brick facade, a granite kerb and a street tree
in a single exposure, and making the reviewer choose discards two of the three.

| Category | Means | May inform |
|---|---|---|
| `facade` | A building's exterior wall | Facade colour and material; attaches to a specific building |
| `surface` | Ground: paving, cobbles, kerbs | Paving and kerb colour |
| `greenery` | Trees, planting, grass | Foliage colour, canopy size |
| `furniture` | Benches, railings, lamps, bollards | Prop appearance |
| `landmark` | A named feature — the carousel, an arch | That landmark's appearance |
| `bridge` | A subject another module owns | **Nothing** |
| `historic` | A past state | Geometry and layout, never colour |
| `context` | Useful to a human, not to the renderer | Nothing |

Permissions are the **union** of the tags, which is what lets the awkward pairs resolve themselves
instead of needing a rule each. `bridge` contributes nothing, so `[bridge, facade]` yields exactly
the facade's permissions. `historic` contributes aspects but no measured colour, because an archival
wall may have been repainted twice since.

Two of these categories exist because a real corpus taught us they had to. `bridge` was added after
a bridge's paint was averaged onto a warehouse; the neighbouring module owns that subject and this
one must not guess at it. `historic` was added after an archival photograph of a demolished building
was about to be presented as a claim about today.

The reviewer's rejections are worth more than the acceptances and should be **stored permanently**,
keyed by source URL, so a later re-ingest cannot quietly resurrect them. Everything else in a photo
pipeline can be re-fetched; human judgement cannot.

**Derive** turns accepted observations into the module's appearance data. For DUMBO that means
`facades.json` entries move from `source_basis: ["official_dataset"]` inferred, to
`["official_dataset", "photo"]` observed, with `confidence` raised to `B` and `DOQ-007` closed for
that building.

The important structural property: **`facades.json` keeps exactly the same shape.** The viewer does
not change. A building whose facade came from a photograph and one whose facade came from PLUTO
class render through the same code path and differ only in their recorded confidence.

---

## 5. Volunteer capture guide

Written to be handed to a non-technical volunteer.

### Before you go

- Any phone from the last several years is fine. Resolution is rarely the limiting factor.
- **Turn on location, and turn on the compass.** In iOS: Settings → Privacy → Location Services →
  Camera → While Using. On Android, enable "Store location" in the camera app. Without a compass
  bearing your photo is worth much less.
- Pick a **dry, bright but overcast** day if you can. Even light beats sunshine: harsh shadows hide
  exactly the facade detail we are trying to record.
- Mid-morning on a weekday has the fewest parked cars and the fewest people in frame.

### What to photograph

In priority order, because the model needs them in this order:

1. **Whole facades, straight on.** Stand across the street, centre the building, hold the phone
   *level and upright*. One per building face that meets the street.
2. **The ground floor separately.** Storefronts, awnings, signage, doorways. This is where a
   district's character lives and where our data is weakest.
3. **Paving and kerbs.** Point the camera down at about 45°, capturing where sidewalk meets road.
   Cobblestone, granite kerbs, tree pits.
4. **Street trees with something for scale.** A whole tree in frame, ideally with a doorway, parking
   meter or person nearby so canopy size can be estimated.
5. **The same view in different seasons.** Bare and full canopy from the *same spot* is unusually
   valuable and costs one extra visit.

### How to take a good one

- **Level and upright.** Tilting up to fit a tall building makes it lean backwards and makes the
  photo far harder to use. Instead, step further back. If you cannot, take it tilted and say so.
- **Fill the frame with the subject**, not with sky and road.
- **Stand still, tap to focus, then shoot.** Motion blur is the most common reason a photo is
  rejected.
- **Do not zoom** unless you must — digital zoom throws away the detail we want.
- **Do not edit, filter or crop.** Send the original. Filters change the colours we are trying to
  record, and cropping destroys the EXIF that tells us where you stood.
- **Take two or three of anything important**, from slightly different positions. Redundancy is
  cheap; a return trip is not.

### What not to photograph

- **Interiors, and through windows.** Out of scope and intrusive.
- **Anything requiring you to trespass, block a footway, or step into a roadway.** Nothing here is
  worth your safety, and a photo taken from an inaccessible spot is one nobody can retake.
- **People as subjects.** They will inevitably appear in the background; that is fine, faces get
  blurred. Do not photograph individuals deliberately, and do not photograph children.
- **Anything you were asked not to.** If someone objects, delete it and move on.

### When you submit

Tell us:

- **Roughly where you were and which way you were facing** — "Water St at Main, looking north-east"
  is genuinely enough if the compass data is missing.
- **What you were photographing** — "the green awning on the corner building".
- **Roughly when**, if the file date might be wrong.
- **That it is yours and we may use it.** Contributions are accepted under CC BY 4.0 unless you say
  otherwise. You keep the copyright; we get permission to derive from it and credit you.

Pseudonyms are fine. A campaign should never require a contributor's real identity.

---

## 6. Privacy and safety

Non-negotiable, and worth stating in the contract rather than in a policy nobody reads:

- **Faces and readable licence plates are blurred before any image is published.**
  `contains_people` flags an image for review; `privacy_reviewed` records that it happened.
- **`reference_only` images are never served to end users**, only to reviewers.
- **Contributor identity is optional and pseudonymous by default.**
- **No photography of building interiors**, and none through windows into private space.
- **A takedown request is honoured immediately**, and `supersedes` keeps the derived appearance
  working after the image is gone — which is a real advantage of deriving attributes rather than
  serving textures.

---

## 7. Checklist

For a campaign:

- [ ] Every observation validates against `photo-survey.schema.json`.
- [ ] `license` and `usage` are present on every record; unlicensed images are rejected, not stored.
- [ ] `captured_at` and `captured_precision` are recorded; dated imagery cannot claim to be current.
- [ ] `review.grants_confidence` is set by a human and never exceeds `B`.
- [ ] Derived appearance records `photo` in `source_basis` and cites the observation ID.
- [ ] Attribution for every contributing image is displayed wherever derived appearance is rendered.
- [ ] Faces and plates are blurred before publication, and the review is recorded.
- [ ] Retiring an open question is an explicit, per-asset act, not a bulk assumption.
