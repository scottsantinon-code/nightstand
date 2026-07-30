#!/usr/bin/env python3
"""Import the Regular revision docx into Nightstand.

Converts the docx with pandoc, cleans Word/pandoc artifacts, preserves
Word highlighter marks as ==text== (rendered as marks in the app),
copies embedded images into papers/revision-media/, and upserts the
manifest entry with the asset list for offline precaching.

Usage: python3 tools/import_revision.py
Then bump CACHE_VERSION in sw.js, commit, push.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCX = Path("/Users/scottsantinon/Library/CloudStorage/GoogleDrive-scott.santinon@gmail.com"
            "/My Drive/*Scott resources/**Regular revision.docx")
RAW = ROOT / "sources" / "revision-raw.md"
MEDIA_SRC = ROOT / "sources" / "revision-media"
MEDIA_DEST = ROOT / "papers" / "revision-media"
OUT = ROOT / "papers" / "revision.md"

FRONT_MATTER = """---
id: revision
title: "Regular Revision"
authors: Scott Santinon
short: "Regular revision"
note: "Knowledge you need in a hurry, without time to look it up."
---

"""


def convert():
    if not DOCX.exists():
        sys.exit(f"docx not found: {DOCX}")
    if MEDIA_SRC.exists():
        shutil.rmtree(MEDIA_SRC)
    # relative extract path so image refs in the markdown stay relative
    subprocess.run(
        ["pandoc", str(DOCX), "-t", "gfm", "--wrap=none",
         "--extract-media=sources/revision-media", "-o", "sources/revision-raw.md"],
        check=True, cwd=ROOT)


def clean_outside_tables(text):
    # Word's own table of contents; the app has a Contents sheet
    text = re.sub(r"^\*\*Table of Contents\*\*\s*$", "", text, flags=re.M)
    text = re.sub(r"^\[.*\]\(#.*\)\s*$", "", text, flags=re.M)
    # Word highlighter marks become ==text==, rendered as <mark> by the app
    text = re.sub(r'<span class="mark">(.*?)</span>', r"==\1==", text, flags=re.S)
    text = re.sub(r"</?u>", "", text)
    text = re.sub(r'<img src="([^"]+)"[^>]*/?>', r"![](\1)", text)
    text = re.sub(r"<sup>(.*?)</sup>", r"^\1^", text)
    text = re.sub(r"<(https?://[^>]+)>", r"[\1](\1)", text)
    # pandoc backslash-escapes literal punctuation; the app renders it plainly
    text = re.sub(r"\\([*_\[\]~<>])", r"\1", text)
    return text


def clean_inside_tables(html):
    html = html.replace('<span class="mark">', "<mark>").replace("</span>", "</mark>")
    # residual spans that were not marks got a stray </mark>; normalise
    html = re.sub(r"<span[^>]*>", "<span>", html)
    html = re.sub(r"<colgroup>.*?</colgroup>", "", html, flags=re.S)
    html = re.sub(r'style="[^"]*"', "", html)
    return html


def rewrite_media(text):
    return text.replace("sources/revision-media/media/", "papers/revision-media/")


def main():
    convert()
    raw = RAW.read_text(encoding="utf-8")

    # Process table blocks and prose separately: tables stay HTML,
    # prose gets converted to app markdown.
    parts = re.split(r"(<table.*?</table>)", raw, flags=re.S)
    out = []
    for part in parts:
        if part.startswith("<table"):
            out.append(clean_inside_tables(part))
        else:
            out.append(clean_outside_tables(part))
    body = rewrite_media("".join(out))
    body = re.sub(r"\n{3,}", "\n\n", body).strip() + "\n"

    OUT.write_text(FRONT_MATTER + body, encoding="utf-8")

    # Copy media into the deployed tree
    if MEDIA_DEST.exists():
        shutil.rmtree(MEDIA_DEST)
    MEDIA_DEST.mkdir(parents=True)
    assets = []
    src_media = MEDIA_SRC / "media"
    if src_media.exists():
        for f in sorted(src_media.iterdir()):
            shutil.copy2(f, MEDIA_DEST / f.name)
            assets.append(f"papers/revision-media/{f.name}")

    # Upsert manifest entry with asset list for the service worker
    mf_path = ROOT / "papers" / "manifest.json"
    mf = json.loads(mf_path.read_text(encoding="utf-8"))
    entry = {"id": "revision", "file": "papers/revision.md", "order": 0,
             "kind": "revision", "assets": assets}
    mf["papers"] = [p for p in mf["papers"] if p.get("id") != "revision"]
    mf["papers"].insert(0, entry)
    mf_path.write_text(json.dumps(mf, indent=2) + "\n", encoding="utf-8")

    marks = body.count("==") // 2
    tables = body.count("<table")
    print(f"revision.md: {len(body)} chars, {marks} marks, {tables} html tables, {len(assets)} images")


if __name__ == "__main__":
    main()
