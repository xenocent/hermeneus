# Contributing

Thanks for helping. The extension is plain JavaScript with no build step: edit the files in
`extension/`, then press the reload icon on the extension's card in `chrome://extensions`
and refresh the reading page.

## Testing without an API key

`dev/test-harness` runs the real `content.js` against real page images with a fake `chrome`
API, so you can work on detection, typesetting, the progress panel and the cache for free.

```bash
node dev/test-harness/serve.js
```

Open `http://localhost:8765/dev/test-harness/index.html?base=<folder URL ending in />&pages=1,2,3`
and in the browser console:

```js
MOCK['1.jpg'] = { bubbles: [{ x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.25, original: '(test)',
  english: 'Test line', kind: 'speech', vertical: true, size: 0.03, bg: '#ffffff', fg: '#111111' }] };
MOCK_DELAY = 3000;          // fake translation time in ms
await startExtension();
sendToContent({ type: 'pick' }); // try the reader-area picker
```

Bubble boxes are fractions (0–1) of the page image. Storage lives in `sessionStorage`, so
reloading the page tests the cache; run `sessionStorage.clear()` for a fresh start.

## Where things live

- **Provider calls, prompt, JSON schema, cache writes:** `extension/background.js`
- **Page detection, typesetting, toolbar, progress panel, picker:** `extension/content.js`
- **Popup settings:** `extension/popup.html` and `extension/popup.js`

## Pull requests

- Keep the extension dependency-free and buildless.
- Test on at least one real reading site, and say which one in the PR.
- Never commit API keys.
