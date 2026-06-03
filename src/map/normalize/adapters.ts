import type {
  NormalizedFeatureProperties,
  NormalizedLink,
} from './normalized-feature';

// Upstream property bag is untyped JSON. Adapters narrow what they need.
type RawProperties = Record<string, unknown>;
// `id` is assigned by the catalog after adapter run (it needs cross-feature
// dedup), so adapters only produce the rest of the shape.
type NormalizedFeatureDraft = Omit<NormalizedFeatureProperties, 'id'>;

export type FeatureAdapter = (
  raw: RawProperties,
) => NormalizedFeatureDraft | null;

// Returns null to drop the feature entirely (no usable title). The catalog
// will filter these out.
export const ADAPTERS: Record<string, FeatureAdapter> = {
  'diving-sites': adaptDivingSite,
  'marine-caves': adaptMarineCave,
  'anchoring-and-mooring-hotspots': adaptAnchoringHotspot,
  'bunkering-areas': adaptBunkeringArea,
  'water-quality': adaptWaterQualitySite,
};

function adaptDivingSite(raw: RawProperties): NormalizedFeatureDraft | null {
  const siteName = str(raw.siteName);
  const location = str(raw.location);
  const text = str(raw.text);
  const title = siteName ?? location ?? text;
  if (!title) return null;

  const siteType = str(raw.siteType);
  const subtitle = siteType === 'location' ? 'Dive location' : 'Dive site';

  const hasDescription =
    raw.hasDescription === 'true' || raw.hasDescription === true;
  const description = hasDescription ? str(raw.shortDescription) : undefined;

  const interest = str(raw.interest);
  // Upstream encodes multi-interest as "Cave & Reef & Wall"; "N/A" means none.
  const tags =
    interest && interest.toUpperCase() !== 'N/A'
      ? compactTags(interest.split('&').map((s) => s.trim()))
      : undefined;

  const details = compactDetails([
    depthDetail(raw),
    labelDetail('Shore access', str(raw.shoreAccess)),
    labelDetail('Level', str(raw.qualification)),
    labelDetail('Popularity', str(raw.popularity)),
  ]);

  const youtubeIds = parseYoutube(str(raw.youtube));
  const media = youtubeIds.length > 0 ? { youtubeIds } : undefined;

  const links = parseLinks(str(raw.links));

  const rating = parseRating(raw.rating, raw.ratings);

  const identifier = str(raw.identifier);
  const sourceUrl =
    identifier && /^https?:\/\//i.test(identifier) ? identifier : undefined;
  const sourceId = str(raw.localId) ?? str(raw.sourcePath);

  return {
    title,
    subtitle,
    description,
    tags,
    details,
    media,
    links: links.length > 0 ? links : undefined,
    rating,
    sourceId,
    sourceUrl,
  };
}

function adaptMarineCave(raw: RawProperties): NormalizedFeatureDraft | null {
  const localId = str(raw.localId);
  const name = displayName(raw.name);
  const title = name ?? (localId ? `Marine cave ${localId}` : undefined);
  if (!title) return null;

  const description = str(raw.description);
  const island = extractIsland(description);

  const geomorphType = str(raw.naturalGeomorphologicFeatureType);
  // Upstream values like "erosional" / "constructional" — capitalize for display.
  const tags = compactTags([
    island,
    geomorphType ? capitalize(geomorphType) : undefined,
  ]);
  const mappingFrame = str(raw.mappingFrame);
  const details = compactDetails([
    labelDetail(
      'Mapping frame',
      mappingFrame ? startCase(mappingFrame) : undefined,
    ),
  ]);

  return {
    title,
    subtitle: 'Marine cave',
    description,
    tags,
    details,
    sourceId: localId,
    sourceUrl: sourceUrl(raw.identifier),
  };
}

function adaptAnchoringHotspot(
  raw: RawProperties,
): NormalizedFeatureDraft | null {
  const placeName = str(raw.text);
  if (!placeName) return null;

  const description = str(raw.description) ?? undefined;
  const descriptionParts = splitDescription(description);
  const authority = str(raw.CharacterString);
  const details = compactDetails([
    labelDetail('Authority', authority),
    labelDetail('Published', dateOnly(str(raw.beginLifespanVersion))),
  ]);

  return {
    title: placeName,
    subtitle: descriptionParts?.kind ?? 'Anchoring & mooring hotspot',
    description,
    tags: compactTags([descriptionParts?.period]),
    details,
    sourceId: str(raw.localId) ?? str(raw.gml_id),
    sourceUrl: sourceUrl(raw.identifier),
  };
}

function adaptBunkeringArea(raw: RawProperties): NormalizedFeatureDraft | null {
  const localId = str(raw.localId);
  const displayName = str(raw.name);
  const displayNumber = displayName
    ? /\barea\s*(\d+)\b/i.exec(displayName)?.[1]
    : null;
  // localId is "bunkeringArea_3"; pull the trailing number as a fallback only.
  const localNumber = localId ? /(\d+)$/.exec(localId)?.[1] : null;
  const number = displayNumber ?? localNumber;
  const title = number ? `Bunkering area ${number}` : 'Bunkering area';

  return {
    title,
    subtitle: 'Offshore bunkering',
    description: str(raw.description) ?? undefined,
    details: compactDetails([
      labelDetail('Published', dateOnly(str(raw.beginLifespanVersion))),
    ]),
    sourceId: localId ?? str(raw.gml_id),
    sourceUrl: sourceUrl(raw.identifier),
  };
}

// Environmental Health Directorate bathing-water sites. Field names come
// straight off the ArcGIS feature layer (Name_ENG, Blue_Flag_OR_Beach_of_Quality,
// Bathing_Water_Profile, …) — see data/datasets/water-quality.geojson.
function adaptWaterQualitySite(
  raw: RawProperties,
): NormalizedFeatureDraft | null {
  const englishName = str(raw.Name_ENG);
  const malteseName = str(raw.Name_MT);
  const siteCode = str(raw.Site_Code);
  const title =
    englishName ??
    malteseName ??
    (siteCode ? `Bathing site ${siteCode}` : undefined);
  if (!title) return null;

  const beachType = beachTypeLabel(str(raw.Sandy_OR_Rocky_Beach));
  const blueFlag = yesNo(raw.Blue_Flag_OR_Beach_of_Quality);
  const petFriendly = yesNo(raw.Pet_Friendly);
  const recommended = yesNo(raw.RecommendedForBathing_YES_OR_NO);

  const tags = compactTags([
    beachType,
    blueFlag === true ? 'Blue Flag / Beach of Quality' : undefined,
    petFriendly === true ? 'Pet friendly' : undefined,
    recommended === false ? 'Not recommended for bathing' : undefined,
  ]);

  // Show the Maltese name only when it actually differs from the title we're
  // already displaying, so most sheets don't repeat the heading.
  const malteseDetail =
    malteseName && malteseName.toLowerCase() !== title.toLowerCase()
      ? malteseName
      : undefined;

  const details = compactDetails([
    labelDetail('Locality', str(raw.Local_Council)),
    labelDetail('Maltese name', malteseDetail),
    labelDetail(
      'Recommended for bathing',
      yesNoLabel(raw.RecommendedForBathing_YES_OR_NO),
    ),
    labelDetail(
      'Blue Flag / Beach of Quality',
      yesNoLabel(raw.Blue_Flag_OR_Beach_of_Quality),
    ),
    labelDetail('Beach type', beachType),
    labelDetail('Pet friendly', yesNoLabel(raw.Pet_Friendly)),
    labelDetail(
      'Public convenience',
      publicConvenienceLabel(str(raw.Pubic_convenience)),
    ),
  ]);

  const profile = sourceUrl(raw.Bathing_Water_Profile);

  return {
    title,
    subtitle: 'Bathing water site',
    description: str(raw.Description),
    tags,
    details,
    links: profile
      ? [{ url: profile, label: 'Bathing water profile' }]
      : undefined,
    sourceId: siteCode ?? str(raw.GlobalID),
    sourceUrl: profile,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function displayName(v: unknown): string | undefined {
  const value = str(v);
  if (!value) return undefined;
  return value === '(Name not available)' ? undefined : value;
}

function sourceUrl(v: unknown): string | undefined {
  const value = str(v);
  return value && /^https?:\/\//i.test(value) ? value : undefined;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Upstream encodes booleans as "Yes"/"No" strings. Returns undefined for
// anything else (blank, "N/A") so callers can drop the field entirely.
function yesNo(v: unknown): boolean | undefined {
  const value = str(v)?.toLowerCase();
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return undefined;
}

function yesNoLabel(v: unknown): string | undefined {
  const flag = yesNo(v);
  return flag === undefined ? undefined : flag ? 'Yes' : 'No';
}

// Beach-type values arrive with inconsistent casing ("Rocky Beach" vs
// "Rocky beach") and a literal "NA" for unknown. Normalise casing so the tag
// set dedupes, and drop the placeholder.
function beachTypeLabel(v: unknown): string | undefined {
  const value = str(v);
  if (!value || /^n\/?a$/i.test(value)) return undefined;
  const lower = value.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// "Pubic_convenience" (sic) is either "N/A" or a free-text "Situated <coords>".
// The coordinates aren't useful in a detail row — collapse to a plain flag.
function publicConvenienceLabel(v: unknown): string | undefined {
  const value = str(v);
  if (!value || /^n\/?a$/i.test(value)) return undefined;
  return 'Available nearby';
}

function startCase(s: string): string {
  const spaced = s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function labelDetail(label: string, value: string | undefined) {
  return value ? { label, value } : null;
}

function compactDetails(
  details: ({ label: string; value: string } | null)[],
): { label: string; value: string }[] | undefined {
  const filtered = details.filter(
    (d): d is { label: string; value: string } => d !== null,
  );
  return filtered.length > 0 ? filtered : undefined;
}

function compactTags(tags: (string | undefined)[]): string[] | undefined {
  const seen = new Set<string>();
  const filtered = tags.filter((tag): tag is string => {
    if (!tag) return false;
    const key = tag.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return filtered.length > 0 ? filtered : undefined;
}

function splitDescription(
  description: string | undefined,
): { kind: string; period?: string } | undefined {
  if (!description) return undefined;
  const [kind, period] = description
    .split(/\s+-\s+/, 2)
    .map((part) => part.trim());
  return kind ? { kind, period: period || undefined } : undefined;
}

function dateOnly(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
}

function extractIsland(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const match = /\b(Gozo|Malta|Comino)\b/i.exec(description);
  return match ? capitalize(match[1].toLowerCase()) : undefined;
}

function depthDetail(
  raw: RawProperties,
): { label: string; value: string } | null {
  const avg = parseNumeric(raw.depthAverageMeters);
  const max = parseNumeric(raw.depthMaxMeters);
  const avgIsMin =
    raw.depthAverageIsMinimum === 'true' || raw.depthAverageIsMinimum === true;
  const maxIsMin =
    raw.depthMaxIsMinimum === 'true' || raw.depthMaxIsMinimum === true;

  if (avg != null && max != null && avg !== max) {
    const suffix = maxIsMin ? '+' : '';
    return { label: 'Depth', value: `${avg}–${max}${suffix} m` };
  }
  if (max != null) {
    return { label: 'Depth', value: `${max}${maxIsMin ? '+' : ''} m` };
  }
  if (avg != null) {
    return { label: 'Depth', value: `${avg}${avgIsMin ? '+' : ''} m` };
  }
  return null;
}

// Upstream youtube field is "ID,start,end" — we only need the ID; start/end
// are seconds and the client doesn't deep-link timestamps today.
function parseYoutube(raw: string | undefined): string[] {
  if (!raw) return [];
  // Tolerate space-separated lists in case upstream ever changes shape.
  return raw
    .split(/\s+/)
    .map((entry) => entry.split(',')[0]?.trim())
    .filter(
      (id): id is string => Boolean(id) && /^[A-Za-z0-9_-]{6,}$/.test(id),
    );
}

// Links field is space-separated URLs; each may carry a "|Label" suffix.
function parseLinks(raw: string | undefined): NormalizedLink[] {
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const pipeIndex = entry.indexOf('|');
      if (pipeIndex === -1) return { url: entry };
      const url = entry.slice(0, pipeIndex);
      const label = entry.slice(pipeIndex + 1).trim();
      return label ? { url, label } : { url };
    })
    .filter((link) => /^https?:\/\//i.test(link.url));
}

function parseRating(rawValue: unknown, rawCount: unknown) {
  const value = parseNumeric(rawValue);
  const count = parseNumeric(rawCount);
  if (value == null || count == null || value <= 0 || count <= 0)
    return undefined;
  return { value, count: Math.round(count) };
}

function parseNumeric(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
