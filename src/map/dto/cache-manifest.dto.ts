// Lightweight change-detection payload the app polls on focus/reconnect. Each
// `rev` is an opaque token that moves when the corresponding resource changes;
// the client compares it to the last value it saw and invalidates only the
// affected query, instead of speculatively re-fetching large GeoJSON layers or
// the full notice list on every foreground.
export class DatasetsManifestDto {
  rev!: string;
}

export class NoticesManifestDto {
  rev!: string;
  // The soonest activeTo among currently-active public notices, or null when
  // none expire. The app uses it to schedule a client-side drop of lapsed
  // notices without contacting the server (expiry is deterministic).
  nextExpiryAt!: string | null;
}

export class CacheManifestDto {
  datasets!: DatasetsManifestDto;
  notices!: NoticesManifestDto;
}
