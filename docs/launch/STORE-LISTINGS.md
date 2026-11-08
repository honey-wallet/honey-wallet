# Store listings: privacy and permission answers

Ready-to-paste answers for the Chrome Web Store, App Store Connect and Google Play.
Every answer is based on the code as of 8 November 2026. Re-check it when you add an
SDK, a server table or a permission.

Public URLs (served from `apps/web`):

- Privacy policy: https://honeywallet.org/privacy
- Terms: https://honeywallet.org/terms
- Support: https://honeywallet.org/support
- Account and data deletion: https://honeywallet.org/delete-account
- Contact: team@honeywallet.org

What the code shows (the basis for every answer below):

- Recovery phrases and keys are generated and stored on the device only (phone secure
  storage; extension: scrypt + XChaCha20-Poly1305 in `chrome.storage.local`, unlocked
  copy in `chrome.storage.session`). Never sent to the server.
- No analytics, advertising or crash-reporting SDK in mobile, extension or web
  (no Sentry, PostHog, Firebase Analytics, Crashlytics, etc.). No IDFA/AAID use.
- Notifications are local only (`expo-notifications`, no push token collected).
- Server database (`apps/server/migrations`): waitlist email; random user ID, wallet
  addresses, hashed sessions, sign-in/sign-out events; operation records (swaps,
  transfers) incl. signed transactions passed to the network.
- Optional Firebase sign-in (Google, Apple, email link): Firebase processes email and
  provider profile; server reads the Firebase user ID from the verified token.
- Thesis agent: idea text and pasted links go to NEAR AI Cloud and Linkup; not stored
  in the database.
- Profile name/photo: local only (phone memory; extension storage). Not uploaded.

---

## Chrome Web Store

### Single purpose

> Honey Wallet is a self-custodial crypto wallet. It lets you hold and send crypto,
> connect your wallet to websites and approve or reject their requests, and pair with
> the Honey app on your phone.

### Permission justifications

**storage**

> Stores the user's wallet, encrypted with their password, plus their wallet list,
> settings, the websites they have connected and pending approval requests. The
> unlocked wallet is kept only in session storage (memory) and cleared when the user
> locks, closes the browser or is idle.

**Host permission: `https://rpc.mainnet.near.org/*`, `https://rpc.testnet.near.org/*`**

> Reads NEAR account balances and broadcasts NEAR transactions the user has approved,
> through the public NEAR RPC endpoints.

**Host permission: Honey API origin (added at build time from `EXPO_PUBLIC_API_URL`)**

> Calls the Honey Wallet server for quotes, market data, wallet sign-in and phone
> pairing. No recovery phrase or private key is ever sent.

**Host permission: `http://localhost:8080/*`**

> Development only. Remove before submitting (see open question 1).

**Content scripts on `http://*/*` and `https://*/*`**

> Required for a wallet: websites detect wallets through `window.ethereum` (EIP-1193 /
> EIP-6963) and the Solana Wallet Standard. `inpage.js` exposes that provider;
> `content.js` only passes the site's requests to the extension, which asks the user
> before connecting or signing anything. The scripts do not read or change page content.

**Remote code**

> No. All code is packaged in the extension. The CSP is `script-src 'self'`.

### Data usage disclosures

What user data do you collect? (Tick only these.)

| Category | Tick | Why |
| --- | --- | --- |
| Personally identifiable information | Yes | Waitlist email, if the user joins from the extension. |
| Health information | No | |
| Financial and payment information | Yes | Wallet addresses and transactions sent to the Honey server and to RPC providers to show balances and execute what the user approves. |
| Authentication information | No | Keys and passwords stay on the device. (Wallet sign-in sessions are random tokens, stored hashed on the server.) |
| Personal communications | No | |
| Location | No | |
| Web history | No | |
| User activity | No | |
| Website content | No | The content script reads nothing from pages. |

Certifications (tick all three):

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Privacy policy URL: https://honeywallet.org/privacy

---

## App Store Connect: App Privacy

**Do you or your third-party partners collect data from this app?** Yes.

**Tracking:** No. The app does not link data with third-party data for advertising and
does not share data with data brokers. No App Tracking Transparency prompt is needed.

| Data type | Collected | Linked to identity | Used for tracking | Purpose |
| --- | --- | --- | --- | --- |
| Contact Info → Email Address | Yes (waitlist; optional Google/Apple/email sign-in via Firebase) | Yes | No | App Functionality |
| Identifiers → User ID | Yes (server user ID; Firebase user ID) | Yes | No | App Functionality |
| Financial Info → Other Financial Info | Yes (wallet addresses, operation records, signed transactions handled by the server) | Yes | No | App Functionality |
| User Content → Other User Content | Yes (thesis idea text and links, sent to the server and AI/search providers; not stored) | No | No | App Functionality |
| Name, Photos, Contacts, Location, Health, Browsing/Search History, Purchases, Usage Data, Diagnostics, Sensitive Info | No | | | |

Notes for the reviewer:

- Profile name and photo stay on the device, so they are "not collected".
- Camera (QR scan) and photo library (profile photo) are processed on device only.
- Optional "Other User Content" could be marked "Not collected" if you consider the
  thesis text ephemeral (processed only in real time, not retained). Apple's rule:
  data processed only in real time and not retained is not "collected". The server
  does not store it, but it is sent to third parties (NEAR AI, Linkup), so declaring it
  is the safer answer.

---

## Google Play: Data safety

**Does your app collect or share any of the required user data types?** Yes.

**Is all of the user data collected by your app encrypted in transit?** Yes (HTTPS).

**Do you provide a way for users to request that their data is deleted?** Yes:
https://honeywallet.org/delete-account

| Data type | Collected | Shared | Optional? | Purposes |
| --- | --- | --- | --- | --- |
| Personal info → Email address | Yes | No | Optional (waitlist / sign-in) | App functionality, Account management |
| Personal info → User IDs | Yes | No | Optional (only with sign-in) | App functionality, Account management |
| Financial info → Other financial info (wallet addresses, transactions) | Yes | Yes (NEAR Intents 1Click and RPC providers, to execute what the user requests) | Required for trading features | App functionality |
| Messages / App activity → Other user-generated content (thesis text) | Yes, processed ephemerally | Yes (NEAR AI Cloud, Linkup) | Optional | App functionality |
| Location, Photos and videos, Contacts, App activity (analytics), Web browsing, App info and performance, Device or other IDs | No | | | |

Notes:

- "Shared" follows Play's definition. Transfers to service providers acting on our
  behalf (Google Cloud, Firebase) are not "sharing". Transfers the user directs, such
  as sending a swap to NEAR Intents, may also be exempt as user-initiated. Marking them
  shared is the conservative choice.
- Photos (profile picture) and camera (QR) are used on device only, so they are not
  collected.
- Data processed ephemerally: thesis text (tick "processed ephemerally").
- Security section: "Data is encrypted in transit" Yes; "You can request that data be
  deleted" Yes.

---

## Open questions (check before submitting)

1. `apps/extension/public/manifest.json` ships `http://localhost:8080/*` in
   `host_permissions`. The build adds the real API origin; remove the localhost entry
   for the Web Store build or reviewers may ask about it.
2. There is no account-deletion endpoint on the server or in the app. Deletion is
   manual by email. Play accepts a web request flow, but you need a process (SQL steps
   plus Firebase user deletion) and the 30-day promise on /delete-account must be met.
3. No retention limit exists for users, wallet memberships, identity events,
   operations or the waitlist. The policy says "kept until you ask us to delete it".
4. The Cloud SQL region (us-central1) is not recorded in the repo; the policy says
   "Google Cloud in the United States". Confirm.
5. The "Honey keeps 1.5%" copy fee is UI text in `thesis-new.tsx`; no server code
   charges it yet. Terms quote it as written.
6. Server logs and optional OTLP trace export may include IP addresses; confirm what
   Cloud Run logging keeps and for how long.
