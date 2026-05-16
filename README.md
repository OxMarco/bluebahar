# BlueBahar

Backend to scrape data about Maltese waters.

## Map API notes

- `GET /v1/map/notices` and `GET /v1/map/notices/review` return `{ items, limit, offset, hasMore }`.
- `GET /v1/map/notices/metrics` returns public/review backlog counts, including active notices hidden pending review.
- `GET /v1/map/datasets` includes each layer's `kind`, `geometryTypes`, and `bbox`.
- `GET /v1/map/datasets/:key` supports `If-None-Match` / `304 Not Modified` via the dataset SHA-256 ETag.

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

- `CACHE_TTL`: in-memory cache TTL in milliseconds.
- `THROTTLE_TTL_MS`: global public API throttle window in milliseconds, default `60000`.
- `THROTTLE_LIMIT`: global public API requests per throttle window, default `120`.
