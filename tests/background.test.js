// Unit tests for extension/background.js. The real file is loaded into a sandbox with a fake
// `chrome` and `fetch`, so no API key or browser is needed. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');

function load({ fetch } = {}) {
  const store = {};
  const context = vm.createContext({
    chrome: {
      runtime: { onMessage: { addListener() {} }, getPlatformInfo() {}, id: 'test' },
      storage: {
        local: {
          get: async (k) => Object.fromEntries((typeof k === 'string' ? [k] : k).filter((x) => x in store).map((x) => [x, store[x]])),
          set: async (o) => Object.assign(store, o),
          remove: async (k) => delete store[k],
        },
      },
      declarativeNetRequest: { updateSessionRules: async () => {} },
    },
    fetch: fetch || (async () => { throw new Error('no network in tests'); }),
    AbortSignal,
    URL,
    btoa,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  vm.runInContext(SOURCE, context);
  const get = (expr) => vm.runInContext(expr, context);
  return { get, store };
}

// A fake fetch that records requests and answers with queued responses.
function recorder(...responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const r = responses.shift() || { status: 200, json: {} };
    return {
      ok: r.status < 400,
      status: r.status,
      headers: { get: () => null },
      json: async () => r.json,
    };
  };
  return { fetch, calls };
}

const PAGE_JSON = JSON.stringify({
  bubbles: [{ x0: 10, y0: 20, x1: 110, y1: 220, original: 'テスト', english: 'Test', kind: 'speech', vertical: true, size: 20 }],
  names: [],
});

// ---------- tiles ----------

test('a normal manga page is one tile', () => {
  const { get } = load();
  assert.deepEqual(JSON.parse(JSON.stringify(get('planTiles(864, 1200)'))), [{ top: 0, height: 1200 }]);
});

test('a webtoon strip is cut into overlapping tiles that cover it exactly', () => {
  const { get } = load();
  const tiles = get('planTiles(800, 6000)');
  assert.ok(tiles.length > 1);
  assert.equal(tiles[0].top, 0);
  const last = tiles[tiles.length - 1];
  assert.equal(last.top + last.height, 6000);
  for (let i = 1; i < tiles.length; i++) {
    const prevEnd = tiles[i - 1].top + tiles[i - 1].height;
    assert.ok(tiles[i].top < prevEnd, 'tiles overlap');
    assert.equal(tiles[i].height, 1200);
  }
});

test('mergeTiles maps tile boxes back to page fractions', () => {
  const { get } = load();
  const merged = get(`mergeTiles([
    { tile: { top: 0, height: 1000 }, bubbles: [{ x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.4, size: 0.02, english: 'a' }] },
  ], 2000)`);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].y0, 0.1);
  assert.equal(merged[0].y1, 0.2);
  assert.equal(merged[0].size, 0.01);
  assert.equal('cut' in merged[0], false);
});

test('a bubble seen whole in the overlap of two tiles is kept once', () => {
  const { get } = load();
  // Tile A covers 0-1000, tile B 750-1750. The bubble sits at 800-900 on the page.
  const merged = get(`mergeTiles([
    { tile: { top: 0, height: 1000 }, bubbles: [{ x0: 0.1, y0: 0.8, x1: 0.3, y1: 0.9, size: 0, english: 'same' }] },
    { tile: { top: 750, height: 1000 }, bubbles: [{ x0: 0.1, y0: 0.05, x1: 0.3, y1: 0.15, size: 0, english: 'same' }] },
  ], 1750)`);
  assert.equal(merged.length, 1);
});

test('a bubble cut by a tile edge is dropped when the next tile has it whole', () => {
  const { get } = load();
  const merged = get(`mergeTiles([
    { tile: { top: 0, height: 1000 }, bubbles: [{ x0: 0.1, y0: 0.9, x1: 0.3, y1: 1.0, size: 0, english: 'half' }] },
    { tile: { top: 750, height: 1000 }, bubbles: [{ x0: 0.1, y0: 0.15, x1: 0.3, y1: 0.4, size: 0, english: 'whole' }] },
  ], 1750)`);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].english, 'whole');
});

test('a bubble too tall for the overlap keeps its biggest part instead of vanishing', () => {
  const { get } = load();
  const merged = get(`mergeTiles([
    { tile: { top: 0, height: 1000 }, bubbles: [{ x0: 0.1, y0: 0.6, x1: 0.3, y1: 1.0, size: 0, english: 'top part' }] },
    { tile: { top: 750, height: 1000 }, bubbles: [{ x0: 0.1, y0: 0.0, x1: 0.3, y1: 0.5, size: 0, english: 'bottom part' }] },
  ], 1750)`);
  assert.equal(merged.length, 1);
});

// ---------- model output ----------

test('parseJson accepts fenced or chatty JSON and rejects non-JSON', () => {
  const { get } = load();
  assert.deepEqual(JSON.parse(JSON.stringify(get('parseJson("Sure!\\n```json\\n{\\"bubbles\\":[]}\\n```")'))), { bubbles: [] });
  assert.throws(() => get('parseJson("no translation here")'), /did not return a translation/);
});

function fakeImage(w, h, paper = 255, ink = 0) {
  const pixels = new Uint8ClampedArray(w * h * 4).fill(paper);
  // a few dark "text" strokes in the middle
  for (let y = Math.floor(h / 3); y < Math.floor(h / 2); y++) {
    for (let x = Math.floor(w / 3); x < Math.floor(w / 2); x += 3) {
      const i = (y * w + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = ink;
    }
  }
  return { pixels, w, h };
}

test('normalize turns pixel boxes into fractions and samples the paper colour', () => {
  const { get } = load();
  const ctx = get('globalThis');
  ctx.img = fakeImage(200, 400);
  const b = get(`normalize({ x0: 150, y0: 300, x1: 50, y1: 100, original: 'あ', english: ' Hi ', kind: 'speech', vertical: true, size: 40 }, { x: 200, y: 400 }, img)`);
  assert.deepEqual([b.x0, b.y0, b.x1, b.y1], [0.25, 0.25, 0.75, 0.75]); // reversed corners are fixed
  assert.equal(b.english, 'Hi');
  assert.equal(b.size, 0.1);
  assert.equal(b.bg, '#ffffff');
  assert.equal(b.fg, '#111111');
});

test('normalize uses light text on dark boxes and drops empty or tiny boxes', () => {
  const { get } = load();
  const ctx = get('globalThis');
  ctx.img = fakeImage(100, 100, 20, 250);
  const dark = get(`normalize({ x0: 0, y0: 0, x1: 100, y1: 100, original: '', english: 'X', kind: 'narration', vertical: false, size: 0 }, { x: 100, y: 100 }, img)`);
  assert.equal(dark.fg, '#ffffff');
  assert.equal(get(`normalize({ x0: 0, y0: 0, x1: 100, y1: 100, english: '  ', kind: 'speech' }, { x: 100, y: 100 }, img)`), null);
  assert.equal(get(`normalize({ x0: 10, y0: 10, x1: 10, y1: 90, english: 'thin', kind: 'speech' }, { x: 100, y: 100 }, img)`), null);
});

test('normalize handles Gemini 0-1000 coordinates', () => {
  const { get } = load();
  const ctx = get('globalThis');
  ctx.img = fakeImage(100, 100);
  const b = get(`normalize({ x0: 100, y0: 200, x1: 500, y1: 600, english: 'ok', kind: 'speech', size: 50 }, { x: 1000, y: 1000 }, img)`);
  assert.deepEqual([b.x0, b.y0, b.x1, b.y1, b.size], [0.1, 0.2, 0.5, 0.6, 0.05]);
});

test('the prompt carries coordinates, glossary and previous lines', () => {
  const { get } = load();
  const text = get(`userText({ w: 800, h: 1100 }, { glossary: [['宮本', 'Miyamoto']], previous: [['はい', 'Yes']] }, 'pixels')`);
  assert.match(text, /800x1100/);
  assert.match(text, /宮本 -> Miyamoto/);
  assert.match(text, /はい -> Yes/);
});

// ---------- provider requests ----------

test('Claude request sends the image, schema and refusal fallbacks', async () => {
  const { fetch, calls } = recorder({ status: 200, json: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: PAGE_JSON }] } });
  const { get } = load({ fetch });
  const text = await get(`CALL.claude({ key: 'k', model: 'claude-opus-5-5' }, 'BASE64', 'prompt')`);
  assert.equal(text, PAGE_JSON);
  const [call] = calls;
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.headers['x-api-key'], 'k');
  assert.equal(call.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(call.body.fallbacks, 'default');
  assert.equal(call.body.output_config.format.type, 'json_schema');
  assert.equal(call.body.messages[0].content[0].source.data, 'BASE64');
});

test('Claude retries without fallbacks when the beta is refused', async () => {
  const { fetch, calls } = recorder(
    { status: 400, json: { error: { message: 'Unexpected value for anthropic-beta: server-side-fallback-2026-07-01' } } },
    { status: 200, json: { stop_reason: 'end_turn', content: [{ type: 'text', text: PAGE_JSON }] } },
  );
  const { get } = load({ fetch });
  await get(`CALL.claude({ key: 'k', model: 'm' }, 'B', 'p')`);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers['anthropic-beta'], undefined);
  assert.equal(calls[1].body.fallbacks, undefined);
});

test('Claude refusals become a readable error', async () => {
  const { fetch } = recorder({ status: 200, json: { stop_reason: 'refusal', content: [] } });
  const { get } = load({ fetch });
  await assert.rejects(get(`CALL.claude({ key: 'k', model: 'm' }, 'B', 'p')`), /declined/);
});

test('OpenAI and OpenRouter use chat completions with a data-URL image', async () => {
  for (const [provider, url] of [['openai', 'https://api.openai.com/v1/chat/completions'], ['openrouter', 'https://openrouter.ai/api/v1/chat/completions']]) {
    const { fetch, calls } = recorder({ status: 200, json: { choices: [{ message: { content: PAGE_JSON } }] } });
    const { get } = load({ fetch });
    assert.equal(await get(`CALL.${provider}({ key: 'k', model: 'm' }, 'B64', 'p')`), PAGE_JSON);
    assert.equal(calls[0].url, url);
    assert.equal(calls[0].headers.authorization, 'Bearer k');
    assert.equal(calls[0].body.messages[1].content[0].image_url.url, 'data:image/jpeg;base64,B64');
    assert.equal(calls[0].body.response_format.type, 'json_schema');
  }
});

test('Gemini uses generateContent with inline image data', async () => {
  const { fetch, calls } = recorder({ status: 200, json: { candidates: [{ content: { parts: [{ text: PAGE_JSON }] } }] } });
  const { get } = load({ fetch });
  assert.equal(await get(`CALL.gemini({ key: 'g', model: 'gemini-x' }, 'B64', 'p')`), PAGE_JSON);
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent');
  assert.equal(calls[0].headers['x-goog-api-key'], 'g');
  assert.equal(calls[0].body.contents[0].parts[0].inline_data.data, 'B64');
  assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');
});

test('a rejected key gives a clear message', async () => {
  const { fetch } = recorder({ status: 401, json: { error: { message: 'invalid x-api-key' } } });
  const { get } = load({ fetch });
  await assert.rejects(get(`CALL.openai({ key: 'bad', model: 'm' }, 'B', 'p')`), /API key was rejected \(401\)/);
});

// ---------- cache ----------

test('translateCached returns a cached page without calling the provider', async () => {
  const { fetch, calls } = recorder();
  const { get, store } = load({ fetch });
  store['tr:https://x/1.jpg'] = { bubbles: [{ english: 'cached' }] };
  const result = await get(`translateCached({ src: 'https://x/1.jpg' }, {})`);
  assert.equal(result.bubbles[0].english, 'cached');
  assert.equal(calls.length, 0);
});

test('missing key or model is reported before any request', async () => {
  const { fetch, calls } = recorder();
  const { get, store } = load({ fetch });
  await assert.rejects(get(`translate({ src: 'https://x/1.jpg' }, {})`), /Add your claude API key/);
  store.provider = 'gemini';
  store.keys = { gemini: 'g' };
  await assert.rejects(get(`translate({ src: 'https://x/1.jpg' }, {})`), /Pick a gemini model/);
  assert.equal(calls.length, 0);
});
