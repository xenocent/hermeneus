// Content script: finds comic page images on any site, sends them to the
// background worker for translation, and typesets editable English on top.
// It stays idle unless the popup toggle is on for this site.
(() => {
  const CONCURRENCY = 2;
  const CONTEXT_LINES = 30;          // previous lines sent along so speakers and tone carry over
  const DEFAULT_ESTIMATE = 30_000;   // ms per page until a few pages have been timed

  const host = location.hostname;
  const pages = new Map();           // img element -> page state
  const queue = [];
  const waiting = new WeakSet();     // images we already listen to for 'load'
  let enabled = false;
  let paused = false;
  let translateAll = false;          // "Translate all": don't wait for pages to scroll near
  let active = 0;
  let root, toolbar, panel, tools, io, ro, mo, ticker;
  let chapter = chapterKey();
  let history = [];                  // [{src, lines}] in completion order for this chapter
  let readerSelector = null;         // picked reader area for this site, or null for auto
  let estimate = DEFAULT_ESTIMATE;
  let hovered = null;                // page under the pointer (for the hover tools)

  chrome.storage.local.get(['sites', 'readers', 'avgMs']).then(({ sites, readers, avgMs }) => {
    readerSelector = readers?.[host] || null;
    if (avgMs) estimate = avgMs;
    setEnabled(!!sites?.[host]);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.readers) {
      readerSelector = changes.readers.newValue?.[host] || null;
      if (enabled) scan();
    }
    if (changes.sites) setEnabled(!!changes.sites.newValue?.[host]);
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'pick') startPicker();
  });

  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    on ? start() : stop();
  }

  function start() {
    root = h('div', { id: 'mtx-root' });
    // Keep clicks and keys inside our UI away from the reader's page-turn handlers.
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress']) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }
    toolbar = makeToolbar();
    tools = makePageTools();
    panel = makePanel();
    root.append(toolbar, tools, panel);
    document.body.appendChild(root);

    io = new IntersectionObserver(onIntersect, { rootMargin: '1500px 0px' });
    ro = new ResizeObserver(scheduleLayout);
    ro.observe(document.documentElement);
    mo = new MutationObserver(scheduleScan);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'style', 'class'] });
    addEventListener('resize', scheduleLayout);
    document.addEventListener('scroll', scheduleLayout, true); // readers that scroll inside a div
    document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    ticker = setInterval(tick, 500);
    scan();
  }

  function stop() {
    io?.disconnect();
    ro?.disconnect();
    mo?.disconnect();
    clearInterval(ticker);
    removeEventListener('resize', scheduleLayout);
    document.removeEventListener('scroll', scheduleLayout, true);
    document.removeEventListener('pointermove', onPointerMove, { capture: true });
    root?.remove();
    pages.clear();
    queue.length = 0;
    hovered = null;
    translateAll = false;
  }

  // ---------- finding pages ----------

  let scanTimer = 0;
  function scheduleScan(mutations) {
    if (mutations?.every?.((m) => root.contains(m.target))) return; // our own edits
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 250);
  }

  function scan() {
    if (!enabled) return;
    if (chapterKey() !== chapter) {
      chapter = chapterKey();
      history = [];
      translateAll = false;
    }
    const found = findPages();
    for (const img of found) if (!pages.has(img)) track(img);
    for (const page of pages.values()) {
      if (!page.img.isConnected || (found.picked && !found.has(page.img))) untrack(page);
      else checkSrc(page);
    }
    for (const img of document.images) {
      if (!img.complete && !waiting.has(img)) {
        waiting.add(img);
        img.addEventListener('load', () => { waiting.delete(img); scheduleScan(); }, { once: true });
      }
    }
    layout();
    updatePanel();
  }

  // Comic pages are: images inside the picked reader area; or (auto) a run of 3+ same-width
  // images stacked edge to edge (vertical reader, webtoon strips); or one large portrait page
  // (paged reader). Covers, thumbnails, avatars and banners don't match any of these.
  function findPages() {
    const imgs = [...document.images].filter((img) => !root.contains(img));
    const rect = new Map(imgs.map((img) => [img, img.getBoundingClientRect()]));
    const ready = (img) => img.complete && img.naturalWidth >= 300;

    if (readerSelector) {
      const area = document.querySelector(readerSelector);
      if (area) {
        const found = new Set(imgs.filter((img) => area.contains(img) && ready(img) && rect.get(img).width >= 150 && rect.get(img).height >= 150));
        found.picked = true;
        return found;
      }
    }

    const columns = new Map(); // same left edge + width -> images, top to bottom
    for (const img of imgs) {
      const r = rect.get(img);
      if (r.width < 250 || r.height < 150) continue;
      const key = `${Math.round((r.left + scrollX) / 24)}:${Math.round(r.width / 24)}`;
      if (!columns.has(key)) columns.set(key, []);
      columns.get(key).push(img);
    }

    const found = new Set();
    const bigPage = Math.max(400, innerWidth * 0.3);
    for (const column of columns.values()) {
      column.sort((a, b) => rect.get(a).top - rect.get(b).top);
      // Split the column into runs of images that touch (gap under 60px).
      let run = [];
      const flush = () => {
        for (const img of run) {
          const r = rect.get(img);
          const portrait = r.height >= r.width * 1.15 && r.width >= bigPage;
          if (ready(img) && (run.length >= 3 || portrait)) found.add(img);
        }
        run = [];
      };
      for (const img of column) {
        const prev = run[run.length - 1];
        if (prev && rect.get(img).top - rect.get(prev).bottom > 60) flush();
        run.push(img);
      }
      flush();
    }
    return found;
  }

  function track(img) {
    const layer = h('div', { className: 'mtx-layer' });
    root.insertBefore(layer, toolbar);
    const page = { img, src: srcOf(img), layer, bubbles: null, state: 'idle', near: false, gen: 0, size: '', original: false };
    pages.set(img, page);
    io.observe(img);
    ro.observe(img);
    if (translateAll) enqueue(page);
  }

  function untrack(page) {
    io.unobserve(page.img);
    ro.unobserve(page.img);
    page.layer.remove();
    pages.delete(page.img);
    if (hovered === page) setHovered(null);
  }

  // Paged readers reuse one <img> and swap its src; treat that as a new page.
  function checkSrc(page) {
    const src = srcOf(page.img);
    if (src === page.src || !page.img.complete) return;
    page.src = src;
    reset(page);
    if (page.near || translateAll) enqueue(page);
  }

  function reset(page) {
    page.gen++;
    page.bubbles = null;
    page.state = 'idle';
    page.size = '';
    page.original = false;
    page.layer.classList.remove('mtx-original');
    page.layer.replaceChildren();
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      const page = pages.get(entry.target);
      if (!page) continue;
      page.near = entry.isIntersecting;
      if (page.near) enqueue(page);
    }
  }

  // ---------- translating ----------

  function enqueue(page) {
    if (page.state !== 'idle') return;
    page.state = 'queued';
    queue.push(page);
    pump();
  }

  function pump() {
    // Top of the chapter first, so earlier pages become context for later ones.
    queue.sort((a, b) => (a.img.compareDocumentPosition(b.img) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    while (enabled && !paused && active < CONCURRENCY && queue.length) {
      const page = queue.shift();
      if (pages.get(page.img) !== page || page.state !== 'queued') continue;
      active++;
      run(page).finally(() => {
        active--;
        pump();
      });
    }
    updatePanel();
  }

  async function run(page) {
    const { src, gen } = page;
    const force = page.force;
    page.force = false;
    page.state = 'working';
    page.startedAt = Date.now();
    status(page);
    try {
      // Cached pages (including your edits) come straight from storage, so refreshing is free.
      const key = 'tr:' + src;
      let result = force ? null : (await chrome.storage.local.get(key))[key];
      if (!result) {
        const msg = { type: 'translate', src, force, glossaryKey: glossaryKey(), context: await buildContext(src) };
        if (src.startsWith('blob:') || src.startsWith('data:')) msg.dataUrl = await readLocal(src);
        result = await chrome.runtime.sendMessage(msg);
        if (!result || result.error) throw new Error(result?.error || 'No reply from the extension.');
        learnDuration(Date.now() - page.startedAt);
      }
      history = history.filter((entry) => entry.src !== src);
      history.push({ src, lines: result.bubbles.map((b) => [b.original, b.english]) });
      if (page.gen !== gen || !enabled) return;
      page.bubbles = result.bubbles;
      page.state = 'done';
      status(page);
      render(page);
    } catch (err) {
      if (page.gen !== gen || !enabled) return;
      page.state = 'error';
      page.error = err.message;
      status(page);
    } finally {
      updatePanel();
      if (hovered === page) placeTools();
    }
  }

  function learnDuration(ms) {
    if (ms < 3000) return; // joined a request that was already almost done
    estimate = Math.round(estimate * 0.7 + ms * 0.3);
    chrome.storage.local.set({ avgMs: estimate });
  }

  async function buildContext(src) {
    const previous = history.filter((entry) => entry.src !== src).flatMap((entry) => entry.lines).slice(-CONTEXT_LINES);
    const gKey = glossaryKey();
    const glossary = Object.entries((await chrome.storage.local.get(gKey))[gKey] || {});
    return { previous, glossary };
  }

  // blob:/data: images can't be fetched by the background worker, so read them here.
  async function readLocal(src) {
    if (src.startsWith('data:')) return src;
    const blob = await (await fetch(src)).blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function save(page) {
    return chrome.storage.local.set({ ['tr:' + page.src]: { bubbles: page.bubbles } });
  }

  function retranslate(page) {
    if (!confirm('Retranslate this page? It calls the API again and replaces your edits on it.')) return;
    history = history.filter((entry) => entry.src !== page.src);
    reset(page);
    page.force = true;
    enqueue(page);
  }

  // ---------- progress: per-page status + chapter panel ----------

  function status(page) {
    page.layer.querySelector('.mtx-status')?.remove();
    if (page.state === 'working') {
      const bar = h('i');
      page.layer.append(h('div', { className: 'mtx-status' }, h('span', { textContent: 'Translating…' }), h('div', { className: 'mtx-status-bar' }, bar)));
    } else if (page.state === 'error') {
      const el = h('div', { className: 'mtx-status mtx-status-error', title: 'Click to retry' }, h('span', { textContent: `⚠ ${page.error} · Retry` }));
      el.addEventListener('click', () => { page.state = 'idle'; status(page); enqueue(page); }, { once: true });
      page.layer.append(el);
    }
  }

  function tick() {
    for (const page of pages.values()) {
      if (page.state !== 'working') continue;
      const el = page.layer.querySelector('.mtx-status');
      if (!el) continue;
      const elapsed = Date.now() - page.startedAt;
      el.firstChild.textContent = `Translating… ${seconds(elapsed)} / ~${seconds(estimate)}`;
      el.querySelector('i').style.width = `${Math.min(95, (elapsed / estimate) * 100)}%`;
    }
    updatePanel();
  }

  function makePanel() {
    const btn = (act, text) => h('button', { type: 'button', textContent: text, dataset: { act } });
    const el = h('div', { className: 'mtx-panel' },
      h('div', { className: 'mtx-panel-row' },
        h('b', { className: 'mtx-panel-count' }),
        h('span', { className: 'mtx-panel-detail' }),
        btn('min', '–')),
      h('div', { className: 'mtx-panel-bar' }, h('i')),
      h('div', { className: 'mtx-panel-row' },
        h('span', { className: 'mtx-panel-eta' }),
        btn('all', 'Translate all'),
        btn('pause', 'Pause'),
        btn('retry', 'Retry failed')));
    el.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act && el.classList.contains('mtx-min')) return el.classList.remove('mtx-min');
      if (act === 'min') el.classList.add('mtx-min');
      if (act === 'pause') {
        paused = !paused;
        pump();
      }
      if (act === 'all') {
        translateAll = true;
        for (const page of pages.values()) enqueue(page);
      }
      if (act === 'retry') {
        for (const page of pages.values()) if (page.state === 'error') { page.state = 'idle'; status(page); enqueue(page); }
      }
      updatePanel();
    });
    return el;
  }

  function updatePanel() {
    if (!panel) return;
    const all = [...pages.values()];
    const count = (state) => all.filter((p) => p.state === state).length;
    const done = count('done'), working = count('working'), queued = count('queued'), failed = count('error'), idle = count('idle');
    panel.classList.toggle('mtx-show', all.length > 0);
    if (!all.length) return;

    panel.querySelector('.mtx-panel-count').textContent = `${done}/${all.length} pages`;
    panel.querySelector('.mtx-panel-detail').textContent = [
      working && `${working} translating`,
      queued && `${queued} queued`,
      failed && `${failed} failed`,
    ].filter(Boolean).join(' · ');
    panel.querySelector('.mtx-panel-bar i').style.width = `${(done / all.length) * 100}%`;

    const running = all.filter((p) => p.state === 'working').reduce((sum, p) => sum + Math.max(0, estimate - (Date.now() - p.startedAt)), 0);
    const eta = (running + queued * estimate) / CONCURRENCY;
    panel.querySelector('.mtx-panel-eta').textContent =
      paused ? 'Paused' :
      working + queued ? `~${seconds(eta)} left` :
      done === all.length ? 'All pages translated' :
      idle ? `${idle} waiting for scroll` : '';
    panel.querySelector('[data-act=pause]').textContent = paused ? 'Resume' : 'Pause';
    panel.querySelector('[data-act=pause]').hidden = !paused && done + failed === all.length;
    panel.querySelector('[data-act=all]').hidden = !idle || translateAll;
    panel.querySelector('[data-act=retry]').hidden = !failed;
    panel.classList.toggle('mtx-busy', working > 0);
  }

  function seconds(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }

  // ---------- hover tools on each page: original / translated, retranslate ----------

  function makePageTools() {
    const el = h('div', { className: 'mtx-page-tools' },
      h('button', { type: 'button', dataset: { act: 'original' }, textContent: 'Original' }),
      h('button', { type: 'button', dataset: { act: 'retranslate' }, textContent: 'Retranslate' }));
    el.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act || !hovered) return;
      if (act === 'original') {
        hovered.original = !hovered.original;
        hovered.layer.classList.toggle('mtx-original', hovered.original);
        toolbar.classList.remove('mtx-show');
      }
      if (act === 'retranslate') retranslate(hovered);
      placeTools();
    });
    return el;
  }

  let pointer = { x: -1, y: -1 }, hoverFrame = 0;
  function onPointerMove(e) {
    pointer = { x: e.clientX, y: e.clientY };
    if (!hoverFrame) hoverFrame = requestAnimationFrame(updateHover);
  }

  function updateHover() {
    hoverFrame = 0;
    let hit = null;
    for (const page of pages.values()) {
      const r = page.img.getBoundingClientRect();
      if (pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom) {
        hit = page;
        break;
      }
    }
    setHovered(hit);
  }

  function setHovered(page) {
    hovered = page;
    placeTools();
  }

  function placeTools() {
    const page = hovered;
    const show = !!page && (page.state === 'done' || page.state === 'error');
    tools.classList.toggle('mtx-show', show);
    if (!show) return;
    tools.querySelector('[data-act=original]').hidden = page.state !== 'done';
    tools.querySelector('[data-act=original]').textContent = page.original ? 'Show translation' : 'Original';
    // Top-right corner of the part of the page that's on screen.
    const base = root.getBoundingClientRect();
    const r = page.img.getBoundingClientRect();
    const top = Math.min(Math.max(r.top, 0) + 8, r.bottom - tools.offsetHeight - 8);
    tools.style.left = `${r.right - base.left - tools.offsetWidth - 8}px`;
    tools.style.top = `${top - base.top}px`;
  }

  // ---------- pick the reader area ----------

  let picking = false;
  function startPicker() {
    if (picking) return;
    picking = true;
    const box = h('div', { className: 'mtx-pick-box' });
    const hint = h('div', { className: 'mtx-pick-hint', textContent: 'Click the area that holds the comic pages. Esc to cancel.' });
    const overlay = h('div', { id: 'mtx-picker' }, box, hint);
    document.documentElement.appendChild(overlay);
    let target = null, frame = 0, last = null;

    const under = (x, y) => document.elementsFromPoint(x, y).find((el) => !overlay.contains(el) && !root?.contains(el));
    const onMove = (e) => {
      last = e;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        target = readerAreaFor(under(last.clientX, last.clientY));
        box.style.display = target ? 'block' : 'none';
        if (!target) return;
        const r = target.getBoundingClientRect();
        Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      });
    };
    const block = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    const onClick = async (e) => {
      block(e);
      target = readerAreaFor(under(e.clientX, e.clientY));
      finish();
      if (!target) return;
      const { readers = {}, sites = {} } = await chrome.storage.local.get(['readers', 'sites']);
      readers[host] = selectorFor(target);
      sites[host] = true; // picking an area means you want this site translated
      await chrome.storage.local.set({ readers, sites });
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      block(e);
      finish();
    };
    const events = [['pointermove', onMove], ['click', onClick], ['mousedown', block], ['pointerdown', block], ['mouseup', block], ['keydown', onKey]];
    for (const [type, fn] of events) addEventListener(type, fn, true);
    function finish() {
      for (const [type, fn] of events) removeEventListener(type, fn, true);
      overlay.remove();
      picking = false;
    }
  }

  // From whatever is under the pointer, climb to the smallest element holding 2+ page-sized
  // images; for a single-page reader, use the image's own container.
  function readerAreaFor(el) {
    if (!el || el === document.documentElement || el === document.body) return null;
    const pageImages = (node) => [...node.querySelectorAll('img')].filter((img) => {
      const r = img.getBoundingClientRect();
      return r.width >= 150 && r.height >= 150;
    }).length;
    const start = el.tagName === 'IMG' ? el.parentElement : el;
    for (let node = start; node && node !== document.body; node = node.parentElement) {
      if (pageImages(node) >= 2) return node;
    }
    return start;
  }

  // A selector that finds the same area on the next chapter of the same site.
  function selectorFor(el) {
    const parts = [];
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (node.id && !/\d{3,}/.test(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const same = [...node.parentElement.children].filter((child) => child.tagName === node.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      parts.unshift(part);
    }
    if (!parts[0]?.startsWith('#')) parts.unshift('body');
    return parts.join(' > ');
  }

  // ---------- layout ----------

  let layoutFrame = 0;
  function scheduleLayout() {
    if (!layoutFrame) layoutFrame = requestAnimationFrame(layout);
  }

  function layout() {
    layoutFrame = 0;
    if (!enabled) return;
    const base = root.getBoundingClientRect();
    for (const page of pages.values()) {
      const r = page.img.getBoundingClientRect();
      page.layer.style.display = r.width ? '' : 'none';
      if (!r.width) continue;
      Object.assign(page.layer.style, {
        left: `${r.left - base.left}px`,
        top: `${r.top - base.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      const size = `${Math.round(r.width)}x${Math.round(r.height)}`;
      if (size !== page.size) {
        page.size = size;
        page.layer.querySelectorAll('.mtx-bubble').forEach(typeset);
      }
    }
    if (toolbar.target) placeToolbar(toolbar.target);
    if (hovered) placeTools();
  }

  // ---------- typesetting ----------
  // Each bubble is "cleaned" by covering it with its own paper colour (sampled from the
  // page), shaped like the bubble, then the English is fitted inside. Font size starts
  // from the original character size so shouted text stays big, and short vertical
  // sound effects / signs stay vertical.

  function render(page) {
    page.layer.querySelectorAll('.mtx-bubble').forEach((el) => el.remove());
    page.bubbles.forEach((b, i) => {
      b.base ??= { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
      const box = h('div', { className: `mtx-bubble mtx-${b.kind}`, title: b.original });
      box.mtx = { page, i };
      if (b.kind === 'sfx') {
        // Don't paint over artwork: outlined text in the opposite colour instead.
        box.style.setProperty('--mtx-fg', b.fg === '#ffffff' ? '#ffffff' : '#111111');
        box.style.setProperty('--mtx-outline', b.fg === '#ffffff' ? '#111111' : '#ffffff');
      } else {
        box.style.background = b.bg;
        box.style.setProperty('--mtx-fg', b.fg);
      }

      const text = h('div', { className: 'mtx-text', contentEditable: 'true', spellcheck: false, textContent: b.english });
      // Edits are saved while you type, so a sudden refresh doesn't lose them.
      let editTimer = 0;
      const commit = () => {
        clearTimeout(editTimer);
        const english = text.innerText.trim();
        if (english === b.english) return;
        b.english = english;
        const entry = history.find((h) => h.src === page.src);
        if (entry) entry.lines[i] = [b.original, english];
        save(page);
      };
      text.addEventListener('input', () => {
        typeset(box);
        clearTimeout(editTimer);
        editTimer = setTimeout(commit, 400);
      });
      text.addEventListener('blur', commit);
      box.appendChild(text);
      box.addEventListener('pointerenter', () => showToolbar(box));
      box.addEventListener('pointerleave', hideToolbarSoon);
      text.addEventListener('focus', () => showToolbar(box));

      page.layer.appendChild(box);
      place(box);
      typeset(box);
    });
  }

  function place(box) {
    const b = box.mtx.page.bubbles[box.mtx.i];
    Object.assign(box.style, {
      left: `${b.x0 * 100}%`,
      top: `${b.y0 * 100}%`,
      width: `${(b.x1 - b.x0) * 100}%`,
      height: `${(b.y1 - b.y0) * 100}%`,
    });
  }

  function isVertical(b) {
    if (b.forceVertical !== undefined) return b.forceVertical;
    // Short vertical SFX and signs read fine as stacked letters; vertical dialogue becomes a
    // narrow centred column instead (stacked Latin letters in speech are hard to read).
    return b.vertical && (b.kind === 'sfx' || b.kind === 'sign') && b.english.replace(/\s/g, '').length <= 12;
  }

  function typeset(box) {
    const { page, i } = box.mtx;
    const b = page.bubbles[i];
    const text = box.firstChild;
    const layerH = page.layer.clientHeight;
    if (!layerH) return;
    box.classList.toggle('mtx-vertical', isVertical(b));

    // Keep text inside the bubble: an oval's inscribed rectangle leaves ~15% per side.
    const w = box.offsetWidth, ht = box.offsetHeight;
    const oval = b.kind === 'speech' || b.kind === 'thought';
    const padX = b.kind === 'sfx' ? 0 : oval ? w * 0.13 : Math.min(6, w * 0.06);
    const padY = b.kind === 'sfx' ? 0 : oval ? ht * 0.13 : Math.min(6, ht * 0.05);
    box.style.padding = `${padY}px ${padX}px`;
    const innerW = w - 2 * padX, innerH = ht - 2 * padY;

    // Start from the original lettering size (Latin glyphs run ~80% of a CJK character box).
    const fromOriginal = b.size ? b.size * layerH * 0.8 : page.layer.clientWidth / 36;
    let size = Math.min(Math.max(fromOriginal, 9), 72);
    const overflows = () =>
      text.offsetWidth > innerW + 1 || text.offsetHeight > innerH + 1 ||
      text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1;

    text.style.fontSize = `${size}px`;
    while (size > 7 && overflows()) {
      size -= 0.5;
      text.style.fontSize = `${size}px`;
    }
    // Manual A-/A+ applies on top of the fitted size (it may spill past the bubble on purpose).
    if (b.scale && b.scale !== 1) text.style.fontSize = `${size * b.scale}px`;
  }

  // ---------- bubble adjust toolbar ----------

  function makeToolbar() {
    const buttons = [
      ['smaller', 'A−', 'Smaller text'],
      ['bigger', 'A+', 'Bigger text'],
      ['vertical', '⇅', 'Switch vertical / horizontal'],
      ['move', '✥', 'Drag to move'],
      ['resize', '⤡', 'Drag to resize'],
      ['hide', '◐', 'Show original (click again to restore)'],
      ['reset', '↺', 'Reset size and position'],
    ];
    const bar = h('div', { className: 'mtx-toolbar' },
      ...buttons.map(([act, label, title]) => h('button', { type: 'button', textContent: label, title, dataset: { act } })));
    bar.addEventListener('pointerenter', () => clearTimeout(bar.hideTimer));
    bar.addEventListener('pointerleave', hideToolbarSoon);
    bar.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act && bar.target) adjust(bar.target, act);
    });
    bar.addEventListener('pointerdown', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if ((act === 'move' || act === 'resize') && bar.target) drag(e, bar.target, act);
    });
    return bar;
  }

  function showToolbar(box) {
    clearTimeout(toolbar.hideTimer);
    toolbar.target = box;
    toolbar.classList.add('mtx-show');
    placeToolbar(box);
  }

  function hideToolbarSoon() {
    clearTimeout(toolbar.hideTimer);
    toolbar.hideTimer = setTimeout(() => {
      if (toolbar.dragging || toolbar.target?.contains(document.activeElement)) return;
      toolbar.classList.remove('mtx-show');
      toolbar.target = null;
    }, 500);
  }

  function placeToolbar(box) {
    if (!box.isConnected) return;
    const base = root.getBoundingClientRect();
    const r = box.getBoundingClientRect();
    const h = toolbar.offsetHeight + 4;
    // Above the bubble, or below it when the bubble touches the top of the window.
    const top = r.top - h >= 0 ? r.top - h : Math.min(r.bottom + 4, innerHeight - h);
    toolbar.style.left = `${Math.max(0, r.left) - base.left}px`;
    toolbar.style.top = `${top - base.top}px`;
  }

  function adjust(box, act) {
    const { page, i } = box.mtx;
    const b = page.bubbles[i];
    if (act === 'smaller') b.scale = Math.max(0.3, (b.scale || 1) / 1.12);
    if (act === 'bigger') b.scale = Math.min(4, (b.scale || 1) * 1.12);
    if (act === 'vertical') b.forceVertical = !isVertical(b);
    if (act === 'hide') {
      box.classList.toggle('mtx-hidden');
      return;
    }
    if (act === 'reset') {
      Object.assign(b, b.base);
      delete b.scale;
      delete b.forceVertical;
      place(box);
    }
    typeset(box);
    placeToolbar(box);
    save(page);
  }

  function drag(e, box, act) {
    e.preventDefault();
    const { page, i } = box.mtx;
    const b = page.bubbles[i];
    const btn = e.target;
    btn.setPointerCapture(e.pointerId);
    toolbar.dragging = true;
    let lastX = e.clientX, lastY = e.clientY;

    const onMove = (ev) => {
      const dx = (ev.clientX - lastX) / page.layer.clientWidth;
      const dy = (ev.clientY - lastY) / page.layer.clientHeight;
      lastX = ev.clientX;
      lastY = ev.clientY;
      if (act === 'move') {
        b.x0 += dx; b.x1 += dx; b.y0 += dy; b.y1 += dy;
      } else {
        b.x1 = Math.max(b.x0 + 0.02, b.x1 + dx);
        b.y1 = Math.max(b.y0 + 0.01, b.y1 + dy);
      }
      place(box);
      if (act === 'resize') typeset(box);
      placeToolbar(box);
    };
    const onUp = () => {
      btn.removeEventListener('pointermove', onMove);
      btn.removeEventListener('pointerup', onUp);
      btn.removeEventListener('pointercancel', onUp);
      toolbar.dragging = false;
      typeset(box);
      save(page);
    };
    btn.addEventListener('pointermove', onMove);
    btn.addEventListener('pointerup', onUp);
    btn.addEventListener('pointercancel', onUp);
  }

  // ---------- helpers ----------

  // Builds elements without innerHTML (some sites block it with Trusted Types).
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'dataset') Object.assign(el.dataset, value);
      else el[key] = value;
    }
    el.append(...children);
    return el;
  }

  function srcOf(img) {
    return img.currentSrc || img.src;
  }

  function chapterKey() {
    return location.origin + location.pathname;
  }

  // Glossary is shared by every chapter under the same parent path,
  // e.g. /manga/some-title/chapter-12/ and /manga/some-title/chapter-13/.
  function glossaryKey() {
    const parts = location.pathname.split('/').filter(Boolean);
    return `gl:${host}/${parts.slice(0, -1).join('/')}`;
  }
})();
