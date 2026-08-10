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
from pathlib import Path

TOOL_VERSION = "photo-survey/build_corpus@1.0.0"

# What an accepted photograph is allowed to support. Deliberately short.
#
# `material` and `arrangement` are things a photograph genuinely settles: whether a pier is brick or
# granite, whether a walkway runs above the roadway or beside it. `dimension` is absent on purpose --
# a photograph without scale control cannot carry one, and leaving the value out of the vocabulary
# stops it being claimed by accident.
GRANTS = ("material", "arrangement", "existence", "condition", "appearance")


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
    grants_for = {c["id"]: c.get("grants", "appearance") for c in cfg["categories"]}
    for cid, g in grants_for.items():
        if g not in GRANTS:
            die("category %s declares grants=%r, which is not in %s" % (cid, g, GRANTS))

    survey = json.loads((root / cfg["outputs"]["raw"]).read_text(encoding="utf-8"))
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
        obs["categories"] = cats
        obs["review"] = {
            "status": "accepted",
            "reviewer": args.reviewer,
            "notes": "Reviewed by a person. This judgement overrides any automatic screen.",
            "grants_confidence": sorted({grants_for[c] for c in cats}) or ["appearance"],
        }
        for c in cats:
            by_category[c] = by_category.get(c, 0) + 1
        kept.append(obs)

    survey["observations"] = kept
    survey["provenance"] = dict(survey.get("provenance", {}))
    survey["provenance"].update({
        "reviewed_by_tool": TOOL_VERSION,
        "accepted": len(kept) - untouched,
        "auto_screened": untouched,
        "refused_by_review": skipped,
        "by_category": by_category,
        "grants_note": (
            "An accepted photograph supports material, arrangement, existence, condition and "
            "appearance. It does NOT carry a dimension: without scale control in the frame a "
            "photograph cannot measure. Dimensional claims stay with measured drawings and primary "
            "documents."
        ),
    })

    out = root / cfg["outputs"]["survey"]
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(survey, fh, indent=1, sort_keys=False)
        fh.write("\n")

    print("accepted      %4d" % (len(kept) - untouched))
    print("auto_screened %4d  (nobody has looked)" % untouched)
    print("refused       %4d" % skipped)
    if by_category:
        print("by category:")
        for c, n in sorted(by_category.items(), key=lambda kv: -kv[1]):
            print("   %-16s %3d   grants %s" % (c, n, grants_for[c]))
    print("wrote %s" % out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
