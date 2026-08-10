"""Licence-first photograph harvesting for any module in the Digital 3D stack.

Promoted from `dumbo-district-3d/scripts/ingest_photos.py`, which proved the approach on 537
reviewed photographs. Everything module-specific — the shot list, the search area, the category
vocabulary — now comes from a campaign config, so a bridge, a district or a building can run the
same pipeline without forking it.

Two sources, both licence-first:

    Wikimedia Commons  everything carries an explicit licence, and much of it carries coordinates
    Openverse          aggregates Flickr and others, and can be queried with a licence filter

**An image whose licence is unknown is rejected rather than assumed.** However good it looks,
fetching it would only create a temptation later.

What the licence decides is recorded per record rather than applied as a blanket assumption:

    redistribute       the image itself may be served to end users, with its credit line
    derive_appearance  colours, materials and arrangement may be read from it; the image is
                       not republished by us

Share-alike is deliberately held at `derive_appearance`. Reading the material of a wall extracts a
fact, and facts carry no copyright, so nothing downstream inherits the ShareAlike obligation.
Republishing the photograph would be permitted too, but only under the same licence, and quietly
mixing that obligation into a repository that is otherwise MIT is very hard to unpick later.
Reference it, read it, do not vendor it.

Usage::

    python harvest.py --config path/to/photo-campaign.json
    python harvest.py --config ... --limit 40      # a small run while iterating

Zero dependencies, standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import pathlib
from pathlib import Path

TOOL_VERSION = "photo-survey/harvest@1.0.0"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
OPENVERSE_API = "https://api.openverse.org/v1/images/"

# See the module docstring for why share-alike sits at derive_appearance.
LICENCE_POLICY: dict[str, tuple[str, str]] = {
    "CC0-1.0": ("redistribute", "CC0 1.0 Universal"),
    "public-domain": ("redistribute", "Public domain"),
    "CC-BY-2.0": ("redistribute", "Creative Commons Attribution 2.0"),
    "CC-BY-3.0": ("redistribute", "Creative Commons Attribution 3.0"),
    "CC-BY-4.0": ("redistribute", "Creative Commons Attribution 4.0"),
    "CC-BY-SA-2.0": ("derive_appearance", "Creative Commons Attribution-ShareAlike 2.0"),
    "CC-BY-SA-3.0": ("derive_appearance", "Creative Commons Attribution-ShareAlike 3.0"),
    "CC-BY-SA-4.0": ("derive_appearance", "Creative Commons Attribution-ShareAlike 4.0"),
}

LICENCE_PATTERNS = [
    (re.compile(r"^cc[ -]?0", re.I), "CC0-1.0"),
    (re.compile(r"public\s*domain|^pd\b", re.I), "public-domain"),
    (re.compile(r"cc[ -]?by[ -]?sa[ -]?4", re.I), "CC-BY-SA-4.0"),
    (re.compile(r"cc[ -]?by[ -]?sa[ -]?3", re.I), "CC-BY-SA-3.0"),
    (re.compile(r"cc[ -]?by[ -]?sa[ -]?2", re.I), "CC-BY-SA-2.0"),
    (re.compile(r"cc[ -]?by[ -]?4", re.I), "CC-BY-4.0"),
    (re.compile(r"cc[ -]?by[ -]?3", re.I), "CC-BY-3.0"),
    (re.compile(r"cc[ -]?by[ -]?2", re.I), "CC-BY-2.0"),
]

# Every HTTP failure, so the run can report which sources refused rather than reading as if they
# simply held nothing.
HTTP_FAILURES: list[tuple] = []


def die(msg: str) -> None:
    print("HARVEST FAILED: " + msg, file=sys.stderr)
    raise SystemExit(1)


def normalise_licence(text: str | None) -> str | None:
    """Map a free-text licence string onto the closed vocabulary, or None if it is not recognised.

    None is a rejection, not a default. That is the whole point of the function.
    """
    if not text:
        return None
    for pattern, name in LICENCE_PATTERNS:
        if pattern.search(text):
            return name
    return None


def obs_id(url: str) -> str:
    return "obs-" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]


def get_json(url: str, params: dict, user_agent: str, pause: float = 0.6) -> dict:
    query = urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url + "?" + query, headers={"User-Agent": user_agent})
    try:
        with urllib.request.urlopen(req, timeout=45) as fh:
            payload = json.loads(fh.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Reported, not swallowed. A source that returns nothing because it is refusing us looks
        # exactly like a source with no matching photographs, and the difference matters: one is a
        # gap in the record, the other is a gap in our access to it.
        HTTP_FAILURES.append((url.split("/")[2], exc.code))
        return {}
    except Exception as exc:  # noqa: BLE001 - a failed shot must not kill the campaign
        HTTP_FAILURES.append((url.split("/")[2], type(exc).__name__))
        return {}
    time.sleep(pause)
    return payload


# ------------------------------------------------------------------ Commons


def commons_category_members(category: str, user_agent: str, limit: int) -> list[str]:
    titles: list[str] = []
    cont: dict = {}
    while len(titles) < limit:
        params = {
            "action": "query", "format": "json", "list": "categorymembers",
            "cmtitle": "Category:" + category, "cmtype": "file",
            "cmlimit": min(500, limit - len(titles)),
        }
        params.update(cont)
        data = get_json(COMMONS_API, params, user_agent)
        members = data.get("query", {}).get("categorymembers", [])
        titles.extend(m["title"] for m in members)
        if "continue" not in data:
            break
        cont = data["continue"]
    return titles[:limit]


def commons_geosearch(lat: float, lon: float, radius_m: int, user_agent: str, limit: int) -> list[str]:
    data = get_json(COMMONS_API, {
        "action": "query", "format": "json", "list": "geosearch",
        "gscoord": "%s|%s" % (lat, lon), "gsradius": radius_m,
        "gslimit": min(500, limit), "gsnamespace": 6,
    }, user_agent)
    return [m["title"] for m in data.get("query", {}).get("geosearch", [])]


def commons_details(titles: list[str], user_agent: str) -> list[dict]:
    out: list[dict] = []
    for i in range(0, len(titles), 25):
        batch = titles[i:i + 25]
        data = get_json(COMMONS_API, {
            "action": "query", "format": "json", "titles": "|".join(batch),
            "prop": "imageinfo|coordinates",
            "iiprop": "url|extmetadata|size",
            "iiurlwidth": 1024,
        }, user_agent)
        for page in data.get("query", {}).get("pages", {}).values():
            info = (page.get("imageinfo") or [{}])[0]
            if not info.get("url"):
                continue
            meta = info.get("extmetadata", {})

            def field(key: str) -> str | None:
                v = meta.get(key, {}).get("value")
                if not v:
                    return None
                return re.sub(r"<[^>]+>", "", str(v)).strip() or None

            coords = (page.get("coordinates") or [{}])[0]
            out.append({
                "title": page.get("title"),
                "image_url": info["url"],
                "thumbnail_url": info.get("thumburl") or info["url"],
                "licence_text": field("LicenseShortName") or field("License"),
                "licence_url": meta.get("LicenseUrl", {}).get("value"),
                "artist": field("Artist"),
                "credit": field("Credit"),
                "date": field("DateTimeOriginal") or field("DateTime"),
                "lat": coords.get("lat"),
                "lon": coords.get("lon"),
                "collection": "Wikimedia Commons",
                "descriptionurl": info.get("descriptionurl"),
            })
    return out


# ----------------------------------------------------------------- Openverse


def openverse_search(query: str, user_agent: str, limit: int) -> list[dict]:
    data = get_json(OPENVERSE_API, {
        "q": query, "page_size": min(50, limit),
        "license_type": "commercial,modification",
    }, user_agent)
    out = []
    for r in data.get("results", []):
        out.append({
            "title": r.get("title"),
            "image_url": r.get("url"),
            "thumbnail_url": r.get("thumbnail") or r.get("url"),
            "licence_text": (r.get("license") or "") + "-" + (r.get("license_version") or ""),
            "licence_url": r.get("license_url"),
            "artist": r.get("creator"),
            "credit": r.get("source"),
            "date": r.get("indexed_on"),
            "lat": None, "lon": None,
            "collection": "Openverse/" + (r.get("source") or "unknown"),
            "descriptionurl": r.get("foreign_landing_url"),
        })
    return out


# ------------------------------------------------------------------- records


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def prune_nulls(value):
    """Drop keys whose value is None, recursively.

    Every contract in this repo types its optional fields (`"type": "string"`) rather than
    permitting null, so an absent thumbnail must be an absent *key*. Emitting `null` claims the
    field exists and is empty, which is a different assertion from not knowing.
    """
    if isinstance(value, dict):
        return {k: prune_nulls(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [prune_nulls(v) for v in value]
    return value


def normalise_capture_date(value) -> tuple[str, str] | None:
    """Return ``(captured_at, captured_precision)``, or None when nothing survives.

    Precision is *derived from what actually parsed*, never declared. The predecessor of this
    function truncated whatever upstream returned to ten characters and labelled every record
    ``day``; Wikimedia hands back free text such as "Taken on 2 June 2016", so a corpus came out
    the far side reading ``captured_at: "Taken on 2"`` with a confident day-precision stamp on it.
    A wrong date that announces itself is recoverable, a wrong date wearing a precision badge is
    not, so anything unrecognised returns None and the record simply carries no date.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None

    m = re.search(r"(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?", text)
    if m:
        stamp = "%s-%s-%sT%s:%s" % m.group(1, 2, 3, 4, 5)
        return (stamp + (":" + m.group(6) if m.group(6) else ""), "exact")

    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", text)
    if m:
        return (m.group(0), "day")

    # "2 June 2016" and "June 2016" are both common in archival captions.
    months = ("january", "february", "march", "april", "may", "june",
              "july", "august", "september", "october", "november", "december")
    m = re.search(r"(?:(\d{1,2})\s+)?([A-Za-z]{3,9})\.?,?\s+(\d{4})", text)
    if m:
        name = m.group(2).lower()
        hits = [i for i, mon in enumerate(months, start=1) if mon.startswith(name[:3])]
        if len(hits) == 1:
            if m.group(1):
                return ("%s-%02d-%02d" % (m.group(3), hits[0], int(m.group(1))), "day")
            return ("%s-%02d" % (m.group(3), hits[0]), "month")

    m = re.search(r"(\d{4})-(\d{2})(?!\d)", text)
    if m:
        return (m.group(0), "month")

    # Slashed dates, which EXIF and Commons both emit: "04/17/24", "17/04/2024".
    # Order is only resolvable when one field exceeds 12. When both could be a month the date is
    # genuinely ambiguous, so it degrades to the year rather than picking a convention -- being
    # wrong by eleven months while claiming day precision is worse than being right to the year.
    m = re.search(r"\b(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})\b", text)
    if m:
        a, b, y = int(m.group(1)), int(m.group(2)), m.group(3)
        year = int(y) if len(y) == 4 else (2000 + int(y) if int(y) <= 30 else 1900 + int(y))
        if 1 <= a <= 12 and 12 < b <= 31:
            return ("%04d-%02d-%02d" % (year, a, b), "day")
        if 1 <= b <= 12 and 12 < a <= 31:
            return ("%04d-%02d-%02d" % (year, b, a), "day")
        if a <= 12 and b <= 12:
            return ("%04d" % year, "year")

    m = re.search(r"\b(1[6-9]\d{2}|20\d{2})s\b", text)
    if m:
        return (m.group(0), "decade")

    m = re.search(r"\b(1[6-9]\d{2}|20\d{2})\b", text)
    if m:
        return (m.group(0), "year")

    return None


def to_observation(raw: dict, subject: str, informs: list[str], campaign: dict) -> dict | None:
    """Build a photo-survey observation, or None if the licence is not recognised.

    Conforms to `schemas/photo-survey.schema.json`. Every record starts life graded
    `auto_screened`: no automatic test decides that a photograph is evidence. A person does, in the
    review sheet, and until then the record says plainly that nobody has looked.
    """
    licence = normalise_licence(raw.get("licence_text"))
    if licence is None:
        return None
    usage, licence_name = LICENCE_POLICY[licence]

    attribution = raw.get("artist") or raw.get("credit") or "unknown"
    rec = {
        "observation_id": obs_id(raw["image_url"]),
        "image_url": raw["image_url"],
        "thumbnail_url": raw.get("thumbnail_url"),
        "position_source": "exif_gps" if raw.get("lat") is not None else "unknown",
        "captured_precision": "unknown",
        "license": licence,
        "license_url": raw.get("licence_url"),
        "attribution_text": "%s (%s)" % (attribution, licence_name),
        "rights_holder": attribution,
        "usage": usage,
        "source_collection": raw.get("collection"),
        # Neither `observes` nor `categories` is emitted here, and the omission is the point.
        # `observes` means "shows this asset well enough to inform it" and `categories` means
        # "a reviewer says the frame contains this" — both are judgements, and the harvester has
        # made none. All it knows is which search turned the image up, which is a statement about
        # a query rather than about a photograph. That hint travels in the harvest report sidecar
        # and is only promoted to `observes` once a person accepts the record.
        "review": {
            "status": "auto_screened",
            "notes": "Harvested for '%s'. No person has looked at this yet." % subject,
        },
        "notes": raw.get("title") or "",
    }
    if raw.get("lat") is not None:
        rec["position"] = {"lon": raw["lon"], "lat": raw["lat"]}
    if raw.get("descriptionurl"):
        rec["notes"] = (rec["notes"] + " | " + raw["descriptionurl"]).strip(" |")
    dated = normalise_capture_date(raw.get("date"))
    if dated:
        rec["captured_at"], rec["captured_precision"] = dated
    return rec


def _self_test() -> int:
    """Assert the date parser on the inputs that actually broke it.

    Every case below is a real string from a real collection, not an invented one. The first two
    shipped a corrupt corpus; the third was recorded as undated for weeks and only surfaced when a
    downstream guard demanded a date.
    """
    cases = [
        ("Taken on 2 June 2016", ("2016-06-02", "day")),
        ("Taken on\u00a09 September 2011", ("2011-09-09", "day")),
        ("04/17/24", ("2024-04-17", "day")),
        ("17/04/2024", ("2024-04-17", "day")),
        # Order undeterminable: both fields could be a month, so it must degrade to the year
        # rather than pick a convention and be wrong half the time at full confidence.
        ("04/05/24", ("2024", "year")),
        ("2016-06-02T14:23:11Z", ("2016-06-02T14:23:11", "exact")),
        ("June 2016", ("2016-06", "month")),
        ("circa 1898", ("1898", "year")),
        ("1890s", ("1890s", "decade")),
        ("unknown date", None),
        ("", None),
        (None, None),
    ]
    bad = 0
    for raw, want in cases:
        got = normalise_capture_date(raw)
        flag = "ok  " if got == want else "FAIL"
        if got != want:
            bad += 1
        print("  %s %-24r -> %-24r want %r" % (flag, raw, got, want))
    print("%d case(s) failed" % bad if bad else "all %d date cases pass" % len(cases))
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=False, help="campaign config JSON")
    ap.add_argument("--self-test", action="store_true",
                    help="assert the capture-date parser on known-tricky real inputs, then exit")
    ap.add_argument("--root", default=".", help="module root that output paths are relative to")
    ap.add_argument("--limit", type=int, default=0, help="cap results per shot while iterating")
    ap.add_argument("--out", default=None, help="override the config's output path")
    args = ap.parse_args()

    if args.self_test:
        return _self_test()
    if not args.config:
        ap.error("--config is required unless --self-test is given")

    cfg_path = Path(args.config).resolve()
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    root = pathlib.Path(args.root).resolve()
    module = cfg["module_id"]
    user_agent = cfg.get("user_agent") or (
        "%s/1.0 (openly-licensed imagery survey; %s) Python-urllib" % (module, TOOL_VERSION))

    per_shot = args.limit or cfg.get("per_shot_limit", 60)
    out_path = Path(args.out) if args.out else (root / cfg["outputs"]["raw"])

    print("campaign : %s" % cfg.get("campaign_name", module))
    print("module   : %s" % module)
    print("shots    : %d" % len(cfg["shots"]))
    print()

    seen: dict[str, dict] = {}
    rejected_licence = 0
    per_source: dict[str, int] = {}
    # Which searches turned each image up. A hint about a query, not a claim about a photograph,
    # so it stays out of the survey document and travels in the report sidecar for build_corpus.
    hints: dict[str, list[str]] = {}

    def remember(oid: str, assets: list[str]) -> None:
        bucket = hints.setdefault(oid, [])
        for a in assets:
            if a not in bucket:
                bucket.append(a)

    area = cfg.get("area")
    if area:
        print("geosearch %.5f,%.5f r=%dm" % (area["lat"], area["lon"], area["radius_m"]))
        titles = commons_geosearch(area["lat"], area["lon"], area["radius_m"], user_agent, per_shot * 3)
        for raw in commons_details(titles, user_agent):
            rec = to_observation(raw, "area_geosearch", cfg.get("area_informs", []), cfg)
            if rec is None:
                rejected_licence += 1
                continue
            seen.setdefault(rec["observation_id"], rec)
            remember(rec["observation_id"], cfg.get("area_informs", []))
            per_source[raw["collection"]] = per_source.get(raw["collection"], 0) + 1
        print("   %d kept so far" % len(seen))

    for shot in cfg["shots"]:
        subject = shot["subject"]
        informs = shot.get("informs", [])
        found_before = len(seen)

        if shot.get("commons_category"):
            titles = commons_category_members(shot["commons_category"], user_agent, per_shot)
            for raw in commons_details(titles, user_agent):
                rec = to_observation(raw, subject, informs, cfg)
                if rec is None:
                    rejected_licence += 1
                    continue
                if rec["observation_id"] not in seen:
                    seen[rec["observation_id"]] = rec
                    per_source[raw["collection"]] = per_source.get(raw["collection"], 0) + 1
                remember(rec["observation_id"], informs)

        if shot.get("openverse"):
            for raw in openverse_search(shot["openverse"], user_agent, per_shot):
                rec = to_observation(raw, subject, informs, cfg)
                if rec is None:
                    rejected_licence += 1
                    continue
                if rec["observation_id"] not in seen:
                    seen[rec["observation_id"]] = rec
                    per_source[raw["collection"]] = per_source.get(raw["collection"], 0) + 1
                remember(rec["observation_id"], informs)

        print("  %-28s +%d  (total %d)" % (subject, len(seen) - found_before, len(seen)))

    diagnostics = {
        "tool": TOOL_VERSION,
        "generated_at": _now(),
        "module_id": module,
        "kept": len(seen),
        "rejected_for_licence": rejected_licence,
        "collections": per_source,
        "asset_hints": {k: hints[k] for k in sorted(hints) if hints[k]},
        "source_failures": sorted({"%s HTTP %s" % (h, c) for h, c in HTTP_FAILURES}),
        "note": (
            "Only images already published under a reuse-permitting licence. Anything without "
            "an explicit licence is rejected rather than assumed. Share-alike images are marked "
            "derive_appearance: facts may be read from them, the images are not vendored. "
            "Every record is auto_screened until a person reviews it."
        ),
    }

    survey = prune_nulls({
        "contract_version": "1.0.0",
        "module_id": module,
        "frame_id": cfg.get("frame_id"),
        "campaign": {
            "campaign_id": cfg.get("campaign_id", module + "-photo-survey"),
            "title": cfg.get("campaign_name", module),
            "guidance_url": cfg.get("guidance_url"),
        },
        "observations": sorted(seen.values(), key=lambda r: r["observation_id"]),
        "provenance": {
            "module_id": module,
            "generated_by": TOOL_VERSION,
            "generated_at": _now(),
        },
    })

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(survey, fh, indent=1, sort_keys=False)
        fh.write("\n")

    # The contract's `provenance` is deliberately narrow, so the harvest's own diagnostics live
    # beside the document rather than inside it. They are not decoration: `source_failures`
    # records which collections refused us, and a corpus that quietly shrank because an API
    # returned 429 looks exactly like a corpus with nothing to find.
    report_path = out_path.with_suffix(".harvest-report.json")
    with report_path.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(diagnostics, fh, indent=1, sort_keys=False)
        fh.write("\n")

    print()
    print("%d observations kept, %d rejected for licence" % (len(seen), rejected_licence))
    for name, n in sorted(per_source.items(), key=lambda kv: -kv[1]):
        print("   %-28s %d" % (name, n))
    if HTTP_FAILURES:
        codes = sorted({"%s HTTP %s" % (h, c) for h, c in HTTP_FAILURES})
        print()
        print("SOURCES THAT REFUSED (recorded in the survey, not swallowed):")
        for c in codes:
            print("   %s" % c)
        print("   A 401 means the source now needs a key, not that it holds nothing.")
    print("wrote %s" % out_path)
    print()
    print("Next: python review_sheet.py --config %s" % args.config)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
