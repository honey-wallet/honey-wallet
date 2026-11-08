# Honey deck

The pitch deck for **Honey Wallet: Jars**, for the NEAR Hackathon (submissions close 14 Nov 2026).
Product facts come from the [honey-wallet](https://github.com/honey-wallet/honey-wallet) repository and its
test mode; every outside number is cited on its slide and listed on the References slide.

## Slides

1. **Honey.** What it is.
2. **The problem.** Eight steps to act on an idea today, three with Honey (one click-build).
3. **The market.** 741M crypto owners, 62% juggling wallets, $33B+ through NEAR Intents.
4. **Jars.** Write an idea, review the proposal, buy in one approval.
5. **The agent.** Its six real progress steps, then the proposal with the critic's warning.
6. **Routes.** The app's route planner output for a $5,000 jar across four chains.
7. **NEAR.** What NEAR AI Cloud, NEAR Intents, the 1Click token list and NEAR accounts do, with code paths.
8. **Safety.** The agent suggests, you sign.
9. **Friends.** Shared, public and copyable jars.
10. **Built.** During the hackathon window, and where it stands.
11. **Try it.** Test mode in five minutes. 12. Close. 13. References.

Honey's dark theme (colours from `apps/mobile/src/theme/index.ts`, the logo from `apps/web/public/honey-mark.svg`)
is in `src/styles/tokens.css` and `src/components/honey.css`.

The three films in `public/video/` (Jars flow, NEAR route, friends) are made in `~/video-harness/films/honey-deck/`
from real screenshots of the app in test mode (`capture/step.mjs`, `capture/record.mjs`). To change one, edit its
`*.html` there, then render: `node render.mjs films/honey-deck/flow.html --fps 60 --sub 2 --out …` and copy the MP4
and a poster still into `public/video/`.

---

# Deck engine

A pitch deck as a web app, in a research-note style: numbered slide titles, Figure and Table captions,
and every number linked to a source on a References slide. React 18, Vite 5, TypeScript, framer-motion.

Starter template. The last deck built on it is
[prodabhi/huma-deck](https://github.com/prodabhi/huma-deck), which uses every component below with real data.

## Run

```sh
# from the repository root (the deck is the @honey-wallet/deck workspace package)
pnpm install
pnpm --filter @honey-wallet/deck dev         # http://localhost:5175
pnpm --filter @honey-wallet/deck typecheck
pnpm --filter @honey-wallet/deck build       # static site in deck/dist/
```

Arrow keys or space advance. Press `?` in the deck for the full key list. `#n` in the URL opens slide n.

## Where things go

| What | Where |
|---|---|
| Slides | `src/App.tsx`, one child of `<Deck>` per slide (`nav` = overview name, `notes` = speaker notes) |
| Sources and chart data | `src/data/sources.ts`; cite with `{cite(n)}` from `src/components/Cite.tsx` |
| Images and screenshots | `public/img/`, referenced as `/img/name.png` |
| Theme (colours, fonts) | `src/styles/tokens.css`; accent is `--primary` |
| Page title, favicon | `index.html`, `public/favicon.svg` |

## Components

| Component | Use it for |
|---|---|
| `Cover` | Opening slide: kicker, title, subtitle with byline and abstract |
| `ChartSlide` | Any content slide: numbered title, full-bleed visual, caption at the foot. `aside` takes `AsideStat`s |
| `BigStats`, `AsideStat` (in `ChartSlide.tsx`) | Large figures |
| `ResearchLine` | Line chart with real axes, end labels, an event `marker` and a `reference` line |
| `HBars` | Horizontal bar chart with hover detail |
| `CountUp` | A number that counts up when it enters view |
| `Process` | Four boxes and arrows, with a dashed "private" frame and line-drawing figures |
| `Compare` | Comparison table; one `hero` column is tinted in the accent |
| `Audience` | Grid of who/why boxes plus one accent stat box |
| `Showdown` | Two screenshots side by side; the right one appears on click with a stamp |
| `Slide`, `Reveal`, `Build` (in `src/deck/`) | Plain slide, fade-in on view, and click-to-reveal steps (`<Build at={1}>`) |

## Notes from earlier decks

- **Cite everything.** Each number on a slide gets `{cite(n)}` and an entry in `sources.ts`, numbered in
  the order they first appear. One reliable source per claim is enough. Open the source and check the figure.
- **Class names.** `src/styles/base.css` already defines many classes (for example `.cmp*`). Give new
  components their own short prefix (`vs-`, `au-`, `sd-`) so they don't inherit stray styles.
- **Scale.** A PostCSS plugin in `vite.config.ts` multiplies every CSS `px` by `SCALE` (1.25, `src/scale.ts`).
  Write px values at 100%.
- **Checking slides without a browser extension.** Run `pnpm --filter @honey-wallet/deck exec vite preview --port 5180` and take headless
  Chrome screenshots of `http://localhost:5180/#n` at 1600×900 and 1280×800. To skip the fade-in
  animations, use a copy of `dist/index.html` with this added to `<head>`:
  `<style>.slide [style*="opacity"]{opacity:1!important;transform:none!important;filter:none!important}.noir-dock{display:none!important}.slide-stage{animation:none!important}</style>`
