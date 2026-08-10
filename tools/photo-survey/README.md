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

## The three rules that keep this honest

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

`build_corpus.py` maps each grant into the contract's own `observes[].aspect` vocabulary —
`material` becomes `surface_material`, `arrangement` becomes `member_arrangement`, and so on —
so a downstream reader sees what the photograph is evidence *for* in the same terms as every
other source. Nothing on the right-hand side of that map is dimensional, and there is no route by
which it could become so. Separately, `review.grants_confidence` records how strongly it counts,
and is capped at `B`: a person looked at a real image of the real structure, which is observation,
not measurement. Dimensional claims stay with measured drawings and primary documents.

**3. What is written before review is as important as what is written after.** A harvested record
carries neither `observes` nor `categories`. Both are judgements — "shows this asset well enough to
inform it", "a reviewer says the frame contains this" — and the harvester has made neither. All it
knows is which query returned the image, which is a fact about a search rather than about a
photograph. That hint rides in the `*.harvest-report.json` sidecar and is shown on the review card
as a prompt, never as a pre-ticked answer; it is promoted to a real `observes` entry only when a
person accepts the record. The contract already said an observation with no subjects is context
rather than evidence, which is precisely the right thing to say about a corpus nobody has read.

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
  "subject_terms": ["Williamsburg Bridge", "Williamsburg"],
  "outputs": { "raw": "...", "decisions": "...", "survey": "...", "review_sheet": "..." }
}
```

**`subject_terms` is optional and orders the review sheet; it never filters.** A geosearch returns
everything inside the radius, which is right for a district and wrong for a single structure — the
first Williamsburg Bridge campaign came back 250 photographs of which 187 were basketball courts, a
sugar refinery and the Manhattan skyline. Listing the subject's name puts the photographs that
mention it first. Nothing is hidden, dropped or pre-ticked, because a heuristic good enough to sort
a list is nowhere near good enough to decide what counts as evidence. Omit it and the corpus keeps
its harvested order.

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
gap in our access to it. Failures are therefore recorded in the `*.harvest-report.json` sidecar and
printed at the end of the run, not swallowed.

**Not every Commons category exists.** Several plausible names returned nothing; the geosearch did
the real work. A shot returning `+0` is reported per shot so a dead category is visible rather than
assumed empty.

**Resolve outputs against the module root, not the config's directory.** The first run wrote
`sources/photos/sources/photos/photos.raw.json`. Hence `--root`.

**Nothing validated the document these scripts existed to produce.** The first corpus declared
`contract_version: 1.0.0` and did not conform to the contract in six separate ways — a campaign
block with invented field names, `observes` holding bare strings, a `provenance` full of fields the
shared definition forbids, and `grants_confidence` set to a list of grant kinds where a single
confidence grade belongs. Every one of those had been reviewed and none had been *checked*, because
declaring a version is free and the tooling never asked. Run the repo validator over the output as
part of the pipeline:

```powershell
node tools/validate.mjs <module>/viewer/public/photo-survey.json
```

**Only the unreviewed path ever ran.** Half of the above lived in `build_corpus.py`'s acceptance
branch, which does nothing until a human has ticked something — so it stayed unexecuted, and its
bugs stayed invisible, through an entire campaign. It was worth feeding the tool a synthetic
decisions file purely to make that branch run once: it immediately produced an empty `categories`
array from a bare `use` verdict, which the schema rejects. If a code path only executes after a
human does something, it has not been tested by shipping.

**A truncated date is a lie with a badge on.** `str(date)[:10]` plus a hard-coded
`captured_precision = "day"` turned Wikimedia's "Taken on 2 June 2016" into `"Taken on 2"`, dated to
the day, 272 times over. Precision is now *derived* from what actually parsed — the corpus came back
90 exact, 142 day, 37 year, 3 genuinely unknown — and unparseable input yields no date at all
rather than a confident wrong one.

**The corpus is biased toward the photogenic, and that is the campaign's most useful output.** The
first full run of this pipeline settled the promenade decking and the roadway surface immediately —
both are photographed thousands of times a year — and returned **zero** images for the two
categories the campaign was actually built to close: the approach arcade and the staircase down to
street level. People photograph a bridge from its walkway and its waterfront, not from underneath
the viaduct they drive on. So:

- **Declare the categories you need, not the ones you expect to fill.** An empty category is a
  measurement. Had the campaign only listed subjects likely to appear, the gap would have been
  invisible and easy to mistake for coverage.
- **Report zero-tick categories loudly.** `build_corpus.py` prints the per-category tally, and a
  category absent from it is the signal to stop harvesting and go to the drawings, the owner, or a
  targeted field visit.

Crowd-sourcing answers the questions the crowd finds interesting. Those are rarely the questions a
model is missing, and no amount of additional harvesting changes the distribution.

**A corpus is not from one day, so mark what changes.** The first real campaign returned images
from 1867 to 2026. That is a resource for anything original — granite, ironwork, the towers — and a
hazard for anything renewed, because a Victorian photograph of a roadway is excellent evidence
about a surface that was torn up seventy years ago. Declare it per category:

```json
{ "id": "deck",    "grants": "material", "temporal": "renewed" }
{ "id": "masonry", "grants": "material", "temporal": "stable"  }
```

and have the consuming module refuse archival frames as evidence for renewed subjects. The reviewer
in that campaign got this right without being asked, tagging every pre-1920 image `context` and
nothing else — which is exactly why it was worth encoding. Correctness that rests on one person's
instinct is not yet a property of the pipeline.

**Ambiguity is a legitimate parse result.** Commons returned `DateTimeOriginal = 04/17/24` for an
image the harvester had recorded as undated. Slashed dates only resolve when one field exceeds 12;
given `04/05/24`, picking a convention is wrong about half the time and looks exactly as confident
as being right. The parser now returns day precision when the order is determined and falls back to
the *year* when it is not. A coarser true answer beats a precise coin-flip.
