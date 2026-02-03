/**
 * Situational Analysis client for Cloudflare Workers.
 * Analyzes rest, travel, scheduling, and context factors.
 */

type ModelResult = {
  model: string;
  signal: boolean;
  direction: "home" | "away" | "over" | "under" | "neutral";
  confidence: number;
  weight: number;
  reasoning: string;
};

const SPORT_PATHS: Record<string, string> = {
  nfl: "football/nfl",
  nba: "basketball/nba",
  mlb: "baseball/mlb",
  nhl: "hockey/nhl",
};

type ScheduleEvent = {
  date: string;
  isHome: boolean;
  opponent: string;
  score?: string;
  result?: string;
};

// Team geo data for travel distance calculation
const TEAM_GEO: Record<string, { lat: number; lon: number; tz: string }> = {
  // Eastern
  bos: { lat: 42.36, lon: -71.06, tz: "America/New_York" },
  bkn: { lat: 40.68, lon: -73.97, tz: "America/New_York" },
  nyk: { lat: 40.75, lon: -73.99, tz: "America/New_York" },
  phi: { lat: 39.90, lon: -75.17, tz: "America/New_York" },
  tor: { lat: 43.64, lon: -79.38, tz: "America/Toronto" },
  atl: { lat: 33.76, lon: -84.40, tz: "America/New_York" },
  mia: { lat: 25.78, lon: -80.19, tz: "America/New_York" },
  orl: { lat: 28.54, lon: -81.38, tz: "America/New_York" },
  was: { lat: 38.90, lon: -77.02, tz: "America/New_York" },
  cha: { lat: 35.23, lon: -80.84, tz: "America/New_York" },
  chi: { lat: 41.88, lon: -87.67, tz: "America/Chicago" },
  cle: { lat: 41.50, lon: -81.69, tz: "America/New_York" },
  det: { lat: 42.34, lon: -83.06, tz: "America/Detroit" },
  ind: { lat: 39.76, lon: -86.16, tz: "America/Indiana/Indianapolis" },
  mil: { lat: 43.04, lon: -87.92, tz: "America/Chicago" },
  // Central
  dal: { lat: 32.79, lon: -96.81, tz: "America/Chicago" },
  hou: { lat: 29.75, lon: -95.36, tz: "America/Chicago" },
  mem: { lat: 35.14, lon: -90.05, tz: "America/Chicago" },
  no: { lat: 29.95, lon: -90.08, tz: "America/Chicago" },
  sa: { lat: 29.43, lon: -98.44, tz: "America/Chicago" },
  min: { lat: 44.98, lon: -93.28, tz: "America/Chicago" },
  okc: { lat: 35.46, lon: -97.52, tz: "America/Chicago" },
  // Western
  den: { lat: 39.75, lon: -105.00, tz: "America/Denver" },
  por: { lat: 45.53, lon: -122.67, tz: "America/Los_Angeles" },
  uta: { lat: 40.77, lon: -111.90, tz: "America/Denver" },
  gsw: { lat: 37.77, lon: -122.39, tz: "America/Los_Angeles" },
  lac: { lat: 34.04, lon: -118.27, tz: "America/Los_Angeles" },
  lal: { lat: 34.04, lon: -118.27, tz: "America/Los_Angeles" },
  phx: { lat: 33.45, lon: -112.07, tz: "America/Phoenix" },
  sac: { lat: 38.58, lon: -121.50, tz: "America/Los_Angeles" },
  sea: { lat: 47.60, lon: -122.35, tz: "America/Los_Angeles" },
  // NFL extras
  buf: { lat: 42.77, lon: -78.79, tz: "America/New_York" },
  ne: { lat: 42.09, lon: -71.26, tz: "America/New_York" },
  nyg: { lat: 40.81, lon: -74.07, tz: "America/New_York" },
  nyj: { lat: 40.81, lon: -74.07, tz: "America/New_York" },
  pit: { lat: 40.45, lon: -80.02, tz: "America/New_York" },
  bal: { lat: 39.28, lon: -76.62, tz: "America/New_York" },
  cin: { lat: 39.10, lon: -84.52, tz: "America/New_York" },
  jax: { lat: 30.32, lon: -81.64, tz: "America/New_York" },
  ten: { lat: 36.17, lon: -86.77, tz: "America/Chicago" },
  gb: { lat: 44.50, lon: -88.06, tz: "America/Chicago" },
  kc: { lat: 39.05, lon: -94.48, tz: "America/Chicago" },
  lv: { lat: 36.09, lon: -115.18, tz: "America/Los_Angeles" },
  lar: { lat: 33.95, lon: -118.34, tz: "America/Los_Angeles" },
  sf: { lat: 37.40, lon: -121.97, tz: "America/Los_Angeles" },
  ari: { lat: 33.53, lon: -112.26, tz: "America/Phoenix" },
  car: { lat: 35.23, lon: -80.85, tz: "America/New_York" },
  tb: { lat: 27.98, lon: -82.50, tz: "America/New_York" },
  col: { lat: 39.75, lon: -105.00, tz: "America/Denver" },
};

export class SituationalClient {
  constructor(private cache: KVNamespace) {}

  async analyzeSpots(away: string, home: string, sport: string): Promise<ModelResult> {
    const sportPath = SPORT_PATHS[sport];
    if (!sportPath) {
      return {
        model: "situational_spots", signal: false, direction: "neutral",
        confidence: 0, weight: 6,
        reasoning: `Unsupported sport: ${sport}`,
      };
    }

    const today = new Date().toISOString().slice(0, 10);

    const [awaySch, homeSch] = await Promise.all([
      this.fetchSchedule(sportPath, away).catch(() => []),
      this.fetchSchedule(sportPath, home).catch(() => []),
    ]);

    const signals: string[] = [];
    let awayNeg = 0;
    let homeNeg = 0;

    // Rest differential
    const awayRest = this.restDays(awaySch, today);
    const homeRest = this.restDays(homeSch, today);
    const restDiff = homeRest - awayRest;

    if (Math.abs(restDiff) >= 2) {
      const fatigued = restDiff > 0 ? away : home;
      const score = Math.min(Math.abs(restDiff) * 2, 8);
      if (fatigued === away) awayNeg += score;
      else homeNeg += score;
      signals.push(`Rest: ${Math.abs(restDiff)}d advantage (${fatigued.toUpperCase()} fatigued)`);
    }

    // Back-to-back (NBA/NHL)
    if (sport === "nba" || sport === "nhl") {
      if (awayRest === 0) { awayNeg += 7; signals.push(`${away.toUpperCase()} road B2B`); }
      if (homeRest === 0) { homeNeg += 5; signals.push(`${home.toUpperCase()} home B2B`); }
    }

    // Travel distance
    const awayGeo = TEAM_GEO[away];
    const homeGeo = TEAM_GEO[home];
    if (awayGeo && homeGeo) {
      const dist = this.haversine(awayGeo.lat, awayGeo.lon, homeGeo.lat, homeGeo.lon);
      if (dist > 1500) {
        awayNeg += dist > 2500 ? 5 : 3;
        signals.push(`${away.toUpperCase()} traveled ~${Math.round(dist)}mi`);
      }

      const tzDiff = this.tzDiff(awayGeo.tz, homeGeo.tz);
      if (tzDiff >= 2) {
        awayNeg += 4;
        signals.push(`${away.toUpperCase()} ${tzDiff}hr TZ disadvantage`);
      }
    }

    // Altitude
    if (home === "den" || home === "col") {
      awayNeg += 4;
      signals.push("Altitude (5,280ft)");
    }

    const diff = homeNeg - awayNeg;

    if (signals.length === 0 || Math.abs(diff) < 3) {
      return {
        model: "situational_spots", signal: false, direction: "neutral",
        confidence: 0, weight: 6,
        reasoning: signals.length > 0
          ? `Balanced: ${signals.join("; ")}`
          : `Rest: away=${awayRest}d, home=${homeRest}d. No factors.`,
      };
    }

    const direction: ModelResult["direction"] = diff > 0 ? "away" : "home";
    const confidence = Math.min(Math.abs(diff) * 5, 70);

    return {
      model: "situational_spots", signal: true, direction, confidence, weight: 6,
      reasoning: `${signals.join("; ")}. Edge: ${direction}.`,
    };
  }

  private async fetchSchedule(sportPath: string, team: string): Promise<ScheduleEvent[]> {
    const cacheKey = `schedule_${sportPath}_${team}`;
    const cached = await this.cache.get(cacheKey, "json");
    if (cached) return cached as ScheduleEvent[];

    const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/teams/${team}/schedule`;
    const resp = await fetch(url);
    if (!resp.ok) return [];

    const data = (await resp.json()) as {
      events?: Array<{
        date: string;
        competitions?: Array<{
          competitors?: Array<{ homeAway: string; team: { abbreviation: string }; score?: { displayValue: string } }>;
        }>;
      }>;
    };

    const events: ScheduleEvent[] = (data.events ?? []).map((e) => {
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find((c) => c.homeAway === "home");
      const away = comp?.competitors?.find((c) => c.homeAway === "away");
      return {
        date: e.date.slice(0, 10),
        isHome: home?.team.abbreviation.toLowerCase() === team.toLowerCase(),
        opponent: home?.team.abbreviation.toLowerCase() === team.toLowerCase()
          ? (away?.team.abbreviation ?? "UNK")
          : (home?.team.abbreviation ?? "UNK"),
        score: home?.score?.displayValue,
      };
    });

    await this.cache.put(cacheKey, JSON.stringify(events), {
      expirationTtl: 3600,
    });

    return events;
  }

  private restDays(schedule: ScheduleEvent[], gameDate: string): number {
    const past = schedule
      .filter((e) => e.date < gameDate)
      .sort((a, b) => b.date.localeCompare(a.date));

    if (past.length === 0) return 7;

    const lastGame = new Date(past[0].date);
    const today = new Date(gameDate);
    return Math.floor((today.getTime() - lastGame.getTime()) / 86_400_000);
  }

  private haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 3959; // miles
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private tzDiff(tz1: string, tz2: string): number {
    // Approximate timezone offset differences
    const offsets: Record<string, number> = {
      "America/New_York": -5,
      "America/Toronto": -5,
      "America/Detroit": -5,
      "America/Indiana/Indianapolis": -5,
      "America/Chicago": -6,
      "America/Denver": -7,
      "America/Phoenix": -7,
      "America/Los_Angeles": -8,
    };
    return Math.abs((offsets[tz1] ?? -5) - (offsets[tz2] ?? -5));
  }
}
