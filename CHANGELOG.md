# Changelog

## 0.2.0 (unreleased)

- **Webtoon strips**: very tall images are translated in overlapping tiles, so small text stays
  readable. Bubbles on tile edges are merged back into one. The progress timer accounts for
  the extra calls.
- **Claude**: if your key or proxy doesn't accept the refusal-fallback beta, the request is
  retried without it instead of failing.
- **Popup**: shows how many pages are cached and how much space they use, with a Clear button.
- **Icons** for the toolbar and the extensions page.
- **Tests**: unit tests for tiling, merging, coordinates, colour sampling and every provider's
  request format (`npm test`), a browser test page for the image pipeline, and CI on GitHub.

## 0.1.0

First release.

- Translate comic pages on any site with your own Claude, OpenAI, Gemini or OpenRouter key.
- Automatic page detection, plus a *Pick area* mode per site.
- Typesetter: bubble-colour masking, size from the original lettering, vertical text,
  per-bubble size / move / resize / peek tools, editable text.
- Progress panel with time left, pause, translate all and retry failed.
- Per-page *Original* and *Retranslate* hover buttons.
- Cache that survives refreshes, including a refresh in the middle of a translation.
