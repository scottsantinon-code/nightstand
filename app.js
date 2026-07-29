/* Nightstand — single-purpose offline paper reader.
   No build step, no framework, no network at runtime. */
'use strict';

/* ================================================================
   Storage
   ================================================================ */
const STORE_PREFIX = 'nightstand.';
const SCHEMA_VERSION = 1;

function loadStore(key, fallback) {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + key);
    if (raw === null) return fallback;
    const val = JSON.parse(raw);
    return val === null || val === undefined ? fallback : val;
  } catch (e) {
    return fallback;
  }
}

function saveStore(key, value) {
  try {
    localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
  } catch (e) { /* storage full or unavailable; keep running */ }
}

const DEFAULT_SETTINGS = {
  typeStep: 2,        // index into TYPE_SIZES, default 19px
  lineStep: 1,        // index into LINE_HEIGHTS
  marginStep: 1,      // index into MARGINS
  font: 'serif',
  theme: 'night',
  warmth: 0,          // 0-40
  dim: 0,             // 0-0.75
  scrubSide: 'right',
  wakeLock: true,
  justify: false,
};

const TYPE_SIZES = [15, 17, 19, 21, 23, 24.5, 26];
const LINE_HEIGHTS = [1.5, 1.65, 1.8];
const MARGINS = [16, 22, 30];
const TAGS = ['steal', 'disagree', 'question', 'key'];
const TAG_LABELS = { steal: 'Steal', disagree: 'Disagree', question: 'Question', key: 'Key' };

let settings = Object.assign({}, DEFAULT_SETTINGS, loadStore('settings', {}));
let positions = loadStore('positions', {});
let highlights = loadStore('highlights', []);
let meta = Object.assign({ lastPaperId: null, schemaVersion: SCHEMA_VERSION, lastExportAt: null, backupNagDismissed: false }, loadStore('meta', {}));

// Migration hook for future schema changes
if (meta.schemaVersion !== SCHEMA_VERSION) {
  meta.schemaVersion = SCHEMA_VERSION;
  saveStore('meta', meta);
}

function persistHighlights() { saveStore('highlights', highlights); }
function persistPositions() { saveStore('positions', positions); }
function persistMeta() { saveStore('meta', meta); }
function persistSettings() { saveStore('settings', settings); }

/* ================================================================
   Markdown parsing
   ================================================================ */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseFrontMatter(text) {
  const fm = {};
  let body = text;
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      const block = text.slice(3, end).trim();
      body = text.slice(text.indexOf('\n', end + 1) + 1);
      for (const line of block.split('\n')) {
        const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (m) {
          let v = m[2].trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          fm[m[1]] = v;
        }
      }
    }
  }
  return { fm, body };
}

/* Inline markdown: code, images, links, bold, italic, footnote refs.
   Escapes HTML first, so raw HTML in source is shown literally. */
function renderInline(text) {
  let s = escapeHtml(text);
  const stash = [];
  const put = (html) => { stash.push(html); return '\u0000' + (stash.length - 1) + '\u0000'; };

  // code spans first, protect their content
  s = s.replace(/`([^`]+)`/g, (m, code) => put('<code>' + code + '</code>'));
  // images
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (m, alt, src) => put('<img src="' + src + '" alt="' + alt + '" loading="lazy">'));
  // footnote refs
  s = s.replace(/\[\^([^\]]+)\]/g,
    (m, id) => put('<sup class="fnref" data-fn="' + escapeHtml(id) + '">' + escapeHtml(id) + '</sup>'));
  // links
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (m, label, href) => put('<a href="' + href + '" target="_blank" rel="noopener">' + label + '</a>'));
  // bold then italic
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');

  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[+i]);
  return s;
}

/* Block-level parse. Returns { blocks, footnotes, headings }.
   blocks: [{ id, type, level?, html, md }] with ids b0, b1, ... */
function parseMarkdown(md) {
  const lines = md.split('\n');
  const blocks = [];
  const footnotes = {};
  const headings = [];
  let i = 0;
  let para = [];

  const push = (type, html, extra) => {
    const id = 'b' + blocks.length;
    blocks.push(Object.assign({ id, type, html }, extra || {}));
    return blocks[blocks.length - 1];
  };

  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(' ').trim();
    para = [];
    if (text) push('p', '<p>' + renderInline(text) + '</p>');
  };

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (!t) { flushPara(); i++; continue; }

    // fenced code
    if (t.startsWith('```')) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
      i++;
      push('pre', '<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>');
      continue;
    }

    // footnote definition
    const fnDef = t.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (fnDef) {
      flushPara();
      const buf = [fnDef[2]];
      i++;
      while (i < lines.length && /^(\s{2,}|\t)\S/.test(lines[i])) { buf.push(lines[i].trim()); i++; }
      footnotes[fnDef[1]] = renderInline(buf.join(' '));
      continue;
    }

    // heading
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const level = Math.min(h[1].length, 4);
      const textPlain = h[2].replace(/[*_`]/g, '').trim();
      const b = push('h', '<h' + level + '>' + renderInline(h[2]) + '</h' + level + '>', { level, heading: textPlain });
      headings.push({ blockId: b.id, level, text: textPlain });
      i++;
      continue;
    }

    // horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flushPara();
      push('hr', '<hr>');
      i++;
      continue;
    }

    // blockquote
    if (t.startsWith('>')) {
      flushPara();
      const buf = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      const inner = buf.join('\n').split(/\n\s*\n/).map(p => '<p>' + renderInline(p.replace(/\n/g, ' ').trim()) + '</p>').join('');
      push('blockquote', '<blockquote>' + inner + '</blockquote>');
      continue;
    }

    // table
    if (t.startsWith('|') && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim()) && lines[i + 1].includes('-')) {
      flushPara();
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i].trim()); i++; }
      const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => renderInline(c.trim()));
      let html = '<table><thead><tr>' + cells(rows[0]).map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>';
      for (let r = 2; r < rows.length; r++) {
        html += '<tr>' + cells(rows[r]).map(c => '<td>' + c + '</td>').join('') + '</tr>';
      }
      html += '</tbody></table>';
      push('table', html);
      continue;
    }

    // list
    const listStart = t.match(/^([-*+]|\d+[.)])\s+/);
    if (listStart) {
      flushPara();
      const ordered = /^\d/.test(t);
      const items = [];
      while (i < lines.length) {
        const lt = lines[i].trim();
        const im = lt.match(/^([-*+]|\d+[.)])\s+(.*)$/);
        if (im && /^\d/.test(lt) === ordered) { items.push(im[2]); i++; }
        else if (lt && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lt; i++; }
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      push('list', '<' + tag + '>' + items.map(it => '<li>' + renderInline(it) + '</li>').join('') + '</' + tag + '>');
      continue;
    }

    // standalone image -> figure. Caption: an immediately following emphasised line.
    const img = t.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
    if (img) {
      flushPara();
      let caption = img[3] || '';
      if (!caption && i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        const cm = next.match(/^\*([^*]+)\*$/) || next.match(/^_([^_]+)_$/);
        if (cm) { caption = cm[1]; i++; }
      }
      push('figure',
        '<figure><img src="' + img[2] + '" alt="' + escapeHtml(img[1]) + '" loading="lazy">' +
        (caption ? '<figcaption>' + renderInline(caption) + '</figcaption>' : '') + '</figure>');
      i++;
      continue;
    }

    para.push(t);
    i++;
  }
  flushPara();
  return { blocks, footnotes, headings };
}

/* ================================================================
   Export formatting
   ================================================================ */
function shortLabel(fm) {
  if (fm.short) return fm.short;
  const first = (fm.authors || '').split(',')[0].trim();
  const surname = first.split(' ').pop() || 'Untitled';
  return fm.year ? surname + ' ' + fm.year : surname;
}

function formatExport(papersMeta, hls) {
  // hls grouped per paper, papers in library order
  const parts = [];
  for (const pm of papersMeta) {
    const phls = hls.filter(h => h.paperId === pm.id);
    if (!phls.length) continue;
    parts.push('## ' + shortLabel(pm) + ', ' + pm.title + '\n');
    if (pm.citation) parts.push(pm.citation + '\n');
    for (const tag of TAGS) {
      const group = phls.filter(h => h.tag === tag);
      if (!group.length) continue;
      parts.push('### ' + TAG_LABELS[tag] + '\n');
      for (const h of group) {
        parts.push('> ' + h.text.replace(/\n/g, ' ') + '\n> <sub>' + (h.section || 'Untitled section') + '</sub>\n');
        if (h.note) parts.push('  ' + h.note.replace(/\n/g, '\n  ') + '\n');
      }
    }
  }
  // App-generated wording contains no em dashes; quoted paper text stays verbatim.
  return parts.join('\n').trim() + '\n';
}

/* ================================================================
   Everything below touches the DOM.
   ================================================================ */
if (typeof document !== 'undefined') {

  const $ = (sel) => document.querySelector(sel);
  const appEl = $('#app');
  const libraryEl = $('#library');
  const readerEl = $('#reader');
  const contentEl = $('#content');

  /* ---------- App state ---------- */
  let manifest = { papers: [] };
  const paperCache = {};    // id -> { fm, blocks, footnotes, headings }
  let currentPaper = null;  // parsed paper currently in reader
  let currentId = null;
  let chromeTimer = null;
  let pendingRestore = null;  // { blockId, offset } applied until user scrolls
  let editingHighlightId = null;
  let pendingSelection = null; // captured selection ranges for the hl bar

  /* ---------- Boot ---------- */
  async function boot() {
    applySettings(false);
    try {
      const res = await fetch('papers/manifest.json');
      manifest = await res.json();
      manifest.papers.sort((a, b) => (a.order || 0) - (b.order || 0));
    } catch (e) {
      manifest = { papers: [] };
    }

    const last = meta.lastPaperId;
    if (last && manifest.papers.some(p => p.id === last)) {
      await openPaper(last, { resume: true });
    } else {
      await showLibrary();
    }
    appEl.classList.add('ready');
    registerSW();
    maybeBackupNag();
  }

  async function loadPaper(id) {
    if (paperCache[id]) return paperCache[id];
    const entry = manifest.papers.find(p => p.id === id);
    if (!entry) return null;
    try {
      const res = await fetch(entry.file);
      const text = await res.text();
      const { fm, body } = parseFrontMatter(text);
      const parsed = parseMarkdown(body);
      paperCache[id] = { id, fm, blocks: parsed.blocks, footnotes: parsed.footnotes, headings: parsed.headings };
      return paperCache[id];
    } catch (e) {
      return null;
    }
  }

  async function loadAllPapers() {
    return (await Promise.all(manifest.papers.map(p => loadPaper(p.id)))).filter(Boolean);
  }

  /* ---------- Settings application ---------- */
  function applySettings(preservePosition) {
    const saved = preservePosition && readerVisible() ? capturePosition() : null;
    const r = document.documentElement;
    r.style.setProperty('--type-size', TYPE_SIZES[settings.typeStep] + 'px');
    r.style.setProperty('--line-height', LINE_HEIGHTS[settings.lineStep]);
    r.style.setProperty('--margin', MARGINS[settings.marginStep] + 'px');
    r.style.setProperty('--body-font', settings.font === 'sans' ? 'var(--sans)' : 'var(--serif)');
    r.style.setProperty('--warmth', settings.warmth);
    r.style.setProperty('--justify', settings.justify ? 'justify' : 'left');
    r.dataset.theme = settings.theme;
    document.body.classList.toggle('scrub-left', settings.scrubSide === 'left');
    $('#dim-overlay').style.opacity = settings.dim;
    const THEME_BG = { night: '#0e0e10', sepia: '#f3ead9', grey: '#26262a', light: '#fbf8f2' };
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.content = THEME_BG[settings.theme] || THEME_BG.night;
    if (saved) requestAnimationFrame(() => { restorePosition(saved); updateScrubber(); });
    updateWakeLock();
  }

  /* ---------- Views ---------- */
  function readerVisible() { return !readerEl.hidden; }

  async function showLibrary() {
    savePositionNow();
    releaseWakeLock();
    readerEl.hidden = true;
    document.body.classList.remove('chrome-visible');
    await renderLibrary();
    libraryEl.hidden = false;
    window.scrollTo(0, 0);
  }

  async function openPaper(id, opts) {
    const paper = await loadPaper(id);
    if (!paper) { await showLibrary(); return; }
    currentPaper = paper;
    currentId = id;
    meta.lastPaperId = id;
    persistMeta();

    libraryEl.hidden = true;
    readerEl.hidden = false;
    document.body.classList.remove('chrome-visible');
    $('#paper-short').textContent = paper.fm.title || id;

    renderPaper(paper);
    reanchorHighlights(paper);
    applyAllHighlights();
    buildScrubberMarks();

    const pos = positions[id];
    if (opts && opts.resume && pos && pos.blockId) {
      pendingRestore = { blockId: pos.blockId, offset: pos.offset || 0 };
      restorePosition(pendingRestore);
    } else if (opts && opts.toBlock) {
      pendingRestore = null;
      jumpToBlock(opts.toBlock, true);
    } else {
      pendingRestore = null;
      window.scrollTo(0, 0);
    }
    updateScrubber();
    updateWakeLock();
  }

  /* ---------- Paper rendering ---------- */
  function renderPaper(paper) {
    const frag = document.createDocumentFragment();
    const refsRe = /^(references|bibliography|works cited)$/i;
    let inRefs = false;
    let refsLevel = 0;

    for (const b of paper.blocks) {
      const div = document.createElement('div');
      div.className = 'block';
      div.id = b.id;
      div.innerHTML = b.html;

      if (b.type === 'h' && refsRe.test(b.heading || '')) {
        inRefs = true;
        refsLevel = b.level;
        const btn = document.createElement('button');
        btn.className = 'refs-heading';
        btn.innerHTML = '<span class="chev">&#9656;</span><span class="refs-title">' + escapeHtml(b.heading) + '</span>';
        btn.addEventListener('click', () => {
          btn.classList.toggle('open');
          const open = btn.classList.contains('open');
          let el = div.nextElementSibling;
          while (el && el.dataset.refs === '1') {
            el.classList.toggle('refs-hidden', !open);
            el = el.nextElementSibling;
          }
          buildScrubberMarks();
        });
        div.innerHTML = '';
        div.appendChild(btn);
        frag.appendChild(div);
        continue;
      }
      if (inRefs && b.type === 'h' && b.level <= refsLevel) inRefs = false;
      if (inRefs) {
        div.dataset.refs = '1';
        div.classList.add('refs-hidden');
      }
      frag.appendChild(div);
    }
    contentEl.innerHTML = '';
    contentEl.appendChild(frag);

    // image load can shift layout: keep re-applying resume until user scrolls
    contentEl.querySelectorAll('img').forEach(img => {
      img.addEventListener('load', () => {
        if (pendingRestore) restorePosition(pendingRestore);
        buildScrubberMarks();
      });
    });
  }

  function expandRefsIfNeeded(blockId) {
    const el = document.getElementById(blockId);
    if (el && el.classList.contains('refs-hidden')) {
      let prev = el;
      while (prev && !prev.querySelector('.refs-heading')) prev = prev.previousElementSibling;
      const btn = prev && prev.querySelector('.refs-heading');
      if (btn && !btn.classList.contains('open')) btn.click();
    }
  }

  /* ---------- Position ---------- */
  const ANCHOR_FRACTION = 0.25; // reference line down the viewport

  function anchorY() { return window.scrollY + window.innerHeight * ANCHOR_FRACTION; }

  function capturePosition() {
    const y = anchorY();
    const blocksEls = contentEl.children;
    for (let i = 0; i < blocksEls.length; i++) {
      const el = blocksEls[i];
      if (el.classList.contains('refs-hidden')) continue;
      const top = el.offsetTop;
      const h = el.offsetHeight || 1;
      if (top + h > y) {
        return { blockId: el.id, offset: Math.max(0, Math.min(1, (y - top) / h)) };
      }
    }
    const lastEl = blocksEls[blocksEls.length - 1];
    return lastEl ? { blockId: lastEl.id, offset: 1 } : null;
  }

  function restorePosition(pos) {
    const el = document.getElementById(pos.blockId);
    if (!el) return;
    expandRefsIfNeeded(pos.blockId);
    const target = el.offsetTop + (el.offsetHeight || 0) * (pos.offset || 0) - window.innerHeight * ANCHOR_FRACTION;
    window.scrollTo(0, Math.max(0, target));
  }

  function docFraction() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return max > 0 ? Math.max(0, Math.min(1, window.scrollY / max)) : 0;
  }

  function savePositionNow() {
    if (!readerVisible() || !currentId) return;
    const pos = capturePosition();
    if (!pos) return;
    const prev = positions[currentId] || {};
    positions[currentId] = Object.assign({}, prev, pos, {
      docFraction: docFraction(),
      updatedAt: new Date().toISOString(),
    });
    persistPositions();
  }

  let saveTimer = null;
  function schedulePositionSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; savePositionNow(); }, 400);
  }

  window.addEventListener('scroll', () => {
    if (!readerVisible()) return;
    schedulePositionSave();
    updateScrubber();
  }, { passive: true });

  // user scroll cancels pending image-shift restores
  window.addEventListener('touchstart', () => { pendingRestore = null; }, { passive: true });
  window.addEventListener('wheel', () => { pendingRestore = null; }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePositionNow();
    else updateWakeLock();
  });
  window.addEventListener('pagehide', savePositionNow);

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!readerVisible()) return;
    const saved = positions[currentId];
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (saved && saved.blockId) restorePosition(saved);
      buildScrubberMarks();
      updateScrubber();
    }, 120);
  });

  /* ---------- Chrome ---------- */
  function showChrome() {
    document.body.classList.add('chrome-visible');
    clearTimeout(chromeTimer);
    chromeTimer = setTimeout(hideChrome, 6000);
  }
  function hideChrome() {
    document.body.classList.remove('chrome-visible');
    clearTimeout(chromeTimer);
  }
  function toggleChrome() {
    if (document.body.classList.contains('chrome-visible')) hideChrome();
    else showChrome();
  }

  contentEl.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('a')) return;
    if (t.closest('sup.fnref')) {
      const id = t.closest('sup.fnref').dataset.fn;
      openFootnote(id);
      return;
    }
    if (t.closest('figure img')) {
      openImageViewer(t.closest('figure img'));
      return;
    }
    if (t.closest('mark.hl')) {
      openHighlightEditor(t.closest('mark.hl').dataset.hid);
      return;
    }
    if (t.closest('.refs-heading')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const w = window.innerWidth, h = window.innerHeight;
    if (e.clientX > w / 3 && e.clientX < (2 * w) / 3 && e.clientY > h * 0.12 && e.clientY < h * 0.88) {
      toggleChrome();
    }
  });

  /* Bar buttons */
  $('#back-btn').addEventListener('click', showLibrary);
  $('#contents-btn').addEventListener('click', openContents);
  $('#reader-highlights-btn').addEventListener('click', () => openHighlightsView(currentId));
  $('#reader-search-btn').addEventListener('click', () => openSearch(currentId));
  $('#reader-settings-btn').addEventListener('click', openSettings);
  $('#lib-highlights-btn').addEventListener('click', () => openHighlightsView(null));
  $('#lib-search-btn').addEventListener('click', () => openSearch(null));
  $('#lib-settings-btn').addEventListener('click', openSettings);

  /* Left-edge swipe back */
  let edgeSwipe = null;
  document.addEventListener('touchstart', (e) => {
    if (!readerVisible()) return;
    if (e.target.closest && e.target.closest('#scrubber')) return;
    const t = e.touches[0];
    if (t.clientX < 24) edgeSwipe = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!edgeSwipe) return;
    const t = e.touches[0];
    if (t.clientX - edgeSwipe.x > 70 && Math.abs(t.clientY - edgeSwipe.y) < 60) {
      edgeSwipe = null;
      showLibrary();
    }
  }, { passive: true });
  document.addEventListener('touchend', () => { edgeSwipe = null; }, { passive: true });

  /* ---------- Scrubber ---------- */
  const scrubberEl = $('#scrubber');
  const scrubTrack = $('#scrub-track');
  const scrubFill = $('#scrub-fill');
  const scrubLabel = $('#scrub-label');

  function updateScrubber() {
    if (!readerVisible()) return;
    scrubFill.style.height = (docFraction() * 100) + '%';
  }

  function buildScrubberMarks() {
    if (!currentPaper) return;
    const total = document.documentElement.scrollHeight;
    if (!total) return;
    const ticks = $('#scrub-ticks');
    const pips = $('#scrub-pips');
    ticks.innerHTML = '';
    pips.innerHTML = '';
    for (const h of currentPaper.headings) {
      if (h.level !== 2) continue;
      const el = document.getElementById(h.blockId);
      if (!el || el.classList.contains('refs-hidden')) continue;
      const tick = document.createElement('div');
      tick.className = 'tick';
      tick.style.top = ((el.offsetTop / total) * 100) + '%';
      ticks.appendChild(tick);
    }
    for (const hl of highlights) {
      if (hl.paperId !== currentId || hl.orphaned) continue;
      const el = document.getElementById(hl.blockId);
      if (!el || el.classList.contains('refs-hidden')) continue;
      const pip = document.createElement('div');
      pip.className = 'pip pip-' + hl.tag;
      pip.style.top = ((el.offsetTop / total) * 100) + '%';
      pips.appendChild(pip);
    }
  }

  function sectionNameAt(scrollTop) {
    if (!currentPaper) return '';
    const y = scrollTop + window.innerHeight * ANCHOR_FRACTION;
    let name = currentPaper.fm.title || '';
    for (const h of currentPaper.headings) {
      const el = document.getElementById(h.blockId);
      if (el && !el.classList.contains('refs-hidden') && el.offsetTop <= y) name = h.text;
    }
    return name;
  }

  let scrubbing = false;
  scrubberEl.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    scrubberEl.classList.add('expanded');
    scrubberEl.setPointerCapture(e.pointerId);
    scrubTo(e.clientY);
    e.preventDefault();
  });
  scrubberEl.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e.clientY); });
  scrubberEl.addEventListener('pointerup', () => {
    scrubbing = false;
    scrubLabel.hidden = true;
    setTimeout(() => { if (!scrubbing) scrubberEl.classList.remove('expanded'); }, 900);
    savePositionNow();
  });
  scrubberEl.addEventListener('pointercancel', () => {
    scrubbing = false;
    scrubLabel.hidden = true;
    scrubberEl.classList.remove('expanded');
  });

  function scrubTo(clientY) {
    const rect = scrubTrack.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, frac * max);
    scrubLabel.hidden = false;
    scrubLabel.style.top = (clientY - scrubberEl.getBoundingClientRect().top) + 'px';
    scrubLabel.textContent = sectionNameAt(frac * max);
    pendingRestore = null;
  }

  /* ---------- Library rendering ---------- */
  function relTime(iso) {
    if (!iso) return '';
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
    const days = Math.floor(hrs / 24);
    if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
    const months = Math.floor(days / 30);
    return months + (months === 1 ? ' month ago' : ' months ago');
  }

  async function renderLibrary() {
    const papers = await loadAllPapers();
    const cardsEl = $('#lib-cards');
    cardsEl.innerHTML = '';

    const state = (p) => {
      const pos = positions[p.id];
      if (pos && pos.finished) return 2;
      if (pos && pos.blockId) return 0;
      return 1;
    };
    papers.sort((a, b) => state(a) - state(b) ||
      (manifest.papers.findIndex(x => x.id === a.id) - manifest.papers.findIndex(x => x.id === b.id)));

    for (const p of papers) {
      const pos = positions[p.id] || {};
      const count = highlights.filter(h => h.paperId === p.id).length;
      const card = document.createElement('div');
      card.className = 'card' + (pos.finished ? ' finished' : '');
      card.setAttribute('role', 'button');

      const metaLine = [p.fm.authors, p.fm.year].filter(Boolean).join(', ');
      const footer = [];
      if (count) footer.push(count + (count === 1 ? ' highlight' : ' highlights'));
      if (pos.updatedAt && !pos.finished && pos.blockId) footer.push('Last read ' + relTime(pos.updatedAt));
      if (pos.finished) footer.push('Finished');

      card.innerHTML =
        '<div class="card-title">' + escapeHtml(p.fm.title || p.id) + '</div>' +
        '<div class="card-meta">' + escapeHtml(metaLine) + '</div>' +
        (p.fm.note ? '<div class="card-note">' + escapeHtml(p.fm.note) + '</div>' : '') +
        '<div class="card-progress"><div class="fill" style="width:' + ((pos.finished ? 1 : (pos.docFraction || 0)) * 100) + '%"></div></div>' +
        (footer.length ? '<div class="card-footer">' + footer.map(escapeHtml).join('<span>&#183;</span>') + '</div>' : '');

      card.addEventListener('click', () => openPaper(p.id, { resume: true }));
      attachLongPress(card, () => openCardMenu(p));
      cardsEl.appendChild(card);
    }
  }

  function attachLongPress(el, fn) {
    let timer = null, startX = 0, startY = 0, fired = false;
    el.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY; fired = false;
      timer = setTimeout(() => { fired = true; fn(); }, 500);
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) clearTimeout(timer);
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      clearTimeout(timer);
      if (fired) { e.preventDefault(); }
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); fn(); });
  }

  function openCardMenu(p) {
    openSheet(
      '<div class="sheet-title">' + escapeHtml(p.fm.title || p.id) + '</div>' +
      '<button class="menu-item" data-act="reset">Reset position</button>' +
      '<button class="menu-item" data-act="finish">' + ((positions[p.id] || {}).finished ? 'Mark as unfinished' : 'Mark as finished') + '</button>' +
      '<button class="menu-item" data-act="hls">View highlights</button>'
    );
    $('#sheet-body').addEventListener('click', async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === 'reset') {
        delete positions[p.id];
        persistPositions();
        closeSheet();
        renderLibrary();
      } else if (act === 'finish') {
        positions[p.id] = Object.assign({}, positions[p.id], { finished: !(positions[p.id] || {}).finished, updatedAt: new Date().toISOString() });
        persistPositions();
        closeSheet();
        renderLibrary();
      } else if (act === 'hls') {
        openHighlightsView(p.id);
      }
    }, { once: false });
  }

  /* ---------- Sheets ---------- */
  const sheetEl = $('#sheet');
  const sheetBackdrop = $('#sheet-backdrop');

  function openSheet(html) {
    // Fresh node each open so listeners from previous sheets never accumulate
    const old = $('#sheet-body');
    const fresh = old.cloneNode(false);
    fresh.innerHTML = html;
    old.replaceWith(fresh);
    sheetBackdrop.hidden = false;
    sheetEl.hidden = false;
    sheetEl.classList.add('entering');
    requestAnimationFrame(() => requestAnimationFrame(() => sheetEl.classList.remove('entering')));
  }
  function closeSheet() {
    sheetEl.hidden = true;
    sheetBackdrop.hidden = true;
    $('#sheet-body').innerHTML = '';
  }
  sheetBackdrop.addEventListener('click', closeSheet);

  /* ---------- Footnotes ---------- */
  function openFootnote(id) {
    const note = currentPaper && currentPaper.footnotes[id];
    openSheet('<div class="fn-body">' + (note || 'Footnote ' + escapeHtml(id) + ' not found in this paper.') + '</div>');
    $('#sheet-body').addEventListener('click', closeSheet);
  }

  /* ---------- Contents ---------- */
  function openContents() {
    if (!currentPaper) return;
    const current = sectionNameAt(window.scrollY);
    const hlBlocks = new Set(highlights.filter(h => h.paperId === currentId).map(h => h.blockId));
    const blockIndex = (bid) => parseInt(bid.slice(1), 10);

    let html = '<div class="sheet-title">Contents</div>';
    const hs = currentPaper.headings;
    for (let i = 0; i < hs.length; i++) {
      const h = hs[i];
      const from = blockIndex(h.blockId);
      const to = i + 1 < hs.length ? blockIndex(hs[i + 1].blockId) : currentPaper.blocks.length;
      let hasHl = false;
      for (const bid of hlBlocks) {
        const bi = blockIndex(bid);
        if (bi >= from && bi < to) { hasHl = true; break; }
      }
      html += '<button class="toc-item l' + h.level + (h.text === current ? ' current' : '') + '" data-block="' + h.blockId + '">' +
        (hasHl ? '<span class="toc-pip"></span>' : '') + escapeHtml(h.text) + '</button>';
    }
    openSheet(html);
    $('#sheet-body').addEventListener('click', (e) => {
      const item = e.target.closest('.toc-item');
      if (!item) return;
      closeSheet();
      jumpToBlock(item.dataset.block, false);
    });
  }

  function jumpToBlock(blockId, flash) {
    expandRefsIfNeeded(blockId);
    const el = document.getElementById(blockId);
    if (!el) return;
    window.scrollTo(0, Math.max(0, el.offsetTop - window.innerHeight * 0.15));
    if (flash) {
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1300);
    }
    savePositionNow();
    updateScrubber();
  }

  /* ---------- Settings sheet ---------- */
  function openSettings() {
    const seg = (key, opts) => '<div class="seg" data-set="' + key + '">' +
      opts.map(o => '<button data-val="' + o.v + '" class="' + (String(settings[key]) === String(o.v) ? 'on' : '') + '">' + o.l + '</button>').join('') + '</div>';
    const stepper = (key, hint) =>
      '<div class="stepper" data-set="' + key + '">' +
      '<button data-d="-1" aria-label="Decrease">&#8722;</button>' +
      '<span class="stepval">' + hint + '</span>' +
      '<button data-d="1" aria-label="Increase">+</button></div>';
    const toggle = (key) => '<button class="switch ' + (settings[key] ? 'on' : '') + '" data-set="' + key + '" role="switch" aria-checked="' + !!settings[key] + '"></button>';

    openSheet(
      '<div class="sheet-title">Settings</div>' +
      '<div class="set-row"><span class="set-label">Type size</span>' + stepper('typeStep', TYPE_SIZES[settings.typeStep] + 'px') + '</div>' +
      '<div class="set-row"><span class="set-label">Line height</span>' + stepper('lineStep', LINE_HEIGHTS[settings.lineStep]) + '</div>' +
      '<div class="set-row"><span class="set-label">Margins</span>' + stepper('marginStep', MARGINS[settings.marginStep] + 'px') + '</div>' +
      '<div class="set-row"><span class="set-label">Font</span>' + seg('font', [{ v: 'serif', l: 'Serif' }, { v: 'sans', l: 'Sans' }]) + '</div>' +
      '<div class="set-row"><span class="set-label">Theme</span>' + seg('theme', [{ v: 'night', l: 'Night' }, { v: 'sepia', l: 'Sepia' }, { v: 'grey', l: 'Grey' }, { v: 'light', l: 'Light' }]) + '</div>' +
      '<div class="set-row"><span class="set-label">Warmth</span><input type="range" data-set="warmth" min="0" max="40" step="1" value="' + settings.warmth + '"></div>' +
      '<div class="set-row"><span class="set-label">Screen dim<span class="set-hint">Darker than minimum brightness</span></span><input type="range" data-set="dim" min="0" max="0.75" step="0.05" value="' + settings.dim + '"></div>' +
      '<div class="set-row"><span class="set-label">Scrubber side</span>' + seg('scrubSide', [{ v: 'right', l: 'Right' }, { v: 'left', l: 'Left' }]) + '</div>' +
      '<div class="set-row"><span class="set-label">Keep screen awake</span>' + toggle('wakeLock') + '</div>' +
      '<div class="set-row"><span class="set-label">Justify text</span>' + toggle('justify') + '</div>' +
      '<div class="set-btn-row">' +
      '<button class="set-btn" data-act="export-md">Export highlights</button>' +
      '<button class="set-btn" data-act="export-json">Export backup</button>' +
      '<button class="set-btn" data-act="import-json">Import backup</button>' +
      '<button class="set-btn danger" data-act="reset-pos">Reset all positions</button>' +
      '</div>'
    );

    const body = $('#sheet-body');
    body.addEventListener('click', (e) => {
      const stepBtn = e.target.closest('.stepper button');
      if (stepBtn) {
        const key = stepBtn.closest('.stepper').dataset.set;
        const arr = key === 'typeStep' ? TYPE_SIZES : key === 'lineStep' ? LINE_HEIGHTS : MARGINS;
        settings[key] = Math.max(0, Math.min(arr.length - 1, settings[key] + parseInt(stepBtn.dataset.d, 10)));
        stepBtn.closest('.stepper').querySelector('.stepval').textContent =
          key === 'lineStep' ? arr[settings[key]] : arr[settings[key]] + 'px';
        persistSettings();
        applySettings(true);
        return;
      }
      const segBtn = e.target.closest('.seg button');
      if (segBtn) {
        const key = segBtn.closest('.seg').dataset.set;
        settings[key] = segBtn.dataset.val;
        segBtn.closest('.seg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === segBtn));
        persistSettings();
        applySettings(true);
        return;
      }
      const sw = e.target.closest('.switch');
      if (sw) {
        const key = sw.dataset.set;
        settings[key] = !settings[key];
        sw.classList.toggle('on', settings[key]);
        sw.setAttribute('aria-checked', settings[key]);
        persistSettings();
        applySettings(true);
        return;
      }
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'export-md') exportMarkdown(null);
      if (act === 'export-json') exportJson();
      if (act === 'import-json') importJson();
      if (act === 'reset-pos') {
        if (confirm('Reset reading positions for all papers?')) {
          positions = {};
          persistPositions();
          showToast('All positions reset');
        }
      }
    });
    body.addEventListener('input', (e) => {
      const key = e.target.dataset && e.target.dataset.set;
      if (key === 'warmth' || key === 'dim') {
        settings[key] = parseFloat(e.target.value);
        persistSettings();
        applySettings(false);
      }
    });
  }

  /* ---------- Wake lock ---------- */
  let wakeLock = null;
  async function updateWakeLock() {
    try {
      if (settings.wakeLock && readerVisible() && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
        if (!wakeLock || wakeLock.released) {
          wakeLock = await navigator.wakeLock.request('screen');
        }
      } else {
        releaseWakeLock();
      }
    } catch (e) { /* unavailable; fail silently */ }
  }
  function releaseWakeLock() {
    try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) { /* ignore */ }
  }

  /* ================================================================
     Highlights
     ================================================================ */
  function blockPlainText(blockId) {
    const el = document.getElementById(blockId);
    return el ? el.textContent : '';
  }

  /* Offsets of a DOM point within a block's plain text */
  function offsetInBlock(blockEl, node, nodeOffset) {
    let total = 0;
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n === node) return total + nodeOffset;
      total += n.nodeValue.length;
    }
    return total;
  }

  /* selectionchange drives the highlight bar */
  const hlBar = $('#hl-bar');
  const noteField = $('#hl-note-field');
  let selDebounce = null;

  document.addEventListener('selectionchange', () => {
    clearTimeout(selDebounce);
    selDebounce = setTimeout(handleSelection, 250);
  });

  function handleSelection() {
    if (editingHighlightId) return; // bar already open in edit mode
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !readerVisible()) {
      if (!editingHighlightId && document.activeElement !== noteField) hideHlBar();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!contentEl.contains(range.commonAncestorContainer)) { hideHlBar(); return; }

    const blockOf = (node) => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      return el && el.closest('.block');
    };
    const startBlock = blockOf(range.startContainer);
    const endBlock = blockOf(range.endContainer);
    if (!startBlock || !endBlock) { hideHlBar(); return; }

    const startIdx = parseInt(startBlock.id.slice(1), 10);
    const endIdx = parseInt(endBlock.id.slice(1), 10);
    const parts = [];
    for (let bi = startIdx; bi <= endIdx; bi++) {
      const bid = 'b' + bi;
      const el = document.getElementById(bid);
      if (!el) continue;
      const text = el.textContent;
      let s = 0, e2 = text.length;
      if (bi === startIdx) s = offsetInBlock(el, range.startContainer, range.startOffset);
      if (bi === endIdx) e2 = offsetInBlock(el, range.endContainer, range.endOffset);
      if (e2 > s) parts.push({ blockId: bid, start: s, end: e2 });
    }
    if (!parts.length) { hideHlBar(); return; }
    pendingSelection = parts;
    editingHighlightId = null;
    showHlBar(false);
  }

  function showHlBar(editMode) {
    hlBar.hidden = false;
    $('#hl-delete-btn').hidden = !editMode;
    if (!editMode && document.activeElement !== noteField) {
      noteField.hidden = true;
      noteField.value = '';
    }
    hlBar.querySelectorAll('.hl-tagbtn').forEach(b => b.classList.remove('on'));
    if (editMode) {
      const hl = highlights.find(h => h.id === editingHighlightId);
      if (hl) {
        const btn = hlBar.querySelector('.hl-tagbtn[data-tag="' + hl.tag + '"]');
        if (btn) btn.classList.add('on');
        noteField.value = hl.note || '';
        noteField.hidden = false;
      }
    }
    liftAboveKeyboard();
  }

  /* The bar sits where the iOS keyboard appears, so shift it up while
     the keyboard is open (dictating or typing a note). */
  function liftAboveKeyboard() {
    if (hlBar.hidden || !window.visualViewport) return;
    const vv = window.visualViewport;
    const covered = window.innerHeight - vv.height - vv.offsetTop;
    hlBar.style.transform = covered > 40 ? 'translateY(-' + covered + 'px)' : '';
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', liftAboveKeyboard);
    window.visualViewport.addEventListener('scroll', liftAboveKeyboard);
  }

  function hideHlBar() {
    hlBar.hidden = true;
    hlBar.style.transform = '';
    pendingSelection = null;
    editingHighlightId = null;
    noteField.value = '';
    noteField.hidden = true;
  }

  hlBar.querySelectorAll('.hl-tagbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      if (editingHighlightId) {
        const hl = highlights.find(h => h.id === editingHighlightId);
        if (hl) { hl.tag = tag; persistHighlights(); applyAllHighlights(); buildScrubberMarks(); }
        hlBar.querySelectorAll('.hl-tagbtn').forEach(b => b.classList.toggle('on', b === btn));
      } else if (pendingSelection) {
        createHighlights(tag, noteField.value.trim());
      }
    });
  });

  $('#hl-note-btn').addEventListener('click', () => {
    noteField.hidden = false;
    noteField.focus();
  });

  noteField.addEventListener('input', () => {
    // Save on every input event: dictation must never lose content
    if (editingHighlightId) {
      const hl = highlights.find(h => h.id === editingHighlightId);
      if (hl) { hl.note = noteField.value; persistHighlights(); }
    }
    noteField.style.height = 'auto';
    noteField.style.height = noteField.scrollHeight + 'px';
  });

  $('#hl-copy-btn').addEventListener('click', () => {
    let text = '';
    if (editingHighlightId) {
      const hl = highlights.find(h => h.id === editingHighlightId);
      text = hl ? hl.text : '';
    } else if (pendingSelection) {
      text = pendingSelection.map(p => blockPlainText(p.blockId).slice(p.start, p.end)).join('\n');
    }
    if (text) copyText(text).then(() => showToast('Copied'));
    hideHlBar();
    clearNativeSelection();
  });

  $('#hl-delete-btn').addEventListener('click', () => {
    if (!editingHighlightId) return;
    highlights = highlights.filter(h => h.id !== editingHighlightId);
    persistHighlights();
    hideHlBar();
    applyAllHighlights();
    buildScrubberMarks();
  });

  function clearNativeSelection() {
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
  }

  function currentSectionForBlock(blockId) {
    if (!currentPaper) return '';
    const bi = parseInt(blockId.slice(1), 10);
    let name = '';
    for (const h of currentPaper.headings) {
      if (parseInt(h.blockId.slice(1), 10) <= bi) name = h.text;
      else break;
    }
    return name;
  }

  function createHighlights(tag, note) {
    if (!pendingSelection) return;
    const now = new Date();
    const stamp = now.getTime();
    let first = true;
    for (const part of pendingSelection) {
      const text = blockPlainText(part.blockId);
      const quoted = text.slice(part.start, part.end);
      if (!quoted.trim()) continue;
      highlights.push({
        id: 'h_' + stamp + '_' + Math.random().toString(36).slice(2, 5),
        paperId: currentId,
        blockId: part.blockId,
        start: part.start,
        end: part.end,
        text: quoted,
        before: text.slice(Math.max(0, part.start - 40), part.start),
        after: text.slice(part.end, part.end + 40),
        tag,
        note: first ? note : '',
        section: currentSectionForBlock(part.blockId),
        createdAt: now.toISOString(),
      });
      first = false;
    }
    persistHighlights();
    hideHlBar();
    clearNativeSelection();
    applyAllHighlights();
    buildScrubberMarks();
  }

  function openHighlightEditor(hid) {
    const hl = highlights.find(h => h.id === hid);
    if (!hl) return;
    editingHighlightId = hid;
    pendingSelection = null;
    showHlBar(true);
  }

  document.addEventListener('click', (e) => {
    if (hlBar.hidden) return;
    if (e.target.closest('#hl-bar') || e.target.closest('mark.hl')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    hideHlBar();
  });

  /* ---------- Applying highlights to the DOM ---------- */
  function applyAllHighlights() {
    if (!currentPaper) return;
    // reset each block that had marks
    const byBlock = {};
    for (const hl of highlights) {
      if (hl.paperId !== currentId || hl.orphaned) continue;
      (byBlock[hl.blockId] = byBlock[hl.blockId] || []).push(hl);
    }
    for (const b of currentPaper.blocks) {
      const el = document.getElementById(b.id);
      if (!el || el.querySelector('.refs-heading')) continue;
      const wants = byBlock[b.id] || [];
      const has = el.querySelector('mark.hl');
      if (!wants.length && !has) continue;
      el.innerHTML = b.html;   // reset to pristine
      for (const hl of wants.slice().sort((a, b2) => a.start - b2.start)) {
        wrapRangeInBlock(el, hl.start, hl.end, hl.tag, hl.id);
      }
    }
  }

  function wrapRangeInBlock(blockEl, start, end, tag, hid) {
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    let pos = 0;
    for (let node of nodes) {
      const len = node.nodeValue.length;
      const a = pos, b = pos + len;
      pos = b;
      if (b <= start || a >= end) continue;
      let target = node;
      let localStart = Math.max(0, start - a);
      let localEnd = Math.min(len, end - a);
      if (localStart > 0) target = target.splitText(localStart);
      if (localEnd - localStart < target.nodeValue.length) target.splitText(localEnd - localStart);
      const mark = document.createElement('mark');
      mark.className = 'hl hl-' + tag;
      mark.dataset.hid = hid;
      target.parentNode.replaceChild(mark, target);
      mark.appendChild(target);
    }
  }

  /* ---------- Re-anchoring ---------- */
  function reanchorHighlights(paper) {
    let changed = false;
    // plain text per block, computed off-DOM
    const scratch = document.createElement('div');
    const plain = paper.blocks.map(b => { scratch.innerHTML = b.html; return scratch.textContent; });

    for (const hl of highlights) {
      if (hl.paperId !== paper.id) continue;
      const bi = parseInt((hl.blockId || '').slice(1), 10);
      const ok = !isNaN(bi) && bi < plain.length && plain[bi].slice(hl.start, hl.end) === hl.text;
      if (ok) { if (hl.orphaned) { hl.orphaned = false; changed = true; } continue; }
      // search for the exact text anywhere in the paper
      let found = false;
      for (let i2 = 0; i2 < plain.length; i2++) {
        const idx = plain[i2].indexOf(hl.text);
        if (idx !== -1) {
          hl.blockId = 'b' + i2;
          hl.start = idx;
          hl.end = idx + hl.text.length;
          hl.orphaned = false;
          found = true;
          changed = true;
          break;
        }
      }
      if (!found && !hl.orphaned) { hl.orphaned = true; changed = true; }
    }
    if (changed) persistHighlights();
  }

  /* ---------- Highlights view ---------- */
  async function openHighlightsView(paperId) {
    const papers = await loadAllPapers();
    let filterTag = null;

    function render() {
      const scoped = highlights.filter(h => (!paperId || h.paperId === paperId) && (!filterTag || h.tag === filterTag));
      const title = paperId ? 'Highlights' : 'All highlights';
      let html = '<div class="sheet-title">' + title + '</div>';
      html += '<div class="hlv-filter">' +
        '<button data-tag="" class="' + (!filterTag ? 'on' : '') + '">All</button>' +
        TAGS.map(t => '<button data-tag="' + t + '" class="' + (filterTag === t ? 'on' : '') + '">' + TAG_LABELS[t] + '</button>').join('') +
        '</div>';
      if (!scoped.length) {
        html += '<p style="color:var(--muted)">No highlights yet. Long press on text while reading.</p>';
      }
      for (const h of scoped) {
        const pm = papers.find(p => p.id === h.paperId);
        const src = [pm ? shortLabel(pm.fm) : h.paperId, h.section].filter(Boolean).join(' &#183; ');
        html += '<div class="hlv-entry" data-tag="' + h.tag + '" data-hid="' + h.id + '">' +
          '<div class="hlv-meta">' + src + (h.orphaned ? ' <span class="hlv-orphan">&#183; orphaned</span>' : '') + '</div>' +
          '<div class="hlv-quote">' + escapeHtml(h.text) + '</div>' +
          (h.note ? '<div class="hlv-note">' + escapeHtml(h.note) + '</div>' : '') +
          '<div class="hlv-actions">' +
          (!h.orphaned ? '<button data-act="go">Open</button>' : '') +
          '<button data-act="copy">Copy</button>' +
          '<button data-act="delete">Delete</button>' +
          '</div></div>';
      }
      html += '<div class="set-btn-row">' +
        '<button class="set-btn" data-act="export">Export' + (paperId ? ' this paper' : ' all') + '</button>' +
        '</div>';
      $('#sheet-body').innerHTML = html;
    }

    openSheet('');
    render();

    $('#sheet-body').addEventListener('click', async (e) => {
      const fbtn = e.target.closest('.hlv-filter button');
      if (fbtn) { filterTag = fbtn.dataset.tag || null; render(); return; }
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'export') { exportMarkdown(paperId); return; }
      const entry = e.target.closest('.hlv-entry');
      if (!entry || !act) return;
      const hl = highlights.find(h => h.id === entry.dataset.hid);
      if (!hl) return;
      if (act === 'copy') { copyText(hl.text + (hl.note ? '\n\n' + hl.note : '')).then(() => showToast('Copied')); }
      if (act === 'delete') {
        highlights = highlights.filter(h => h.id !== hl.id);
        persistHighlights();
        render();
        if (currentId === hl.paperId) { applyAllHighlights(); buildScrubberMarks(); }
      }
      if (act === 'go') {
        closeSheet();
        if (currentId !== hl.paperId) await openPaper(hl.paperId, {});
        jumpToBlock(hl.blockId, true);
      }
    });
  }

  /* ---------- Export / import ---------- */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  }

  function downloadFile(name, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  async function exportMarkdown(paperId) {
    const papers = await loadAllPapers();
    const ordered = papers.map(p => Object.assign({ id: p.id }, p.fm));
    const scopedPapers = paperId ? ordered.filter(p => p.id === paperId) : ordered;
    const md = formatExport(scopedPapers, highlights);
    if (!md.trim()) { showToast('No highlights to export'); return; }
    await copyText(md);
    meta.lastExportAt = new Date().toISOString();
    persistMeta();
    showToast('Copied to clipboard');
    downloadFile((paperId || 'nightstand-highlights') + '.md', md, 'text/markdown');
  }

  function exportJson() {
    const payload = {
      app: 'nightstand',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      highlights,
      positions,
      settings,
    };
    meta.lastExportAt = new Date().toISOString();
    persistMeta();
    downloadFile('nightstand-backup.json', JSON.stringify(payload, null, 2), 'application/json');
    showToast('Backup downloaded');
  }

  function importJson() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (data.app !== 'nightstand') throw new Error('not a nightstand backup');
          let added = 0;
          const have = new Set(highlights.map(h => h.id));
          for (const h of data.highlights || []) {
            if (!have.has(h.id)) { highlights.push(h); added++; }
          }
          for (const [pid, pos] of Object.entries(data.positions || {})) {
            const cur = positions[pid];
            if (!cur || new Date(pos.updatedAt || 0) > new Date(cur.updatedAt || 0)) positions[pid] = pos;
          }
          persistHighlights();
          persistPositions();
          showToast('Imported ' + added + (added === 1 ? ' highlight' : ' highlights'));
          if (currentPaper) { reanchorHighlights(currentPaper); applyAllHighlights(); buildScrubberMarks(); }
        } catch (err) {
          showToast('Could not read that file');
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  function maybeBackupNag() {
    if (meta.backupNagDismissed) return;
    if (highlights.length <= 20) return;
    const last = meta.lastExportAt ? new Date(meta.lastExportAt).getTime() : 0;
    if (Date.now() - last < 30 * 24 * 3600 * 1000) return;
    showToast('It has been a while. Export a backup of your highlights? Tap here.', 8000, () => {
      exportJson();
    });
    meta.backupNagDismissed = true;
    persistMeta();
  }

  /* ---------- Search ---------- */
  async function openSearch(paperId) {
    openSheet(
      '<div class="sheet-title">' + (paperId ? 'Search this paper' : 'Search all papers') + '</div>' +
      '<input id="search-input" type="search" placeholder="Search" autocomplete="off">' +
      '<div id="search-results"></div>'
    );
    const input = $('#search-input');
    const resultsEl = $('#search-results');
    const papers = paperId ? [await loadPaper(paperId)].filter(Boolean) : await loadAllPapers();

    // plain text per paper per block
    const scratch = document.createElement('div');
    const corpus = papers.map(p => ({
      paper: p,
      texts: p.blocks.map(b => { scratch.innerHTML = b.html; return scratch.textContent; }),
    }));

    let searchTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(run, 200);
    });
    input.focus();

    function sectionFor(paper, bi) {
      let name = '';
      for (const h of paper.headings) {
        if (parseInt(h.blockId.slice(1), 10) <= bi) name = h.text;
        else break;
      }
      return name;
    }

    function run() {
      const q = input.value.trim().toLowerCase();
      resultsEl.innerHTML = '';
      if (q.length < 2) return;
      let count = 0;
      let html = '';
      for (const { paper, texts } of corpus) {
        for (let bi = 0; bi < texts.length && count < 80; bi++) {
          const lower = texts[bi].toLowerCase();
          const idx = lower.indexOf(q);
          if (idx === -1) continue;
          count++;
          const from = Math.max(0, idx - 55);
          const to = Math.min(texts[bi].length, idx + q.length + 55);
          const snippet = (from > 0 ? '&#8230;' : '') +
            escapeHtml(texts[bi].slice(from, idx)) +
            '<mark>' + escapeHtml(texts[bi].slice(idx, idx + q.length)) + '</mark>' +
            escapeHtml(texts[bi].slice(idx + q.length, to)) +
            (to < texts[bi].length ? '&#8230;' : '');
          const src = [paperId ? '' : (paper.fm.short || paper.fm.title), sectionFor(paper, bi)].filter(Boolean).join(' &#183; ');
          html += '<button class="search-result" data-paper="' + paper.id + '" data-block="b' + bi + '">' +
            snippet + '<span class="src">' + src + '</span></button>';
        }
      }
      resultsEl.innerHTML = html || '<p style="color:var(--muted)">No matches.</p>';
    }

    resultsEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.search-result');
      if (!btn) return;
      closeSheet();
      const pid = btn.dataset.paper;
      if (currentId !== pid || !readerVisible()) await openPaper(pid, {});
      jumpToBlock(btn.dataset.block, true);
    });
  }

  /* ---------- Image viewer ---------- */
  const viewer = $('#img-viewer');
  const viewerImg = $('#img-viewer-img');
  let vState = null;

  function openImageViewer(img) {
    viewerImg.src = img.src;
    viewerImg.style.transform = '';
    viewer.hidden = false;
    vState = { scale: 1, x: 0, y: 0, pointers: new Map(), lastDist: 0, moved: false };
  }
  function closeImageViewer() {
    viewer.hidden = true;
    viewerImg.src = '';
    vState = null;
  }

  viewer.addEventListener('pointerdown', (e) => {
    if (!vState) return;
    vState.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    vState.moved = false;
    viewer.setPointerCapture(e.pointerId);
  });
  viewer.addEventListener('pointermove', (e) => {
    if (!vState || !vState.pointers.has(e.pointerId)) return;
    const prev = vState.pointers.get(e.pointerId);
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) vState.moved = true;
    vState.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const pts = [...vState.pointers.values()];
    if (pts.length === 2) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (vState.lastDist) {
        vState.scale = Math.max(1, Math.min(6, vState.scale * (dist / vState.lastDist)));
      }
      vState.lastDist = dist;
    } else if (pts.length === 1 && vState.scale > 1) {
      vState.x += dx;
      vState.y += dy;
    }
    viewerImg.style.transform = 'translate(' + vState.x + 'px,' + vState.y + 'px) scale(' + vState.scale + ')';
    viewerImg.style.transformOrigin = 'center';
  });
  viewer.addEventListener('pointerup', (e) => {
    if (!vState) return;
    vState.pointers.delete(e.pointerId);
    vState.lastDist = 0;
    if (!vState.moved && vState.pointers.size === 0) closeImageViewer();
  });
  viewer.addEventListener('pointercancel', (e) => {
    if (vState) { vState.pointers.delete(e.pointerId); vState.lastDist = 0; }
  });

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function showToast(msg, ms, onTap) {
    const toast = $('#toast');
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toast.onclick = () => {
      toast.hidden = true;
      if (onTap) onTap();
    };
    toastTimer = setTimeout(() => { toast.hidden = true; }, ms || 2500);
  }

  /* ---------- Service worker ---------- */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            showToast('New version ready, tap to reload', 10000, () => {
              nw.postMessage('skipWaiting');
            });
          }
        });
      });
    }).catch(() => { /* offline first run without SW still works from network cache */ });

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      savePositionNow();
      location.reload();
    });
  }

  boot();
}

/* Node test hook */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseMarkdown, parseFrontMatter, renderInline, formatExport, shortLabel };
}
