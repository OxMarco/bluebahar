export interface DatasetDefinition {
  key: string;
  name: string;
  // Original WFS source URL — kept for attribution and so a maintainer can
  // re-download the GeoJSON manually when upstream republishes.
  sourceUrl: string;
}

// Static catalogue of GeoJSON datasets shipped in data/datasets/{key}.geojson.
// These layers change on a multi-year cadence; refresh them by hand rather than
// scraping (cuts IP-block risk and infrastructure).
export const DATASETS: DatasetDefinition[] = [
  {
    key: 'marine-facilities',
    name: 'Marine facilities',
    sourceUrl:
      'https://haleconnect.com/ows/services/org.1261.ca3351c0-2a54-43ff-87fe-710f9afcf9ef_wfs?REQUEST=GetFeature&SERVICE=WFS&VERSION=2.0.0&TYPENAMES=am%3AManagementRestrictionOrRegulationZone',
  },
  {
    key: 'fisheries-management-zone',
    name: 'Fisheries Management Zone',
    sourceUrl:
      'https://haleconnect.com/ows/services/org.1261.4c7fe626-297d-41b3-81f9-d38f50a23d25_wfs?REQUEST=GetFeature&SERVICE=WFS&VERSION=2.0.0&TYPENAMES=am%3AManagementRestrictionOrRegulationZone&count=1',
  },
  {
    key: 'coastal-marine-infrastructure',
    name: 'Coastal and Marine Infrastructure',
    sourceUrl:
      'https://haleconnect.com/ows/services/org.1261.1cc518e8-38ee-4152-884f-0cc62eea4177_wfs?REQUEST=GetFeature&SERVICE=WFS&VERSION=2.0.0&TYPENAMES=am%3AManagementRestrictionOrRegulationZone&count=1',
  },
  {
    key: 'conservation-area-around-wrecks',
    name: 'Conservation area around wrecks',
    sourceUrl:
      'https://haleconnect.com/ows/services/org.1261.1ea70633-7954-4a2c-86e5-f639bb2bf3bd_wfs?REQUEST=GetFeature&SERVICE=WFS&VERSION=2.0.0&TYPENAMES=am%3AManagementRestrictionOrRegulationZone&count=1',
  },
  {
    key: 'anchoring-and-mooring-hotspots',
    name: 'Anchoring and Mooring Hotspots',
    sourceUrl:
      'https://haleconnect.com/ows/services/org.1261.74389601-d380-460f-a7dd-5e6a26798333_wfs?REQUEST=GetFeature&SERVICE=WFS&VERSION=2.0.0&TYPENAMES=am%3AManagementRestrictionOrRegulationZone&count=1',
  },
  {
    key: 'harbour-approach-routes',
    name: 'Harbour Approach Routes',
    sourceUrl:
      'https://haleconnect.com/ows/services/org.1261.4796a5e3-19ac-43a7-94a6-e8f9a158ffc8_wfs?REQUEST=GetFeature&SERVICE=WFS&VERSION=2.0.0&TYPENAMES=am%3AManagementRestrictionOrRegulationZone&count=1',
  },
  {
    key: 'natura-2000-sites',
    name: 'Natura 2000 Sites',
    sourceUrl:
      'https://haleconnect.com/ows/services/org.1261.47b1eb61-a89a-4ee0-a4e4-6e0123f8601b_wfs?REQUEST=GetFeature&SERVICE=WFS&VERSION=2.0.0&TYPENAMES=ps%3AProtectedSite&count=1',
  },
];
