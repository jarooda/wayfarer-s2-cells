// S2 Cell Overlay – Wayfarer (isolated world)
(function () {
  'use strict';

  let overlayActive = false;
  let settings = { l14: true, l17: true, l14Color: '#e040fb', l17Color: '#00bcd4' };
  let mapReady = false;
  let lastBounds = null;
  let throttle = null;

  // Future nominations
  let nominations = [];        // { id, lat, lng, desc, emoji, createdAt }
  let markerLayer = null;
  let pickMode = false;
  let pendingBox = null;       // the open inline input box, if any

  // Shared emoji palette (scripts/emoji.js loads before this in the manifest)
  const { DEFAULT_EMOJI, buildEmojiPicker } = window.S2Emoji;

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

  // ── Canvas overlay ─────────────────────────────────────────────────────────
  // One <canvas> for every cell, drawn as a single path per level: one fill and
  // one stroke call, instead of one DOM node per cell.

  // Hard cap per level. Above this the lines are a few pixels apart anyway, so
  // the level is skipped instead of enumerated. Keeps zoomed-out views cheap.
  const MAX_CELLS_PER_LEVEL = 10000;
  // Average S2 cell area (km²): Earth's surface / (6 faces × 4^level).
  const EARTH_KM2 = 510.1e6;
  function avgCellKm2(level) { return EARTH_KM2 / (6 * Math.pow(4, level)); }

  function estimateCellCount(bounds, level) {
    const midLat = (bounds.swLat + bounds.neLat) / 2;
    const heightKm = Math.abs(bounds.neLat - bounds.swLat) * 111.32;
    let lngSpan = bounds.neLng - bounds.swLng;
    if (lngSpan < 0) lngSpan += 360;
    const widthKm = lngSpan * 111.32 * Math.cos(midLat * Math.PI / 180);
    return (heightKm * widthKm) / avgCellKm2(level);
  }

  let canvasEl = null;

  function getOrCreateCanvas() {
    if (canvasEl && document.contains(canvasEl)) return canvasEl;
    const mapDiv = document.querySelector('.gm-style');
    if (!mapDiv) return null;
    canvasEl = document.createElement('canvas');
    canvasEl.id = 's2-overlay';
    canvasEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:200;';
    mapDiv.appendChild(canvasEl);
    return canvasEl;
  }

  function removeOverlay() {
    if (canvasEl) { canvasEl.remove(); canvasEl = null; }
  }

  function renderOverlay(bounds) {
    if (!overlayActive) return;
    const canvas = getOrCreateCanvas();
    if (!canvas) return;
    const mapDiv = canvas.parentElement;
    const w = mapDiv.offsetWidth, h = mapDiv.offsetHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const zoom = bounds.zoom;
    const fitsL14 = estimateCellCount(bounds, 14) <= MAX_CELLS_PER_LEVEL;
    const fitsL17 = estimateCellCount(bounds, 17) <= MAX_CELLS_PER_LEVEL;
    const showL14 = settings.l14 && fitsL14;
    const showL17 = settings.l17 && fitsL17;

    const hidden = [];
    if (settings.l14 && !fitsL14) hidden.push('L14');
    if (settings.l17 && !fitsL17) hidden.push('L17');
    if (hidden.length) showZoomHint(zoom, hidden); else hideZoomHint();
    if (!showL14 && !showL17) return;

    function drawCells(level, color, strokeW, fillOpacity) {
      const cells = S2.getCellsForBounds(bounds.swLat, bounds.swLng, bounds.neLat, bounds.neLng, level);
      ctx.beginPath();
      for (const cell of cells) {
        const c = cell.corners;
        for (let k = 0; k < c.length; k++) {
          const p = project(c[k].lat, c[k].lng, bounds, w, h);
          if (k === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
      }
      ctx.fillStyle = color;
      ctx.globalAlpha = fillOpacity;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = strokeW;
      ctx.globalAlpha = 0.75;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (showL17) drawCells(17, settings.l17Color, 1, 0.04);
    if (showL14) drawCells(14, settings.l14Color, 2, 0.06);
  }

  function requestBounds() {
    window.dispatchEvent(new CustomEvent('s2:request'));
  }

  // ── Future nominations ──────────────────────────────────────────────────────

  function persistNominations() {
    chrome.storage.local.set({ s2_nominations: nominations });
  }

  function getMarkerLayer() {
    if (markerLayer && document.contains(markerLayer)) return markerLayer;
    const mapDiv = document.querySelector('.gm-style');
    if (!mapDiv) return null;
    markerLayer = document.createElement('div');
    markerLayer.id = 's2-marker-layer';
    markerLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:250;';
    mapDiv.appendChild(markerLayer);
    return markerLayer;
  }

  function renderNominations(bounds) {
    const layer = getMarkerLayer();
    if (!layer) return;
    layer.innerHTML = '';
    const mapDiv = document.querySelector('.gm-style');
    if (!mapDiv) return;
    const w = mapDiv.offsetWidth, h = mapDiv.offsetHeight;
    for (const nom of nominations) {
      const p = project(nom.lat, nom.lng, bounds, w, h);
      if (p.x < -40 || p.x > w + 40 || p.y < -60 || p.y > h + 40) continue;
      const pin = document.createElement('div');
      pin.className = 's2-nom-pin';
      pin.style.left = p.x + 'px';
      pin.style.top = p.y + 'px';
      pin.textContent = nom.emoji || DEFAULT_EMOJI;
      const tip = document.createElement('div');
      tip.className = 's2-nom-tip';
      tip.textContent = (nom.desc || '(no description)');
      pin.appendChild(tip);
      pin.addEventListener('click', function (ev) {
        ev.stopPropagation();
        // Opens Street View at the pin; Google falls back to the map if no pano nearby
        const url = 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + nom.lat + ',' + nom.lng;
        window.open(url, '_blank', 'noopener');
      });
      layer.appendChild(pin);
    }
  }

  // Places the inline box near the click point, flipping/clamping so it never
  // gets cropped by the map edges (e.g. when the pin is near the top).
  function positionInlineBox(box, px, py) {
    const mapDiv = document.querySelector('.gm-style');
    if (!mapDiv) return;
    const mapW = mapDiv.offsetWidth, mapH = mapDiv.offsetHeight;
    const boxW = box.offsetWidth, boxH = box.offsetHeight;
    const gap = 14, margin = 8;
    // Prefer above the point, horizontally centered on it
    let left = px - boxW / 2;
    let top = py - boxH - gap;
    // Not enough room above → drop below the point instead
    if (top < margin) top = py + gap;
    // Keep fully inside the map
    left = Math.max(margin, Math.min(left, mapW - boxW - margin));
    top = Math.max(margin, Math.min(top, mapH - boxH - margin));
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  }

  // Reposition / redraw everything that depends on bounds
  function refreshMapLayers(bounds) {
    if (overlayActive) renderOverlay(bounds);
    renderNominations(bounds);
    if (pendingBox && pendingBox._lat != null) {
      const mapDiv = document.querySelector('.gm-style');
      if (mapDiv) {
        const p = project(pendingBox._lat, pendingBox._lng, bounds, mapDiv.offsetWidth, mapDiv.offsetHeight);
        positionInlineBox(pendingBox, p.x, p.y);
      }
    }
  }

  function enterPickMode() {
    pickMode = true;
    document.body.classList.add('s2-picking');
    showPickBanner();
    if (lastBounds) renderNominations(lastBounds);
    else requestBounds();
  }

  function exitPickMode() {
    pickMode = false;
    document.body.classList.remove('s2-picking');
    hidePickBanner();
    closeInlineBox();
  }

  function showPickBanner() {
    let el = document.getElementById('s2-pick-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 's2-pick-banner';
      el.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);background:rgba(0,131,143,.95);color:#fff;font:13px/1.3 system-ui;padding:9px 18px;border-radius:20px;z-index:100000;box-shadow:0 2px 10px rgba(0,0,0,.3);';
      document.body.appendChild(el);
    }
    el.textContent = '📍 Click the map to drop a nomination (Esc to cancel)';
    el.style.display = 'block';
  }

  function hidePickBanner() {
    const el = document.getElementById('s2-pick-banner');
    if (el) el.style.display = 'none';
  }

  function closeInlineBox() {
    if (pendingBox) { pendingBox.remove(); pendingBox = null; }
  }

  function showInlineBox(lat, lng) {
    closeInlineBox();
    const mapDiv = document.querySelector('.gm-style');
    if (!mapDiv || !lastBounds) return;
    const p = project(lat, lng, lastBounds, mapDiv.offsetWidth, mapDiv.offsetHeight);

    const box = document.createElement('div');
    box.className = 's2-nom-box';
    box._lat = lat;
    box._lng = lng;
    box.innerHTML =
      '<div class="s2-nom-box-coord"></div>' +
      '<textarea class="s2-nom-box-input" rows="1" placeholder="Description…"></textarea>' +
      '<div class="s2-nom-emoji"></div>' +
      '<div class="s2-nom-box-actions">' +
        '<button type="button" class="s2-nom-cancel">Cancel</button>' +
        '<button type="button" class="s2-nom-save">Save</button>' +
      '</div>';
    box.querySelector('.s2-nom-box-coord').textContent = lat.toFixed(6) + ', ' + lng.toFixed(6);
    mapDiv.appendChild(box);
    pendingBox = box;

    let selectedEmoji = DEFAULT_EMOJI;
    const picker = buildEmojiPicker(selectedEmoji, em => { selectedEmoji = em; });
    box.querySelector('.s2-nom-emoji').appendChild(picker);

    // Position after content (incl. emoji picker) is in place so height is known
    positionInlineBox(box, p.x, p.y);

    const input = box.querySelector('.s2-nom-box-input');
    setTimeout(() => input.focus(), 0);

    const save = () => {
      saveNomination(lat, lng, input.value.trim(), selectedEmoji);
      exitPickMode();
    };
    box.querySelector('.s2-nom-save').addEventListener('click', save);
    box.querySelector('.s2-nom-cancel').addEventListener('click', () => exitPickMode());
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); save(); }
      ev.stopPropagation();
    });
  }

  function saveNomination(lat, lng, desc, emoji) {
    nominations.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      lat, lng, desc,
      emoji: emoji || DEFAULT_EMOJI,
      createdAt: new Date().toISOString()
    });
    persistNominations();
    if (lastBounds) renderNominations(lastBounds);
  }

  function deleteNomination(id) {
    nominations = nominations.filter(n => n.id !== id);
    persistNominations();
    if (lastBounds) renderNominations(lastBounds);
  }

  // Capture map clicks relayed from the bridge
  window.addEventListener('s2:response', function(e) {
    if (e.detail && e.detail.type === 'click' && pickMode) {
      showInlineBox(e.detail.lat, e.detail.lng);
    }
  });

  document.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape' && pickMode) exitPickMode();
  });

  // Re-sync pins when the list is edited/deleted elsewhere (e.g. the manager page)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.s2_nominations) return;
    const next = changes.s2_nominations.newValue;
    nominations = Array.isArray(next) ? next : [];
    if (lastBounds) renderNominations(lastBounds);
  });

  function showZoomHint(zoom, levels) {
    let el = document.getElementById('s2-zoom-hint');
    if (!el) {
      el = document.createElement('div');
      el.id = 's2-zoom-hint';
      el.style.cssText = 'position:fixed;bottom:56px;left:50%;transform:translateX(-50%);background:rgba(20,20,20,.85);color:#fff;font:13px/1 system-ui;padding:7px 16px;border-radius:20px;z-index:99999;pointer-events:none;';
      document.body.appendChild(el);
    }
    el.textContent = `S2 ${levels.join(' & ')}: zoom in to show (current: ${zoom})`;
    el.style.display = 'block';
  }

  function hideZoomHint() {
    const el = document.getElementById('s2-zoom-hint');
    if (el) el.style.display = 'none';
  }

  // ── Listen for bounds from bridge.js ───────────────────────────────────────

  window.addEventListener('s2:response', function(e) {
    const detail = e.detail;
    // 'mapfound' means the bridge has the map but getBounds() is not ready yet.
    if (detail.type === 'mapfound') mapReady = true;
    if (detail.type === 'bounds' && detail.bounds) {
      mapReady = true;
      lastBounds = detail.bounds;
      clearTimeout(throttle);
      throttle = setTimeout(() => refreshMapLayers(detail.bounds), 80);
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
        if (e.detail.type === 'bounds' || e.detail.type === 'mapfound') mapReady = true;
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
        removeOverlay();
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

    if (msg.type === 'S2_START_PICK') {
      enterPickMode();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'S2_GET_NOMINATIONS') {
      sendResponse({ ok: true, nominations });
      return true;
    }

    if (msg.type === 'S2_DELETE_NOMINATION') {
      deleteNomination(msg.id);
      sendResponse({ ok: true, nominations });
      return true;
    }

    if (msg.type === 'S2_ZOOM_TO') {
      window.dispatchEvent(new CustomEvent('s2:panto', { detail: { lat: msg.lat, lng: msg.lng, zoom: 18 } }));
      sendResponse({ ok: true });
      return true;
    }
  });

  // ── Auto-restore ───────────────────────────────────────────────────────────

  chrome.storage.local.get(['s2_settings', 's2_active', 's2_nominations'], result => {
    if (result.s2_settings) settings = result.s2_settings;
    if (result.s2_active) overlayActive = true;
    if (Array.isArray(result.s2_nominations)) nominations = result.s2_nominations;
    if (nominations.length) { if (lastBounds) renderNominations(lastBounds); else requestBounds(); }
  });

})();
