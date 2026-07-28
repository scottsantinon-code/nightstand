#!/usr/bin/env python3
"""One-off: normalise PDF-converted markdown into Nightstand paper format.

Strips converter artifacts (standalone page numbers, page-break rules,
repeated running heads, the filename H1) and writes proper front matter.
Originals are left untouched; output goes to papers/<id>.md
"""
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PAPERS = [
    {
        "src": "Hutchins 1995.md",
        "id": "hutchins-1995",
        "title": "How a Cockpit Remembers Its Speeds",
        "authors": "Edwin Hutchins",
        "year": "1995",
        "short": "Hutchins 1995",
        "citation": "Hutchins, E. (1995). How a cockpit remembers its speeds. Cognitive Science, 19(3), 265-288.",
        "note": "The theoretical foundation under every tool I have built.",
        "drop_h1": ["Hutchins 1995"],
    },
    {
        "src": "kahneman-klein-2009.md",
        "id": "kahneman-klein-2009",
        "title": "Conditions for Intuitive Expertise: A Failure to Disagree",
        "authors": "Daniel Kahneman, Gary Klein",
        "year": "2009",
        "short": "Kahneman and Klein 2009",
        "citation": "Kahneman, D., & Klein, G. (2009). Conditions for intuitive expertise: A failure to disagree. American Psychologist, 64(6), 515-526.",
        "note": "When can a clinician trust the feeling of knowing? The boundary conditions, from both camps at once.",
        "drop_h1": ["kahneman-klein-2009"],
    },
    {
        "src": "Improving Healthcare Team Communication.md",
        "id": "eisenberg-2008",
        "title": "The Social Construction of Healthcare Teams",
        "authors": "Eric M. Eisenberg",
        "year": "2008",
        "short": "Eisenberg 2008",
        "citation": "Eisenberg, E. M. (2008). The social construction of healthcare teams. In C. P. Nemeth (Ed.), Improving Healthcare Team Communication. Ashgate.",
        "note": "Communication as the thing that builds the team, not just the thing that moves information through it.",
        "drop_h1": ["Improving Healthcare Team Communication"],
    },
    {
        "src": "Horsley Wiig.md",
        "id": "horsley-wiig",
        "title": "Simulation Approaches to Enhance Team and System Resilience",
        "authors": "Craig Horsley, Siri Wiig",
        "year": "",
        "short": "Horsley and Wiig",
        "citation": "Horsley, C., & Wiig, S. Simulation Approaches to Enhance Team and System Resilience. Book chapter.",
        "note": "In-situ simulation in a real ICU, framed through resilient healthcare rather than error-hunting.",
        "drop_h1": ["Horsley Wiig"],
    },
]


def strip_front_matter(text):
    if text.startswith("---"):
        m = re.match(r"^---\n.*?\n---\n", text, re.S)
        if m:
            return text[m.end():]
    return text


def clean(text, drop_h1):
    text = strip_front_matter(text)
    lines = text.split("\n")

    # Find running heads: short bare lines repeated 4+ times (page headers).
    bare = Counter(
        l.strip() for l in lines
        if l.strip() and len(l.strip()) < 40
        and not l.strip().startswith(("#", ">", "-", "*", "|", "!", "["))
        and not re.search(r"[.,;:?]", l.strip())
    )
    running_heads = {t for t, n in bare.items() if n >= 4 and not t.isdigit()}

    out = []
    for l in lines:
        s = l.strip()
        if re.fullmatch(r"\d{1,4}", s):          # standalone page number
            continue
        if s == "---" or s == "***":              # page-break rule
            continue
        if s in running_heads:                    # repeated running head
            continue
        if s.startswith("# ") and s[2:].strip() in drop_h1:  # filename H1
            continue
        out.append(l)

    # Collapse runs of blank lines
    cleaned = re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip() + "\n"
    return cleaned, sorted(running_heads)


for p in PAPERS:
    src = ROOT / p["src"]
    body, heads = clean(src.read_text(encoding="utf-8"), p["drop_h1"])
    fm = ["---",
          f'id: {p["id"]}',
          f'title: "{p["title"]}"',
          f'authors: {p["authors"]}',
          ]
    if p["year"]:
        fm.append(f'year: {p["year"]}')
    fm += [f'short: "{p["short"]}"',
           f'citation: "{p["citation"]}"',
           f'note: "{p["note"]}"',
           "---", "", ""]
    dest = ROOT / "papers" / f'{p["id"]}.md'
    dest.write_text("\n".join(fm) + body, encoding="utf-8")
    print(f'{p["id"]}: {len(body)} chars, removed running heads: {heads}')
