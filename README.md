# Nightstand

A single-purpose offline PWA for reading academic papers on a phone, one-handed, in a dark room. No accounts, no network calls at runtime, no build step. Static files only.

## Adding a paper

1. Convert the paper to clean markdown (headings, paragraphs, footnotes as `[^1]`). Raw converter output goes in `sources/` (gitignored, stays local); either clean it by hand or add an entry to `tools/normalise_papers.py` and run it to strip page numbers, running heads and other PDF artifacts automatically.
2. Add front matter at the top of the file:

   ```markdown
   ---
   id: hutchins-1995
   title: "How a Cockpit Remembers Its Speeds"
   authors: Edwin Hutchins
   year: 1995
   short: "Hutchins 1995"
   citation: "Hutchins, E. (1995). How a cockpit remembers its speeds. Cognitive Science, 19(3), 265-288."
   note: "Why this paper is in the stack, one line."
   ---
   ```

   `short` is optional; it is the label used in exports and search results.
3. Save it as `papers/<id>.md`.
4. Add one entry to `papers/manifest.json`:

   ```json
   { "id": "hutchins-1995", "file": "papers/hutchins-1995.md", "order": 5 }
   ```

5. Bump `CACHE_VERSION` at the top of `sw.js` (for example `nightstand-v1` to `nightstand-v2`).
6. Commit and push. The app shows a "New version ready" toast on next open; tap it to update.

That is the whole workflow. Nothing else to run.

## Installing on an iPhone

1. Open the site in Safari.
2. Tap the share button, then **Add to Home Screen**.
3. Open it from the home screen icon, not from Safari. That gives the full-screen standalone app with offline support.

After the first open, the app works fully in aeroplane mode, including papers never opened before.

## Backups

Safari can evict local storage without warning. From Settings, use **Export backup** occasionally to download a JSON file of all highlights and positions, and **Import backup** to restore it.

## Development

Serve the folder over HTTP (the service worker needs it):

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/`. When iterating locally, hard-reload or bump `CACHE_VERSION`, because the service worker serves cached files first.

`tools/` holds helper scripts (paper normalisation, icon generation) and `sources/` holds raw converter output; neither is part of the deployed app.
