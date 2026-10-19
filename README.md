# Hermeneus

*Hermeneus (ἑρμηνεύς) is Ancient Greek for "interpreter, translator".*

An open-source Chrome extension that translates raw manga, manhwa and manhua pages into
English right on the reading site, using **your own API key** (Claude, OpenAI, Gemini or
OpenRouter).

It never creates a new image. Each bubble on the original page is masked with its own paper
colour and editable English text is typeset on top. Turn it off, or press **Original**, and
the untouched page is back.

## Install (from source)

1. Download or clone this repository.
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension` folder.
4. Pin the extension, open a chapter and click its icon:
   - pick a **provider**, paste your **API key**, pick a **model** that accepts images;
   - flip **Translate on &lt;site&gt;**.

The toggle is per site, so your key is never spent on random images elsewhere.

## Features

**Your own key**

| Provider   | Key looks like | Notes |
|------------|----------------|-------|
| Claude     | `sk-ant-...`   | Default model `claude-opus-5-5`. Cheaper: `claude-sonnet-5-5`, `claude-haiku-5-5`. |
| OpenAI     | `sk-...`       | Pick a vision model from the list. |
| Gemini     | `AIza...`      | Pick from the list. Gemini models rank high on the [ichigo.moe leaderboard](https://ichigo.moe/leaderboard). |
| OpenRouter | `sk-or-...`    | The list shows only image-capable models. |

The model list is loaded from each provider's own model endpoint after you enter a key.

**Finding the pages**
- Automatic: a run of 3+ same-width images stacked edge to edge (vertical readers,
  webtoon strips), or one large portrait page (paged readers). Covers, thumbnails, avatars
  and banners are skipped.
- **Pick area**: if a site confuses the automatic detection, click *Pick area* in the popup
  and click the part of the page that holds the comic. It's remembered for that site.
  *Auto* goes back to automatic detection.
- Pages are translated as you scroll near them, top first, two at a time, or all at once
  with **Translate all**.

**Translation with context**
- The last 30 translated lines of the chapter and a per-series name glossary are sent with
  each page, so speakers, names and tone stay consistent.

**Typesetter**
- *Cleaner*: each bubble is covered with its own paper colour (sampled from the page),
  shaped as an oval for speech/thought so the bubble outline stays visible.
- *Formatter*: font size starts from the original lettering size (big or shouted text stays
  big) and shrinks until it fits the bubble.
- *Vertical text*: short vertical sound effects and signs stay vertical; vertical dialogue
  becomes a narrow centred column. Switch any bubble with ⇅.
- Sound effects are drawn as outlined text without covering the artwork.
- Hover a bubble for A− / A+ size, ⇅ vertical, ✥ move, ⤡ resize, ◐ peek, ↺ reset.
  Click the text to edit it. Hovering also shows the original text.

**Progress and recovery**
- A panel (bottom right) shows pages done, pages translating/queued/failed, a progress bar
  and the estimated time left. It can **Pause**, **Translate all** and **Retry failed**, and
  can be minimised to a small pill.
- Each page shows its own timer and progress bar while it's being translated.
- A request with no answer after 3 minutes becomes a clickable **Retry** badge instead of
  hanging. Brief network drops and rate limits are retried automatically.

**Per-page hover buttons**
- **Original / Show translation** switches instantly (from the cache, no API call).
- **Retranslate** asks the model again and replaces that page's edits.

**Cache**
- Every translated page, with your edits and adjustments, is stored by image URL.
  Refreshing, reopening the chapter or restarting Chrome reuses it for free.
- A page that was still translating when you refreshed is finished and saved in the
  background, and the reloaded page joins that request instead of paying twice.

## Privacy

- Your API keys are stored only in this browser (`chrome.storage.local`).
- Page images are sent only to the provider you choose, and only for sites where you turned
  translation on.
- There is no server, analytics or tracking in this project.

## Tips

- For a scanlation look, install a comic font such as *Wild Words* or *Anime Ace*; the
  extension uses it automatically when present.

## Known limits

- Readers that draw pages on `<canvas>` (instead of `<img>`) aren't detected.
- Very tall webtoon strips are shrunk to fit the model's image size, which can make small
  text hard to read. Normal manga pages are fine.
- Bubble boxes come from the model, so some will be slightly off. Use ✥ and ⤡ to fix them.

## Project layout

```
extension/          the Chrome extension (load this folder unpacked)
  manifest.json
  background.js     image download, provider calls, cache, colour sampling
  content.js        page detection, typesetting, progress panel, picker
  content.css
  popup.html/.js    toggle, provider, key, model, reader area
dev/test-harness/   offline test page with a fake API (see CONTRIBUTING.md)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports with the site URL and a screenshot help
the most.

## License

[MIT](LICENSE)
