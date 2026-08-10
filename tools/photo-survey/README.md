# Photo survey tooling

Crowd-sourced photographs, screened by a **person**, turned into evidence a source-governed model can
cite. Three standard-library scripts, driven by one config file, so a bridge, a district or a
building runs the same pipeline without forking it.

```
harvest.py       licence-first fetch from Wikimedia Commons and Openverse
review_sheet.py  one self-contained HTML page; a human ticks what each photo can inform
build_corpus.py  merges those decisions into the survey the module consumes
```

Promoted from `dumbo-district-3d/scripts/`, where the approach was proven on **537 reviewed
photographs**. What was module-specific there — the shot list, the search area, the category
vocabulary — is now config.

---

## Why a human is in the loop

Because the automatic screen could not do the job and should not have pretended to.

Measured across the DUMBO corpus, sky coverage ran **0.16–0.79 for interiors and 0.51–1.00 for
exteriors**. Any threshold that caught the interiors also discarded good street views. The honest
answer is a person, and the contract said so all along by grading every harvested record
`auto_screened` rather than `accepted`.

That grade is not cosmetic. A record nobody has looked at stays `auto_screened` and is carried as
weaker evidence — never silently promoted, never silently dropped. **If a person has said use or
skip, that judgement wins outright.**

---

## The two rules that keep this honest

**1. An unknown licence is a rejection, not a default.** However good the photograph looks, if the
licence cannot be read it is refused. Fetching it anyway would only create a temptation later. Each
recognised licence maps to what it actually permits:

| | |
|---|---|
| `redistribute` | the image may be served to end users, with its credit line |
| `derive_appearance` | facts may be read from it; **the image is not republished by us** |

Share-alike sits at `derive_appearance` deliberately. Reading the material of a wall extracts a
fact, and facts carry no copyright, so nothing downstream inherits the ShareAlike obligation.
Republishing would be permitted too, but only under the same licence — and quietly mixing that
obligation into an otherwise-MIT repository is very hard to unpick later.

**2. A photograph cannot carry a dimension.** It can settle what something is *made of* and how it
is *arranged*; without scale control in the frame it cannot measure. So the vocabulary a category
may grant is closed, and `dimension` is not in it:

```
material  arrangement  existence  condition  appearance
```

`build_corpus.py` writes the grant per record in `review.grants_confidence`, so a downstream reader
cannot mistake one for the other. Dimensional claims stay with measured drawings and primary
documents.

---

## Running a campaign

```powershell
python tools/photo-survey/harvest.py      --config <module>/photo-campaign.json --root <module>
python tools/photo-survey/review_sheet.py --config <module>/photo-campaign.json --root <module>
start <module>/viewer/public/review/index.html
#   tick what each photograph can inform, press Save, drop review-decisions.json where it says
python tools/photo-survey/build_corpus.py --config <module>/photo-campaign.json --root <module>
```

`--root` is the module the output paths are relative to; the config may live anywhere.

The review sheet **hotlinks** the images from their source rather than copying them, so no
third-party bytes are stored, and it needs no server. It ships inside `viewer/public/`, so a
reviewer can work through it from a phone rather than only on the machine that built the corpus.

---

## The config

```jsonc
{
  "module_id": "brooklyn-bridge-3d",
  "campaign_name": "...",
  "purpose": "why this campaign exists, in terms of the model's own open questions",
  "area":  { "lat": 40.7061, "lon": -73.9969, "radius_m": 1200 },
  "shots": [ { "subject": "towers",
               "commons_category": "Towers of the Brooklyn Bridge",
               "openverse": "Brooklyn Bridge tower arches masonry",
               "informs": ["tower_manhattan"] } ],
  "categories": [ { "id": "masonry", "label": "masonry", "grants": "material",
                    "help": "shown in the review sheet's legend" } ],
  "outputs": { "raw": "...", "decisions": "...", "survey": "...", "review_sheet": "..." }
}
```

**Write `help` against the model's own open questions.** A reviewer ticking `arcade` because the
legend says *"OQ-007: the model draws slender bents, but SRC-004 describes brick piers and arches"*
is answering a specific question. A reviewer ticking `arcade` because it looks like an arcade is
just sorting photographs.

**The `area` coordinate is for search only.** It must never become a control. This repository's
sibling records exactly that trap: an invented coordinate was nearly used to "verify" a placement.

---

## Traps met while building this

**Openverse now returns HTTP 401 without a key.** A source that refuses looks exactly like a source
with no matching photographs, and the difference matters — one is a gap in the record, the other a
gap in our access to it. Failures are therefore recorded in `provenance.source_failures` and printed
at the end of the run, not swallowed.

**Not every Commons category exists.** Several plausible names returned nothing; the geosearch did
the real work. A shot returning `+0` is reported per shot so a dead category is visible rather than
assumed empty.

**Resolve outputs against the module root, not the config's directory.** The first run wrote
`sources/photos/sources/photos/photos.raw.json`. Hence `--root`.
