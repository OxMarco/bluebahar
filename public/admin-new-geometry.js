(function () {
  'use strict';

  // Mirrors MIN_POINTS in create-notice.dto.ts: a point needs one position, a
  // line two, a polygon three (the serializer closes the ring). Used for the
  // pre-submit check so the admin isn't bounced through a server round-trip.
  var MIN_POINTS = { point: 1, line: 2, polygon: 3 };
  var TYPES = ['point', 'line', 'polygon'];

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function readInitial() {
    var node = document.getElementById('initial-areas');
    if (!node || !node.textContent) return [];
    var raw;
    try {
      raw = JSON.parse(node.textContent);
    } catch (err) {
      console.warn('[admin-new-geometry] bad initial-areas JSON', err);
      return [];
    }
    // The server embeds form.areas, which on the error re-render is still the
    // raw hidden-field string (JSON-encoded a second time by the `json` helper).
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch (err) {
        return [];
      }
    }
    if (!Array.isArray(raw)) return [];
    return raw
      .map(function (part) {
        var type = TYPES.indexOf(part && part.geometryType) >= 0
          ? part.geometryType
          : 'point';
        var points = Array.isArray(part && part.points) ? part.points : [];
        return {
          label: part && typeof part.label === 'string' ? part.label : '',
          geometryType: type,
          points: points.map(function (p) {
            return { lat: toNum(p && p.lat), long: toNum(p && p.long) };
          }),
        };
      })
      .filter(Boolean);
  }

  function toNum(value) {
    if (value === '' || value === null || value === undefined) return null;
    var n = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function start() {
    if (typeof L === 'undefined') {
      window.setTimeout(start, 50);
      return;
    }

    var form = document.querySelector('form[action="/admin/notices"]');
    var listEl = document.getElementById('geometry-parts');
    var mapEl = document.getElementById('geometry-map');
    var hiddenEl = document.getElementById('areas-input');
    var hintEl = document.getElementById('geometry-map-hint');
    var emptyEl = document.getElementById('geometry-empty');
    var addBtn = document.getElementById('geometry-add-part');
    if (!form || !listEl || !mapEl || !hiddenEl || !addBtn) return;

    var state = readInitial();
    var activeIndex = state.length > 0 ? 0 : -1;

    var map = L.map(mapEl, { scrollWheelZoom: true }).setView([35.9, 14.5], 8);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    var previewLayer = L.featureGroup().addTo(map);

    map.on('click', function (event) {
      if (activeIndex < 0 || !state[activeIndex]) return;
      var part = state[activeIndex];
      var pt = {
        lat: round(event.latlng.lat),
        long: round(event.latlng.lng),
      };
      // A point is a single position; a fresh click moves it rather than
      // stacking extras the serializer would ignore anyway.
      if (part.geometryType === 'point') part.points = [pt];
      else part.points.push(pt);
      render();
      redraw(true);
    });

    function round(n) {
      return Math.round(n * 1e6) / 1e6;
    }

    function setActive(index) {
      activeIndex = index;
      Array.prototype.forEach.call(
        listEl.querySelectorAll('.geometry-part'),
        function (card, i) {
          if (i === activeIndex) card.setAttribute('data-active', '');
          else card.removeAttribute('data-active');
        },
      );
      updateHint();
    }

    function updateHint() {
      if (!hintEl) return;
      if (activeIndex < 0 || !state[activeIndex]) {
        hintEl.textContent = 'Add a geometry part to start drawing.';
        return;
      }
      var part = state[activeIndex];
      var label = part.label ? '“' + part.label + '”' : 'this part';
      hintEl.textContent =
        'Click the map to add points to ' + label + ' (' + part.geometryType + ').';
    }

    function addPart() {
      state.push({ label: '', geometryType: 'point', points: [] });
      render();
      setActive(state.length - 1);
      redraw(false);
    }

    function render() {
      listEl.innerHTML = '';
      if (emptyEl) emptyEl.hidden = state.length > 0;

      state.forEach(function (part, index) {
        var card = el('div', 'geometry-part');
        card.addEventListener('click', function (event) {
          if (event.target.closest('button')) return;
          setActive(index);
        });

        // Header: label + type + remove
        var header = el('div', 'flex items-center gap-2');

        var labelInput = el('input', 'border border-ink/15 rounded-md px-3 py-2 text-sm w-full');
        labelInput.type = 'text';
        labelInput.placeholder = 'Label (optional)';
        labelInput.value = part.label;
        labelInput.addEventListener('input', function () {
          part.label = labelInput.value;
          if (index === activeIndex) updateHint();
        });

        var typeSelect = el('select', 'border border-ink/15 rounded-md px-2 py-2 text-sm bg-white');
        TYPES.forEach(function (t) {
          var opt = el('option', null, t);
          opt.value = t;
          if (t === part.geometryType) opt.selected = true;
          typeSelect.appendChild(opt);
        });
        typeSelect.addEventListener('change', function () {
          part.geometryType = typeSelect.value;
          render();
          if (index === activeIndex) updateHint();
          redraw(false);
        });

        var removePart = el('button', 'text-xs bg-bad text-white rounded-md px-2 py-1 hover:opacity-90', 'Remove');
        removePart.type = 'button';
        removePart.addEventListener('click', function () {
          state.splice(index, 1);
          if (activeIndex >= state.length) activeIndex = state.length - 1;
          render();
          setActive(activeIndex);
          redraw(false);
        });

        header.appendChild(labelInput);
        header.appendChild(typeSelect);
        header.appendChild(removePart);
        card.appendChild(header);

        // Coordinate rows
        var coords = el('div', 'flex flex-col gap-1 mt-2');
        part.points.forEach(function (pt, pIndex) {
          coords.appendChild(coordRow(part, pt, pIndex));
        });
        card.appendChild(coords);

        var addPoint = el('button', 'text-xs bg-ink text-white rounded-md px-2 py-1 mt-2 hover:opacity-90', '+ Add point');
        addPoint.type = 'button';
        addPoint.addEventListener('click', function () {
          if (part.geometryType === 'point' && part.points.length >= 1) {
            // Keep point geometries single-position.
            setActive(index);
            return;
          }
          part.points.push({ lat: null, long: null });
          render();
          setActive(index);
        });
        card.appendChild(addPoint);

        var minNote = el(
          'p',
          'text-xs text-ink/55 mt-1',
          'Needs at least ' +
            MIN_POINTS[part.geometryType] +
            ' point' +
            (MIN_POINTS[part.geometryType] === 1 ? '' : 's') +
            '.',
        );
        card.appendChild(minNote);

        listEl.appendChild(card);
        if (index === activeIndex) card.setAttribute('data-active', '');
      });
    }

    function coordRow(part, pt, pIndex) {
      var row = el('div', 'coord-row');

      var latInput = el('input', 'border border-ink/15 rounded-md px-2 py-1 text-sm');
      latInput.type = 'number';
      latInput.step = 'any';
      latInput.placeholder = 'lat';
      latInput.value = pt.lat == null ? '' : pt.lat;
      latInput.addEventListener('input', function () {
        pt.lat = toNum(latInput.value);
        redraw(false);
      });

      var lngInput = el('input', 'border border-ink/15 rounded-md px-2 py-1 text-sm');
      lngInput.type = 'number';
      lngInput.step = 'any';
      lngInput.placeholder = 'long';
      lngInput.value = pt.long == null ? '' : pt.long;
      lngInput.addEventListener('input', function () {
        pt.long = toNum(lngInput.value);
        redraw(false);
      });

      var remove = el('button', 'text-xs bg-ink/5 rounded-md px-2 py-1 hover:bg-ink/5', '✕');
      remove.type = 'button';
      remove.title = 'Remove point';
      remove.addEventListener('click', function () {
        part.points.splice(pIndex, 1);
        render();
      });

      row.appendChild(latInput);
      row.appendChild(lngInput);
      row.appendChild(remove);
      return row;
    }

    function latlngs(part) {
      return part.points
        .filter(function (p) {
          return Number.isFinite(p.lat) && Number.isFinite(p.long);
        })
        .map(function (p) {
          return [p.lat, p.long];
        });
    }

    function redraw(fit) {
      previewLayer.clearLayers();
      state.forEach(function (part) {
        var pts = latlngs(part);
        if (pts.length === 0) return;
        if (part.geometryType === 'polygon' && pts.length >= 3) {
          previewLayer.addLayer(
            L.polygon(pts, { color: '#152051', weight: 2, fillOpacity: 0.15 }),
          );
        } else if (part.geometryType === 'line' && pts.length >= 2) {
          previewLayer.addLayer(L.polyline(pts, { color: '#152051', weight: 2 }));
        }
        // Always show vertices so single, sub-minimum, or point parts are visible.
        pts.forEach(function (p) {
          previewLayer.addLayer(
            L.circleMarker(p, {
              radius: 6,
              color: '#d80c2b',
              weight: 2,
              fillColor: '#d80c2b',
              fillOpacity: 0.5,
            }),
          );
        });
      });

      if (fit) {
        var bounds = previewLayer.getBounds();
        if (bounds && bounds.isValid && bounds.isValid()) {
          map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 });
        }
      }
    }

    function serialize() {
      return state
        .map(function (part) {
          return {
            label: (part.label || '').trim(),
            geometryType: part.geometryType,
            points: part.points
              .filter(function (p) {
                return Number.isFinite(p.lat) && Number.isFinite(p.long);
              })
              .map(function (p) {
                return { lat: p.lat, long: p.long };
              }),
          };
        })
        .filter(function (part) {
          return part.points.length > 0;
        });
    }

    function firstError(parts) {
      for (var i = 0; i < state.length; i++) {
        var part = state[i];
        var hasPartial = part.points.some(function (p) {
          var a = Number.isFinite(p.lat);
          var b = Number.isFinite(p.long);
          return a !== b;
        });
        if (hasPartial) {
          return 'Part ' + (i + 1) + ': every point needs both a latitude and a longitude.';
        }
      }
      for (var j = 0; j < parts.length; j++) {
        var p = parts[j];
        if (p.points.length < MIN_POINTS[p.geometryType]) {
          return (
            'A ' +
            p.geometryType +
            ' geometry needs at least ' +
            MIN_POINTS[p.geometryType] +
            ' point' +
            (MIN_POINTS[p.geometryType] === 1 ? '' : 's') +
            '.'
          );
        }
      }
      return null;
    }

    form.addEventListener('submit', function (event) {
      var parts = serialize();
      var error = firstError(parts);
      if (error) {
        event.preventDefault();
        if (hintEl) hintEl.textContent = error;
        return;
      }
      hiddenEl.value = parts.length > 0 ? JSON.stringify(parts) : '';
    });

    addBtn.addEventListener('click', addPart);

    render();
    setActive(activeIndex);
    redraw(true);

    // Leaflet mis-measures a container that was just laid out; nudge it.
    window.setTimeout(function () {
      map.invalidateSize();
    }, 100);
  }

  ready(start);
})();
