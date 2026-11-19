# DayPact

A Kazakh/Russian PWA for daily plans, shared commitments with friends, reminders and an offline Astana map. The interface follows the approved charcoal/blue DayPact design with local Roboto fonts and the approved logo.

**Live app:** [daypact.vertex-blip.workers.dev](https://daypact.vertex-blip.workers.dev). Cloudflare Free and Firebase Spark are configured. The release passed 95 automated tests and 58 checks against the deployed API using real Firebase identities. See the [release verification record](docs/RELEASE.md) for browser checks and remaining physical-device checks. This is not an independent security audit.

## Product

- Email/password registration, email verification, password reset, profile and account deletion.
- Personal/shared daily, weekly, monthly and one-time plans; completion, savings contributions and event attendance.
- Private friend invitations, per-member permissions, reminders, quiet hours and friend nudges.
- Kazakh/Russian settings and dark/light/system themes.
- Offline snapshots and queued changes scoped to the signed-in account, with explicit sync status.
- A ready Protomaps/OpenStreetMap basemap, optional 3D buildings, location picker, local place search and an integrity-checked Astana offline package: approximately **12.9 MB** for map resources, plus the app shell.
- Data export and removal of local private data on logout. No ads, analytics trackers or AI features.

## Architecture

```text
React PWA ── Firebase Auth (identity only)
    │
    ├── /api/* ── Cloudflare Worker ── D1 (plans, friends, settings)
    │                       └── Cron ── Firebase Cloud Messaging
    └── Static Assets ── PMTiles + local glyphs/sprites/POI index
```

TypeScript runs in the browser and Cloudflare Workers. A Java server would require a separate JVM host; it is not introduced merely to add another language. Map data is a ready Protomaps extract of OpenStreetMap, not copied 2GIS content.

## Development

Use the Node version in `.nvmrc` (24.22.3) and the committed npm lockfile.

```sh
npm ci
npm run check
npm run verify:maps
```

For a connected local app, populate `.env.local` and `.dev.vars` using the example files and a Firebase web app. Add the local hostname to Firebase Auth's authorized domains. There is no production authentication bypass or demo account.

```sh
npm run db:migrate:local
npm run dev:api
# In a second terminal:
npm run dev
```

Unit/integration tests run without cloud credentials. API tests use real local D1/SQLite with a test-only injected identity function; authentication tests verify signed JWTs separately. Browser QA harnesses, where provided, run with isolated fixtures and are excluded from the production build.

## Release and limits

Read [deployment setup](docs/DEPLOYMENT.md), [security model](docs/SECURITY.md), [API contract](docs/API.md) and [map provenance/offline behavior](docs/MAPS.md).

`npm run deploy` rejects missing production settings before it builds or publishes. GitHub CI checks types, tests, production build, map integrity and vulnerable dependencies. CI deliberately does not deploy using account-wide credentials.

The selected free services have hard quotas. Push delivery needs internet, permission and a supported installed PWA on iOS; it is not an exact alarm or a guaranteed background task. Offline changes synchronize when the app is open again with a connection. Browser eviction can remove local data. No background route tracking, SMS login, bank transfers or real money custody is implemented.

## Licenses

Application code and brand assets remain the repository owner's work; this repository does not grant a blanket open-source license to them. Third-party code, fonts, icons and map data retain their respective licenses. See `public/fonts/Roboto-OFL.txt`, `public/map-assets/licenses/` and [map attribution](docs/MAPS.md#attribution-and-licenses). Keep OpenStreetMap/Protomaps attribution visible.
