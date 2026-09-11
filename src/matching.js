// Nearest-break matching using the haversine formula (great-circle distance).

const EARTH_RADIUS_MILES = 3958.8;

export function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MILES * c;
}

/**
 * @param {{latitude:number, longitude:number}} point
 * @param {Array<{id:number, latitude:number, longitude:number}>} breaks
 * @returns {{ match: object, distanceMiles: number } | null}
 */
export function findNearestBreak(point, breaks) {
  if (!breaks?.length) return null;

  let best = null;
  let bestDistance = Infinity;

  for (const b of breaks) {
    const d = haversineMiles(point.latitude, point.longitude, b.latitude, b.longitude);
    if (d < bestDistance) {
      bestDistance = d;
      best = b;
    }
  }

  return best ? { match: best, distanceMiles: bestDistance } : null;
}
