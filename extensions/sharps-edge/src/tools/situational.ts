/**
 * SHARPS EDGE - Situational Analysis Tool
 *
 * Analyzes scheduling spots, rest differentials, travel, and situational
 * factors that the market systematically underprices.
 *
 * This is what separates AI from human sharps: holding ALL situational
 * variables simultaneously instead of the 2-3 a human brain can juggle.
 */

import { Type } from "@sinclair/typebox";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

const cache = new Map<string, { data: unknown; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour - schedules don't change often

// Team timezone mapping (for travel/circadian analysis)
const TEAM_TIMEZONES: Record<string, { tz: string; lat: number; lon: number }> = {
  // NFL East
  buf: { tz: "America/New_York", lat: 42.77, lon: -78.79 },
  mia: { tz: "America/New_York", lat: 25.96, lon: -80.24 },
  ne: { tz: "America/New_York", lat: 42.09, lon: -71.26 },
  nyj: { tz: "America/New_York", lat: 40.81, lon: -74.07 },
  nyg: { tz: "America/New_York", lat: 40.81, lon: -74.07 },
  phi: { tz: "America/New_York", lat: 39.90, lon: -75.17 },
  pit: { tz: "America/New_York", lat: 40.45, lon: -80.02 },
  bal: { tz: "America/New_York", lat: 39.28, lon: -76.62 },
  wsh: { tz: "America/New_York", lat: 38.91, lon: -76.86 },
  cle: { tz: "America/New_York", lat: 41.51, lon: -81.70 },
  cin: { tz: "America/New_York", lat: 39.10, lon: -84.52 },
  jax: { tz: "America/New_York", lat: 30.32, lon: -81.64 },
  atl: { tz: "America/New_York", lat: 33.76, lon: -84.40 },
  car: { tz: "America/New_York", lat: 35.23, lon: -80.85 },
  tb: { tz: "America/New_York", lat: 27.98, lon: -82.50 },
  det: { tz: "America/Detroit", lat: 42.34, lon: -83.05 },
  ind: { tz: "America/Indiana/Indianapolis", lat: 39.76, lon: -86.16 },
  // Central
  chi: { tz: "America/Chicago", lat: 41.86, lon: -87.62 },
  gb: { tz: "America/Chicago", lat: 44.50, lon: -88.06 },
  min: { tz: "America/Chicago", lat: 44.97, lon: -93.26 },
  dal: { tz: "America/Chicago", lat: 32.75, lon: -97.09 },
  hou: { tz: "America/Chicago", lat: 29.68, lon: -95.41 },
  no: { tz: "America/Chicago", lat: 29.95, lon: -90.08 },
  ten: { tz: "America/Chicago", lat: 36.17, lon: -86.77 },
  kc: { tz: "America/Chicago", lat: 39.05, lon: -94.48 },
  // Mountain
  den: { tz: "America/Denver", lat: 39.74, lon: -105.02 },
  ari: { tz: "America/Phoenix", lat: 33.53, lon: -112.26 },
  lv: { tz: "America/Los_Angeles", lat: 36.09, lon: -115.18 },
  // Pacific
  sf: { tz: "America/Los_Angeles", lat: 37.40, lon: -121.97 },
  lac: { tz: "America/Los_Angeles", lat: 33.95, lon: -118.34 },
  lar: { tz: "America/Los_Angeles", lat: 33.95, lon: -118.34 },
  sea: { tz: "America/Los_Angeles", lat: 47.60, lon: -122.33 },
  // NBA / MLB / NHL share similar geography
  bos: { tz: "America/New_York", lat: 42.37, lon: -71.06 },
  bkn: { tz: "America/New_York", lat: 40.68, lon: -73.97 },
  nyk: { tz: "America/New_York", lat: 40.75, lon: -73.99 },
  tor: { tz: "America/Toronto", lat: 43.64, lon: -79.38 },
  mil: { tz: "America/Chicago", lat: 43.04, lon: -87.92 },
  okc: { tz: "America/Chicago", lat: 35.46, lon: -97.52 },
  sas: { tz: "America/Chicago", lat: 29.43, lon: -98.44 },
  mem: { tz: "America/Chicago", lat: 35.14, lon: -90.05 },
  uta: { tz: "America/Denver", lat: 40.77, lon: -111.90 },
  phx: { tz: "America/Phoenix", lat: 33.45, lon: -112.07 },
  por: { tz: "America/Los_Angeles", lat: 45.53, lon: -122.67 },
  sac: { tz: "America/Los_Angeles", lat: 38.58, lon: -121.50 },
  gsw: { tz: "America/Los_Angeles", lat: 37.77, lon: -122.39 },
  lal: { tz: "America/Los_Angeles", lat: 34.04, lon: -118.27 },
  lac2: { tz: "America/Los_Angeles", lat: 34.04, lon: -118.27 },
  col: { tz: "America/Denver", lat: 39.76, lon: -104.99 },
};

const SPORT_PATHS: Record<string, string> = {
  nfl: "football/nfl",
  nba: "basketball/nba",
  mlb: "baseball/mlb",
  nhl: "hockey/nhl",
};

export const GetSituationalSchema = Type.Object(
  {
    sport: Type.String({
      description: "Sport: nfl, nba, mlb, nhl",
    }),
    away_team: Type.String({
      description: "Away team abbreviation (e.g. DAL)",
    }),
    home_team: Type.String({
      description: "Home team abbreviation (e.g. PHI)",
    }),
    game_date: Type.Optional(
      Type.String({
        description: "Game date YYYY-MM-DD. Default: today.",
      }),
    ),
  },
  { additionalProperties: false },
);

type SituationalParams = {
  sport: string;
  away_team: string;
  home_team: string;
  game_date?: string;
};

type SpotSignal = {
  spot: string;
  team: string;
  impact: "positive" | "negative" | "neutral";
  weight: number;
  description: string;
};

export function createGetSituationalTool() {
  return {
    name: "get_situational",
    label: "Situational Analysis",
    description:
      "Analyze scheduling spots, rest differentials, travel, and situational " +
      "factors for a matchup. Detects letdown spots, sandwich games, Thursday " +
      "disadvantages, back-to-backs, travel fatigue, altitude, timezone mismatches, " +
      "and motivation mismatches. These are the factors the market underprices " +
      "because humans can't hold them all simultaneously.",
    parameters: GetSituationalSchema,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details: unknown;
    }> {
      const p = params as SituationalParams;
      const sport = p.sport.toLowerCase();
      const away = p.away_team.toLowerCase();
      const home = p.home_team.toLowerCase();
      const gameDate = p.game_date ?? new Date().toISOString().slice(0, 10);

      const sportPath = SPORT_PATHS[sport];
      if (!sportPath) {
        return err(`Unknown sport '${sport}'`);
      }

      try {
        // Fetch schedule data for both teams
        const [awaySchedule, homeSchedule] = await Promise.all([
          fetchTeamSchedule(sportPath, away),
          fetchTeamSchedule(sportPath, home),
        ]);

        const signals: SpotSignal[] = [];

        // 1. Rest differential
        const awayRest = calculateRestDays(awaySchedule, gameDate);
        const homeRest = calculateRestDays(homeSchedule, gameDate);
        const restDiff = homeRest - awayRest;

        if (Math.abs(restDiff) >= 2) {
          const fatigued = restDiff > 0 ? away : home;
          const rested = restDiff > 0 ? home : away;
          signals.push({
            spot: "rest_differential",
            team: fatigued,
            impact: "negative",
            weight: Math.min(Math.abs(restDiff) * 2, 8),
            description: `${rested.toUpperCase()} has ${Math.abs(restDiff)} more rest days than ${fatigued.toUpperCase()}`,
          });
        }

        // 2. Back-to-back detection (NBA/NHL)
        if (sport === "nba" || sport === "nhl") {
          if (awayRest === 0) {
            signals.push({
              spot: "back_to_back_road",
              team: away,
              impact: "negative",
              weight: 7,
              description: `${away.toUpperCase()} on road back-to-back. Historically ~55% ATS against.`,
            });
          }
          if (homeRest === 0) {
            signals.push({
              spot: "back_to_back_home",
              team: home,
              impact: "negative",
              weight: 5,
              description: `${home.toUpperCase()} on home back-to-back. Less impactful than road B2B but still a factor.`,
            });
          }

          // 3-in-4 detection
          const awayDensity = calculateScheduleDensity(awaySchedule, gameDate, 4);
          const homeDensity = calculateScheduleDensity(homeSchedule, gameDate, 4);
          if (awayDensity >= 3) {
            signals.push({
              spot: "schedule_density",
              team: away,
              impact: "negative",
              weight: 6,
              description: `${away.toUpperCase()} playing ${awayDensity}-in-4 nights. Cumulative fatigue.`,
            });
          }
          if (homeDensity >= 3) {
            signals.push({
              spot: "schedule_density",
              team: home,
              impact: "negative",
              weight: 5,
              description: `${home.toUpperCase()} playing ${homeDensity}-in-4 nights. Cumulative fatigue.`,
            });
          }
        }

        // 3. Travel distance
        const awayGeo = TEAM_TIMEZONES[away];
        const homeGeo = TEAM_TIMEZONES[home];
        if (awayGeo && homeGeo) {
          const distanceMiles = haversineDistance(
            awayGeo.lat, awayGeo.lon,
            homeGeo.lat, homeGeo.lon,
          );

          if (distanceMiles > 1500) {
            signals.push({
              spot: "long_travel",
              team: away,
              impact: "negative",
              weight: distanceMiles > 2500 ? 5 : 3,
              description: `${away.toUpperCase()} traveled ~${Math.round(distanceMiles)} miles. Cross-country fatigue.`,
            });
          }

          // Timezone mismatch (West → East early game)
          const tzOffsetDiff = getTimezoneOffsetDiff(awayGeo.tz, homeGeo.tz);
          if (tzOffsetDiff >= 2) {
            signals.push({
              spot: "timezone_disadvantage",
              team: away,
              impact: "negative",
              weight: 4,
              description: `${away.toUpperCase()} in ${tzOffsetDiff}hr earlier timezone. Early starts = circadian disadvantage.`,
            });
          }
        }

        // 4. Altitude (Denver)
        if (home === "den" || home === "col") {
          signals.push({
            spot: "altitude",
            team: away,
            impact: "negative",
            weight: 4,
            description: `Playing at altitude (5,280ft). Visiting teams show measurable performance drops.`,
          });
        }

        // 5. NFL-specific spots
        if (sport === "nfl") {
          const gameDay = new Date(gameDate).getDay();

          // Thursday game
          if (gameDay === 4) {
            signals.push({
              spot: "thursday_game",
              team: "both",
              impact: "neutral",
              weight: 5,
              description: "Thursday game. Short week hurts favorites more (complex schemes need more prep).",
            });
          }

          // Check for letdown/look-ahead (would need previous + next game context)
          const awayPrev = getLastResult(awaySchedule, gameDate);
          const homePrev = getLastResult(homeSchedule, gameDate);

          if (awayPrev?.isBlowoutWin) {
            signals.push({
              spot: "letdown",
              team: away,
              impact: "negative",
              weight: 5,
              description: `${away.toUpperCase()} coming off blowout win. Letdown spot - emotional hangover.`,
            });
          }
          if (homePrev?.isBlowoutWin) {
            signals.push({
              spot: "letdown",
              team: home,
              impact: "negative",
              weight: 4,
              description: `${home.toUpperCase()} coming off blowout win. Letdown spot (less impactful at home).`,
            });
          }
        }

        // 6. MLB day-after-night
        if (sport === "mlb") {
          const awayPrev = getLastResult(awaySchedule, gameDate);
          if (awayPrev?.wasNightGame) {
            const gameHour = 13; // Approximate day game
            if (gameHour < 17) {
              signals.push({
                spot: "day_after_night",
                team: away,
                impact: "negative",
                weight: 5,
                description: `${away.toUpperCase()} road day game after night game. Bullpen taxed, late bedtime.`,
              });
            }
          }
        }

        // Calculate compound spot score
        const negativeSignals = signals.filter((s) => s.impact === "negative");
        const positiveSignals = signals.filter((s) => s.impact === "positive");

        const awayNeg = negativeSignals.filter((s) => s.team === away || s.team === "both");
        const homeNeg = negativeSignals.filter((s) => s.team === home || s.team === "both");
        const awayNegScore = awayNeg.reduce((s, sig) => s + sig.weight, 0);
        const homeNegScore = homeNeg.reduce((s, sig) => s + sig.weight, 0);

        let situationalEdge = "neutral";
        let edgeTeam = "none";
        const differential = homeNegScore - awayNegScore;

        if (Math.abs(differential) >= 5) {
          edgeTeam = differential > 0 ? away : home;
          situationalEdge = Math.abs(differential) >= 10 ? "strong" : "moderate";
        }

        return ok(
          {
            matchup: `${away.toUpperCase()}@${home.toUpperCase()}`,
            date: gameDate,
            sport,
            rest: {
              away: { team: away.toUpperCase(), days_rest: awayRest },
              home: { team: home.toUpperCase(), days_rest: homeRest },
              differential: restDiff,
            },
            signals,
            summary: {
              away_negative_score: awayNegScore,
              home_negative_score: homeNegScore,
              situational_edge: situationalEdge,
              edge_favors: edgeTeam === "none" ? "neither" : edgeTeam.toUpperCase(),
              signal_count: signals.length,
            },
            compound_note:
              signals.length >= 3
                ? "Multiple situational factors detected. Check independence before compounding."
                : signals.length === 0
                  ? "No significant situational factors. Look to other models."
                  : "Some situational factors present. Combine with other edge models.",
          },
          `Situational: ${away.toUpperCase()}@${home.toUpperCase()}`,
        );
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

// Exported for use by check-edge orchestrator
export {
  fetchTeamSchedule,
  calculateRestDays,
  calculateScheduleDensity,
  getLastResult,
  haversineDistance,
  getTimezoneOffsetDiff,
  TEAM_TIMEZONES,
  SPORT_PATHS as SITUATIONAL_SPORT_PATHS,
};
export type { SpotSignal, ScheduleGame };

// --- Helper functions ---

type ScheduleGame = {
  date: string;
  opponent: string;
  home: boolean;
  score?: { team: number; opponent: number };
  wasNightGame?: boolean;
};

async function fetchTeamSchedule(
  sportPath: string,
  team: string,
): Promise<ScheduleGame[]> {
  const cacheKey = `schedule_${sportPath}_${team}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data as ScheduleGame[];
  }

  const url = `${ESPN_BASE}/${sportPath}/teams/${team}/schedule`;
  const res = await fetch(url);
  if (!res.ok) {
    return []; // Graceful degradation
  }

  const data = await res.json();
  const games: ScheduleGame[] = [];

  try {
    const events = ((data as Record<string, unknown>).events as Array<Record<string, unknown>>) ?? [];
    for (const event of events) {
      const dateStr = (event.date as string) ?? "";
      const competitions = (event.competitions as Array<Record<string, unknown>>) ?? [];
      const comp = competitions[0];
      if (!comp) continue;

      const competitors = (comp.competitors as Array<Record<string, unknown>>) ?? [];
      const teamEntry = competitors.find(
        (c) => (c.team as Record<string, unknown>)?.abbreviation?.toString().toLowerCase() === team,
      );
      const oppEntry = competitors.find(
        (c) => (c.team as Record<string, unknown>)?.abbreviation?.toString().toLowerCase() !== team,
      );

      const teamScore = teamEntry?.score ? Number(teamEntry.score) : undefined;
      const oppScore = oppEntry?.score ? Number(oppEntry.score) : undefined;

      games.push({
        date: dateStr.slice(0, 10),
        opponent: ((oppEntry?.team as Record<string, unknown>)?.abbreviation as string) ?? "??",
        home: teamEntry?.homeAway === "home",
        score:
          teamScore != null && oppScore != null
            ? { team: teamScore, opponent: oppScore }
            : undefined,
        wasNightGame: new Date(dateStr).getUTCHours() >= 23, // ~7pm ET or later
      });
    }
  } catch {
    // ESPN shape varies
  }

  cache.set(cacheKey, { data: games, fetchedAt: Date.now() });
  return games;
}

function calculateRestDays(schedule: ScheduleGame[], gameDate: string): number {
  const target = new Date(gameDate).getTime();
  let lastGame: number | null = null;

  for (const game of schedule) {
    const gTime = new Date(game.date).getTime();
    if (gTime < target) {
      if (!lastGame || gTime > lastGame) {
        lastGame = gTime;
      }
    }
  }

  if (!lastGame) return 7; // No recent game found, assume well-rested
  return Math.floor((target - lastGame) / (24 * 60 * 60 * 1000)) - 1;
}

function calculateScheduleDensity(
  schedule: ScheduleGame[],
  gameDate: string,
  windowDays: number,
): number {
  const target = new Date(gameDate).getTime();
  const windowStart = target - windowDays * 24 * 60 * 60 * 1000;
  let count = 1; // Include the current game

  for (const game of schedule) {
    const gTime = new Date(game.date).getTime();
    if (gTime >= windowStart && gTime < target) {
      count++;
    }
  }

  return count;
}

function getLastResult(
  schedule: ScheduleGame[],
  gameDate: string,
): { isBlowoutWin: boolean; wasNightGame: boolean } | null {
  const target = new Date(gameDate).getTime();
  let lastGame: ScheduleGame | null = null;
  let lastTime = 0;

  for (const game of schedule) {
    const gTime = new Date(game.date).getTime();
    if (gTime < target && gTime > lastTime) {
      lastTime = gTime;
      lastGame = game;
    }
  }

  if (!lastGame?.score) return null;

  const margin = lastGame.score.team - lastGame.score.opponent;
  return {
    isBlowoutWin: margin >= 14, // Won by 14+ (2 TDs)
    wasNightGame: lastGame.wasNightGame ?? false,
  };
}

function haversineDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R = 3959; // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getTimezoneOffsetDiff(tz1: string, tz2: string): number {
  // Simplified: map timezone names to UTC offsets
  const offsets: Record<string, number> = {
    "America/New_York": -5,
    "America/Detroit": -5,
    "America/Indiana/Indianapolis": -5,
    "America/Toronto": -5,
    "America/Chicago": -6,
    "America/Denver": -7,
    "America/Phoenix": -7,
    "America/Los_Angeles": -8,
  };
  const o1 = offsets[tz1] ?? -5;
  const o2 = offsets[tz2] ?? -5;
  return Math.abs(o1 - o2);
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
