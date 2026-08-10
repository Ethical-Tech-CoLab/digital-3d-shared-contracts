"""Build a review sheet so a person, not a heuristic, decides which photographs count as evidence.

Promoted from `dumbo-district-3d/scripts/build_review_sheet.py`, which exists because the automatic
screen could not do the job and should not have pretended to. On that corpus, sky coverage ran 0.16
to 0.79 for interiors and 0.51 to 1.00 for exteriors, so any threshold that caught the interiors also
discarded good street views. The honest answer is a human, and the contract said so all along by
grading every record `auto_screened` rather than `accepted`.

Generalised here: the **category vocabulary comes from the campaign config**, because what a
photograph can tell you about a suspension bridge is not what it can tell you about a district. A
district asks "facade, surface, greenery". A bridge asks "masonry, arcade, cornice, truss, cable".

The output is one self-contained HTML file. It **hotlinks** the images from their source rather than
copying them, so no third-party bytes are stored, and it needs no server: open it, tick what each
photograph can inform, press Save, and drop the downloaded file next to the config.

Usage::

    python review_sheet.py --config path/to/photo-campaign.json
    start <module>/review/index.html
"""

from __future__ import annotations

import argparse
import html
import json
import pathlib
from pathlib import Path

TOOL_VERSION = "photo-survey/review_sheet@1.0.0"

PAGE = """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  :root {{ color-scheme: dark; --line:#30363d; --muted:#8b949e; --ok:#2e9e4f; --no:#c4453c; }}
  body {{ margin:0; background:#0d1117; color:#e6edf3;
         font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }}
  header {{ position:sticky; top:0; z-index:5; background:#0d1117ee; backdrop-filter:blur(6px);
            border-bottom:1px solid var(--line); padding:14px 20px; }}
  h1 {{ margin:0 0 4px; font-size:19px; }}
  .sub {{ color:var(--muted); font-size:13px; max-width:70em; }}
  .bar {{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:10px; }}
  button, select {{ background:#21262d; color:#e6edf3; border:1px solid var(--line);
                    border-radius:6px; padding:6px 12px; font-size:13px; cursor:pointer; }}
  button:hover {{ border-color:var(--muted); }}
  button.primary {{ background:#1f6feb; border-color:#1f6feb; }}
  .count {{ color:var(--muted); margin-left:auto; font-variant-numeric:tabular-nums; }}
  .grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr));
           gap:14px; padding:18px 20px; }}
  .card {{ border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#161b22;
           display:flex; flex-direction:column; }}
  .card.inc {{ border-color:var(--ok); }}
  .card.exc {{ border-color:var(--no); opacity:.5; }}
  .card.hidden {{ display:none; }}
  .thumb {{ width:100%; height:215px; object-fit:cover; background:#21262d; display:block; }}
  .meta {{ padding:9px 11px; font-size:12px; color:var(--muted); flex:1; }}
  .meta b {{ color:#e6edf3; font-weight:600; display:block; margin-bottom:3px; word-break:break-word; }}
  .flag {{ display:inline-block; padding:1px 6px; border-radius:10px; font-size:11px;
           border:1px solid var(--line); margin:2px 4px 2px 0; }}
  .flag.warn {{ color:#d29922; border-color:#493c17; }}
  .flag.good {{ color:var(--ok); border-color:#1c4028; }}
  .choices {{ display:flex; flex-wrap:wrap; border-top:1px solid var(--line); }}
  .choices label {{ flex:1 1 33%; text-align:center; padding:7px 2px; cursor:pointer;
                    font-size:11.5px; border-right:1px solid var(--line);
                    border-top:1px solid var(--line); }}
  .choices label:hover {{ background:#1c2129; }}
  .choices label.on {{ background:#1f6feb; color:#fff; }}
  .choices label.off {{ background:#5c2b28; color:#fff; }}
  .choices input {{ display:none; }}
  a {{ color:#58a6ff; }}
  .legend {{ padding:0 20px 10px; color:var(--muted); font-size:12.5px; max-width:70em; }}
  .legend dt {{ color:#e6edf3; font-weight:600; margin-top:6px; }}
  .legend dd {{ margin:0 0 0 0; }}
</style>
<header>
  <h1>{title}</h1>
  <div class="sub">
    Give each photograph <b>every</b> category it can actually inform — one view of a tower is often
    masonry, a cornice and a cable anchorage at once. Tick <b>skip</b> for anything not worth
    keeping. Untouched photographs stay <code>auto_screened</code> and are treated as weaker
    evidence.
    <br><b>A photograph can establish what something is made of and how it is arranged. It cannot
    give a dimension without scale control.</b> Tick a category for what the image shows, not for
    what you hope to measure from it.
  </div>
  <div class="bar">
    <button class="primary" onclick="save()">Save decisions</button>
    <select id="filter" onchange="applyFilter()">
      <option value="all">show all</option>
      <option value="undecided">undecided only</option>
      <option value="used">kept only</option>
      <option value="skipped">skipped only</option>
    </select>
    <span class="count" id="count"></span>
  </div>
</header>
<div class="legend"><dl>{legend}</dl></div>
<div class="grid" id="grid">{cards}</div>
<script>
const DECISIONS = {decisions};
function key(el) {{ return el.closest('.card').dataset.id; }}
function state(id) {{ return DECISIONS[id] || ''; }}
function paint(card) {{
  const v = state(card.dataset.id);
  card.classList.toggle('inc', v.startsWith('use:'));
  card.classList.toggle('exc', v === 'skip');
  card.querySelectorAll('label').forEach(l => {{
    const c = l.dataset.cat;
    l.classList.remove('on','off');
    if (c === 'skip') {{ if (v === 'skip') l.classList.add('off'); }}
    else if (v.startsWith('use:') && v.slice(4).split(',').includes(c)) l.classList.add('on');
  }});
}}
function toggle(el, cat) {{
  const card = el.closest('.card'), id = card.dataset.id;
  let v = state(id);
  if (cat === 'skip') {{ DECISIONS[id] = (v === 'skip') ? '' : 'skip'; }}
  else {{
    let cats = v.startsWith('use:') ? v.slice(4).split(',').filter(Boolean) : [];
    cats = cats.includes(cat) ? cats.filter(c => c !== cat) : cats.concat([cat]);
    DECISIONS[id] = cats.length ? 'use:' + cats.join(',') : '';
  }}
  paint(card); tally(); applyFilter();
}}
function tally() {{
  const vals = Object.values(DECISIONS);
  const used = vals.filter(v => v.startsWith('use:')).length;
  const skipped = vals.filter(v => v === 'skip').length;
  const total = document.querySelectorAll('.card').length;
  document.getElementById('count').textContent =
    used + ' kept  ·  ' + skipped + ' skipped  ·  ' + (total - used - skipped) + ' undecided';
}}
function applyFilter() {{
  const mode = document.getElementById('filter').value;
  document.querySelectorAll('.card').forEach(c => {{
    const v = state(c.dataset.id);
    const show = mode === 'all'
      || (mode === 'undecided' && !v)
      || (mode === 'used' && v.startsWith('use:'))
      || (mode === 'skipped' && v === 'skip');
    c.classList.toggle('hidden', !show);
  }});
}}
function save() {{
  const clean = {{}};
  for (const [k, v] of Object.entries(DECISIONS)) if (v) clean[k] = v;
  const blob = new Blob([JSON.stringify(clean, null, 1)], {{type:'application/json'}});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'review-decisions.json';
  a.click();
}}
document.querySelectorAll('.card').forEach(paint);
tally();
</script>
"""


def card_html(obs: dict, categories: list[dict], hints: dict[str, list[str]]) -> str:
    oid = html.escape(obs["observation_id"])
    thumb = html.escape(obs.get("thumbnail_url") or obs.get("image_url") or "")
    title = html.escape((obs.get("notes") or obs["observation_id"]).split(" | ")[0][:110])
    lic = html.escape(obs.get("license") or "?")
    usage = obs.get("usage") or "?"
    flags = ['<span class="flag %s">%s</span>' % (
        "good" if usage == "redistribute" else "warn", html.escape(usage))]
    flags.append('<span class="flag">%s</span>' % lic)
    if obs.get("position"):
        flags.append('<span class="flag good">geotagged</span>')
    # What the harvester was looking for when it found this. Shown as a prompt, never as a
    # default tick: the reviewer is here precisely because the search may have been wrong.
    hint = hints.get(obs["observation_id"]) or []
    if hint:
        flags.append('<span class="flag">sought: %s</span>'
                     % html.escape(", ".join(hint)[:44]))

    choices = "".join(
        '<label data-cat="%s" title="%s" onclick="toggle(this,\'%s\')">%s</label>'
        % (html.escape(c["id"]), html.escape(c.get("help", "")), html.escape(c["id"]),
           html.escape(c["label"]))
        for c in categories
    )
    choices += '<label data-cat="skip" onclick="toggle(this,\'skip\')">skip</label>'

    link = html.escape(obs.get("image_url") or "")
    return (
        '<div class="card" data-id="%s">'
        '<a class="zoom" href="%s" target="_blank" rel="noreferrer">'
        '<img class="thumb" src="%s" loading="lazy" alt=""></a>'
        '<div class="meta"><b>%s</b>%s</div>'
        '<div class="choices">%s</div></div>'
        % (oid, link, thumb, title, "".join(flags), choices)
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True)
    ap.add_argument("--root", default=".", help="module root that output paths are relative to")
    args = ap.parse_args()

    cfg_path = Path(args.config).resolve()
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    root = pathlib.Path(args.root).resolve()

    survey = json.loads((root / cfg["outputs"]["raw"]).read_text(encoding="utf-8"))
    obs = survey["observations"]
    categories = cfg["categories"]

    hints_path = (root / cfg["outputs"]["raw"]).with_suffix(".harvest-report.json")
    hints = {}
    if hints_path.exists():
        hints = json.loads(hints_path.read_text(encoding="utf-8")).get("asset_hints", {})

    decisions_path = root / cfg["outputs"]["decisions"]
    decisions = {}
    if decisions_path.exists():
        decisions = json.loads(decisions_path.read_text(encoding="utf-8"))

    legend = "".join(
        "<dt>%s</dt><dd>%s</dd>" % (html.escape(c["label"]), html.escape(c.get("help", "")))
        for c in categories
    )

    page = PAGE.format(
        title=html.escape(cfg.get("campaign_name", cfg["module_id"]) + " — photo review"),
        legend=legend,
        cards="".join(card_html(o, categories, hints) for o in obs),
        decisions=json.dumps(decisions),
    )

    out = root / cfg["outputs"]["review_sheet"]
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(page)

    print("%d photographs, %d already decided" % (len(obs), len(decisions)))
    print("wrote %s" % out)
    print()
    print("Open it, tick what each photograph can inform, press Save, and put the downloaded")
    print("review-decisions.json at %s" % decisions_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
