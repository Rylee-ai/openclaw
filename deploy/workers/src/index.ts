/**
 * SHARPS EDGE API - Cloudflare Worker
 *
 * Production x402 micropayment API for sports betting intelligence.
 * Serves edge analysis from free data sources behind Coinbase x402 paywall.
 *
 * Endpoints:
 *   GET /health       - Service status (free)
 *   GET /sports       - Available sports (free)
 *   GET /quick-check  - Fast odds summary (x402: $0.10)
 *   GET /line-check   - Line movement analysis (x402: $0.25)
 *   GET /full-analysis - Complete 8-model analysis (x402: $1.00)
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { x402, type PricingTier } from "./x402";
import { analyzeEdge, type AnalysisDepth } from "./analysis";
import { OddsClient } from "./odds";
import { WeatherClient } from "./weather";
import { InjuriesClient } from "./injuries";
import { SocialClient } from "./social";
import { SituationalClient } from "./situational";

type Env = {
  CACHE: KVNamespace;
  THE_ODDS_API_KEY: string;
  X402_WALLET_ADDRESS: string;
  X402_VERIFICATION_KEY?: string;
  ENVIRONMENT: string;
};

const app = new Hono<{ Bindings: Env }>();

// CORS for API consumers
app.use("*", cors({ origin: "*" }));

// --- Free endpoints ---

app.get("/health", (c) => {
  return c.json({
    status: "operational",
    service: "sharps-edge-api",
    version: "0.1.0",
    models: 8,
    sports: ["nfl", "nba", "mlb", "nhl"],
    data_sources: {
      odds: "the-odds-api (free tier, 500 req/mo)",
      weather: "open-meteo (free, unlimited)",
      injuries: "espn (free, public)",
      social: "espn news (free, public)",
      situational: "espn schedules (free, public)",
    },
    disclaimer:
      "For informational purposes only. Sports betting involves risk.",
  });
});

app.get("/sports", async (c) => {
  const apiKey = c.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    return c.json({
      sports: ["nfl", "nba", "mlb", "nhl"],
      note: "Static list. Set THE_ODDS_API_KEY for live sport availability.",
    });
  }

  // Check cache
  const cached = await c.env.CACHE.get("sports_list", "json");
  if (cached) return c.json(cached);

  try {
    const resp = await fetch(
      `https://api.the-odds-api.com/v4/sports?apiKey=${apiKey}`,
    );
    const data = await resp.json();
    const sports = (data as Array<{ key: string; title: string; active: boolean }>)
      .filter((s) => s.active)
      .map((s) => ({ key: s.key, title: s.title }));

    const result = { sports, updated_at: new Date().toISOString() };
    await c.env.CACHE.put("sports_list", JSON.stringify(result), {
      expirationTtl: 3600,
    });
    return c.json(result);
  } catch (e) {
    return c.json(
      { sports: ["nfl", "nba", "mlb", "nhl"], error: "Live fetch failed" },
      500,
    );
  }
});

// --- x402 gated endpoints ---

const PRICING: Record<string, PricingTier> = {
  "quick-check": {
    amount: "0.10",
    currency: "USDC",
    network: "base",
    description: "Fast odds summary with line value detection",
  },
  "line-check": {
    amount: "0.25",
    currency: "USDC",
    network: "base",
    description: "Line movement analysis with RLM proxy + stale line detection",
  },
  "full-analysis": {
    amount: "1.00",
    currency: "USDC",
    network: "base",
    description:
      "Complete 8-model edge analysis: lines, weather, injuries, social, situational, calibration",
  },
};

// Quick check: fast odds summary (Models 1-2 only)
app.get("/quick-check", x402("quick-check", PRICING), async (c) => {
  const sport = (c.req.query("sport") ?? "nba").toLowerCase();
  const game = (c.req.query("game") ?? "").toUpperCase();

  if (!game) {
    return c.json(
      { error: "Missing 'game' parameter. Format: AWAY@HOME (e.g. DAL@PHI)" },
      400,
    );
  }

  const result = await analyzeEdge({
    sport,
    game,
    depth: "quick",
    apiKey: c.env.THE_ODDS_API_KEY,
    cache: c.env.CACHE,
  });

  return c.json(result);
});

// Line check: line movement + RLM + stale lines (Models 1-2, 6)
app.get("/line-check", x402("line-check", PRICING), async (c) => {
  const sport = (c.req.query("sport") ?? "nba").toLowerCase();
  const game = (c.req.query("game") ?? "").toUpperCase();

  if (!game) {
    return c.json(
      { error: "Missing 'game' parameter. Format: AWAY@HOME (e.g. DAL@PHI)" },
      400,
    );
  }

  const result = await analyzeEdge({
    sport,
    game,
    depth: "standard",
    apiKey: c.env.THE_ODDS_API_KEY,
    cache: c.env.CACHE,
  });

  return c.json(result);
});

// Full analysis: all 8 models (premium)
app.get("/full-analysis", x402("full-analysis", PRICING), async (c) => {
  const sport = (c.req.query("sport") ?? "nba").toLowerCase();
  const game = (c.req.query("game") ?? "").toUpperCase();

  if (!game) {
    return c.json(
      { error: "Missing 'game' parameter. Format: AWAY@HOME (e.g. DAL@PHI)" },
      400,
    );
  }

  const result = await analyzeEdge({
    sport,
    game,
    depth: "full",
    apiKey: c.env.THE_ODDS_API_KEY,
    cache: c.env.CACHE,
  });

  return c.json(result);
});

// --- Today's games (free, helps discovery) ---

app.get("/games", async (c) => {
  const sport = (c.req.query("sport") ?? "nba").toLowerCase();
  const apiKey = c.env.THE_ODDS_API_KEY;

  if (!apiKey) {
    return c.json({ error: "THE_ODDS_API_KEY not configured" }, 503);
  }

  const SPORT_KEYS: Record<string, string> = {
    nfl: "americanfootball_nfl",
    nba: "basketball_nba",
    mlb: "baseball_mlb",
    nhl: "icehockey_nhl",
  };

  const sportKey = SPORT_KEYS[sport];
  if (!sportKey) {
    return c.json({ error: `Unknown sport: ${sport}` }, 400);
  }

  const cacheKey = `games_${sport}`;
  const cached = await c.env.CACHE.get(cacheKey, "json");
  if (cached) return c.json(cached);

  try {
    const resp = await fetch(
      `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${apiKey}&markets=h2h,spreads&regions=us&oddsFormat=american`,
    );
    const events = (await resp.json()) as Array<{
      id: string;
      home_team: string;
      away_team: string;
      commence_time: string;
    }>;

    const games = events.map((e) => ({
      id: e.id,
      game: `${abbreviate(e.away_team)}@${abbreviate(e.home_team)}`,
      away: e.away_team,
      home: e.home_team,
      time: e.commence_time,
    }));

    const result = {
      sport,
      games,
      count: games.length,
      updated_at: new Date().toISOString(),
    };

    await c.env.CACHE.put(cacheKey, JSON.stringify(result), {
      expirationTtl: 300, // 5 min cache
    });

    return c.json(result);
  } catch (e) {
    return c.json({ error: "Failed to fetch games" }, 500);
  }
});

// Team name to abbreviation (best effort)
function abbreviate(teamName: string): string {
  const parts = teamName.split(" ");
  if (parts.length === 1) return teamName.slice(0, 3).toUpperCase();
  // Use first 3 chars of city/region
  return parts[0].slice(0, 3).toUpperCase();
}

export default app;
