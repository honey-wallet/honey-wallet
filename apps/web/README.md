# Honey website (honeywallet.org)

The marketing site for Honey Wallet: Next.js 16, Tailwind CSS v4, one page (`src/app/page.tsx`).

```sh
# from the repository root
pnpm install
pnpm --filter @honey-wallet/web dev        # http://localhost:3200
pnpm --filter @honey-wallet/web typecheck
pnpm --filter @honey-wallet/web build
```

- Sections live in `src/components/site/`, one file each, in page order: nav, hero, how-it-works and
  worked-example (stacked story cards), reveal-band, features, faq, cta, footer.
- Product facts (the sample proposal, the agent's steps, the route plan) are in `honey-data.ts`, copied
  from the app's test mode and the deck. Keep them in step with the app.
- The illustrations are SVG, drawn in `art.tsx` from the Honey mark; token marks are in `public/logos/`.
- Colours are the app's light palette (`apps/mobile/src/theme/index.ts`), set as tokens in
  `src/app/globals.css`.
- The waitlist form posts to `NEXT_PUBLIC_API_URL` (default `https://api.honeywallet.org`)
  `/api/v1/waitlist`, the same call as `apps/web`. That origin must be in the server's
  `CORS_ALLOWED_ORIGINS`.
- Privacy, terms, support and account deletion are static pages in `public/<page>/index.html` (styles in
  `public/legal.css`); `vercel.json` maps the clean URLs and holds the `/get` store redirect, the
  `/app/*` deep-link fallback and the `.well-known` app-link files' headers.
- Invite email images live in `public/email/` (built by `scripts/invite-hero.sh`).
- The developer console that talks to a running server is `apps/console` (not deployed).
