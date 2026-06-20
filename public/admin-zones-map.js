(function () {
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function readJson(id) {
    const node = document.getElementById(id);
    if (!node || !node.textContent) {
      console.warn('[admin-zones-map] no/empty data node for', id);
      return null;
    }
    try {
      return JSON.parse(node.textContent);
    } catch (err) {
      console.warn('[admin-zones-map] JSON parse failed', err);
      return null;
    }
  }

  var COMMUNITY = '#0e7490';
  var OTHER = '#152051';
  var REVIEW = '#b45309';

  function colorFor(props) {
    if (!props) return OTHER;
    if (props.needsReview) return REVIEW;
    return props.community ? COMMUNITY : OTHER;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[c];
    });
  }

  function formatDate(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  function popupHtml(props) {
    if (!props) return '';
    var from = formatDate(props.activeFrom);
    var to = formatDate(props.activeTo);
    var when = from
      ? 'Active ' + from + (to ? ' → ' + to : ' → no expiry')
      : '';
    var source = props.source
      ? props.community
        ? 'Community map'
        : '<a href="' +
          escapeHtml(props.source) +
          '" target="_blank" rel="noopener">source</a>'
      : '';
    return (
      '<div style="min-width:180px">' +
      '<strong>' +
      escapeHtml(props.title) +
      '</strong><br/>' +
      '<span style="text-transform:uppercase;font-size:11px;letter-spacing:.05em">' +
      escapeHtml(props.kind) +
      '</span>' +
      (props.needsReview
        ? ' <span style="color:' + REVIEW + '">· needs review</span>'
        : '') +
      (when ? '<br/><span style="font-size:12px">' + when + '</span>' : '') +
      (source ? '<br/><span style="font-size:12px">' + source + '</span>' : '') +
      '</div>'
    );
  }

  // Leaflet loads from a CDN; cap the wait (~5s) so an outage surfaces a hint.
  var attempts = 0;

  function start() {
    if (typeof L === 'undefined') {
      attempts += 1;
      if (attempts > 100) {
        var el = document.getElementById('zones-map');
        if (el) el.textContent = 'Map unavailable: Leaflet failed to load.';
        return;
      }
      window.setTimeout(start, 50);
      return;
    }

    var mapEl = document.getElementById('zones-map');
    if (!mapEl) return;
    var fc = readJson('zones-data');

    var map = L.map(mapEl, { scrollWheelZoom: true }).setView([35.9, 14.45], 10);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    if (!fc || !Array.isArray(fc.features) || fc.features.length === 0) return;

    var layer = L.geoJSON(fc, {
      style: function (feature) {
        var c = colorFor(feature && feature.properties);
        return { color: c, weight: 2, fillColor: c, fillOpacity: 0.18 };
      },
      pointToLayer: function (feature, latlng) {
        var c = colorFor(feature && feature.properties);
        return L.circleMarker(latlng, {
          radius: 6,
          color: c,
          weight: 2,
          fillColor: c,
          fillOpacity: 0.5,
        });
      },
      onEachFeature: function (feature, lyr) {
        lyr.bindPopup(popupHtml(feature && feature.properties));
      },
    }).addTo(map);

    var bounds = layer.getBounds();
    if (bounds && bounds.isValid && bounds.isValid()) {
      map.fitBounds(bounds, { padding: [24, 24] });
    }

    // Leaflet sometimes mis-measures a just-laid-out container.
    window.setTimeout(function () {
      map.invalidateSize();
    }, 100);
  }

  ready(start);
})();
