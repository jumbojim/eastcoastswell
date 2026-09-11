// Open-Meteo integration (free, no API key).
//
// Two endpoints are combined:
//  - Marine API   (marine-api.open-meteo.com) -> wave / swell height, period, direction
//  - Forecast API (api.open-meteo.com)        -> surface wind speed & direction
// Both are requested in the same explicit timezone and forecast_days so their
// hourly "time" arrays line up and can be merged index-for-index.

const MARINE_BASE = 'https://marine-api.open-meteo.com/v1/marine';
const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';

const MARINE_HOURLY = [
  'wave_height',
  'wave_direction',
  'wave_period',
  'swell_wave_height',
  'swell_wave_period',
  'swell_wave_direction',
  'wind_wave_height',
].join(',');

const FORECAST_HOURLY = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'].join(',');

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Open-Meteo request failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

const metersToFeet = (m) => (m == null ? null : m * 3.28084);

/**
 * Fetch and merge marine + wind hourly data for one location.
 * @param {number} latitude
 * @param {number} longitude
 * @param {object} opts
 * @param {string} opts.timezone IANA timezone, e.g. "America/New_York"
 * @param {number} opts.days forecast_days (1-16 for forecast API; marine API supports up to 10)
 * @returns {Promise<Array<object>>} hourly records, one per hour, in local time
 */
export async function getHourlyConditions(latitude, longitude, { timezone, days = 7 } = {}) {
  const tz = encodeURIComponent(timezone || 'America/New_York');
  const marineUrl =
    `${MARINE_BASE}?latitude=${latitude}&longitude=${longitude}` +
    `&hourly=${MARINE_HOURLY}&timezone=${tz}&forecast_days=${days}&cell_selection=sea`;
  const windUrl =
    `${FORECAST_BASE}?latitude=${latitude}&longitude=${longitude}` +
    `&hourly=${FORECAST_HOURLY}&wind_speed_unit=mph&timezone=${tz}&forecast_days=${days}`;

  const [marine, wind] = await Promise.all([fetchJson(marineUrl), fetchJson(windUrl)]);

  const times = marine.hourly?.time || [];
  const windTimeIndex = new Map((wind.hourly?.time || []).map((t, i) => [t, i]));

  return times.map((time, i) => {
    const wIdx = windTimeIndex.get(time);
    return {
      time, // "YYYY-MM-DDTHH:mm" in the requested timezone
      waveHeightFt: metersToFeet(marine.hourly.wave_height?.[i]),
      wavePeriodS: marine.hourly.wave_period?.[i] ?? null,
      waveDirectionDeg: marine.hourly.wave_direction?.[i] ?? null,
      swellHeightFt: metersToFeet(marine.hourly.swell_wave_height?.[i]),
      swellPeriodS: marine.hourly.swell_wave_period?.[i] ?? null,
      swellDirectionDeg: marine.hourly.swell_wave_direction?.[i] ?? null,
      windWaveHeightFt: metersToFeet(marine.hourly.wind_wave_height?.[i]),
      windSpeedMph: wIdx != null ? wind.hourly.wind_speed_10m?.[wIdx] ?? null : null,
      windGustMph: wIdx != null ? wind.hourly.wind_gusts_10m?.[wIdx] ?? null : null,
      windDirectionDeg: wIdx != null ? wind.hourly.wind_direction_10m?.[wIdx] ?? null : null,
    };
  });
}
