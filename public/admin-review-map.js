(function () {
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function readJson(id) {
    const node = document.getElementById(id);
    if (!node) {
      console.warn('[admin-review-map] no data node for', id);
      return null;
    }
    if (!node.textContent) {
      console.warn('[admin-review-map] empty data node for', id);
      return null;
    }
    try {
      const parsed = JSON.parse(node.textContent);
      console.debug('[admin-review-map]', id, parsed);
      return parsed;
    } catch (err) {
      console.warn(
        '[admin-review-map] JSON parse failed for',
        id,
        err,
        node.textContent.slice(0, 200),
      );
      return null;
    }
  }

  function start() {
    if (typeof L === 'undefined') {
      window.setTimeout(start, 50);
      return;
    }
    const mapEl = document.getElementById('review-map');
    if (!mapEl) return;

    const rows = Array.from(document.querySelectorAll('tr[data-notice-id]'));
    if (rows.length === 0) return;

    // Malta-centric default view; gets replaced as soon as a row is selected.
    const map = L.map(mapEl, { scrollWheelZoom: true }).setView(
      [35.9, 14.5],
      8,
    );
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    const hint = document.getElementById('review-map-hint');
    let activeLayer = null;
    let selectedRow = null;

    function clearSelection() {
      if (activeLayer) {
        map.removeLayer(activeLayer);
        activeLayer = null;
      }
      if (selectedRow) {
        selectedRow.removeAttribute('data-selected');
        selectedRow = null;
      }
    }

    function select(row) {
      const id = row.dataset.noticeId;
      if (!id) return;

      const geom = readJson('geom-' + id);
      const reps = readJson('reps-' + id);

      clearSelection();
      selectedRow = row;
      row.setAttribute('data-selected', '');

      const titleEl = row.querySelector('.notice-title');
      if (hint) {
        hint.textContent = titleEl
          ? 'Showing: ' + titleEl.textContent.trim()
          : 'Showing selected notice.';
      }

      // One group holds both the area outlines and a pin per area, so the whole
      // notice clears together and fitBounds frames every shape and marker.
      const group = L.layerGroup().addTo(map);
      activeLayer = group;

      if (geom) {
        L.geoJSON(geom, {
          style: {
            color: '#152051',
            weight: 2,
            fillColor: '#152051',
            fillOpacity: 0.15,
          },
          pointToLayer: function (_feature, latlng) {
            return L.circleMarker(latlng, {
              radius: 7,
              color: '#d80c2b',
              weight: 2,
              fillColor: '#d80c2b',
              fillOpacity: 0.5,
            });
          },
        }).addTo(group);
      }

      // One marker per area (representativePoints): a multi-area notice (a cable
      // plus a wreck, two firing ranges, …) renders every shape, so each must
      // carry its own pin or the shapes without one are visible but untappable.
      const points = Array.isArray(reps) ? reps : [];
      points.forEach(function (p) {
        if (p && typeof p.latitude === 'number' && typeof p.longitude === 'number') {
          L.marker([p.latitude, p.longitude]).addTo(group);
        }
      });

      const bounds = L.featureGroup(group.getLayers()).getBounds();
      if (bounds && bounds.isValid && bounds.isValid()) {
        map.fitBounds(bounds, { padding: [24, 24], maxZoom: 14 });
        return;
      }

      if (hint) {
        hint.textContent = 'No geometry available for this notice.';
      }
    }

    rows.forEach(function (row) {
      row.addEventListener('click', function (event) {
        const target = event.target;
        if (target && target.closest && target.closest('button, a')) return;
        select(row);
      });
    });

    // Pre-select the first row so the map isn't empty on load.
    select(rows[0]);

    // Leaflet sometimes mis-measures a hidden/just-laid-out container; nudge it
    // after layout settles so tiles render at the correct size.
    window.setTimeout(function () {
      map.invalidateSize();
    }, 100);
  }

  ready(start);
})();
