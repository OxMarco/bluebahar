# BlueBaħar

Backend to scrape data about Maltese waters.

## Map API notes

- `GET /v1/map/notices` returns `{ items, limit, offset, hasMore }`.
- `GET /v1/map/notices/metrics` returns public/review backlog counts, including active notices hidden pending review.
- `POST /v1/map/notices/report/:id` lets the public flag a notice; it increments the notice's `reports` counter.
- `GET /v1/map/datasets` includes each layer's `kind`, `geometryTypes`, and `bbox`.
- `GET /v1/map/datasets/:key` supports `If-None-Match` / `304 Not Modified` via the dataset SHA-256 ETag.

## Admin panel

Browser-only. Visit `/admin/login` and enter the `ADMIN_API_KEY` value; on success the server mints a JWT signed with `ADMIN_JWT_SECRET` and stores it in an httpOnly, `SameSite=Strict` cookie scoped to `/admin`. Cookie lifetime is `ADMIN_SESSION_TTL_SECONDS` (default 3600).

- `/admin/review` — notices flagged for review (`needsReview=true`), either by deterministic extraction sanity checks or by the AI-vision cross-check that compares extracted geometry against the notice's own chart pages (`VISION_VERIFY`, see `.env.example`); approve to publish, delete to reject.
- `/admin/flagged?minReports=` — notices with at least `minReports` user reports (default 1); dismiss to reset the counter, delete to remove.
- `/admin/logs?logType=` — scraping/ingestion log entries, newest first. Logs older than 14 days are pruned daily by a midnight cron.
- `/admin/new` — manually create a notice (skips the review queue). Geometries (`areas`) aren't editable from the form yet.

## Dataset maintenance

Dry-run a refresh report:

```sh
npm run datasets:refresh
```

Refresh one layer and write the committed GeoJSON:

```sh
npm run datasets:refresh -- --dataset=diving-sites --write
```

The refresh script validates GeoJSON shape and Malta-area bounds before writing.
Committed datasets are also validated strictly at boot. Invalid GeoJSON marks
that layer unavailable and makes catalog health report down; features are only
dropped during interactive property normalization when an adapter cannot produce
a usable title.

## Runtime knobs

- `THROTTLE_TTL_MS`: global public API throttle window in milliseconds, default `60000`.
- `THROTTLE_LIMIT`: global public API requests per throttle window, default `120`.

## Error monitoring (Sentry)

`src/instrument.ts` initialises `@sentry/nestjs` before any other module loads
(imported on line 1 of `main.ts`). It's a no-op when `SENTRY_DSN` is unset, so
dev/test need no config. Capture is automatic:

- HTTP, `@Cron`, BullMQ `@Processor`, and event handlers are auto-instrumented
  by `@sentry/nestjs` — thrown errors in any of them are captured.
- Deliberate `>=500` `HttpException`s are reported by `ApiExceptionFilter`
  (it runs before `SentryGlobalFilter`; see the note in `app.module.ts`).
- The scraper `captureMessage`s notices flagged for manual review (warning).

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
