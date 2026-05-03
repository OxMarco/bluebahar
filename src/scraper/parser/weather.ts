import { cookieJar, fetchHtml } from '../../common/utils/http';
import type {
  WeatherForecast,
  WeatherRadarImage,
} from '../entities/weather.entity';

export interface ParsedWeather {
  externalId: number;
  publishTime: Date;
  lastUpdated: Date;
  forecastDate: string;
  forecast: WeatherForecast;
  radarImage?: WeatherRadarImage;
  seaTemperature?: string;
}

export const WEATHER_URL =
  'https://content.maltametoffice.com/api/weather-3day-mariner-forecast/current';

const CSRF_URL = 'https://content.maltametoffice.com/sanctum/csrf-cookie';
const SITE_ORIGIN = 'https://maltametoffice.com';

interface WeatherDay {
  en: WeatherForecast;
  date: { date_default: string };
  radar_image?: WeatherRadarImage;
  sea_temparture?: string;
}

interface WeatherApiResponse {
  id: number;
  publish_time: string;
  last_updated: string;
  days: WeatherDay[];
}

export async function fetchMarinerForecast(): Promise<ParsedWeather> {
  // The API sits behind Laravel Sanctum's stateless CSRF: the front-end primes
  // an XSRF-TOKEN cookie via /sanctum/csrf-cookie, then echoes it as the
  // X-XSRF-TOKEN header on subsequent calls. Without this dance the API
  // responds 403 Access Denied.
  await fetchHtml(CSRF_URL, {
    headers: {
      Origin: SITE_ORIGIN,
      Referer: `${SITE_ORIGIN}/`,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/plain, */*',
    },
  });

  const xsrfCookie = (await cookieJar.getCookies(WEATHER_URL)).find(
    (c) => c.key === 'XSRF-TOKEN',
  );
  if (!xsrfCookie) {
    throw new Error('Missing XSRF-TOKEN cookie after CSRF prime');
  }
  const xsrfToken = decodeURIComponent(xsrfCookie.value);

  const body = await fetchHtml(WEATHER_URL, {
    headers: {
      Origin: SITE_ORIGIN,
      Referer: `${SITE_ORIGIN}/`,
      'X-Requested-With': 'XMLHttpRequest',
      'X-XSRF-TOKEN': xsrfToken,
      Accept: 'application/json, text/plain, */*',
    },
  });
  const json = JSON.parse(body) as WeatherApiResponse;

  const today = json.days?.[0];
  if (typeof json.id !== 'number' || !today?.en || !today.date?.date_default) {
    throw new Error('Unexpected weather forecast payload shape');
  }

  return {
    externalId: json.id,
    publishTime: new Date(json.publish_time),
    lastUpdated: new Date(json.last_updated),
    forecastDate: today.date.date_default,
    forecast: today.en,
    ...(today.radar_image && { radarImage: today.radar_image }),
    ...(today.sea_temparture && { seaTemperature: today.sea_temparture }),
  };
}
