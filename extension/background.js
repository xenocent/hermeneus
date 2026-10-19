// Background service worker: downloads a comic page image, shrinks it, sends it to
// the provider you picked in the popup (Claude, OpenAI, Gemini or OpenRouter) and
// returns bubble boxes, English text, original text size/orientation and bubble colours.

const MAX_EDGE = 1568;     // keeps the image at a size every provider reads without resizing again
const MAX_PIXELS = 1_150_000;

const PROVIDERS = {
  claude: { defaultModel: 'claude-opus-5-5', coords: 'pixels' },
  openai: { defaultModel: '', coords: 'pixels' },
  gemini: { defaultModel: '', coords: 'norm1000' }, // Gemini is trained on 0-1000 boxes
  openrouter: { defaultModel: '', coords: 'pixels' },
};

const SYSTEM = `You translate comic pages (manga, manhwa, manhua) into English for a reader overlay that covers the original text.

Find every piece of non-English text a reader needs: speech bubbles, thought bubbles, narration boxes, signs and notes, and sound effects. Ignore page numbers, watermarks, scan credits and site logos.

For each one return:
- x0, y0, x1, y1: the box to cover (see the coordinate rule in the request). For bubbles and boxes, cover the bubble's inner white area so the English hides the original text, without covering the bubble's outline; for loose text and sound effects, cover the text itself.
- original: the text exactly as written.
- english: the translation.
- kind: speech, thought, narration, sign or sfx.
- vertical: true if the original is written top-to-bottom.
- size: the height of one original character, in the same units as the box. Shouted or emphasised text is usually bigger; keep that difference.

List them in the comic's reading order (right-to-left panels for Japanese manga, left-to-right for Korean and Chinese).

Write natural, idiomatic English that keeps each character's voice, tone and register, the way a good scanlation reads rather than a literal gloss. Use the previous lines to work out who is speaking, omitted subjects and references. Keep honorifics (-san, -kun, -chan, -senpai, -sama) and use the glossary spellings for names. Keep sound effects short (for example "THUD" or "*stare*"). Match emphasis: shouting can use capitals or "!", whispers can use lowercase or "...".

In names, list character names and recurring terms on this page with the English spelling you used.`;

const JSON_SHAPE = `Reply with only JSON in this shape:
{"bubbles":[{"x0":0,"y0":0,"x1":0,"y1":0,"original":"","english":"","kind":"speech","vertical":true,"size":0}],"names":[{"original":"","english":""}]}`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['bubbles', 'names'],
  properties: {
    bubbles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['x0', 'y0', 'x1', 'y1', 'original', 'english', 'kind', 'vertical', 'size'],
        properties: {
          x0: { type: 'integer' },
          y0: { type: 'integer' },
          x1: { type: 'integer' },
          y1: { type: 'integer' },
          original: { type: 'string' },
          english: { type: 'string' },
          kind: { type: 'string', enum: ['speech', 'thought', 'narration', 'sign', 'sfx'] },
          vertical: { type: 'boolean' },
          size: { type: 'integer' },
        },
      },
    },
    names: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['original', 'english'],
        properties: { original: { type: 'string' }, english: { type: 'string' } },
      },
    },
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const job = msg?.type === 'translate' ? translateCached(msg, sender) : msg?.type === 'models' ? listModels(msg.provider, msg.key) : null;
  if (!job) return;
  job.then(sendResponse, (err) => sendResponse({ error: err.message || String(err) }));
  return true; // keep the channel open for the async reply
});

// The worker saves results itself, so a page refreshed mid-translation still lands in the
// cache, and the reloaded page joins the request already running instead of paying twice.
const inflight = new Map(); // cache key -> promise

function translateCached(msg, sender) {
  const key = 'tr:' + msg.src;
  if (!inflight.has(key)) {
    const job = (async () => {
      if (msg.force) await chrome.storage.local.remove(key); // "Retranslate" on a page
      const cached = (await chrome.storage.local.get(key))[key];
      if (cached) return cached;
      const keepAlive = setInterval(chrome.runtime.getPlatformInfo, 20_000); // don't idle out mid-call
      try {
        const result = await translate(msg, sender);
        const entry = { bubbles: result.bubbles };
        await chrome.storage.local.set({ [key]: entry });
        if (msg.glossaryKey) await rememberNames(msg.glossaryKey, result.names);
        return entry;
      } finally {
        clearInterval(keepAlive);
      }
    })();
    inflight.set(key, job);
    job.finally(() => inflight.delete(key)).catch(() => {});
  }
  return inflight.get(key);
}

const GLOSSARY_MAX = 80;
async function rememberNames(gKey, names) {
  if (!names?.length) return;
  const glossary = (await chrome.storage.local.get(gKey))[gKey] || {};
  for (const n of names) if (n.original && n.english && !glossary[n.original]) glossary[n.original] = n.english;
  await chrome.storage.local.set({ [gKey]: Object.fromEntries(Object.entries(glossary).slice(-GLOSSARY_MAX)) });
}

async function settings() {
  const { provider = 'claude', keys = {}, models = {} } = await chrome.storage.local.get(['provider', 'keys', 'models']);
  const key = keys[provider]?.trim();
  const model = models[provider]?.trim() || PROVIDERS[provider].defaultModel;
  if (!key) throw new Error(`Add your ${provider} API key in the extension popup.`);
  if (!model) throw new Error(`Pick a ${provider} model in the extension popup.`);
  return { provider, key, model };
}

// ---------- translate ----------

async function translate({ src, dataUrl, context }, sender) {
  const cfg = await settings();
  const blob = dataUrl ? await (await fetch(dataUrl)).blob() : await fetchImage(src, sender.tab?.url);
  const img = await shrink(blob);
  const { coords } = PROVIDERS[cfg.provider];

  const prompt = userText(img, context, coords);
  const text = await CALL[cfg.provider](cfg, img.data, prompt);
  const out = parseJson(text);
  const scale = coords === 'norm1000' ? { x: 1000, y: 1000 } : { x: img.w, y: img.h };

  return {
    bubbles: (out.bubbles || []).map((b) => normalize(b, scale, img)).filter(Boolean),
    names: out.names || [],
  };
}

function userText(img, context = {}, coords) {
  const lines = [
    coords === 'norm1000'
      ? 'Coordinates: 0-1000 normalised to the image (0,0 top-left, 1000,1000 bottom-right). size uses the same 0-1000 vertical scale.'
      : `Coordinates: pixels of this ${img.w}x${img.h} image (0,0 top-left). size is in pixels.`,
  ];
  if (context.glossary?.length) {
    lines.push('', 'Glossary (use these spellings):', ...context.glossary.map(([o, e]) => `- ${o} -> ${e}`));
  }
  if (context.previous?.length) {
    lines.push('', 'Previous lines in this chapter, oldest first:', ...context.previous.map(([o, e]) => `- ${o} -> ${e}`));
  }
  lines.push('', 'Translate this page.');
  return lines.join('\n');
}

// Models sometimes wrap JSON in ```fences``` or add a sentence; take the outermost object.
function parseJson(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The model did not return a translation.');
  return JSON.parse(text.slice(start, end + 1));
}

// Model box -> fractions of the image, plus the bubble's own colours for the cleaner.
function normalize(b, scale, img) {
  const f = (v, max) => Math.min(Math.max(Number(v) || 0, 0), max) / max;
  const x0 = f(Math.min(b.x0, b.x1), scale.x), x1 = f(Math.max(b.x0, b.x1), scale.x);
  const y0 = f(Math.min(b.y0, b.y1), scale.y), y1 = f(Math.max(b.y0, b.y1), scale.y);
  const english = String(b.english || '').trim();
  if (x1 - x0 < 0.005 || y1 - y0 < 0.005 || !english) return null;
  const kind = ['speech', 'thought', 'narration', 'sign', 'sfx'].includes(b.kind) ? b.kind : 'speech';
  const { bg, fg } = bubbleColors(img, x0, y0, x1, y1);
  return {
    x0, y0, x1, y1,
    original: String(b.original || ''),
    english,
    kind,
    vertical: !!b.vertical,
    size: b.size > 0 ? Math.min(b.size / scale.y, 0.2) : 0, // character height as a fraction of page height
    bg,
    fg,
  };
}

// Most common colour inside the box = the bubble's paper colour (text is the minority).
function bubbleColors(img, x0, y0, x1, y1) {
  const { pixels, w, h } = img;
  const counts = new Map();
  const left = Math.floor(x0 * w), right = Math.ceil(x1 * w), top = Math.floor(y0 * h), bottom = Math.ceil(y1 * h);
  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x < right; x += 2) {
      const i = (y * w + x) * 4;
      const key = ((pixels[i] >> 4) << 8) | ((pixels[i + 1] >> 4) << 4) | (pixels[i + 2] >> 4);
      const c = counts.get(key) || [0, 0, 0, 0];
      c[0]++; c[1] += pixels[i]; c[2] += pixels[i + 1]; c[3] += pixels[i + 2];
      counts.set(key, c);
    }
  }
  let best = [1, 255, 255, 255];
  for (const c of counts.values()) if (c[0] > best[0]) best = c;
  const [n, r, g, bl] = best.map((v, i) => (i ? Math.round(v / best[0]) : v));
  const hex = (v) => v.toString(16).padStart(2, '0');
  const light = 0.299 * r + 0.587 * g + 0.114 * bl > 128;
  return { bg: `#${hex(r)}${hex(g)}${hex(bl)}`, fg: light ? '#111111' : '#ffffff' };
}

// ---------- providers ----------

const CALL = {
  async claude({ key, model }, data, prompt) {
    const res = await request('https://api.anthropic.com/v1/messages', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: {
        model,
        max_tokens: 16000,
        fallbacks: 'default',
        system: SYSTEM,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      },
    });
    if (res.stop_reason === 'refusal') throw new Error('Claude declined to translate this page.');
    if (res.stop_reason === 'max_tokens') throw new Error('Response was cut off (page has too much text).');
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  },

  openai: (cfg, data, prompt) => chatCompletions('https://api.openai.com/v1/chat/completions', cfg, data, prompt),

  openrouter: (cfg, data, prompt) => chatCompletions('https://openrouter.ai/api/v1/chat/completions', cfg, data, prompt),

  async gemini({ key, model }, data, prompt) {
    const res = await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      headers: { 'x-goog-api-key': key },
      body: {
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data } }, { text: `${prompt}\n\n${JSON_SHAPE}` }] }],
        generationConfig: { responseMimeType: 'application/json' },
      },
    });
    const cand = res.candidates?.[0];
    if (!cand) throw new Error(`Gemini returned nothing (${res.promptFeedback?.blockReason || 'blocked'}).`);
    return (cand.content?.parts || []).map((p) => p.text || '').join('');
  },
};

// OpenAI and OpenRouter share the Chat Completions format.
async function chatCompletions(url, { key, model }, data, prompt) {
  const res = await request(url, {
    headers: { authorization: `Bearer ${key}`, 'X-Title': 'Hermeneus' },
    body: {
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}`, detail: 'high' } },
            { type: 'text', text: `${prompt}\n\n${JSON_SHAPE}` },
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'comic_page', strict: true, schema: SCHEMA } },
    },
  });
  const msg = res.choices?.[0]?.message;
  if (msg?.refusal) throw new Error(`The model declined: ${msg.refusal}`);
  if (!msg?.content) throw new Error('The model returned an empty reply.');
  return typeof msg.content === 'string' ? msg.content : msg.content.map((p) => p.text || '').join('');
}

const TIMEOUT_MS = 180_000; // a stuck request turns into a "Retry" badge instead of hanging forever

async function request(url, { headers, body, method = 'POST' }) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (err.name === 'TimeoutError') throw new Error(`No answer after ${TIMEOUT_MS / 60_000} minutes.`);
      if (attempt < 2) continue; // brief network drop: try again
      throw new Error(`Network error: ${err.message}`);
    }
    if (res.ok) return res.json();

    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = Number(res.headers.get('retry-after')) || 2 ** attempt * 2;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error(`API key was rejected (${res.status}). Check it in the popup.`);
    const err = await res.json().catch(() => null);
    const detail = err?.error?.message || (Array.isArray(err) ? err[0]?.error?.message : null);
    throw new Error(detail || `API error ${res.status}`);
  }
}

// ---------- model lists for the popup ----------

const NOT_CHAT = /embed|tts|whisper|dall-e|moderation|audio|realtime|transcribe|image-|search|davinci|babbage|aqa/i;

async function listModels(provider, key) {
  if (provider === 'claude') {
    const res = await request('https://api.anthropic.com/v1/models?limit=100', {
      method: 'GET',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    });
    return res.data.map((m) => m.id);
  }
  if (provider === 'openai') {
    const res = await request('https://api.openai.com/v1/models', { method: 'GET', headers: { authorization: `Bearer ${key}` } });
    return res.data.map((m) => m.id).filter((id) => !NOT_CHAT.test(id)).sort();
  }
  if (provider === 'openrouter') {
    const res = await request('https://openrouter.ai/api/v1/models', { method: 'GET', headers: {} });
    return res.data.filter((m) => m.architecture?.input_modalities?.includes('image')).map((m) => m.id).sort();
  }
  if (provider === 'gemini') {
    const res = await request('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { method: 'GET', headers: { 'x-goog-api-key': key } });
    return res.models
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && !NOT_CHAT.test(m.name))
      .map((m) => m.name.replace(/^models\//, ''));
  }
  return [];
}

// ---------- image ----------

async function fetchImage(src, pageUrl) {
  // Many comic CDNs refuse requests without the reader page as Referer (hotlink protection).
  if (pageUrl) await setReferer(new URL(src).hostname, new URL(pageUrl).origin + '/');
  const res = await fetch(src, { credentials: 'include' });
  if (!res.ok) throw new Error(`Couldn't download the image (HTTP ${res.status}).`);
  return res.blob();
}

const referers = new Map(); // image host -> referer already set this session
async function setReferer(host, referer) {
  if (referers.get(host) === referer) return;
  let id = 0;
  for (const c of host) id = (id * 31 + c.charCodeAt(0)) % 1_000_000;
  id += 1;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: referer }] },
        condition: { requestDomains: [host], initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest', 'other'] },
      },
    ],
  });
  referers.set(host, referer);
}

async function shrink(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height), Math.sqrt(MAX_PIXELS / (bmp.width * bmp.height)));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; // transparent PNG pages would otherwise turn black in JPEG
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const pixels = ctx.getImageData(0, 0, w, h).data;
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(bin), w, h, pixels };
}
