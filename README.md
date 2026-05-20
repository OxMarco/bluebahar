# BlueBaħar

Backend to scrape data about Maltese waters.

## Map API notes

- `GET /v1/map/notices` returns `{ items, limit, offset, hasMore }`.
- `GET /v1/map/notices/metrics` returns public/review backlog counts, including active notices hidden pending review.
- `POST /v1/map/notices/report/:id` lets the public flag a notice; it increments the notice's `reports` counter.
- `GET /v1/map/datasets` includes each layer's `kind`, `geometryTypes`, and `bbox`.
- `GET /v1/map/datasets/:key` supports `If-None-Match` / `304 Not Modified` via the dataset SHA-256 ETag.

## Admin API notes

All `/v1/admin` routes require a shared secret on the `X-Admin-Api-Key` header matching the `ADMIN_API_KEY` env var (min 32 chars); requests without a valid key get `401 Unauthorized`. The key is compared in constant time.

- `GET /v1/admin/notices/review` returns notices in the geo-sanity review queue (`{ items, limit, offset, hasMore }`).
- `GET /v1/admin/notices/flagged?minReports=` returns notices with at least `minReports` user reports (default 1).
- `GET /v1/admin/logs?logType=&since=` returns audit logs, newest first, optionally filtered by type and ISO `since` date. Logs older than 14 days are pruned daily by a midnight cron.
- `POST /v1/admin/notices` manually creates a notice (skips the review queue).
- `POST /v1/admin/notices/:id/approve` clears the review flag; `POST /v1/admin/notices/:id/dismiss-reports` resets the report counter; `DELETE /v1/admin/notices/:id` removes a notice.

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
