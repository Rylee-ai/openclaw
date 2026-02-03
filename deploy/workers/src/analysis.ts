/**
 * Edge Analysis Engine - Cloudflare Worker version
 *
 * Standalone analysis that runs entirely on Cloudflare Workers.
 * Uses fetch() for all data sources (no Node.js deps).
 * Uses KV for caching instead of filesystem.
 *
 * Same 8-model architecture as the OpenClaw plugin version.
 */

import { OddsClient, type OddsEvent } from "./odds";
import { WeatherClient } from "./weather";
import { InjuriesClient } from "./injuries";
import { SocialClient } from "./social";
import { SituationalClient } from "./situational";

export type AnalysisDepth = "quick" | "standard" | "full";

type ModelResult = {
  model: string;
  signal: boolean;
  direction: "home" | "away" | "over" | "under" | "neutral";
  confidence: number;
  weight: number;
  reasoning: string;
};

type AnalysisResult = {
  game: string;
  sport: string;
  depth: string;
  models_run: number;
  models_fired: number;
  edge_score: number;
  direction: string;
  recommendation: string;
  confidence_tier: string;
  models: ModelResult[];
  caveats: string[];
  timestamp: string;
  disclaimer: string;
};

type AnalysisParams = {
  sport: string;
  game: string;
  depth: AnalysisDepth;
  apiKey: string;
  cache: KVNamespace;
};

const NFL_KEY_NUMBERS = [3, 7, 10, 14];

export async function analyzeEdge(params: AnalysisParams): Promise<AnalysisResult> {
  const { sport, game, depth, apiKey, cache } = params;
  const parts = game.split("@");
  const away = parts[0]?.trim().toLowerCase() ?? "";
  const home = parts[1]?.trim().toLowerCase() ?? "";

  if (!away || !home) {
    throw new Error("Game must be in AWAY@HOME format");
  }

  const models: ModelResult[] = [];
  const caveats: string[] = [];

  // Initialize clients
  const oddsClient = new OddsClient(apiKey, cache);
  const weatherClient = new WeatherClient(cache);
  const injuriesClient = new InjuriesClient(cache);
  const socialClient = new SocialClient(cache);
  const situationalClient = new SituationalClient(cache);

  // Fetch odds (shared across models 1, 2, 6)
  let matchedEvent: OddsEvent | null = null;
  try {
    const events = await oddsClient.getOdds(sport);
    matchedEvent = oddsClient.findGame(events, away, home);
  } catch {
    caveats.push("Odds API unavailable - line models degraded");
  }

  // Model 1: Line Value (always runs)
  models.push(analyzeLineValue(matchedEvent, sport));

  // Model 2: RLM proxy (always runs)
  models.push(analyzeRLM(matchedEvent));

  if (depth === "standard" || depth === "full") {
    // Model 3: Weather (parallel with Model 4)
    // Model 4: Injuries
    const [weather, injuries] = await Promise.all([
      weatherClient.analyzeImpact(home, sport).catch((e): ModelResult => ({
        model: "weather_impact",
        signal: false,
        direction: "neutral",
        confidence: 0,
        weight: 7,
        reasoning: `Weather unavailable: ${e instanceof Error ? e.message : String(e)}`,
      })),
      injuriesClient.analyzeContext(away, home, sport).catch((e): ModelResult => ({
        model: "injury_context",
        signal: false,
        direction: "neutral",
        confidence: 0,
        weight: 5,
        reasoning: `Injuries unavailable: ${e instanceof Error ? e.message : String(e)}`,
      })),
    ]);
    models.push(weather, injuries);
  }

  if (depth === "full") {
    // Models 5, 6, 7 in parallel
    const [social, situational] = await Promise.all([
      socialClient.analyzeSignals(away, home, sport).catch((e): ModelResult => ({
        model: "social_signals",
        signal: false,
        direction: "neutral",
        confidence: 0,
        weight: 4,
        reasoning: `Social unavailable: ${e instanceof Error ? e.message : String(e)}`,
      })),
      situationalClient.analyzeSpots(away, home, sport).catch((e): ModelResult => ({
        model: "situational_spots",
        signal: false,
        direction: "neutral",
        confidence: 0,
        weight: 6,
        reasoning: `Situational unavailable: ${e instanceof Error ? e.message : String(e)}`,
      })),
    ]);

    models.push(social);
    models.push(analyzeStaleLines(matchedEvent));
    models.push(situational);
  }

  // Aggregate
  const firedModels = models.filter((m) => m.signal);
  const modelsRun = models.length;
  const modelsFired = firedModels.length;

  let edgeScore = 0;
  let direction = "neutral";

  if (modelsFired > 0) {
    const directions = new Set(firedModels.map((m) => m.direction));
    const hasConflict =
      (directions.has("home") && directions.has("away")) ||
      (directions.has("over") && directions.has("under"));

    const totalWeight = firedModels.reduce((s, m) => s + m.weight, 0);
    edgeScore = Math.round(
      firedModels.reduce((s, m) => s + m.confidence * m.weight, 0) / totalWeight,
    );

    if (hasConflict) {
      edgeScore = Math.round(edgeScore * 0.7);
      caveats.push("Conflicting model directions - confidence reduced 30%");
    }

    const dirCounts: Record<string, number> = {};
    for (const m of firedModels) {
      dirCounts[m.direction] = (dirCounts[m.direction] ?? 0) + m.weight;
    }
    direction =
      Object.entries(dirCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "neutral";
  }

  // Confidence tier
  let confidenceTier: string;
  let recommendation: string;

  if (edgeScore < 30) {
    confidenceTier = "NO_EDGE";
    recommendation = "No actionable edge. Pass.";
  } else if (edgeScore < 50) {
    confidenceTier = "MARGINAL";
    recommendation = `Marginal ${direction} lean (${edgeScore}%). Proceed with caution.`;
    caveats.push("Marginal edges are often noise");
  } else if (edgeScore < 70) {
    confidenceTier = "MODERATE";
    recommendation = `Moderate ${direction} edge (${edgeScore}%). Multiple confirming signals.`;
  } else {
    confidenceTier = "STRONG";
    recommendation = `Strong ${direction} edge (${edgeScore}%). High confidence.`;
  }

  if (modelsFired <= 1) {
    caveats.push("Single-signal edge - less reliable");
  }

  caveats.push("Probabilistic estimates, not predictions. Past performance does not guarantee future results.");

  return {
    game,
    sport,
    depth,
    models_run: modelsRun,
    models_fired: modelsFired,
    edge_score: edgeScore,
    direction,
    recommendation,
    confidence_tier: confidenceTier,
    models,
    caveats,
    timestamp: new Date().toISOString(),
    disclaimer:
      "For informational purposes only. Sports betting involves risk. Never bet more than you can afford to lose.",
  };
}

// --- Line Value (Model 1) ---

function analyzeLineValue(event: OddsEvent | null, sport: string): ModelResult {
  if (!event || event.bookmakers.length === 0) {
    return {
      model: "line_value", signal: false, direction: "neutral",
      confidence: 0, weight: 6,
      reasoning: "No odds data available.",
    };
  }

  const spreads: Array<{ book: string; homeSpread: number }> = [];
  for (const bm of event.bookmakers) {
    for (const market of bm.markets) {
      if (market.key === "spreads") {
        const home = market.outcomes.find(
          (o) => o.name.toUpperCase() === event.home_team.toUpperCase(),
        );
        if (home?.point != null) {
          spreads.push({ book: bm.key, homeSpread: home.point });
        }
      }
    }
  }

  if (spreads.length === 0) {
    return {
      model: "line_value", signal: false, direction: "neutral",
      confidence: 0, weight: 6, reasoning: "No spread data.",
    };
  }

  const avg = spreads.reduce((s, x) => s + x.homeSpread, 0) / spreads.length;
  const range = Math.max(...spreads.map((s) => s.homeSpread)) - Math.min(...spreads.map((s) => s.homeSpread));

  let confidence = 0;
  let signal = false;
  let direction: ModelResult["direction"] = "neutral";
  const reasons: string[] = [];

  if (sport === "nfl") {
    for (const kn of NFL_KEY_NUMBERS) {
      if (Math.abs(Math.abs(avg) - kn) < 0.5) {
        reasons.push(`Line at key number ${kn}`);
        confidence += 15;
      }
    }
  }

  if (range >= 1.5) {
    signal = true;
    confidence += 25;
    const maxSpread = Math.max(...spreads.map((s) => s.homeSpread));
    direction = maxSpread > avg ? "home" : "away";
    reasons.push(
      `${range.toFixed(1)}pt spread range across ${spreads.length} books`,
    );
  }

  if (!signal && confidence > 0) signal = true;

  return {
    model: "line_value", signal, direction,
    confidence: Math.min(confidence, 80), weight: 6,
    reasoning: reasons.length > 0 ? reasons.join(". ") : `Consensus ${avg > 0 ? "+" : ""}${avg.toFixed(1)}. No edge.`,
  };
}

// --- RLM Proxy (Model 2) ---

function analyzeRLM(event: OddsEvent | null): ModelResult {
  if (!event || event.bookmakers.length < 3) {
    return {
      model: "reverse_line_movement", signal: false, direction: "neutral",
      confidence: 0, weight: 8,
      reasoning: "Insufficient data for RLM proxy. Needs 3+ books.",
    };
  }

  const spreads: Array<{ book: string; homeSpread: number }> = [];
  for (const bm of event.bookmakers) {
    const mkt = bm.markets.find((m) => m.key === "spreads");
    const home = mkt?.outcomes.find(
      (o) => o.name.toUpperCase() === event.home_team.toUpperCase(),
    );
    if (home?.point != null) spreads.push({ book: bm.key, homeSpread: home.point });
  }

  const sharpBooks = ["pinnacle", "williamhill_us", "lowvig"];
  const sharp = spreads.filter((s) => sharpBooks.includes(s.book));
  const pub = spreads.filter((s) => !sharpBooks.includes(s.book));

  if (sharp.length > 0 && pub.length > 0) {
    const sharpAvg = sharp.reduce((s, x) => s + x.homeSpread, 0) / sharp.length;
    const pubAvg = pub.reduce((s, x) => s + x.homeSpread, 0) / pub.length;
    const diff = sharpAvg - pubAvg;

    if (Math.abs(diff) >= 1.0) {
      const dir: ModelResult["direction"] = diff > 0 ? "home" : "away";
      return {
        model: "reverse_line_movement", signal: true, direction: dir,
        confidence: Math.min(Math.round(Math.abs(diff) * 20), 60), weight: 8,
        reasoning: `Sharp/public divergence: ${Math.abs(diff).toFixed(1)}pts. Sharp books favor ${dir}.`,
      };
    }
  }

  return {
    model: "reverse_line_movement", signal: false, direction: "neutral",
    confidence: 0, weight: 8,
    reasoning: `${spreads.length} books. No sharp/public divergence.`,
  };
}

// --- Stale Lines (Model 6) ---

function analyzeStaleLines(event: OddsEvent | null): ModelResult {
  if (!event || event.bookmakers.length < 3) {
    return {
      model: "stale_line_detection", signal: false, direction: "neutral",
      confidence: 0, weight: 9, reasoning: "Need 3+ books.",
    };
  }

  const spreads: Array<{ book: string; homeSpread: number }> = [];
  for (const bm of event.bookmakers) {
    const mkt = bm.markets.find((m) => m.key === "spreads");
    const home = mkt?.outcomes.find(
      (o) => o.name.toUpperCase() === event.home_team.toUpperCase(),
    );
    if (home?.point != null) spreads.push({ book: bm.key, homeSpread: home.point });
  }

  if (spreads.length < 3) {
    return {
      model: "stale_line_detection", signal: false, direction: "neutral",
      confidence: 0, weight: 9, reasoning: "Insufficient spread data.",
    };
  }

  const avg = spreads.reduce((s, x) => s + x.homeSpread, 0) / spreads.length;
  const outliers = spreads.filter((s) => Math.abs(s.homeSpread - avg) >= 2.0);

  if (outliers.length === 0) {
    return {
      model: "stale_line_detection", signal: false, direction: "neutral",
      confidence: 0, weight: 9,
      reasoning: `${spreads.length} books within 2pts of consensus.`,
    };
  }

  const best = outliers.sort(
    (a, b) => Math.abs(b.homeSpread - avg) - Math.abs(a.homeSpread - avg),
  )[0];
  const diff = best.homeSpread - avg;
  const dir: ModelResult["direction"] = diff > 0 ? "home" : "away";

  return {
    model: "stale_line_detection", signal: true, direction: dir,
    confidence: Math.min(Math.round(Math.abs(diff) * 15), 75), weight: 9,
    reasoning: `STALE at ${best.book}: ${Math.abs(diff).toFixed(1)}pt gap vs consensus.`,
  };
}
