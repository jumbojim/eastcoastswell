// Zip code -> lat/long lookup.
//
// Uses Zippopotam.us (https://www.zippopotam.us/) — free, no API key, generous
// enough for signup-time lookups. If you outgrow it or need better accuracy,
// swap this module for the US Census Bureau geocoder or a bundled ZIP
// centroid dataset; nothing else in the pipeline needs to change.

export class GeocodeError extends Error {}

export async function zipToLatLong(zip) {
  const cleanZip = String(zip).trim().slice(0, 5);
  if (!/^\d{5}$/.test(cleanZip)) {
    throw new GeocodeError(`"${zip}" doesn't look like a 5-digit US zip code.`);
  }

  const res = await fetch(`https://api.zippopotam.us/us/${cleanZip}`);
  if (res.status === 404) {
    throw new GeocodeError(`Zip code ${cleanZip} not found.`);
  }
  if (!res.ok) {
    throw new GeocodeError(`Zip lookup failed (HTTP ${res.status}).`);
  }

  const data = await res.json();
  const place = data.places?.[0];
  if (!place) {
    throw new GeocodeError(`Zip code ${cleanZip} returned no location data.`);
  }

  return {
    zip: cleanZip,
    latitude: Number(place.latitude),
    longitude: Number(place.longitude),
    placeName: place['place name'],
    state: place['state abbreviation'],
  };
}
