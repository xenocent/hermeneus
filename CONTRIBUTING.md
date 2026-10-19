# Contributing

Thanks for helping. The extension is plain JavaScript with no build step: edit the files in
`extension/`, then press the reload icon on the extension's card in `chrome://extensions`
and refresh the reading page.

## Unit tests

```bash
npm test
```

`tests/background.test.js` loads the real `extension/background.js` into a sandbox with a fake
`chrome` and `fetch`. It covers webtoon tiling and merging, coordinates, colour sampling, JSON
parsing, the cache, and the request format for every provider. CI runs it on every push.

## Testing without an API key

`dev/test-harness` has two pages that run the real extension code with a fake API:

```bash
npm run dev
```

(Set `PORT=8766` or similar if 8765 is taken.)

**`background.html`**: runs `background.js` on synthetic pages drawn in the browser (a normal
page and a 6000px webtoon strip) and checks cropping, tiling, colour sampling, context between
tiles and the cache. Open `http://localhost:8765/dev/test-harness/background.html` and run
`await runAll()` in the console.

**`index.html`**: runs `content.js` against real page images. Open
`http://localhost:8765/dev/test-harness/index.html?base=<folder URL ending in />&pages=1,2,3`
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

- **Provider calls, prompt, JSON schema, tiling, cache writes:** `extension/background.js`
- **Page detection, typesetting, toolbar, progress panel, picker:** `extension/content.js`
- **Popup settings and cache controls:** `extension/popup.html` and `extension/popup.js`
- **Icons:** `extension/icons/icon.svg` is the source; the PNGs are rendered from it.

## Pull requests

- Keep the extension dependency-free and buildless.
- Run `npm test`, and test on at least one real reading site (say which one in the PR).
- Add a line to `CHANGELOG.md` under the unreleased version.
- Never commit API keys.
