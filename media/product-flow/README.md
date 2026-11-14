# Honey flow: original composition, current UI

This preserves the existing 14-second canvas film from the team's video harness.
The visual concept, text entrance, typing, floating cards, leftward move, tap,
result reveal and loop timings remain. The native screen crops have been refreshed.

- Write an idea: same input and typed phrase.
- Review the jar: current Thesis agent answer with its allocation/amount control.
- Approve once: current Launch your jar review, followed by the holdings crop.
- The preview uses sample data; this is a composed product illustration, not proof
  of a live transaction or a continuous screen recording.

Four compositions match the original outputs: `flow2.html` (dark/wide),
`flow2-light.html`, `flow2-portrait.html`, `flow2-light-portrait.html`.
Wide: 2000 × 800. Portrait: 1000 × 1250. All are 10.6 seconds at 60 fps, silent
(14 Nov: the review and closing holds were cut short with `warp`, so the review card no
longer sits still for 3.8 s; the review card now hands over to the approval screen with
a quick out-and-in instead of a hard cut).
The screenshots are unedited; crop coordinates live in the composition code.
`screen-frame.js` provides the shared inset mockup for the review, approval and
holdings crops: 16–32 px of internal space, an app-matched background and a
rounded hairline border. Screens retain their aspect ratio; the outside height
and animation positions stay fixed. Approval tap coordinates use the same inset.
The fonts retain their included SIL Open Font License notices.

`near2.html` is the deck's original 13-second NEAR architecture animation. It
shares this film kit and keeps its original composition and timings. Each route
shows the venue as the main mark, with its chain as a 46% badge (optically reduced
for square marks), matching the deck's `OnChain` component. Render it at 60 fps
to `deck/public/video/near2.mp4`, with a poster at 11.2 seconds.

## Render

The included `render.mjs` preserves the original video-harness renderer. It needs
Node 22+, FFmpeg, and Playwright with Chromium installed. It exposes the same
`--still`, `--fps`, `--out` and contact-sheet options as the existing tool.
If Playwright is not installed in the module search path, point it at the existing
video-harness install without adding a runtime dependency to the app:

```sh
HONEY_PLAYWRIGHT_MODULE=/absolute/path/to/video-harness/node_modules/playwright/index.mjs \
node media/product-flow/render.mjs media/product-flow/flow2-light.html \
  --fps 60 --out /tmp/flow-light.mp4
```

Use `--still 5.0 --out /tmp/review.png` to inspect the review beat; check 2.0,
5.0 and 8.0 seconds for the three original stages before replacing a film.

The landing page uses `apps/web/public/video/flow-{light,dark}[-portrait].mp4`.
The deck uses the dark wide cut at `deck/public/video/flow2.mp4`.
Poster times are 5.0 seconds (wide) and 4.8 seconds (portrait), matching Film's
playback start on the centred review card. Refresh all posters and bump the Film/Clip cache versions after
publishing a new render. This source contains no private hackathon notes or keys.
