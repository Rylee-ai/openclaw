/**
 * SHARPS EDGE - Get Weather Tool
 *
 * Fetches game-time weather from Open-Meteo and converts to impact scores.
 * Free API, no key required, no quota limits.
 */

import { Type } from "@sinclair/typebox";

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";

// Known venue coordinates (NFL/MLB/NBA outdoor stadiums)
const VENUES: Record<string, { lat: number; lon: number; dome: boolean; name: string }> = {
  // NFL outdoor
  buf: { lat: 42.7738, lon: -78.787, dome: false, name: "Highmark Stadium" },
  chi: { lat: 41.8623, lon: -87.6167, dome: false, name: "Soldier Field" },
  cin: { lat: 39.0955, lon: -84.516, dome: false, name: "Paycor Stadium" },
  cle: { lat: 41.506, lon: -81.6996, dome: false, name: "Cleveland Browns Stadium" },
  den: { lat: 39.7439, lon: -105.02, dome: false, name: "Empower Field" },
  gb: { lat: 44.5013, lon: -88.0622, dome: false, name: "Lambeau Field" },
  jax: { lat: 30.3239, lon: -81.6373, dome: false, name: "EverBank Stadium" },
  kc: { lat: 39.0489, lon: -94.484, dome: false, name: "Arrowhead Stadium" },
  mia: { lat: 25.958, lon: -80.2389, dome: false, name: "Hard Rock Stadium" },
  ne: { lat: 42.0909, lon: -71.2643, dome: false, name: "Gillette Stadium" },
  nyg: { lat: 40.8128, lon: -74.0742, dome: false, name: "MetLife Stadium" },
  nyj: { lat: 40.8128, lon: -74.0742, dome: false, name: "MetLife Stadium" },
  oak: { lat: 37.7516, lon: -122.2005, dome: false, name: "Oakland Coliseum" },
  phi: { lat: 39.9008, lon: -75.1675, dome: false, name: "Lincoln Financial Field" },
  pit: { lat: 40.4468, lon: -80.0158, dome: false, name: "Acrisure Stadium" },
  sea: { lat: 47.5952, lon: -122.3316, dome: false, name: "Lumen Field" },
  sf: { lat: 37.4033, lon: -121.9694, dome: false, name: "Levi's Stadium" },
  tb: { lat: 27.9759, lon: -82.5033, dome: false, name: "Raymond James Stadium" },
  ten: { lat: 36.1665, lon: -86.7713, dome: false, name: "Nissan Stadium" },
  wsh: { lat: 38.9076, lon: -76.8645, dome: false, name: "Commanders Field" },
  // NFL domes
  ari: { lat: 33.5276, lon: -112.2626, dome: true, name: "State Farm Stadium" },
  atl: { lat: 33.7554, lon: -84.401, dome: true, name: "Mercedes-Benz Stadium" },
  dal: { lat: 32.7473, lon: -97.0945, dome: true, name: "AT&T Stadium" },
  det: { lat: 42.34, lon: -83.0456, dome: true, name: "Ford Field" },
  hou: { lat: 29.6847, lon: -95.4107, dome: true, name: "NRG Stadium" },
  ind: { lat: 39.7601, lon: -86.1639, dome: true, name: "Lucas Oil Stadium" },
  lac: { lat: 33.9535, lon: -118.3392, dome: true, name: "SoFi Stadium" },
  lar: { lat: 33.9535, lon: -118.3392, dome: true, name: "SoFi Stadium" },
  lv: { lat: 36.0909, lon: -115.1833, dome: true, name: "Allegiant Stadium" },
  min: { lat: 44.9736, lon: -93.2575, dome: true, name: "U.S. Bank Stadium" },
  no: { lat: 29.951, lon: -90.0811, dome: true, name: "Caesars Superdome" },
  // MLB outdoor (subset - expand as needed)
  col: { lat: 39.7559, lon: -104.9942, dome: false, name: "Coors Field" },
};

export const GetWeatherSchema = Type.Object(
  {
    venue: Type.Optional(
      Type.String({
        description:
          "Venue code (e.g. buf, chi, den) or 'list' for all venues. If not provided, use lat/lon.",
      }),
    ),
    lat: Type.Optional(Type.Number({ description: "Latitude of game location" })),
    lon: Type.Optional(Type.Number({ description: "Longitude of game location" })),
    game_time: Type.Optional(
      Type.String({
        description: "ISO 8601 datetime of game start (e.g. 2026-02-01T13:00). Default: now.",
      }),
    ),
    sport: Type.Optional(
      Type.String({
        description: "Sport for impact scoring: nfl, mlb, nba. Default: nfl",
      }),
    ),
  },
  { additionalProperties: false },
);

type GetWeatherParams = {
  venue?: string;
  lat?: number;
  lon?: number;
  game_time?: string;
  sport?: string;
};

export function createGetWeatherTool() {
  return {
    name: "get_weather",
    label: "Get Weather Impact",
    description:
      "Fetch game-time weather and calculate impact scores for sports betting. " +
      "Returns wind speed, precipitation, temperature, and their effect on " +
      "spreads/totals. Dome games return 'no impact'. FREE - no quota limits.",
    parameters: GetWeatherSchema,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details: unknown;
    }> {
      const p = params as GetWeatherParams;

      if (p.venue === "list") {
        const list = Object.entries(VENUES).map(([k, v]) => ({
          code: k,
          name: v.name,
          dome: v.dome,
        }));
        return ok({ venues: list }, "Available venues");
      }

      let lat: number;
      let lon: number;
      let dome = false;
      let venueName = "Custom location";

      if (p.venue) {
        const v = VENUES[p.venue.toLowerCase()];
        if (!v) {
          return err(`Unknown venue '${p.venue}'. Use venue='list' to see options.`);
        }
        lat = v.lat;
        lon = v.lon;
        dome = v.dome;
        venueName = v.name;
      } else if (p.lat != null && p.lon != null) {
        lat = p.lat;
        lon = p.lon;
      } else {
        return err("Provide either 'venue' code or 'lat'/'lon' coordinates.");
      }

      // Dome = no weather impact
      if (dome) {
        return ok(
          {
            venue: venueName,
            dome: true,
            impact: { total: 0, spread: 0, note: "Dome game - weather has no impact" },
          },
          `Weather impact: ${venueName}`,
        );
      }

      try {
        const gameTime = p.game_time ? new Date(p.game_time) : new Date();
        const dateStr = gameTime.toISOString().slice(0, 10);
        const hour = gameTime.getUTCHours();

        const url =
          `${OPEN_METEO_BASE}?latitude=${lat}&longitude=${lon}` +
          `&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation_probability,precipitation,relative_humidity_2m` +
          `&temperature_unit=fahrenheit&wind_speed_unit=mph` +
          `&start_date=${dateStr}&end_date=${dateStr}`;

        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Open-Meteo ${res.status}`);
        }

        const data = (await res.json()) as {
          hourly: {
            time: string[];
            temperature_2m: number[];
            wind_speed_10m: number[];
            wind_gusts_10m: number[];
            precipitation_probability: number[];
            precipitation: number[];
            relative_humidity_2m: number[];
          };
        };

        // Find the hour closest to game time
        const idx = Math.min(hour, (data.hourly?.time?.length ?? 1) - 1);
        const weather = {
          temperature_f: data.hourly.temperature_2m[idx],
          wind_speed_mph: data.hourly.wind_speed_10m[idx],
          wind_gusts_mph: data.hourly.wind_gusts_10m[idx],
          precipitation_prob: data.hourly.precipitation_probability[idx],
          precipitation_mm: data.hourly.precipitation[idx],
          humidity_pct: data.hourly.relative_humidity_2m[idx],
        };

        const sport = (p.sport ?? "nfl").toLowerCase();
        const impact = calculateImpact(weather, sport);

        return ok(
          {
            venue: venueName,
            dome: false,
            game_time: gameTime.toISOString(),
            weather,
            impact,
          },
          `Weather impact: ${venueName}`,
        );
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

type WeatherData = {
  temperature_f: number;
  wind_speed_mph: number;
  wind_gusts_mph: number;
  precipitation_prob: number;
  precipitation_mm: number;
  humidity_pct: number;
};

type Impact = {
  total_adjustment: number; // negative = favors under
  spread_adjustment: number;
  confidence: number; // 0-100
  factors: string[];
  recommendation: string;
};

// Exported for use by check-edge orchestrator
export { VENUES, calculateImpact };
export type { WeatherData, Impact };

export async function fetchWeatherForVenue(
  lat: number,
  lon: number,
  gameTime?: Date,
): Promise<WeatherData> {
  const time = gameTime ?? new Date();
  const dateStr = time.toISOString().slice(0, 10);
  const hour = time.getUTCHours();

  const url =
    `${OPEN_METEO_BASE}?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation_probability,precipitation,relative_humidity_2m` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph` +
    `&start_date=${dateStr}&end_date=${dateStr}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo ${res.status}`);
  }

  const data = (await res.json()) as {
    hourly: {
      time: string[];
      temperature_2m: number[];
      wind_speed_10m: number[];
      wind_gusts_10m: number[];
      precipitation_probability: number[];
      precipitation: number[];
      relative_humidity_2m: number[];
    };
  };

  const idx = Math.min(hour, (data.hourly?.time?.length ?? 1) - 1);
  return {
    temperature_f: data.hourly.temperature_2m[idx],
    wind_speed_mph: data.hourly.wind_speed_10m[idx],
    wind_gusts_mph: data.hourly.wind_gusts_10m[idx],
    precipitation_prob: data.hourly.precipitation_probability[idx],
    precipitation_mm: data.hourly.precipitation[idx],
    humidity_pct: data.hourly.relative_humidity_2m[idx],
  };
}

function calculateImpact(w: WeatherData, sport: string): Impact {
  const factors: string[] = [];
  let totalAdj = 0;
  let spreadAdj = 0;
  let confidence = 0;

  if (sport === "nfl" || sport === "ncaaf") {
    // Wind
    if (w.wind_speed_mph >= 20) {
      totalAdj -= 4;
      confidence += 30;
      factors.push(`Strong wind ${w.wind_speed_mph}mph: heavy under signal, passing game impaired`);
    } else if (w.wind_speed_mph >= 15) {
      totalAdj -= 2;
      confidence += 20;
      factors.push(`Moderate wind ${w.wind_speed_mph}mph: favors under, FG accuracy drops`);
    }

    // Gusts
    if (w.wind_gusts_mph >= 30) {
      totalAdj -= 2;
      confidence += 15;
      factors.push(`Dangerous gusts ${w.wind_gusts_mph}mph: punt/kick game severely affected`);
    }

    // Precipitation
    if (w.precipitation_prob >= 70) {
      totalAdj -= 2;
      confidence += 15;
      factors.push(`Rain likely (${w.precipitation_prob}%): fumble risk up, footing impaired`);
    }

    // Extreme cold
    if (w.temperature_f <= 20) {
      totalAdj -= 3;
      confidence += 20;
      factors.push(`Extreme cold ${w.temperature_f}°F: grip issues, reduced offensive efficiency`);
    } else if (w.temperature_f <= 32) {
      totalAdj -= 1;
      confidence += 10;
      factors.push(`Cold ${w.temperature_f}°F: minor impact on passing/kicking`);
    }

    // Extreme heat
    if (w.temperature_f >= 95) {
      confidence += 10;
      factors.push(`Extreme heat ${w.temperature_f}°F: fatigue factor, benefits deeper roster`);
    }
  } else if (sport === "mlb") {
    // Wind at Coors, etc
    if (w.wind_speed_mph >= 15) {
      // Wind direction matters but we don't have it - note this
      totalAdj -= 1;
      confidence += 15;
      factors.push(`Wind ${w.wind_speed_mph}mph: direction-dependent (check ballpark orientation)`);
    }

    // Rain
    if (w.precipitation_prob >= 60) {
      totalAdj -= 1.5;
      confidence += 20;
      factors.push(`Rain likely (${w.precipitation_prob}%): favors under, wet ball impacts hitting`);
    }

    // Humidity + heat = carry
    if (w.humidity_pct <= 30 && w.temperature_f >= 80) {
      totalAdj += 1;
      confidence += 10;
      factors.push(`Dry heat: ball carries further, slight over lean`);
    }
  }

  if (factors.length === 0) {
    factors.push("No significant weather impact detected");
  }

  const recommendation =
    totalAdj <= -3
      ? "Strong under signal from weather"
      : totalAdj <= -1
        ? "Moderate under lean from weather"
        : totalAdj >= 2
          ? "Moderate over lean from weather"
          : "Weather neutral - look to other factors";

  return {
    total_adjustment: totalAdj,
    spread_adjustment: spreadAdj,
    confidence: Math.min(confidence, 100),
    factors,
    recommendation,
  };
}

function ok(data: unknown, label: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ label, data }, null, 2) }],
    details: { label, data },
  };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    details: { error: message },
  };
}
