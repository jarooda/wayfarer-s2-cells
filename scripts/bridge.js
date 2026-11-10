// Runs in the PAGE world (injected via manifest world: MAIN, run_at document_start)
// Captures the page's Google Maps instance and relays bounds to the content
// script via CustomEvents.
(function() {
  if (window.__s2BridgeInstalled) return;
  window.__s2BridgeInstalled = true;
  // Bump with any change here: lets a console probe confirm which build is live.
  window.__s2BridgeVersion = '2.0.1';

  let mapRef = null;

  function isMap(v) {
    return !!v && typeof v === 'object'
      && typeof v.getBounds === 'function'
      && typeof v.getZoom === 'function'
      && typeof v.addListener === 'function';
  }

  function onMap(map) {
    if (mapRef || !isMap(map)) return;
    mapRef = map;
    window.__s2MapFound = true;
    attachListeners(map);
    const bounds = serializeBounds(map);
    dispatch(bounds ? { type: 'bounds', bounds } : { type: 'mapfound' });
  }

  // -- Strategy 1: wrap the Map constructor ----------------------------------
  // Component tag names change between rebuilds; the Maps API does not.

  function wrapMapCtor(Original) {
    if (typeof Original !== 'function' || Original.__s2Hooked) return Original;
    const Wrapped = new Proxy(Original, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget);
        try { onMap(instance); } catch (_) {}
        return instance;
      }
    });
    try { Object.defineProperty(Wrapped, '__s2Hooked', { value: true }); } catch (_) {}
    return Wrapped;
  }

  // google.maps.Map does not exist when google.maps first appears: the bootstrap
  // loader defines it only once importLibrary('maps') resolves. Hook the property
  // whenever it lands, and the class the loader hands back.
  function hookMapsApi(maps) {
    if (!maps || typeof maps !== 'object' || maps.__s2MapHook) return;
    try { Object.defineProperty(maps, '__s2MapHook', { value: true }); } catch (_) {}

    let wrapped = wrapMapCtor(maps.Map);
    try {
      Object.defineProperty(maps, 'Map', {
        configurable: true,
        enumerable: true,
        get() { return wrapped; },
        set(v) { wrapped = wrapMapCtor(v); }
      });
    } catch (_) {
      if (typeof maps.Map === 'function') {
        try { maps.Map = wrapMapCtor(maps.Map); } catch (_) {}
      }
    }

    const originalImport = maps.importLibrary;
    if (typeof originalImport === 'function' && !originalImport.__s2Hooked) {
      const hooked = function() {
        return Promise.resolve(originalImport.apply(this, arguments)).then(lib => {
          try { if (lib && typeof lib.Map === 'function') lib.Map = wrapMapCtor(lib.Map); } catch (_) {}
          return lib;
        });
      };
      try { Object.defineProperty(hooked, '__s2Hooked', { value: true }); } catch (_) {}
      try { maps.importLibrary = hooked; } catch (_) {}
    }
  }

  // An accessor on window.google is not enough on its own: a top-level
  // `var google` in a classic script redefines the global as a plain data
  // property and silently drops the accessor. So watch AND poll.
  function watchProperty(obj, prop, onSet) {
    const existing = obj[prop];
    if (existing) { onSet(existing); return; }
    try {
      let value = existing;
      Object.defineProperty(obj, prop, {
        configurable: true,
        enumerable: true,
        get() { return value; },
        set(v) { value = v; try { onSet(v); } catch (_) {} }
      });
    } catch (_) {}
  }

  watchProperty(window, 'google', g => {
    if (g && typeof g === 'object') watchProperty(g, 'maps', hookMapsApi);
  });

  function pollForMapsApi() {
    try {
      const maps = window.google && window.google.maps;
      if (maps) hookMapsApi(maps);
    } catch (_) {}
  }

  // -- Strategy 2: find a map that already exists -----------------------------
  // Angular stores component instances inside __ngContext__, but how deeply is
  // an implementation detail that moves between versions, so walk the object
  // graph instead of reading fixed positions.

  function deepFindMap(root, maxDepth, budget) {
    const seen = new WeakSet();
    const queue = [[root, 0]];
    let visited = 0;
    while (queue.length && visited < budget) {
      const entry = queue.shift();
      const obj = entry[0], depth = entry[1];
      if (!obj || typeof obj !== 'object' || depth > maxDepth) continue;
      if (seen.has(obj)) continue;
      seen.add(obj);
      visited++;
      if (isMap(obj)) return obj;
      let keys;
      try { keys = Object.keys(obj); } catch (_) { continue; }
      for (const k of keys) {
        let v;
        try { v = obj[k]; } catch (_) { continue; }
        if (v && typeof v === 'object') queue.push([v, depth + 1]);
      }
    }
    return null;
  }

  function collectRoots(root, out) {
    out.push(root);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) collectRoots(el.shadowRoot, out);
    }
    return out;
  }

  function scanDom() {
    for (const root of collectRoots(document, [])) {
      for (const host of root.querySelectorAll('*')) {
        const ctx = host.__ngContext__;
        if (!ctx || typeof ctx !== 'object') continue;
        const found = deepFindMap(ctx, 6, 4000);
        if (found) return found;
      }
    }
    return null;
  }

  function getMap() {
    if (mapRef) return mapRef;
    pollForMapsApi();
    const found = scanDom();
    if (found) onMap(found);
    return mapRef;
  }

  // -- Relay ------------------------------------------------------------------

  function serializeBounds(map) {
    let b;
    try { b = map.getBounds(); } catch (_) { return null; }
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
    // getBounds() is undefined until the first idle. The map is still there, so
    // say so rather than reporting it missing.
    dispatch(bounds ? { type: 'bounds', bounds } : { type: 'mapfound' });
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

    // Relay map clicks (used by the "future nomination" pin picker)
    map.addListener('click', function(e) {
      if (!e || !e.latLng) return;
      dispatch({ type: 'click', lat: e.latLng.lat(), lng: e.latLng.lng() });
    });

    // Pan/zoom to a saved nomination
    window.addEventListener('s2:panto', function(ev) {
      const d = ev.detail || {};
      if (typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
      map.panTo({ lat: d.lat, lng: d.lng });
      if (typeof d.zoom === 'number') map.setZoom(d.zoom);
    });
  }

  // The map can be built well after first paint, and client-side routes swap it
  // in with no page load, so keep looking for a while.
  function waitAndAttach(attempts) {
    if (mapRef || attempts > 240) return;
    getMap();
    if (mapRef) return;
    setTimeout(function() { waitAndAttach(attempts + 1); }, 250);
  }
  waitAndAttach(0);
})();
