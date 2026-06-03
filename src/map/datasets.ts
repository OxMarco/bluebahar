// 'interactive' = features carry user-facing metadata worth a detail sheet
// (description, links, photos, type tags). 'context' = geometry-only overlays
// — render them but don't make them tappable, they'd open empty sheets.
export type DatasetKind = 'interactive' | 'context';
export type DatasetBounds = [number, number, number, number];

// Product-level default extent for the Malta layers currently shipped by the
// app. Individual dataset definitions can override this when we add layers for
// another operating area.
export const DEFAULT_DATASET_BOUNDS: DatasetBounds = [13, 34.5, 16, 37];

// Human-facing credit for the data publisher. Distinct from `sourceUrl`, which
// is the machine endpoint we fetch/re-download from (often an opaque WFS or
// feature-service query). `url` should point at a page a person can read.
export interface DatasetAttribution {
  name: string;
  url?: string;
}

export interface DatasetDefinition {
  key: string;
  name: string;
  kind: DatasetKind;
  bounds?: DatasetBounds;
  // Original source URL — kept for attribution and so a maintainer can
  // re-download the GeoJSON manually when upstream republishes.
  sourceUrl: string;
  // Optional publisher credit surfaced to clients alongside the layer.
  attribution?: DatasetAttribution;
  // When set, DatasetRefreshService re-fetches `sourceUrl` (which must return a
  // GeoJSON FeatureCollection) on this cadence and swaps the in-memory entry.
  // The committed data/datasets/{key}.geojson stays as the boot-time seed and
  // upstream-down fallback. Omit for the hand-refreshed multi-year layers.
  refresh?: 'daily';
  // Extra request headers for the refresh fetch. The ArcGIS `usrsvcs` proxy,
  // for one, 403s every request that doesn't carry a Referer matching its
  // host dashboard — so the header is mandatory, not optional politeness.
  fetchHeaders?: Record<string, string>;
}

// Static catalogue of GeoJSON datasets shipped in data/datasets/{key}.geojson.
// These layers change on a multi-year cadence; refresh them by hand rather than
// scraping (cuts IP-block risk and infrastructure).
export const DATASETS: DatasetDefinition[] = [
  {
    key: 'marine-utility-areas',
    name: 'Marine utility areas',
    kind: 'context',
    sourceUrl:
      'https://haleconnect.com/ows/services/org.1261.ca3351c0-2a54-43ff-87fe-710f9afcf9ef_wfs?REQUEST=GetFeature&SERVICE=WFS&VERSION=2.0.0&TYPENAMES=am%3AManagementRestrictionOrRegulationZone&outputFormat=application%2Fjson',
  },
  {
    key: 'maltese-waters-contour',
    name: 'Maltese waters contour',
    kind: 'context',
    sourceUrl:
      'https://haleconnect.com/ows/services/org.1261.da1e59e6-d134-48bc-8ae9-4d70e0191a4e_wfs?REQUEST=GetFeature&SERVICE=WFS&VERSION=2.0.0&TYPENAMES=am%3AManagementRestrictionOrRegulationZone&outputFormat=application%2Fjson',
  },
  {
    key: 'bathymetric-contours',
    name: 'Bathymetric contours',
    kind: 'context',
    sourceUrl:
      'https://ows.emodnet-bathymetry.eu/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=emodnet%3Acontours&outputFormat=application%2Fjson&bbox=13.669821,35.369532,15.089278,36.499613,EPSG%3A4326',
  },
  {
    key: 'swimming-zones',
    name: 'Swimming zones',
    kind: 'context',
    sourceUrl:
      'https://haleconnect.com/ows/services/org.1261.1cc518e8-38ee-4152-884f-0cc62eea4177_wfs?REQUEST=GetFeature&SERVICE=WFS&VERSION=2.0.0&TYPENAMES=am%3AManagementRestrictionOrRegulationZone&outputFormat=application%2Fjson',
  },
  {
    key: 'conservation-area-around-wrecks',
    name: 'Conservation area around wrecks',
    kind: 'context',
    sourceUrl:
      'https://haleconnect.com/ows/services/org.1261.1ea70633-7954-4a2c-86e5-f639bb2bf3bd_wfs?REQUEST=GetFeature&SERVICE=WFS&VERSION=2.0.0&TYPENAMES=am%3AManagementRestrictionOrRegulationZone&count=1',
  },
  {
    key: 'anchoring-and-mooring-hotspots',
    name: 'Anchoring and Mooring Hotspots',
    kind: 'interactive',
    sourceUrl:
      'https://haleconnect.com/ows/services/org.1261.74389601-d380-460f-a7dd-5e6a26798333_wfs?REQUEST=GetFeature&SERVICE=WFS&VERSION=2.0.0&TYPENAMES=am%3AManagementRestrictionOrRegulationZone&count=1',
  },
  {
    key: 'bunkering-areas',
    name: 'Bunkering areas',
    kind: 'interactive',
    sourceUrl:
      'https://haleconnect.com/ows/services/org.1261.52316317-f1e8-411e-9c1d-6b3aa9f21339_wfs?REQUEST=GetFeature&SERVICE=WFS&VERSION=2.0.0&TYPENAMES=am%3AManagementRestrictionOrRegulationZone&outputFormat=application%2Fjson',
  },
  {
    key: 'harbour-approach-routes',
    name: 'Harbour Approach Routes',
    kind: 'context',
    sourceUrl:
      'https://haleconnect.com/ows/services/org.1261.4796a5e3-19ac-43a7-94a6-e8f9a158ffc8_wfs?REQUEST=GetFeature&SERVICE=WFS&VERSION=2.0.0&TYPENAMES=am%3AManagementRestrictionOrRegulationZone&count=1',
  },
  {
    key: 'diving-sites',
    name: 'Diving Sites',
    kind: 'interactive',
    sourceUrl: 'https://maltadives.com/js/Map/MapDiveSites.php',
  },
  {
    key: 'marine-caves',
    name: 'Marine caves',
    kind: 'interactive',
    sourceUrl:
      'https://haleconnect.com/ows/services/org.1261.253f2b31-c591-41c2-9091-bb5080c9872a_wfs?REQUEST=GetFeature&SERVICE=WFS&VERSION=2.0.0&TYPENAMES=ge%3AMappedFeature&outputFormat=application%2Fgeo%2Bjson',
  },
  {
    // Environmental Health Directorate bathing-water sites (the "EHD Bathing
    // Sites" layer of their public ArcGIS dashboard). Each point carries the
    // bathing-water profile, Blue Flag status and beach characteristics.
    key: 'water-quality',
    name: 'Water quality',
    kind: 'interactive',
    refresh: 'daily',
    sourceUrl:
      'https://utility.arcgis.com/usrsvcs/servers/2ca76f1379594c85bca17d5ff3600721/rest/services/EHD_BathingSites_PublicView_/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson',
    // The proxy 403s without a Referer matching its host dashboard app.
    fetchHeaders: {
      Referer:
        'https://mfh-mt.maps.arcgis.com/apps/dashboards/31f48638f89c4d60bd6143818a46a2c7',
    },
    attribution: {
      name: 'Environmental Health Directorate, Ministry for Health (Malta)',
      url: 'https://environmentalhealth.gov.mt/en/ehs/wrau/bathing-water-profiles/',
    },
  },
];
