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

- `/admin/review` — notices flagged by the LLM extractor (`needsReview=true`); approve to publish, delete to reject.
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
