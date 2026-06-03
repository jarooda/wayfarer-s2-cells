// S2 Cell Overlay – Wayfarer (isolated world)
(function () {
  'use strict';

  let overlayActive = false;
  let settings = { l14: true, l17: true, l14Color: '#e040fb', l17Color: '#00bcd4' };
  let mapReady = false;
  let lastBounds = null;
  let svgEl = null;
  let throttle = null;

  // ── Mercator projection ────────────────────────────────────────────────────
  // Google Maps uses Web Mercator (EPSG:3857). We must use the same math
  // to correctly project lat/lng to pixel coordinates on the map canvas.

  function mercatorY(lat) {
    const sin = Math.sin(lat * Math.PI / 180);
    return Math.log((1 + sin) / (1 - sin)) / 2; // = atanh(sin(lat))
  }

  function project(lat, lng, bounds, w, h) {
    const x = (lng - bounds.swLng) / (bounds.neLng - bounds.swLng) * w;
    const merY     = mercatorY(lat);
    const merSouth = mercatorY(bounds.swLat);
    const merNorth = mercatorY(bounds.neLat);
    const y = (1 - (merY - merSouth) / (merNorth - merSouth)) * h;
    return { x, y };
  }

  // ── SVG overlay ────────────────────────────────────────────────────────────

  function getOrCreateSVG() {
    if (svgEl && document.contains(svgEl)) return svgEl;
    const mapDiv = document.querySelector('.gm-style');
    if (!mapDiv) return null;
    svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.id = 's2-overlay';
    svgEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:200;';
    mapDiv.appendChild(svgEl);
    return svgEl;
  }

  function renderOverlay(bounds) {
    if (!overlayActive) return;
    const svg = getOrCreateSVG();
    if (!svg) return;
    svg.innerHTML = '';

    const mapDiv = document.querySelector('.gm-style');
    if (!mapDiv) return;
    const w = mapDiv.offsetWidth, h = mapDiv.offsetHeight;
    const zoom = bounds.zoom;
    const showL14 = settings.l14 && zoom >= 8;
    const showL17 = settings.l17 && zoom >= 12;

    if (!showL14 && !showL17) { showZoomHint(zoom); return; }
    hideZoomHint();

    function drawCells(cells, color, strokeW, fillOpacity) {
      for (const cell of cells) {
        const pts = cell.corners.map(c => {
          const p = project(c.lat, c.lng, bounds, w, h);
          return `${p.x},${p.y}`;
        });
        const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        poly.setAttribute('points', pts.join(' '));
        poly.setAttribute('fill', color);
        poly.setAttribute('fill-opacity', fillOpacity);
        poly.setAttribute('stroke', color);
        poly.setAttribute('stroke-width', strokeW);
        poly.setAttribute('stroke-opacity', '0.75');
        svg.appendChild(poly);
      }
    }

    if (showL17) drawCells(S2.getCellsForBounds(bounds.swLat, bounds.swLng, bounds.neLat, bounds.neLng, 17), settings.l17Color, 1, '0.04');
    if (showL14) drawCells(S2.getCellsForBounds(bounds.swLat, bounds.swLng, bounds.neLat, bounds.neLng, 14), settings.l14Color, 2, '0.06');
  }

  function requestBounds() {
    window.dispatchEvent(new CustomEvent('s2:request'));
  }

  function showZoomHint(zoom) {
    let el = document.getElementById('s2-zoom-hint');
    if (!el) {
      el = document.createElement('div');
      el.id = 's2-zoom-hint';
      el.style.cssText = 'position:fixed;bottom:56px;left:50%;transform:translateX(-50%);background:rgba(20,20,20,.85);color:#fff;font:13px/1 system-ui;padding:7px 16px;border-radius:20px;z-index:99999;pointer-events:none;';
      document.body.appendChild(el);
    }
    el.textContent = `S2: zoom in more (current: ${zoom})`;
    el.style.display = 'block';
  }

  function hideZoomHint() {
    const el = document.getElementById('s2-zoom-hint');
    if (el) el.style.display = 'none';
  }

  // ── Listen for bounds from bridge.js ───────────────────────────────────────

  window.addEventListener('s2:response', function(e) {
    const detail = e.detail;
    if (detail.type === 'bounds' && detail.bounds) {
      mapReady = true;
      lastBounds = detail.bounds;
      if (overlayActive) {
        clearTimeout(throttle);
        throttle = setTimeout(() => renderOverlay(detail.bounds), 80);
      }
    }
  });

  // ── Message handler ────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'S2_GET_STATUS') {
      let answered = false;
      const handler = e => {
        if (answered) return;
        answered = true;
        window.removeEventListener('s2:response', handler);
        if (e.detail.type === 'bounds') mapReady = true;
        sendResponse({ mapFound: mapReady, mapType: mapReady ? 'googlemaps' : null, overlayActive, settings });
      };
      window.addEventListener('s2:response', handler);
      requestBounds();
      setTimeout(() => {
        if (answered) return;
        answered = true;
        window.removeEventListener('s2:response', handler);
        sendResponse({ mapFound: mapReady, mapType: mapReady ? 'googlemaps' : null, overlayActive, settings });
      }, 600);
      return true;
    }

    if (msg.type === 'S2_TOGGLE') {
      overlayActive = msg.active;
      if (msg.settings) settings = msg.settings;
      if (overlayActive) {
        if (lastBounds) renderOverlay(lastBounds);
        else requestBounds();
        sendResponse({ ok: true, mapType: 'googlemaps' });
      } else {
        if (svgEl) { svgEl.remove(); svgEl = null; }
        hideZoomHint();
        sendResponse({ ok: true });
      }
      return true;
    }

    if (msg.type === 'S2_UPDATE_SETTINGS') {
      settings = msg.settings;
      if (overlayActive && lastBounds) renderOverlay(lastBounds);
      sendResponse({ ok: true });
      return true;
    }
  });

  // ── Auto-restore ───────────────────────────────────────────────────────────

  chrome.storage.local.get(['s2_settings', 's2_active'], result => {
    if (result.s2_settings) settings = result.s2_settings;
    if (result.s2_active) overlayActive = true;
  });

})();
