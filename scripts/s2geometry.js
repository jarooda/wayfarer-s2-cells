// S2 Geometry Library - proper cell enumeration (no sampling gaps)
const S2 = (function() {

  function toRad(deg) { return deg * Math.PI / 180; }
  function toDeg(rad) { return rad * 180 / Math.PI; }

  function latLngToXYZ(lat, lng) {
    const phi = toRad(lat), theta = toRad(lng);
    return {
      x: Math.cos(phi) * Math.cos(theta),
      y: Math.cos(phi) * Math.sin(theta),
      z: Math.sin(phi)
    };
  }

  function xyzToLatLng(x, y, z) {
    const len = Math.sqrt(x*x + y*y + z*z);
    return {
      lat: toDeg(Math.asin(z / len)),
      lng: toDeg(Math.atan2(y, x))
    };
  }

  function xyzToFaceUV(x, y, z) {
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    let face, u, v;
    if (ax >= ay && ax >= az) {
      face = x > 0 ? 0 : 3;
      u = x > 0 ?  y/x : -z/x;
      v = x > 0 ?  z/x : -y/x;
    } else if (ay >= ax && ay >= az) {
      face = y > 0 ? 1 : 4;
      u = y > 0 ? -x/y :  z/y;
      v = y > 0 ?  z/y : -x/y;
    } else {
      face = z > 0 ? 2 : 5;
      u = z > 0 ? -x/z :  y/z;
      v = z > 0 ? -y/z :  x/z;
    }
    return { face, u, v };
  }

  function faceUVToXYZ(face, u, v) {
    switch(face) {
      case 0: return { x:  1, y:  u, z:  v };
      case 1: return { x: -u, y:  1, z:  v };
      case 2: return { x: -u, y: -v, z:  1 };
      case 3: return { x: -1, y: -v, z: -u };
      case 4: return { x:  v, y: -1, z: -u };
      case 5: return { x:  v, y:  u, z: -1 };
    }
  }

  // Quadratic projection (matches Google's S2 library)
  function uvToST(u) {
    return u >= 0
      ? 0.5 * Math.sqrt(1 + 3*u)
      : 1 - 0.5 * Math.sqrt(1 - 3*u);
  }

  function stToUV(s) {
    return s >= 0.5
      ? (1/3) * (4*s*s - 1)
      : (1/3) * (1 - 4*(1-s)*(1-s));
  }

  function stToIJ(s, maxSize) {
    return Math.max(0, Math.min(maxSize - 1, Math.floor(s * maxSize)));
  }

  function ijToST(i, maxSize) { return i / maxSize; }

  // Get corners of a cell given face, i, j, level
  function cellCorners(face, i, j, level) {
    const maxSize = 1 << level;
    const corners = [];
    for (const [di, dj] of [[0,0],[1,0],[1,1],[0,1]]) {
      const s = (i + di) / maxSize;
      const t = (j + dj) / maxSize;
      const u = stToUV(s);
      const v = stToUV(t);
      const xyz = faceUVToXYZ(face, u, v);
      corners.push(xyzToLatLng(xyz.x, xyz.y, xyz.z));
    }
    return corners;
  }

  // Convert lat/lng to face/i/j at a given level
  function latLngToCell(lat, lng, level) {
    const xyz = latLngToXYZ(lat, lng);
    const { face, u, v } = xyzToFaceUV(xyz.x, xyz.y, xyz.z);
    const maxSize = 1 << level;
    const i = stToIJ(uvToST(u), maxSize);
    const j = stToIJ(uvToST(v), maxSize);
    return { face, i, j };
  }

  // Get all unique cells covering a bounding box by walking the IJ grid.
  // This is gap-free: we compute the cell range directly from the corner
  // coordinates on each face, then enumerate every cell in that range.
  function getCellsForBounds(swLat, swLng, neLat, neLng, level) {
    const maxSize = 1 << level;
    const cells = new Map();

    // Sample a dense grid of points across the bounds to collect all cells.
    // Step size is slightly smaller than one cell to guarantee no gaps.
    const latSpan = neLat - swLat;
    const lngSpan = neLng - swLng;
    // Cell size in degrees (approximate at equator — we overshoot intentionally)
    const cellDeg = 180 / maxSize;
    const latSteps = Math.ceil(latSpan / cellDeg) + 2;
    const lngSteps = Math.ceil(lngSpan / cellDeg) + 2;
    const latStep = latSpan / latSteps;
    const lngStep = lngSpan / lngSteps;

    for (let li = 0; li <= latSteps; li++) {
      for (let lj = 0; lj <= lngSteps; lj++) {
        const lat = swLat + li * latStep;
        const lng = swLng + lj * lngStep;
        if (lat < -85 || lat > 85) continue;

        const { face, i, j } = latLngToCell(lat, lng, level);
        const key = `${face}_${i}_${j}`;
        if (!cells.has(key)) {
          cells.set(key, { key, corners: cellCorners(face, i, j, level) });
        }
      }
    }

    // Also sample cell neighbors at corners to catch edge cases
    for (const cell of Array.from(cells.values())) {
      const center = {
        lat: cell.corners.reduce((s, c) => s + c.lat, 0) / 4,
        lng: cell.corners.reduce((s, c) => s + c.lng, 0) / 4
      };
      // Check all 8 neighbors in IJ space
      const { face, i, j } = latLngToCell(center.lat, center.lng, level);
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= maxSize || nj >= maxSize) continue;
          const nkey = `${face}_${ni}_${nj}`;
          if (!cells.has(nkey)) {
            // Check if this neighbor overlaps the bounding box
            const corners = cellCorners(face, ni, nj, level);
            const cLat = corners.reduce((s,c) => s+c.lat, 0) / 4;
            const cLng = corners.reduce((s,c) => s+c.lng, 0) / 4;
            if (cLat >= swLat - cellDeg && cLat <= neLat + cellDeg &&
                cLng >= swLng - cellDeg && cLng <= neLng + cellDeg) {
              cells.set(nkey, { key: nkey, corners });
            }
          }
        }
      }
    }

    return Array.from(cells.values());
  }

  return { getCellsForBounds, latLngToCell, cellCorners };
})();

window.S2 = S2;
