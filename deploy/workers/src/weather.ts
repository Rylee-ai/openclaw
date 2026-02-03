/**
 * Weather client for Cloudflare Workers.
 * Uses Open-Meteo (free, unlimited) with KV caching.
 */

type ModelResult = {
  model: string;
  signal: boolean;
  direction: "home" | "away" | "over" | "under" | "neutral";
  confidence: number;
  weight: number;
  reasoning: string;
};

type Venue = {
  name: string;
  lat: number;
  lon: number;
  dome: boolean;
};

// Major venue lookup (same as plugin version)
const VENUES: Record<string, Venue> = {
  // NFL outdoor
  buf: { name: "Highmark Stadium", lat: 42.7738, lon: -78.787, dome: false },
  chi: { name: "Soldier Field", lat: 41.8623, lon: -87.6167, dome: false },
  cle: { name: "Cleveland Browns Stadium", lat: 41.506, lon: -81.6996, dome: false },
  den: { name: "Empower Field", lat: 39.7439, lon: -105.02, dome: false },
  gb: { name: "Lambeau Field", lat: 44.5013, lon: -88.0622, dome: false },
  kc: { name: "Arrowhead Stadium", lat: 39.0489, lon: -94.484, dome: false },
  ne: { name: "Gillette Stadium", lat: 42.0909, lon: -71.2643, dome: false },
  nyg: { name: "MetLife Stadium", lat: 40.8128, lon: -74.0742, dome: false },
  nyj: { name: "MetLife Stadium", lat: 40.8128, lon: -74.0742, dome: false },
  phi: { name: "Lincoln Financial Field", lat: 39.9008, lon: -75.1675, dome: false },
  pit: { name: "Acrisure Stadium", lat: 40.4468, lon: -80.0158, dome: false },
  sf: { name: "Levi's Stadium", lat: 37.4033, lon: -121.97, dome: false },
  sea: { name: "Lumen Field", lat: 47.5952, lon: -122.3316, dome: false },
  was: { name: "Commanders Field", lat: 38.9076, lon: -76.8645, dome: false },
  // NFL domes
  ari: { name: "State Farm Stadium", lat: 33.5276, lon: -112.2626, dome: true },
  atl: { name: "Mercedes-Benz Stadium", lat: 33.7554, lon: -84.401, dome: true },
  dal: { name: "AT&T Stadium", lat: 32.7473, lon: -97.0945, dome: true },
  det: { name: "Ford Field", lat: 42.34, lon: -83.0456, dome: true },
  hou: { name: "NRG Stadium", lat: 29.6847, lon: -95.4107, dome: true },
  ind: { name: "Lucas Oil Stadium", lat: 39.7601, lon: -86.1639, dome: true },
  lac: { name: "SoFi Stadium", lat: 33.9534, lon: -118.339, dome: true },
  lar: { name: "SoFi Stadium", lat: 33.9534, lon: -118.339, dome: true },
  lv: { name: "Allegiant Stadium", lat: 36.0909, lon: -115.1833, dome: true },
  min: { name: "US Bank Stadium", lat: 44.9736, lon: -93.2575, dome: true },
  no: { name: "Caesars Superdome", lat: 29.951, lon: -90.0812, dome: true },
  // NBA/NHL are indoor
};

export class WeatherClient {
  constructor(private cache: KVNamespace) {}

  async analyzeImpact(homeTeam: string, sport: string): Promise<ModelResult> {
    const venue = VENUES[homeTeam];
    if (!venue) {
      return {
        model: "weather_impact", signal: false, direction: "neutral",
        confidence: 0, weight: 7,
        reasoning: `No venue data for ${homeTeam.toUpperCase()}.`,
      };
    }

    if (venue.dome) {
      return {
        model: "weather_impact", signal: false, direction: "neutral",
        confidence: 0, weight: 7,
        reasoning: `${venue.name} is a dome. No weather impact.`,
      };
    }

    // NBA/NHL are indoor
    if (sport === "nba" || sport === "nhl") {
      return {
        model: "weather_impact", signal: false, direction: "neutral",
        confidence: 0, weight: 7,
        reasoning: `${sport.toUpperCase()} is played indoors.`,
      };
    }

    const cacheKey = `weather_${venue.lat}_${venue.lon}`;
    let weather: WeatherData;

    const cached = await this.cache.get(cacheKey, "json");
    if (cached) {
      weather = cached as WeatherData;
    } else {
      const resp = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${venue.lat}&longitude=${venue.lon}` +
          `&current=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation_probability,weather_code` +
          `&temperature_unit=fahrenheit&wind_speed_unit=mph`,
      );
      const data = (await resp.json()) as {
        current: {
          temperature_2m: number;
          wind_speed_10m: number;
          wind_gusts_10m: number;
          precipitation_probability: number;
          weather_code: number;
        };
      };

      weather = {
        temp_f: data.current.temperature_2m,
        wind_mph: data.current.wind_speed_10m,
        gusts_mph: data.current.wind_gusts_10m,
        precip_prob: data.current.precipitation_probability,
        code: data.current.weather_code,
      };

      await this.cache.put(cacheKey, JSON.stringify(weather), {
        expirationTtl: 1800, // 30 min
      });
    }

    // Score impact
    let confidence = 0;
    let adjustment = 0;
    const factors: string[] = [];

    // Wind
    if (weather.wind_mph >= 20) {
      confidence += 30;
      adjustment -= 3;
      factors.push(`High wind ${weather.wind_mph}mph: passing/kicking affected`);
    } else if (weather.wind_mph >= 15) {
      confidence += 15;
      adjustment -= 1.5;
      factors.push(`Moderate wind ${weather.wind_mph}mph`);
    }

    if (weather.gusts_mph >= 30) {
      confidence += 15;
      adjustment -= 2;
      factors.push(`Dangerous gusts ${weather.gusts_mph}mph`);
    }

    // Precipitation
    if (weather.precip_prob >= 70) {
      confidence += 20;
      adjustment -= 2;
      factors.push(`Rain/snow likely (${weather.precip_prob}%)`);
    }

    // Temperature extremes
    if (weather.temp_f <= 20) {
      confidence += 15;
      adjustment -= 1.5;
      factors.push(`Extreme cold: ${weather.temp_f}°F`);
    } else if (weather.temp_f >= 95) {
      confidence += 10;
      adjustment -= 1;
      factors.push(`Extreme heat: ${weather.temp_f}°F`);
    }

    if (confidence === 0) {
      return {
        model: "weather_impact", signal: false, direction: "neutral",
        confidence: 0, weight: 7,
        reasoning: `${venue.name}: ${weather.temp_f}°F, wind ${weather.wind_mph}mph, precip ${weather.precip_prob}%. Normal conditions.`,
      };
    }

    return {
      model: "weather_impact",
      signal: true,
      direction: adjustment < 0 ? "under" : "over",
      confidence: Math.min(confidence, 75),
      weight: 7,
      reasoning: `${venue.name}: ${factors.join(". ")}.`,
    };
  }
}

type WeatherData = {
  temp_f: number;
  wind_mph: number;
  gusts_mph: number;
  precip_prob: number;
  code: number;
};
