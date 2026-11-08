# Google Cloud setup

Honey runs on Google: Firebase Authentication for sign-in, Cloud SQL for PostgreSQL,
Cloud Run for the API server, Memorystore for Redis and Secret Manager for keys. The
website runs on Vercel. Wallet keys and recovery phrases never leave the user's device;
none of these services ever sees them.

## 1. Firebase Authentication (sign-in)

1. Firebase console → Add project (or add Firebase to the existing Google Cloud project).
2. Authentication → Sign-in method → enable **Google** and **Apple**.
3. Project settings → Your apps → add a **Web app**. Copy its config into
   `apps/mobile/.env`:
   `EXPO_PUBLIC_FIREBASE_API_KEY`, `EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN`,
   `EXPO_PUBLIC_FIREBASE_PROJECT_ID`, `EXPO_PUBLIC_FIREBASE_APP_ID`.
4. Google Cloud console → APIs & Services → Credentials → create OAuth clients:
   - iOS, bundle id `com.honeywallet.app` → `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`
   - Android, package `com.honeywallet.app` plus the signing SHA-1 (debug, EAS and Play)
     → `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`
   - The Web client Firebase created → `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`
5. Apple Developer → the App ID `com.honeywallet.app` → enable **Sign in with Apple**.
6. Server: set `FIREBASE_PROJECT_ID` (the only value it needs; no secret).

### Email sign-in (a one-time link)

1. Authentication → Sign-in method → **Email/Password** → turn on **Email link
   (passwordless sign-in)**.
2. Hosting → Get started (the default site is enough). Firebase serves the iOS and
   Android association files for `<project>.firebaseapp.com` from Hosting.
3. Project settings → Your apps → add an **iOS app** (bundle id `com.honeywallet.app`,
   plus your Apple **Team ID**) and an **Android app** (package `com.honeywallet.app`,
   plus the **SHA-256** fingerprints of the debug, EAS and Play signing keys).
4. Authentication → Settings → Authorized domains: keep `<project>.firebaseapp.com`.
5. Build the app with `EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN` set: the build adds
   `applinks:<auth domain>` (iOS) and an Android app link for `/__/auth/links`, so the
   emailed link opens Honey. The link works once and expires after about an hour.

Emails come from Firebase (`noreply@<project>.firebaseapp.com`); the template is under
Authentication → Templates. A custom sender domain can be added there later.

## 2. Cloud SQL for PostgreSQL (database)

1. Cloud SQL → Create instance → PostgreSQL 16, same region as Cloud Run, private IP.
2. Create database `honey` and user `honey`; store the password in Secret Manager.
3. On Cloud Run, attach the instance (Connections → Cloud SQL) and set
   `DATABASE_URL=postgres://honey:<password>@/honey?host=/cloudsql/<project>:<region>:<instance>`.
4. Keep `DATABASE_MAX_CONNECTIONS` below the instance's connection limit.

## 3. Memorystore (Redis)

Memorystore for Redis → create a Basic instance in the same region and VPC. Give Cloud
Run a Serverless VPC connector (or Direct VPC egress) and set
`REDIS_URL=rediss://<host>:6378` with in-transit encryption on.

## 4. Cloud Run (API server)

CI publishes the image to `ghcr.io/honey-wallet/honey-wallet-server`. Copy it to
Artifact Registry (Cloud Run pulls from there), then deploy with the environment from
`apps/server/.env.example`. Secrets come from Secret Manager, never plain env:
`DATABASE_URL`, `NEAR_AI_API_KEY`, `LINKUP_API_KEY`, `NEAR_INTENTS_API_KEY` (optional).
Point the app's `EXPO_PUBLIC_API_URL` at the service's HTTPS URL.

## 5. Vercel (website)

Import the repository, set the root to `apps/web`, and set `VITE_API_URL` to the Cloud
Run URL.

## 6. App builds (EAS)

The app is linked to EAS project `50cea8fa-f380-421c-8c50-84d29bc0b824`
(`apps/mobile/app.json`). Log in once with `pnpm dlx eas-cli login`, then build from
`apps/mobile` with `pnpm dlx eas-cli build --profile <profile> --platform <ios|android>`.
