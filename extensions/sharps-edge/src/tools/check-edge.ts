/**
 * SHARPS EDGE - Check Edge Tool
 *
 * The core analysis tool. Combines all data sources and edge models
 * into a single confidence-weighted edge score for a game.
 *
 * 8 models total:
 *  1. Line Value     2. RLM          3. Weather      4. Injuries
 *  5. Social         6. Stale Lines  7. Situational  8. Calibration
 *
 * All models now call real data sources (free APIs) instead of returning
 * placeholders. Each model gracefully degrades if its data source fails.
 *
 * This is what the x402 endpoints will serve.
 */

import { Type } from "@sinclair/typebox";

import type { CostTracker } from "../cost-tracker.js";
import {
  VENUES,
  fetchWeatherForVenue,
  calculateImpact,
} from "./get-weather.js";
import {
  fetchTeamInjuries,
  POSITION_IMPACT,
  ROLE_PLAYER_ALERT_POSITIONS,
  INJURY_SPORT_PATHS,
} from "./get-injuries.js";
import { fetchTeamNews, analyzeSignals, SOCIAL_SPORT_PATHS } from "./get-social.js";
import {
  fetchTeamSchedule,
  calculateRestDays,
  calculateScheduleDensity,
  getLastResult,
  haversineDistance,
  getTimezoneOffsetDiff,
  TEAM_TIMEZONES,
  SITUATIONAL_SPORT_PATHS,
} from "./situational.js";
import { loadCalibrationState, findBucket } from "./calibrate.js";
import { fetchWithCache, ODDS_API_BASE } from "./get-odds.js";

export const CheckEdgeSchema = Type.Object(
  {
    sport: Type.String({
      description: "Sport: nfl, nba, mlb, nhl",
    }),
    game: Type.String({
      description:
        "Game identifier: 'AWAY@HOME' format (e.g. DAL@PHI, BOS@NYK). " +
        "Or use an event ID from get_odds.",
    }),
    depth: Type.Optional(
      Type.String({
        description:
          "Analysis depth: 'quick' (lines + RLM only), 'standard' (+ weather + injuries), " +
          "'full' (all models including social). Default: standard",
      }),
    ),
  },
  { additionalProperties: false },
);

type CheckEdgeParams = {
  sport: string;
  game: string;
  depth?: string;
};

// Edge model results
type ModelResult = {
  model: string;
  signal: boolean;
  direction: "home" | "away" | "over" | "under" | "neutral";
  confidence: number; // 0-100
  weight: number;
  reasoning: string;
};

type EdgeAnalysis = {
  game: string;
  sport: string;
  depth: string;
  models_run: number;
  models_fired: number;
  edge_score: number;
  raw_edge_score?: number; // Before calibration overlay
  calibration_applied?: boolean;
  direction: string;
  recommendation: string;
  confidence_tier: string;
  models: ModelResult[];
  caveats: string[];
  disclaimer: string;
};

// Odds API sport key mapping
const ODDS_SPORT_KEYS: Record<string, string> = {
  nfl: "americanfootball_nfl",
  nba: "basketball_nba",
  mlb: "baseball_mlb",
  nhl: "icehockey_nhl",
};

// NFL key numbers: moves through these are significant
const NFL_KEY_NUMBERS = [3, 7, 10, 14];

export function createCheckEdgeTool(costTracker: CostTracker) {
  return {
    name: "check_edge",
    label: "Check Edge",
    description:
      "Run edge detection models against a specific game. Combines line analysis, " +
      "reverse line movement, weather impact, injury context, social signals, " +
      "situational spots, and probability calibration into a confidence-weighted " +
      "edge score. 8 models total. Use depth='quick' for fast checks, 'standard' " +
      "for 6 models, 'full' for all 8. Always includes confidence intervals and caveats.",
    parameters: CheckEdgeSchema,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details: unknown;
    }> {
      const p = params as CheckEdgeParams;
      const depth = p.depth ?? "standard";
      const sport = p.sport.toLowerCase();
      const game = p.game.toUpperCase();

      // Parse game format: "AWAY@HOME"
      const parts = game.split("@");
      const away = parts[0]?.trim().toLowerCase() ?? "";
      const home = parts[1]?.trim().toLowerCase() ?? "";

      if (!away || !home) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "Game must be in 'AWAY@HOME' format (e.g. DAL@PHI)",
              }),
            },
          ],
          details: { error: "Invalid game format" },
        };
      }

      try {
        const models: ModelResult[] = [];
        const caveats: string[] = [];

        // Always run: Line value + RLM (both need odds data)
        // Fetch odds once and share across models that need them
        let oddsData: OddsEvent[] | null = null;
        const apiKey = process.env.THE_ODDS_API_KEY ?? process.env.ODDS_API_KEY;
        if (apiKey) {
          try {
            const oddsSportKey = ODDS_SPORT_KEYS[sport];
            if (oddsSportKey) {
              const url =
                `${ODDS_API_BASE}/sports/${oddsSportKey}/odds` +
                `?apiKey=${apiKey}&markets=h2h,spreads,totals&regions=us,us2&oddsFormat=american`;
              const raw = await fetchWithCache(url, `odds_${oddsSportKey}_h2h,spreads,totals_us,us2`, false, costTracker);
              oddsData = parseOddsEvents(raw);
            }
          } catch {
            caveats.push("Odds API unavailable - line models degraded");
          }
        } else {
          caveats.push("THE_ODDS_API_KEY not set - line models run without live odds");
        }

        // Find the matching game in odds data
        const matchedEvent = oddsData
          ? findGameInOdds(oddsData, away, home)
          : null;

        // Model 1: Line value analysis
        models.push(analyzeLineValue(matchedEvent, sport));

        // Model 2: Reverse line movement (needs betting % - not available on free tier)
        models.push(analyzeRLM(matchedEvent));

        if (depth === "standard" || depth === "full") {
          // Model 3: Weather impact (outdoor sports)
          models.push(await analyzeWeatherImpact(home, sport));

          // Model 4: Injury context
          models.push(await analyzeInjuryContext(away, home, sport));
        }

        if (depth === "full") {
          // Model 5: Social / locker room
          models.push(await analyzeSocialSignals(away, home, sport));

          // Model 6: Stale line detection
          models.push(analyzeStaleLines(matchedEvent));

          // Model 7: Situational spots
          models.push(await analyzeSituationalSpots(away, home, sport));

          // Model 8: Calibration overlay - applied after aggregation
        }

        // Aggregate
        const firedModels = models.filter((m) => m.signal);
        const modelsRun = models.length;
        const modelsFired = firedModels.length;

        let edgeScore = 0;
        let direction = "neutral";

        if (modelsFired > 0) {
          // Check for conflicting directions
          const directions = new Set(firedModels.map((m) => m.direction));
          const hasConflict =
            (directions.has("home") && directions.has("away")) ||
            (directions.has("over") && directions.has("under"));

          // Weighted average of fired models
          const totalWeight = firedModels.reduce((s, m) => s + m.weight, 0);
          edgeScore = Math.round(
            firedModels.reduce((s, m) => s + m.confidence * m.weight, 0) / totalWeight,
          );

          if (hasConflict) {
            edgeScore = Math.round(edgeScore * 0.7); // 30% penalty for conflicting signals
            caveats.push("Models show conflicting directions - confidence reduced 30%");
          }

          // Determine majority direction
          const dirCounts: Record<string, number> = {};
          for (const m of firedModels) {
            dirCounts[m.direction] = (dirCounts[m.direction] ?? 0) + m.weight;
          }
          direction = Object.entries(dirCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "neutral";
        }

        // Model 8: Calibration overlay (post-aggregation correction)
        let rawEdgeScore = edgeScore;
        let calibrationApplied = false;
        if (depth === "full" && edgeScore > 0) {
          const calibration = await applyCalibrationOverlay(edgeScore);
          if (calibration.corrected) {
            rawEdgeScore = edgeScore;
            edgeScore = calibration.calibrated_score;
            calibrationApplied = true;
            models.push({
              model: "calibration_overlay",
              signal: true,
              direction: direction as ModelResult["direction"],
              confidence: edgeScore,
              weight: 0, // Weight 0: doesn't participate in aggregation, only adjusts final score
              reasoning: calibration.reasoning,
            });
          } else {
            models.push({
              model: "calibration_overlay",
              signal: false,
              direction: "neutral",
              confidence: 0,
              weight: 0,
              reasoning: calibration.reasoning,
            });
          }
        }

        // Confidence tier
        let confidenceTier: string;
        let recommendation: string;

        if (edgeScore < 30) {
          confidenceTier = "NO EDGE";
          recommendation = "No actionable edge detected. Pass on this game.";
        } else if (edgeScore < 50) {
          confidenceTier = "MARGINAL";
          recommendation = `Marginal ${direction} lean (${edgeScore}%). Small sample / weak signals. Proceed with caution.`;
          caveats.push("Marginal edges are often noise - requires larger sample to validate");
        } else if (edgeScore < 70) {
          confidenceTier = "MODERATE";
          recommendation = `Moderate ${direction} edge detected (${edgeScore}%). Multiple confirming signals.`;
        } else {
          confidenceTier = "STRONG";
          recommendation = `Strong ${direction} edge (${edgeScore}%). High confidence, multiple converging signals.`;
        }

        // Standard caveats
        if (modelsFired <= 1) {
          caveats.push("Only 1 model fired - single-signal edges are less reliable");
        }

        caveats.push(
          "Edge scores are probabilistic estimates, not predictions. " +
            "Past performance does not guarantee future results.",
        );

        const analysis: EdgeAnalysis = {
          game,
          sport,
          depth,
          models_run: modelsRun,
          models_fired: modelsFired,
          edge_score: edgeScore,
          ...(calibrationApplied ? { raw_edge_score: rawEdgeScore, calibration_applied: true } : {}),
          direction,
          recommendation,
          confidence_tier: confidenceTier,
          models,
          caveats,
          disclaimer:
            "For informational purposes only. Sports betting involves risk. " +
            "Never bet more than you can afford to lose.",
        };

        // Track the analysis cost
        costTracker.trackApiCall("check-edge");

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { label: `Edge analysis: ${game}`, data: analysis },
                null,
                2,
              ),
            },
          ],
          details: analysis,
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: e instanceof Error ? e.message : String(e),
              }),
            },
          ],
          details: { error: e instanceof Error ? e.message : String(e) },
        };
      }
    },
  };
}

// --- Odds data types ---

type OddsBookmaker = {
  key: string;
  title: string;
  markets: Array<{
    key: string; // h2h, spreads, totals
    outcomes: Array<{
      name: string;
      price: number;
      point?: number;
    }>;
  }>;
};

type OddsEvent = {
  id: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  bookmakers: OddsBookmaker[];
};

function parseOddsEvents(raw: unknown): OddsEvent[] {
  if (Array.isArray(raw)) return raw as OddsEvent[];
  if (raw && typeof raw === "object" && "data" in raw) {
    const d = (raw as Record<string, unknown>).data;
    if (Array.isArray(d)) return d as OddsEvent[];
  }
  return [];
}

function findGameInOdds(events: OddsEvent[], away: string, home: string): OddsEvent | null {
  // Match by team abbreviation substring (case-insensitive)
  const awayUpper = away.toUpperCase();
  const homeUpper = home.toUpperCase();
  return events.find((e) => {
    const eHome = e.home_team.toUpperCase();
    const eAway = e.away_team.toUpperCase();
    // Try exact match first, then substring (teams use full names in API)
    return (
      (eAway.includes(awayUpper) || awayUpper.includes(eAway.slice(0, 3))) &&
      (eHome.includes(homeUpper) || homeUpper.includes(eHome.slice(0, 3)))
    );
  }) ?? null;
}

// --- Model 1: Line Value Analysis ---

function analyzeLineValue(event: OddsEvent | null, sport: string): ModelResult {
  if (!event || event.bookmakers.length === 0) {
    return {
      model: "line_value",
      signal: false,
      direction: "neutral",
      confidence: 0,
      weight: 6,
      reasoning: "No odds data available for this game. Set THE_ODDS_API_KEY or check game availability.",
    };
  }

  // Collect spread lines across books
  const spreads: Array<{ book: string; homeSpread: number; awaySpread: number }> = [];
  const totals: Array<{ book: string; total: number }> = [];

  for (const bm of event.bookmakers) {
    for (const market of bm.markets) {
      if (market.key === "spreads") {
        const homeOutcome = market.outcomes.find(
          (o) => o.name.toUpperCase() === event.home_team.toUpperCase(),
        );
        const awayOutcome = market.outcomes.find(
          (o) => o.name.toUpperCase() === event.away_team.toUpperCase(),
        );
        if (homeOutcome?.point != null && awayOutcome?.point != null) {
          spreads.push({ book: bm.key, homeSpread: homeOutcome.point, awaySpread: awayOutcome.point });
        }
      }
      if (market.key === "totals") {
        const over = market.outcomes.find((o) => o.name === "Over");
        if (over?.point != null) {
          totals.push({ book: bm.key, total: over.point });
        }
      }
    }
  }

  if (spreads.length === 0) {
    return {
      model: "line_value",
      signal: false,
      direction: "neutral",
      confidence: 0,
      weight: 6,
      reasoning: "Spread data not available from bookmakers for this game.",
    };
  }

  // Check for spread consensus and key number proximity
  const avgSpread = spreads.reduce((s, x) => s + x.homeSpread, 0) / spreads.length;
  const spreadRange = Math.max(...spreads.map((s) => s.homeSpread)) - Math.min(...spreads.map((s) => s.homeSpread));

  let signal = false;
  let confidence = 0;
  let direction: ModelResult["direction"] = "neutral";
  const reasons: string[] = [];

  // Key number analysis (NFL-specific)
  if (sport === "nfl") {
    for (const kn of NFL_KEY_NUMBERS) {
      // Check if the line is sitting on or near a key number
      if (Math.abs(Math.abs(avgSpread) - kn) < 0.5) {
        reasons.push(`Line at key number ${kn}: moves through this are high-value`);
        confidence += 15;
      }
    }
  }

  // Spread disagreement across books = potential value
  if (spreadRange >= 1.5) {
    signal = true;
    confidence += 25;
    // The side getting more points at some books is the value side
    const maxSpread = Math.max(...spreads.map((s) => s.homeSpread));
    direction = maxSpread > avgSpread ? "home" : "away";
    reasons.push(
      `Spread range ${spreadRange.toFixed(1)} pts across ${spreads.length} books. ` +
        `Shop for best number on ${direction === "home" ? event.home_team : event.away_team}.`,
    );
  }

  // Totals consensus
  if (totals.length >= 2) {
    const avgTotal = totals.reduce((s, x) => s + x.total, 0) / totals.length;
    const totalRange = Math.max(...totals.map((t) => t.total)) - Math.min(...totals.map((t) => t.total));
    if (totalRange >= 1.5) {
      reasons.push(`Total range ${totalRange.toFixed(1)} across books (avg ${avgTotal.toFixed(1)}). Line shopping opportunity.`);
    }
  }

  if (!signal && confidence > 0) {
    signal = true;
  }

  return {
    model: "line_value",
    signal,
    direction,
    confidence: Math.min(confidence, 80),
    weight: 6,
    reasoning: reasons.length > 0
      ? reasons.join(" ")
      : `Consensus spread: ${avgSpread > 0 ? "+" : ""}${avgSpread.toFixed(1)} across ${spreads.length} books. No significant line value detected.`,
  };
}

// --- Model 2: Reverse Line Movement ---

function analyzeRLM(event: OddsEvent | null): ModelResult {
  // RLM requires public betting percentages, which are not available from
  // The Odds API free tier. We detect what we can from multi-book line movement.
  if (!event || event.bookmakers.length < 2) {
    return {
      model: "reverse_line_movement",
      signal: false,
      direction: "neutral",
      confidence: 0,
      weight: 8,
      reasoning:
        "RLM model requires public betting % data (not available on free tier). " +
        "Multi-book comparison insufficient for RLM detection. " +
        "Upgrade to The Odds API paid tier for historical line movement data.",
    };
  }

  // Partial RLM proxy: if spreads across books show unusual divergence patterns,
  // it may indicate sharp money at specific books
  const spreads: Array<{ book: string; homeSpread: number }> = [];
  for (const bm of event.bookmakers) {
    const spreadMkt = bm.markets.find((m) => m.key === "spreads");
    const homeOutcome = spreadMkt?.outcomes.find(
      (o) => o.name.toUpperCase() === event.home_team.toUpperCase(),
    );
    if (homeOutcome?.point != null) {
      spreads.push({ book: bm.key, homeSpread: homeOutcome.point });
    }
  }

  if (spreads.length < 3) {
    return {
      model: "reverse_line_movement",
      signal: false,
      direction: "neutral",
      confidence: 0,
      weight: 8,
      reasoning: "Insufficient book coverage for RLM proxy analysis.",
    };
  }

  // Sharp books (Pinnacle, Circa) vs public books can reveal movement direction
  const sharpBooks = ["pinnacle", "williamhill_us", "lowvig"];
  const sharpLines = spreads.filter((s) => sharpBooks.includes(s.book));
  const publicLines = spreads.filter((s) => !sharpBooks.includes(s.book));

  if (sharpLines.length > 0 && publicLines.length > 0) {
    const sharpAvg = sharpLines.reduce((s, x) => s + x.homeSpread, 0) / sharpLines.length;
    const publicAvg = publicLines.reduce((s, x) => s + x.homeSpread, 0) / publicLines.length;
    const diff = sharpAvg - publicAvg;

    if (Math.abs(diff) >= 1.0) {
      // Sharp books moving differently from public books
      const direction: ModelResult["direction"] = diff > 0 ? "home" : "away";
      return {
        model: "reverse_line_movement",
        signal: true,
        direction,
        confidence: Math.min(Math.round(Math.abs(diff) * 20), 60),
        weight: 8,
        reasoning:
          `Sharp/public book divergence detected: ${Math.abs(diff).toFixed(1)} pts. ` +
          `Sharp books favor ${direction === "home" ? event.home_team : event.away_team}. ` +
          `This is a proxy for RLM - full analysis requires betting % data.`,
      };
    }
  }

  return {
    model: "reverse_line_movement",
    signal: false,
    direction: "neutral",
    confidence: 0,
    weight: 8,
    reasoning:
      `Analyzed ${spreads.length} books. No sharp/public divergence detected. ` +
      "Full RLM requires betting % data from paid tier.",
  };
}

// --- Model 3: Weather Impact ---

async function analyzeWeatherImpact(homeTeam: string, sport: string): Promise<ModelResult> {
  try {
    // Look up venue for home team
    const venue = VENUES[homeTeam];
    if (!venue) {
      return {
        model: "weather_impact",
        signal: false,
        direction: "neutral",
        confidence: 0,
        weight: 7,
        reasoning: `No venue data for '${homeTeam.toUpperCase()}'. Add venue or use get_weather directly.`,
      };
    }

    // Dome = no weather impact
    if (venue.dome) {
      return {
        model: "weather_impact",
        signal: false,
        direction: "neutral",
        confidence: 0,
        weight: 7,
        reasoning: `${venue.name} is a dome. Weather has no impact on this game.`,
      };
    }

    // Fetch real weather data
    const weather = await fetchWeatherForVenue(venue.lat, venue.lon);
    const impact = calculateImpact(weather, sport);

    if (impact.confidence === 0 || impact.total_adjustment === 0) {
      return {
        model: "weather_impact",
        signal: false,
        direction: "neutral",
        confidence: 0,
        weight: 7,
        reasoning:
          `${venue.name}: ${weather.temperature_f}°F, wind ${weather.wind_speed_mph}mph, ` +
          `precip ${weather.precipitation_prob}%. ${impact.factors[0]}`,
      };
    }

    const direction: ModelResult["direction"] = impact.total_adjustment < 0 ? "under" : "over";

    return {
      model: "weather_impact",
      signal: true,
      direction,
      confidence: impact.confidence,
      weight: 7,
      reasoning:
        `${venue.name}: ${weather.temperature_f}°F, wind ${weather.wind_speed_mph}mph ` +
        `(gusts ${weather.wind_gusts_mph}mph), precip ${weather.precipitation_prob}%. ` +
        `${impact.factors.join(". ")}. ${impact.recommendation}`,
    };
  } catch (e) {
    return {
      model: "weather_impact",
      signal: false,
      direction: "neutral",
      confidence: 0,
      weight: 7,
      reasoning: `Weather fetch failed: ${e instanceof Error ? e.message : String(e)}. Model degraded.`,
    };
  }
}

// --- Model 4: Injury Context ---

async function analyzeInjuryContext(
  away: string,
  home: string,
  sport: string,
): Promise<ModelResult> {
  const sportPath = INJURY_SPORT_PATHS[sport];
  if (!sportPath) {
    return {
      model: "injury_context",
      signal: false,
      direction: "neutral",
      confidence: 0,
      weight: 5,
      reasoning: `Unsupported sport '${sport}' for injury analysis.`,
    };
  }

  const sportKey = sportPath.split("/")[1];

  try {
    const [awayInjuries, homeInjuries] = await Promise.all([
      fetchTeamInjuries(sportPath, away.toUpperCase()).catch(() => []),
      fetchTeamInjuries(sportPath, home.toUpperCase()).catch(() => []),
    ]);

    // Analyze edge signals: underpriced injuries
    const analyzeTeam = (injuries: typeof awayInjuries) => {
      let edgeSignalCount = 0;
      let totalImpact = 0;
      const keyMissing: string[] = [];

      for (const inj of injuries) {
        if (inj.status !== "Out" && inj.status !== "Doubtful") continue;

        const posImpact = POSITION_IMPACT[sportKey]?.[inj.position] ?? 3;
        const isRolePlayer = ROLE_PLAYER_ALERT_POSITIONS[sportKey]?.includes(inj.position) ?? false;
        const likelyPriced = posImpact >= 8;

        if (isRolePlayer && !likelyPriced) {
          edgeSignalCount++;
          totalImpact += posImpact;
          keyMissing.push(`${inj.player} (${inj.position}, impact:${posImpact})`);
        } else if (posImpact >= 7) {
          totalImpact += posImpact;
          keyMissing.push(`${inj.player} (${inj.position}, likely priced)`);
        }
      }

      return { edgeSignalCount, totalImpact, keyMissing, total: injuries.length };
    };

    const awayAnalysis = analyzeTeam(awayInjuries);
    const homeAnalysis = analyzeTeam(homeInjuries);

    const awayEdge = awayAnalysis.edgeSignalCount;
    const homeEdge = homeAnalysis.edgeSignalCount;
    const differential = awayEdge - homeEdge; // Positive = away has more underpriced injuries

    if (awayEdge === 0 && homeEdge === 0) {
      return {
        model: "injury_context",
        signal: false,
        direction: "neutral",
        confidence: 0,
        weight: 5,
        reasoning:
          `Away (${away.toUpperCase()}): ${awayAnalysis.total} injuries, 0 underpriced edge signals. ` +
          `Home (${home.toUpperCase()}): ${homeAnalysis.total} injuries, 0 underpriced edge signals. ` +
          "No underpriced role player absences detected.",
      };
    }

    // Direction: the team with MORE underpriced injuries is disadvantaged
    let direction: ModelResult["direction"] = "neutral";
    if (differential > 0) direction = "home"; // Away team weakened = lean home
    else if (differential < 0) direction = "away"; // Home team weakened = lean away

    const confidence = Math.min(
      Math.max(awayEdge, homeEdge) * 15 + Math.abs(differential) * 10,
      70,
    );

    const reasons: string[] = [];
    if (awayAnalysis.keyMissing.length > 0) {
      reasons.push(`${away.toUpperCase()} missing: ${awayAnalysis.keyMissing.join(", ")}`);
    }
    if (homeAnalysis.keyMissing.length > 0) {
      reasons.push(`${home.toUpperCase()} missing: ${homeAnalysis.keyMissing.join(", ")}`);
    }

    return {
      model: "injury_context",
      signal: true,
      direction,
      confidence,
      weight: 5,
      reasoning: reasons.join(". ") + `. Edge signals: away=${awayEdge}, home=${homeEdge}.`,
    };
  } catch (e) {
    return {
      model: "injury_context",
      signal: false,
      direction: "neutral",
      confidence: 0,
      weight: 5,
      reasoning: `Injury fetch failed: ${e instanceof Error ? e.message : String(e)}. Model degraded.`,
    };
  }
}

// --- Model 5: Social Signals ---

async function analyzeSocialSignals(
  away: string,
  home: string,
  sport: string,
): Promise<ModelResult> {
  const sportPath = SOCIAL_SPORT_PATHS[sport];
  if (!sportPath) {
    return {
      model: "social_signals",
      signal: false,
      direction: "neutral",
      confidence: 0,
      weight: 4,
      reasoning: `Unsupported sport '${sport}' for social analysis.`,
    };
  }

  try {
    const [awayArticles, homeArticles] = await Promise.all([
      fetchTeamNews(sportPath, away.toUpperCase()).catch(() => []),
      fetchTeamNews(sportPath, home.toUpperCase()).catch(() => []),
    ]);

    const awaySignals = analyzeSignals(awayArticles);
    const homeSignals = analyzeSignals(homeArticles);

    const awayNegTotal = awaySignals.negative.reduce((s, n) => s + n.weight, 0);
    const awayPosTotal = awaySignals.positive.reduce((s, n) => s + n.weight, 0);
    const homeNegTotal = homeSignals.negative.reduce((s, n) => s + n.weight, 0);
    const homePosTotal = homeSignals.positive.reduce((s, n) => s + n.weight, 0);

    const awayNet = awayPosTotal - awayNegTotal;
    const homeNet = homePosTotal - homeNegTotal;
    const differential = homeNet - awayNet; // Positive = home in better shape

    if (Math.abs(differential) < 3) {
      return {
        model: "social_signals",
        signal: false,
        direction: "neutral",
        confidence: 0,
        weight: 4,
        reasoning:
          `${away.toUpperCase()} sentiment: ${awayNet} (${awayArticles.length} articles). ` +
          `${home.toUpperCase()} sentiment: ${homeNet} (${homeArticles.length} articles). ` +
          "No significant sentiment differential.",
      };
    }

    const direction: ModelResult["direction"] = differential > 0 ? "home" : "away";
    const confidence = Math.min(Math.abs(differential) * 5, 60);

    const reasons: string[] = [];
    if (awaySignals.negative.length > 0) {
      reasons.push(`${away.toUpperCase()} negatives: ${awaySignals.negative.map((s) => s.category).join(", ")}`);
    }
    if (homeSignals.negative.length > 0) {
      reasons.push(`${home.toUpperCase()} negatives: ${homeSignals.negative.map((s) => s.category).join(", ")}`);
    }
    if (awaySignals.positive.length > 0) {
      reasons.push(`${away.toUpperCase()} positives: ${awaySignals.positive.map((s) => s.category).join(", ")}`);
    }
    if (homeSignals.positive.length > 0) {
      reasons.push(`${home.toUpperCase()} positives: ${homeSignals.positive.map((s) => s.category).join(", ")}`);
    }

    return {
      model: "social_signals",
      signal: true,
      direction,
      confidence,
      weight: 4,
      reasoning:
        reasons.join(". ") +
        `. Net sentiment: ${away.toUpperCase()}=${awayNet}, ${home.toUpperCase()}=${homeNet}. ` +
        `Differential favors ${direction === "home" ? home.toUpperCase() : away.toUpperCase()}.`,
    };
  } catch (e) {
    return {
      model: "social_signals",
      signal: false,
      direction: "neutral",
      confidence: 0,
      weight: 4,
      reasoning: `Social fetch failed: ${e instanceof Error ? e.message : String(e)}. Model degraded.`,
    };
  }
}

// --- Model 6: Stale Line Detection ---

function analyzeStaleLines(event: OddsEvent | null): ModelResult {
  if (!event || event.bookmakers.length < 3) {
    return {
      model: "stale_line_detection",
      signal: false,
      direction: "neutral",
      confidence: 0,
      weight: 9,
      reasoning: "Need 3+ books for stale line detection. Insufficient data.",
    };
  }

  // Compare spreads across books - a stale line is one book lagging behind consensus
  const spreads: Array<{ book: string; homeSpread: number }> = [];
  for (const bm of event.bookmakers) {
    const spreadMkt = bm.markets.find((m) => m.key === "spreads");
    const homeOutcome = spreadMkt?.outcomes.find(
      (o) => o.name.toUpperCase() === event.home_team.toUpperCase(),
    );
    if (homeOutcome?.point != null) {
      spreads.push({ book: bm.key, homeSpread: homeOutcome.point });
    }
  }

  if (spreads.length < 3) {
    return {
      model: "stale_line_detection",
      signal: false,
      direction: "neutral",
      confidence: 0,
      weight: 9,
      reasoning: "Insufficient spread data across books for stale line detection.",
    };
  }

  const avg = spreads.reduce((s, x) => s + x.homeSpread, 0) / spreads.length;
  const outliers = spreads.filter((s) => Math.abs(s.homeSpread - avg) >= 2.0);

  if (outliers.length === 0) {
    return {
      model: "stale_line_detection",
      signal: false,
      direction: "neutral",
      confidence: 0,
      weight: 9,
      reasoning:
        `${spreads.length} books checked. All within 2pts of consensus (${avg > 0 ? "+" : ""}${avg.toFixed(1)}). ` +
        "No stale lines detected.",
    };
  }

  // Stale line found: bet the outlier book on the side getting more points than consensus
  const bestOutlier = outliers.sort(
    (a, b) => Math.abs(b.homeSpread - avg) - Math.abs(a.homeSpread - avg),
  )[0];
  const diff = bestOutlier.homeSpread - avg;
  const direction: ModelResult["direction"] = diff > 0 ? "home" : "away";

  return {
    model: "stale_line_detection",
    signal: true,
    direction,
    confidence: Math.min(Math.round(Math.abs(diff) * 15), 75),
    weight: 9,
    reasoning:
      `STALE LINE at ${bestOutlier.book}: ${bestOutlier.homeSpread > 0 ? "+" : ""}${bestOutlier.homeSpread} ` +
      `vs consensus ${avg > 0 ? "+" : ""}${avg.toFixed(1)} (${Math.abs(diff).toFixed(1)}pt gap). ` +
      `Bet ${direction === "home" ? event.home_team : event.away_team} at ${bestOutlier.book} before it moves.`,
  };
}

// --- Model 7: Situational Spots ---

async function analyzeSituationalSpots(
  away: string,
  home: string,
  sport: string,
): Promise<ModelResult> {
  const sportPath = SITUATIONAL_SPORT_PATHS[sport];
  if (!sportPath) {
    return {
      model: "situational_spots",
      signal: false,
      direction: "neutral",
      confidence: 0,
      weight: 6,
      reasoning: `Unsupported sport '${sport}' for situational analysis.`,
    };
  }

  try {
    const gameDate = new Date().toISOString().slice(0, 10);

    const [awaySchedule, homeSchedule] = await Promise.all([
      fetchTeamSchedule(sportPath, away).catch(() => []),
      fetchTeamSchedule(sportPath, home).catch(() => []),
    ]);

    const signals: string[] = [];
    let awayNegScore = 0;
    let homeNegScore = 0;

    // Rest differential
    const awayRest = calculateRestDays(awaySchedule, gameDate);
    const homeRest = calculateRestDays(homeSchedule, gameDate);
    const restDiff = homeRest - awayRest;

    if (Math.abs(restDiff) >= 2) {
      const fatigued = restDiff > 0 ? away : home;
      const score = Math.min(Math.abs(restDiff) * 2, 8);
      if (fatigued === away) awayNegScore += score;
      else homeNegScore += score;
      signals.push(`Rest differential: ${Math.abs(restDiff)} days (${fatigued.toUpperCase()} disadvantaged)`);
    }

    // Back-to-back (NBA/NHL)
    if (sport === "nba" || sport === "nhl") {
      if (awayRest === 0) {
        awayNegScore += 7;
        signals.push(`${away.toUpperCase()} on road back-to-back`);
      }
      if (homeRest === 0) {
        homeNegScore += 5;
        signals.push(`${home.toUpperCase()} on home back-to-back`);
      }

      const awayDensity = calculateScheduleDensity(awaySchedule, gameDate, 4);
      if (awayDensity >= 3) {
        awayNegScore += 6;
        signals.push(`${away.toUpperCase()} playing ${awayDensity}-in-4 nights`);
      }
      const homeDensity = calculateScheduleDensity(homeSchedule, gameDate, 4);
      if (homeDensity >= 3) {
        homeNegScore += 5;
        signals.push(`${home.toUpperCase()} playing ${homeDensity}-in-4 nights`);
      }
    }

    // Travel distance
    const awayGeo = TEAM_TIMEZONES[away];
    const homeGeo = TEAM_TIMEZONES[home];
    if (awayGeo && homeGeo) {
      const dist = haversineDistance(awayGeo.lat, awayGeo.lon, homeGeo.lat, homeGeo.lon);
      if (dist > 1500) {
        const score = dist > 2500 ? 5 : 3;
        awayNegScore += score;
        signals.push(`${away.toUpperCase()} traveled ~${Math.round(dist)} miles`);
      }

      const tzDiff = getTimezoneOffsetDiff(awayGeo.tz, homeGeo.tz);
      if (tzDiff >= 2) {
        awayNegScore += 4;
        signals.push(`${away.toUpperCase()} ${tzDiff}hr timezone disadvantage`);
      }
    }

    // Altitude
    if (home === "den" || home === "col") {
      awayNegScore += 4;
      signals.push("Altitude factor (5,280ft)");
    }

    // NFL Thursday game
    if (sport === "nfl") {
      const gameDay = new Date(gameDate).getDay();
      if (gameDay === 4) {
        signals.push("Thursday game: short week hurts favorites");
      }

      // Letdown spots
      const awayPrev = getLastResult(awaySchedule, gameDate);
      if (awayPrev?.isBlowoutWin) {
        awayNegScore += 5;
        signals.push(`${away.toUpperCase()} letdown spot after blowout win`);
      }
      const homePrev = getLastResult(homeSchedule, gameDate);
      if (homePrev?.isBlowoutWin) {
        homeNegScore += 4;
        signals.push(`${home.toUpperCase()} letdown spot after blowout win`);
      }
    }

    // MLB day-after-night
    if (sport === "mlb") {
      const awayPrev = getLastResult(awaySchedule, gameDate);
      if (awayPrev?.wasNightGame) {
        awayNegScore += 5;
        signals.push(`${away.toUpperCase()} road day after night game`);
      }
    }

    const differential = homeNegScore - awayNegScore;

    if (signals.length === 0 || Math.abs(differential) < 3) {
      return {
        model: "situational_spots",
        signal: false,
        direction: "neutral",
        confidence: 0,
        weight: 6,
        reasoning:
          signals.length > 0
            ? `Spots detected but balanced: ${signals.join("; ")}. No clear edge.`
            : `Rest: away=${awayRest}d, home=${homeRest}d. No significant situational factors.`,
      };
    }

    const direction: ModelResult["direction"] = differential > 0 ? "away" : "home";
    const confidence = Math.min(Math.abs(differential) * 5, 70);

    return {
      model: "situational_spots",
      signal: true,
      direction,
      confidence,
      weight: 6,
      reasoning:
        `${signals.length} situational factors: ${signals.join("; ")}. ` +
        `Negative scores: ${away.toUpperCase()}=${awayNegScore}, ${home.toUpperCase()}=${homeNegScore}. ` +
        `Edge favors ${direction === "home" ? home.toUpperCase() : away.toUpperCase()}.`,
    };
  } catch (e) {
    return {
      model: "situational_spots",
      signal: false,
      direction: "neutral",
      confidence: 0,
      weight: 6,
      reasoning: `Situational fetch failed: ${e instanceof Error ? e.message : String(e)}. Model degraded.`,
    };
  }
}

// --- Model 8: Calibration Overlay ---

async function applyCalibrationOverlay(rawScore: number): Promise<{
  corrected: boolean;
  calibrated_score: number;
  reasoning: string;
}> {
  try {
    const calibrationFile =
      (process.env.HOME ?? "/root") + "/.openclaw/workspace/data/calibration.json";
    const state = await loadCalibrationState(calibrationFile);

    if (!state || Object.keys(state.corrections).length === 0) {
      return {
        corrected: false,
        calibrated_score: rawScore,
        reasoning:
          "No calibration data available. Run `calibrate correct` after 20+ resolved picks. " +
          "Raw score returned unchanged.",
      };
    }

    const bucket = findBucket(rawScore);
    const key = `${bucket.low}-${bucket.high}`;
    const correction = state.corrections[key] ?? 1.0;

    if (correction === 1.0) {
      return {
        corrected: false,
        calibrated_score: rawScore,
        reasoning:
          `Bucket ${key}: correction factor = 1.0 (no adjustment needed or insufficient data).`,
      };
    }

    const calibrated = Math.min(Math.round(rawScore * correction), 99);
    return {
      corrected: true,
      calibrated_score: calibrated,
      reasoning:
        `Calibration applied: ${rawScore}% × ${correction.toFixed(3)} = ${calibrated}%. ` +
        `Status: ${state.status}. Based on ${state.total_calibrated_picks} resolved picks.`,
    };
  } catch {
    return {
      corrected: false,
      calibrated_score: rawScore,
      reasoning: "Calibration file not found or unreadable. Raw score returned.",
    };
  }
}
