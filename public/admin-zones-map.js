(function () {
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function readJson(id) {
    var node = document.getElementById(id);
    if (!node || !node.textContent) return null;
    try {
      return JSON.parse(node.textContent);
    } catch (err) {
      console.warn('[admin-zones-map] JSON parse failed', err);
      return null;
    }
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

  // Notice colours (kept in sync with the toggle swatches in zones.hbs).
  var NOTICE_COLORS = {
    notices: '#152051',
    review: '#b45309',
  };
  // Distinct hues for the reference datasets, assigned by catalogue order.
  var DATASET_PALETTE = [
    '#2563eb',
    '#7c3aed',
    '#db2777',
    '#ea580c',
    '#0d9488',
    '#65a30d',
    '#9333ea',
    '#c026d3',
  ];

  // One "label: value" row; skipped entirely when the value is empty so the
  // popup only lists fields the notice actually carries.
  function popupRow(label, value) {
    if (value == null || value === '') return '';
    return (
      '<div class="map-popup-row">' +
      '<span class="map-popup-label">' +
      escapeHtml(label) +
      '</span>' +
      '<span class="map-popup-value">' +
      value +
      '</span>' +
      '</div>'
    );
  }

  function noticePopup(props) {
    if (!props) return '';

    var from = formatDate(props.activeFrom);
    var to = formatDate(props.activeTo);
    var when = from ? from + (to ? ' → ' + to : ' → no expiry') : '';

    // Provenance: community-map rows just say so; anything else links to its
    // authoritative source when one was recorded.
    var source = props.community
      ? 'Community map'
      : props.sourceUrl
        ? '<a href="' +
          escapeHtml(props.sourceUrl) +
          '" target="_blank" rel="noopener">' +
          escapeHtml(props.source || 'source') +
          '</a>'
        : escapeHtml(props.source || '');

    var reviewReasons =
      props.reviewReasons && props.reviewReasons.length
        ? escapeHtml(props.reviewReasons.join(', '))
        : '';

    var rows =
      popupRow('Kind', escapeHtml(props.kind)) +
      popupRow('Category', escapeHtml(props.category)) +
      popupRow('Location', escapeHtml(props.locationLabel)) +
      popupRow(
        'Description',
        props.description
          ? '<span class="map-popup-desc">' +
              escapeHtml(props.description) +
              '</span>'
          : '',
      ) +
      popupRow('Active', when ? escapeHtml(when) : '') +
      popupRow('Notice ref', escapeHtml(props.noticeRef)) +
      popupRow(
        'Distance',
        typeof props.distance === 'number'
          ? escapeHtml(props.distance + ' m')
          : '',
      ) +
      popupRow('Source', source) +
      popupRow('Reports', props.reports ? escapeHtml(props.reports) : '') +
      popupRow(
        'Needs review',
        props.needsReview
          ? '<span class="map-popup-review">yes</span>' +
              (reviewReasons ? ' (' + reviewReasons + ')' : '')
          : '',
      ) +
      popupRow('Published', escapeHtml(formatDate(props.publishedAt))) +
      popupRow('Added', escapeHtml(formatDate(props.createdAt))) +
      popupRow('Updated', escapeHtml(formatDate(props.updatedAt))) +
      popupRow('ID', escapeHtml(props.noticeId));

    return (
      '<div class="map-popup">' +
      '<div class="map-popup-title">' +
      escapeHtml(props.title) +
      '</div>' +
      rows +
      '</div>'
    );
  }

  function datasetLabel(props) {
    if (!props) return '';
    var keys = ['name', 'title', 'NAME', 'Name', 'label', 'LABEL', 'SITE_NAME'];
    for (var i = 0; i < keys.length; i++) {
      if (props[keys[i]]) return String(props[keys[i]]);
    }
    return '';
  }

  function datasetPopup(dsName, label) {
    return (
      '<div class="map-popup">' +
      '<div class="map-popup-kind">' +
      escapeHtml(dsName) +
      '</div>' +
      (label
        ? '<div class="map-popup-title">' + escapeHtml(label) + '</div>'
        : '') +
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

    var map = L.map(mapEl, { scrollWheelZoom: true }).setView([35.9, 14.45], 10);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    var fc = readJson('zones-data');
    buildNoticeLayers(map, fc);
    loadDatasets(map);

    // Leaflet sometimes mis-measures a just-laid-out container.
    window.setTimeout(function () {
      map.invalidateSize();
    }, 100);
  }

  function buildNoticeLayers(map, fc) {
    var empty = { type: 'FeatureCollection', features: [] };
    var layers = {};

    // Base layer: every notice, one colour. Provenance (which source a notice
    // came from) isn't a useful on-map distinction, so it's not split out.
    layers.notices = L.geoJSON(fc || empty, {
      style: function () {
        return {
          color: NOTICE_COLORS.notices,
          weight: 2,
          fillColor: NOTICE_COLORS.notices,
          fillOpacity: 0.18,
        };
      },
      pointToLayer: function (feature, latlng) {
        return L.circleMarker(latlng, {
          radius: 6,
          color: NOTICE_COLORS.notices,
          weight: 2,
          fillColor: NOTICE_COLORS.notices,
          fillOpacity: 0.5,
        });
      },
      onEachFeature: function (feature, lyr) {
        lyr.bindPopup(noticePopup(feature && feature.properties));
      },
    }).addTo(map);

    // Highlight overlay: needs-review notices get an amber dashed outline on
    // top. It's a highlight, not a separate bucket — the notices stay in the
    // base layer. Non-interactive so clicks fall through to the base popup.
    layers.review = L.geoJSON(fc || empty, {
      filter: function (feature) {
        return !!(feature && feature.properties && feature.properties.needsReview);
      },
      interactive: false,
      style: function () {
        return {
          color: NOTICE_COLORS.review,
          weight: 3,
          dashArray: '5,4',
          fill: false,
          interactive: false,
        };
      },
      pointToLayer: function (feature, latlng) {
        return L.circleMarker(latlng, {
          radius: 9,
          color: NOTICE_COLORS.review,
          weight: 3,
          fill: false,
          interactive: false,
        });
      },
    }).addTo(map);
    layers.review.bringToFront();

    // Wire the notice toggles. Swatch colour is applied here (not via an inline
    // style attribute, which the hardened /admin CSP would block); a ring swatch
    // (data-style="ring") signals a highlight overlay rather than a fill.
    var buttons = document.querySelectorAll('[data-notice-layer]');
    Array.prototype.forEach.call(buttons, function (btn) {
      var key = btn.getAttribute('data-notice-layer');
      var color = btn.getAttribute('data-color');
      var swatch = btn.querySelector('.layer-swatch');
      if (swatch) {
        if (btn.getAttribute('data-style') === 'ring') {
          swatch.style.background = 'transparent';
          swatch.style.border = '2px solid ' + color;
        } else {
          swatch.style.background = color;
        }
      }
      btn.addEventListener('click', function () {
        if (!layers[key]) return;
        var on = btn.getAttribute('aria-pressed') === 'true';
        if (on) {
          map.removeLayer(layers[key]);
          btn.setAttribute('aria-pressed', 'false');
        } else {
          layers[key].addTo(map);
          if (key === 'review') layers[key].bringToFront();
          btn.setAttribute('aria-pressed', 'true');
        }
      });
    });

    var bounds = layers.notices.getBounds();
    if (bounds && bounds.isValid && bounds.isValid()) {
      map.fitBounds(bounds, { padding: [24, 24] });
    }
  }

  // Reference datasets (the same catalogue the public app overlays). Each gets a
  // toggle; geometry is fetched lazily the first time its layer is switched on.
  function loadDatasets(map) {
    var container = document.getElementById('dataset-toggles');
    if (!container) return;
    fetch('/v1/map/datasets', { headers: { Accept: 'application/json' } })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (list) {
        if (!Array.isArray(list) || list.length === 0) return;
        container.hidden = false;
        list.forEach(function (ds, i) {
          addDatasetToggle(map, container, ds, DATASET_PALETTE[i % DATASET_PALETTE.length]);
        });
      })
      .catch(function () {
        /* datasets unavailable — leave the reference group hidden */
      });
  }

  function addDatasetToggle(map, container, ds, color) {
    var cached = null;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layer-toggle';
    btn.setAttribute('aria-pressed', 'false');

    var swatch = document.createElement('i');
    swatch.className = 'layer-swatch';
    swatch.style.background = color;
    btn.appendChild(swatch);
    btn.appendChild(document.createTextNode(' ' + (ds.name || ds.key)));

    if (typeof ds.featureCount === 'number') {
      var count = document.createElement('span');
      count.className = 'layer-count';
      count.textContent = ds.featureCount;
      btn.appendChild(count);
    }
    container.appendChild(btn);

    function render(geo) {
      return L.geoJSON(geo, {
        style: function () {
          return { color: color, weight: 2, fillColor: color, fillOpacity: 0.12 };
        },
        pointToLayer: function (feature, latlng) {
          return L.circleMarker(latlng, {
            radius: 5,
            color: color,
            weight: 2,
            fillColor: color,
            fillOpacity: 0.5,
          });
        },
        onEachFeature: function (feature, lyr) {
          lyr.bindPopup(
            datasetPopup(ds.name || ds.key, datasetLabel(feature && feature.properties)),
          );
        },
      });
    }

    btn.addEventListener('click', function () {
      var on = btn.getAttribute('aria-pressed') === 'true';
      if (on) {
        if (cached) map.removeLayer(cached);
        btn.setAttribute('aria-pressed', 'false');
        return;
      }
      if (cached) {
        cached.addTo(map);
        btn.setAttribute('aria-pressed', 'true');
        return;
      }
      btn.setAttribute('data-loading', 'true');
      fetch('/v1/map/datasets/' + encodeURIComponent(ds.key), {
        headers: { Accept: 'application/geo+json' },
      })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(function (geo) {
          btn.removeAttribute('data-loading');
          if (!geo) return;
          cached = render(geo);
          cached.addTo(map);
          btn.setAttribute('aria-pressed', 'true');
        })
        .catch(function () {
          btn.removeAttribute('data-loading');
        });
    });
  }

  ready(start);
})();
