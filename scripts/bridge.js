// Runs in the PAGE world (injected via manifest world: MAIN)
// Reads __ngContext__ and relays map bounds to the content script via CustomEvents
(function() {
  if (window.__s2BridgeInstalled) return;
  window.__s2BridgeInstalled = true;

  function getMap() {
    const host = document.querySelector('app-wf-base-map');
    if (!host || !Array.isArray(host.__ngContext__)) return null;
    const ctx = host.__ngContext__;
    for (let i = 0; i < ctx.length; i++) {
      const v = ctx[i];
      if (v && typeof v === 'object' && typeof v.getBounds === 'function' && typeof v.getZoom === 'function') return v;
      if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) {
          try {
            const v2 = v[k];
            if (v2 && typeof v2 === 'object' && typeof v2.getBounds === 'function' && typeof v2.getZoom === 'function') return v2;
          } catch(_) {}
        }
      }
    }
    return null;
  }

  function serializeBounds(map) {
    const b = map.getBounds();
    if (!b) return null;
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    return { swLat: sw.lat(), swLng: sw.lng(), neLat: ne.lat(), neLng: ne.lng(), zoom: map.getZoom() };
  }

  function dispatch(detail) {
    window.dispatchEvent(new CustomEvent('s2:response', { detail }));
  }

  window.addEventListener('s2:request', function() {
    const map = getMap();
    if (!map) { dispatch({ type: 'nomap' }); return; }
    const bounds = serializeBounds(map);
    dispatch({ type: 'bounds', bounds });
  });

  let attached = false;
  function attachListeners(map) {
    if (attached) return;
    attached = true;
    ['bounds_changed', 'zoom_changed', 'idle'].forEach(evt => {
      map.addListener(evt, function() {
        const bounds = serializeBounds(map);
        if (bounds) dispatch({ type: 'bounds', bounds });
      });
    });

  }

  function waitAndAttach(attempts) {
    if (attempts > 120) return;
    const map = getMap();
    if (map) { attachListeners(map); dispatch({ type: 'bounds', bounds: serializeBounds(map) }); return; }
    setTimeout(() => waitAndAttach(attempts + 1), 250);
  }
  waitAndAttach(0);
})();
