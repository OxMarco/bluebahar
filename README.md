# BlueBaħar

Backend for the BlueBaħar marine chart app — it serves restriction zones,
notices-to-mariners and reference layers for Maltese waters.

Built with NestJS 11 (Express) + TypeORM/Postgres + Redis. The map data comes
from two sources:

1. **Community-map import** — a daily job ingests the curated "Malta Ranger
   Unit" Google My Maps and turns its marine restriction polygons into
   `Notice-to-Mariners` rows, served from `/v1/map/notices`.
2. **Static GeoJSON datasets** — committed reference layers (bathymetry,
   contours, beaches, …) served from `/v1/map/datasets`.

## Quick start

```sh
cp .env.example .env        # fill in DB / Redis / OPENAI_API_KEY / admin secrets
make dev                    # docker compose local stack with hot-reload
# or, against your own Postgres/Redis:
npm install
npm run start:dev
```

Common scripts: `npm run build`, `npm run lint`, `npm run typecheck`,
`npm test`, `npm run test:e2e`. Postgres schema is auto-synced from the entities
on boot (`synchronize: true`); for breaking entity changes, wipe the volume
(`docker compose down -v`).

## Map API

All routes are under `/v1` (URI versioning).

- `GET /v1/map/notices` returns `{ items, limit, offset, hasMore }`.
- `GET /v1/map/notices/metrics` returns public/review backlog counts, including
  active notices hidden pending review.
- `POST /v1/map/notices/report/:id` lets the public flag a notice; it increments
  the notice's `reports` counter (10/min/IP).
- `POST /v1/map/reports` accepts a title, description, latitude, and longitude
  for a point-specific user report (5/min/IP). Submissions containing swear
  words are discarded before they reach the admin queue.
- `GET /v1/map/manifest` returns a tiny change-detection token the app polls on
  focus/reconnect to decide whether its cached datasets/notices are stale.
- `GET /v1/map/datasets` lists each layer's `kind`, `geometryTypes`, and `bbox`.
- `GET /v1/map/datasets/:key` serves the GeoJSON. Both dataset routes support
  `If-None-Match` / `304 Not Modified` via a SHA-256 ETag (`no-cache`
  revalidation, so a changed layer is never served stale).

Health: `/v1/health/live` (liveness), `/v1/health/ready` (DB, Redis, dataset
catalog, disk), `/v1/health/diagnostics` (adds heap/RSS and an upstream
My-Maps ping).

## Community-map import

The "Malta Ranger Unit" Google My Map (`COMMUNITY_MAP_MID`, with a built-in
default id) is hand-curated and is **authoritative for the geometry and
classification** of marine restriction zones. The daily import
(`src/map/community-map/`):

1. Fetches the map KML and parses its `<Folder>` layers (`kml-source.ts`).
2. Keeps only the marine restriction layers and discards terrestrial layers and
   per-vertex point markers (`layers.config.ts`, `sea-filter.ts`).
3. Extracts factual rules (validity window, clearance distance, governing
   notice ref) from each placemark (`validity.ts`) — never its prose.
4. Rewrites each zone's description with the LLM from those facts plus a
   per-class brief (`map-zone-enrich.ts`); the source prose is **never stored**.
5. Upserts the zones as `community-map` notices (`unique(source, subKey)` dedups
   re-imports). Zones whose enrichment fails are flagged `needsReview`.

The import runs on boot and daily at 04:00 via BullMQ. Daily job IDs prevent
duplicate work across replicas; failed imports retry three times with
exponential backoff. Set `COMMUNITY_MAP_IMPORT_ENABLED=false` to disable it.

> An `OPENAI_API_KEY` is **required** — there is no key-free import path. The
> model is `ENRICH_MODEL` → `OPENAI_MODEL` → `gpt-5.5` (first set wins).

## Admin panel

Browser-only. Visit `/admin/login` and enter the `ADMIN_API_KEY` value; on
success the server mints a JWT signed with `ADMIN_JWT_SECRET` and stores it in an
httpOnly, `SameSite=Strict` cookie scoped to `/admin`. Cookie lifetime is
`ADMIN_SESSION_TTL_SECONDS` (default 3600).

- `/admin/review` — notices flagged for review (`needsReview=true`); approve to
  publish, delete to reject.
- `/admin/flagged?minReports=` — notices with at least `minReports` user reports
  (default 1); dismiss to reset the counter, delete to remove.
- `/admin/reports` — point-specific user reports submitted from the map; resolve
  to archive, delete to remove.
- `/admin/logs?logType=` — ingestion log entries, newest first. Logs older than
  14 days are pruned daily by a midnight cron.
- `/admin/new` — manually create a notice (skips the review queue). Geometries
  (`areas`) aren't editable from the form yet.

The admin views are Handlebars (`views/`) styled with Tailwind. Rebuild the CSS
with `npm run build:admin-css` (or `:watch`); `npm run build` does it for you.

## Static dataset maintenance

The committed `data/datasets/{key}.geojson` layers are the boot-time seed (and
upstream-down fallback). Most change on a multi-year cadence and are refreshed by
hand; a few (e.g. beaches) are re-fetched daily in memory by
`DatasetRefreshService`.

Dry-run a refresh report:

```sh
npm run datasets:refresh
```

Refresh one layer and write the committed GeoJSON:

```sh
npm run datasets:refresh -- --dataset=diving-sites --write
```

The script validates GeoJSON shape and Malta-area bounds before writing.
Committed datasets are also validated strictly at boot: invalid GeoJSON marks
that layer unavailable and makes the catalog health check report down.

## Runtime knobs

- `MAP_CACHE_TTL_MS`: TTL (ms) for cached map reads (metrics, manifest), default
  `30000`.
- `THROTTLE_TTL_MS`: global public API throttle window in ms, default `60000`.
- `THROTTLE_LIMIT`: global public API requests per window, default `120`.

Anonymous writes have tighter per-route budgets (notice flags 10/min/IP,
free-form reports 5/min/IP).

## Error monitoring (Sentry)

`src/instrument.ts` initialises `@sentry/nestjs` before any other module loads
(imported on line 1 of `main.ts`). It's a no-op when `SENTRY_DSN` is unset, so
dev/test need no config. Capture is automatic:

- HTTP, `@Cron`, BullMQ processors, and event handlers are auto-instrumented
  by `@sentry/nestjs` — thrown errors in any of them are captured.
- Deliberate `>=500` `HttpException`s are reported by `ApiExceptionFilter`
  (it runs before `SentryGlobalFilter`; see the note in `app.module.ts`).

Set `SENTRY_TRACES_SAMPLE_RATE` / `SENTRY_PROFILES_SAMPLE_RATE` to tune sampling
(default `0.1`). Set `NODE_ENV=production` in prod so events land in the right
environment bucket.

### Source maps

Prod runs compiled `dist/*.js`, so stack traces need uploaded source maps to be
readable. After `npm run build`, run (in CI, with the release pinned to the
deploy's git SHA):

```bash
export SENTRY_RELEASE="$(git rev-parse HEAD)"   # same value Sentry.init reads
export SENTRY_AUTH_TOKEN="sntrys_…"             # org token; routes to EU region
npm run sentry:sourcemaps                        # inject debug IDs + upload
```

Org/project are in `.sentryclirc`. `SENTRY_RELEASE` MUST be identical at runtime
and at upload time or frames stay minified.

## Deployment

`make deploy` pulls, rebuilds the app image, recreates changed services
(`docker-compose.prod.yaml`) and runs the liveness smoke check. See `make help`
for the full task list (`logs`, `psql`, `redis-cli`, `sh`, `health`, …).
