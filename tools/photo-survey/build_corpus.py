"""Merge human review decisions into the photo survey a module actually consumes.

Promoted from `dumbo-district-3d/scripts/build_photo_corpus.py`. The rule it enforces is the one
that matters:

    **If a person has looked at a photograph and said use or skip, that judgement wins outright.**

No heuristic overrides a human. A record nobody has looked at stays `auto_screened` and is carried
as weaker evidence rather than quietly promoted or quietly dropped.

What this tool will NOT do, and why
-----------------------------------
It does not grade a control. A reviewed photograph can establish **what something is made of** and
**how it is arranged**; it cannot establish **how big** something is without scale control in the
frame. Consuming modules should treat an accepted photograph as material and arrangement evidence,
and should keep dimensional claims tied to measured drawings and primary documents. The output says
so per record, in `grants_confidence`, so a downstream reader cannot mistake one for the other.

Usage::

    python build_corpus.py --config path/to/photo-campaign.json
"""

from __future__ import annotations

import argparse
import json
import pathlib
import time
from pathlib import Path

TOOL_VERSION = "photo-survey/build_corpus@1.0.0"

# What an accepted photograph is allowed to support. Deliberately short.
#
# `material` and `arrangement` are things a photograph genuinely settles: whether a pier is brick or
# granite, whether a walkway runs above the roadway or beside it. `dimension` is absent on purpose --
# a photograph without scale control cannot carry one, and leaving the value out of the vocabulary
# stops it being claimed by accident.
GRANTS = ("material", "arrangement", "existence", "condition", "appearance")

# What each grant becomes in the contract's own aspect vocabulary.
#
# The campaign speaks of grants because that is what a reviewer is deciding; the survey document
# speaks of aspects because that is what a consumer reads. Keeping the two vocabularies mapped
# rather than merged is deliberate: `appearance` lands on `other`, which is honest, because a
# photograph that only shows what something looks like informs nothing in particular.
# Nothing on the right-hand side is dimensional, and there is no route by which it could become so.
GRANT_ASPECT = {
    "material": "surface_material",
    "arrangement": "member_arrangement",
    "existence": "fitting_existence",
    "condition": "condition",
    "appearance": "other",
}

# A reviewed photograph grants B and never better. B is "observed": a person looked at a real
# image of the real structure and reported what they saw. A is reserved for a measured drawing or
# a primary document, and no quantity of photographs adds up to one.
PHOTO_MAX_CONFIDENCE = "B"


def die(msg: str) -> None:
    raise SystemExit("BUILD FAILED: " + msg)


def parse_verdict(raw: str, valid: set[str], oid: str) -> tuple[str, list[str]]:
    """Read `use:a,b`, `use` or `skip`.

    The plain `use` form is accepted for corpora reviewed before categories existed; it means the
    reviewer kept the photograph without saying what for.
    """
    text = (raw or "").strip()
    if text == "skip":
        return "skip", []
    if text == "use":
        return "use", []
    if not text.startswith("use:"):
        die("%s has verdict %r; expected 'use', 'use:<categories>' or 'skip'" % (oid, raw))
    cats = [c.strip() for c in text[4:].split(",") if c.strip()]
    unknown = [c for c in cats if c not in valid]
    if unknown:
        die("%s cites categories not in the campaign: %s" % (oid, ", ".join(unknown)))
    return "use", cats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True)
    ap.add_argument("--root", default=".", help="module root that output paths are relative to")
    ap.add_argument("--reviewer", default="repository owner")
    args = ap.parse_args()

    cfg_path = Path(args.config).resolve()
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    root = pathlib.Path(args.root).resolve()
    valid = {c["id"] for c in cfg["categories"]}
    module_id = cfg["module_id"]
    grants_for = {c["id"]: c.get("grants", "appearance") for c in cfg["categories"]}
    for cid, g in grants_for.items():
        if g not in GRANTS:
            die("category %s declares grants=%r, which is not in %s" % (cid, g, GRANTS))

    # A campaign may name its own categories, but only from the contract's vocabulary: a
    # reviewer's tick ends up in `categories`, which is a closed enum. Read the enum from the
    # schema rather than restating it, so this check cannot drift away from the thing it checks.
    schema_path = Path(__file__).resolve().parents[2] / "schemas" / "photo-survey.schema.json"
    if schema_path.exists():
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        allowed = set(schema["$defs"]["observation"]["properties"]["category"]["enum"])
        stray = sorted(valid - allowed)
        if stray:
            die("campaign declares categories the photo-survey contract does not define: %s.\n"
                "  Add them to the enum in %s (an additive change), or rename them to existing "
                "members. A tick that cannot be expressed in the survey document is a tick that "
                "gets silently dropped." % (", ".join(stray), schema_path))

    survey = json.loads((root / cfg["outputs"]["raw"]).read_text(encoding="utf-8"))
    hints_path = (root / cfg["outputs"]["raw"]).with_suffix(".harvest-report.json")
    hints: dict[str, list[str]] = {}
    if hints_path.exists():
        hints = json.loads(hints_path.read_text(encoding="utf-8")).get("asset_hints", {})
    decisions_path = root / cfg["outputs"]["decisions"]
    decisions = {}
    if decisions_path.exists():
        decisions = json.loads(decisions_path.read_text(encoding="utf-8"))
    else:
        print("no decisions file at %s -- every record stays auto_screened" % decisions_path)

    kept, skipped, untouched = [], 0, 0
    by_category: dict[str, int] = {}
    unknown_ids = [k for k in decisions if k not in {o["observation_id"] for o in survey["observations"]}]
    if unknown_ids:
        die("decisions reference %d observation(s) not in the survey, e.g. %s. "
            "The survey was rebuilt without the decisions being migrated."
            % (len(unknown_ids), unknown_ids[0]))

    for obs in survey["observations"]:
        oid = obs["observation_id"]
        if oid not in decisions:
            untouched += 1
            obs["review"]["status"] = "auto_screened"
            kept.append(obs)
            continue
        verdict, cats = parse_verdict(decisions[oid], valid, oid)
        if verdict == "skip":
            skipped += 1
            continue
        # A bare `use` means the reviewer kept the photograph without saying what for, which is
        # the definition of context. Recording it as such keeps the array non-empty and, more
        # usefully, stops an unexplained keep from being mistaken for evidence of something.
        if not cats:
            cats = ["context"]
        obs["categories"] = cats
        obs["category"] = cats[0]
        aspects = sorted({GRANT_ASPECT[grants_for.get(c, "appearance")] for c in cats}) or ["other"]
        subjects = [
            {"asset_id": "urn:d3d:%s:%s" % (module_id, a), "aspect": aspects}
            for a in hints.get(oid, [])
        ]
        if subjects:
            obs["observes"] = subjects
        else:
            obs.pop("observes", None)
        obs["review"] = {
            "status": "accepted",
            "reviewer": args.reviewer,
            "notes": (
                "Reviewed by a person. This judgement overrides any automatic screen. "
                "Kept for: %s." % ", ".join(cats or ["appearance"])
            ),
            "grants_confidence": PHOTO_MAX_CONFIDENCE,
        }
        for c in cats:
            by_category[c] = by_category.get(c, 0) + 1
        kept.append(obs)

    survey["observations"] = kept
    # Campaign-level fields come from the config, not from whatever the raw file happened to carry.
    # The raw corpus is harvested once and reviewed over days; a campaign edited in between would
    # otherwise be silently ignored. That is not hypothetical: the Williamsburg campaign gained its
    # `frame_id` after harvesting, and the corpus was written without one — passing every step of
    # this pipeline and then failing the contract it declares conformance to.
    if cfg.get("frame_id"):
        survey["frame_id"] = cfg["frame_id"]
    survey["provenance"] = {
        "module_id": module_id,
        "generated_by": TOOL_VERSION,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    # Refuse to write a document that cannot satisfy the contract it declares. The README already
    # records that "nothing validated the document these scripts existed to produce", and six
    # conformance bugs shipped behind that gap; a missing `frame_id` was the seventh. This is not a
    # substitute for `node tools/validate.mjs`, which checks the whole schema — it is the cheap
    # subset that needs no toolchain, so the common failure is caught where it is caused.
    missing = [f for f in ("contract_version", "module_id", "frame_id", "observations")
               if not survey.get(f)]
    if missing:
        die("refusing to write a survey missing %s. Add %s to the campaign config."
            % (", ".join(missing), " and ".join(missing)))

    # The review tally is governance-relevant but has no home in the contract's `provenance`,
    # which is deliberately narrow. It goes beside the document rather than being smuggled in.
    report = {
        "tool": TOOL_VERSION,
        "module_id": module_id,
        "accepted": len(kept) - untouched,
        "auto_screened": untouched,
        "refused_by_review": skipped,
        "by_category": by_category,
        "grants_note": (
            "An accepted photograph supports material, arrangement, existence, condition and "
            "appearance, and grants confidence %s at best. It does NOT carry a dimension: without "
            "scale control in the frame a photograph cannot measure. Dimensional claims stay with "
            "measured drawings and primary documents." % PHOTO_MAX_CONFIDENCE
        ),
    }

    out = root / cfg["outputs"]["survey"]
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(survey, fh, indent=1, sort_keys=False)
        fh.write("\n")

    with out.with_suffix(".review-report.json").open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(report, fh, indent=1, sort_keys=False)
        fh.write("\n")

    print("accepted      %4d" % (len(kept) - untouched))
    print("auto_screened %4d  (nobody has looked)" % untouched)
    print("refused       %4d" % skipped)
    if by_category:
        print("by category:")
        for c, n in sorted(by_category.items(), key=lambda kv: -kv[1]):
            print("   %-16s %3d   grants %s" % (c, n, grants_for.get(c, "appearance")))

    # A category the campaign asked for and the reviewer never ticked is a measurement, not an
    # absence of news. Crowd-sourced imagery skews hard toward the view worth photographing, which
    # is systematically not the view a model is missing -- so an empty category is the signal to
    # stop harvesting and go to the drawings. Printed loudly because it is easy to read a tally of
    # what was found and never notice what was not.
    if decisions:
        empty = [c["id"] for c in cfg["categories"] if not by_category.get(c["id"])]
        if empty:
            print()
            print("CATEGORIES THE CAMPAIGN ASKED FOR AND THE REVIEW NEVER FOUND:")
            for c in empty:
                help_text = next((x.get("help", "") for x in cfg["categories"] if x["id"] == c), "")
                print("   %-16s %s" % (c, help_text[:96]))
            print("   These are not gaps in the review. They are gaps in what people photograph,")
            print("   and no amount of further harvesting will change the distribution.")
    print("wrote %s" % out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
