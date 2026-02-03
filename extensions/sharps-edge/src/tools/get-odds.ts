/**
 * SHARPS EDGE - Get Odds Tool
 *
 * Fetches current lines from The Odds API with quota-aware caching.
 * 500 calls/month free tier - every call counts.
 */

import { Type } from "@sinclair/typebox";

import type { CostTracker } from "../cost-tracker.js";

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// Cache: sport → { data, fetchedAt }
const cache = new Map<string, { data: unknown; fetchedAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min - lines don't move that fast on free tier

export const GetOddsSchema = Type.Object(
  {
    sport: Type.String({
      description:
        "Sport key (e.g. americanfootball_nfl, basketball_nba, baseball_mlb, icehockey_nhl). Use 'list' to see available sports.",
    }),
    markets: Type.Optional(
      Type.String({
        description:
          "Comma-separated markets: h2h, spreads, totals. Default: h2h,spreads,totals",
      }),
    ),
    regions: Type.Optional(
      Type.String({
        description: "Comma-separated regions: us, us2, eu, uk, au. Default: us",
      }),
    ),
    force_refresh: Type.Optional(
      Type.Boolean({
        description: "Bypass cache and fetch fresh data. Use sparingly (500/mo quota).",
      }),
    ),
  },
  { additionalProperties: false },
);

type GetOddsParams = {
  sport: string;
  markets?: string;
  regions?: string;
  force_refresh?: boolean;
};

export function createGetOddsTool(costTracker: CostTracker) {
  return {
    name: "get_odds",
    label: "Get Odds",
    description:
      "Fetch current betting lines from The Odds API. Returns lines from multiple " +
      "sportsbooks for comparison. QUOTA: 500 calls/month free tier - results are " +
      "cached for 10 minutes. Use sport='list' to see available sports.",
    parameters: GetOddsSchema,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details: unknown;
    }> {
      const p = params as GetOddsParams;
      const apiKey = process.env.THE_ODDS_API_KEY ?? process.env.ODDS_API_KEY;

      if (!apiKey) {
        return err("THE_ODDS_API_KEY not set. Get a free key at https://the-odds-api.com");
      }

      try {
        // List available sports
        if (p.sport === "list") {
          const data = await fetchWithCache(
            `${ODDS_API_BASE}/sports?apiKey=${apiKey}`,
            "sports_list",
            p.force_refresh,
            costTracker,
          );
          return ok(data, "Available sports");
        }

        // Fetch odds for a sport
        const markets = p.markets ?? "h2h,spreads,totals";
        const regions = p.regions ?? "us";
        const url =
          `${ODDS_API_BASE}/sports/${p.sport}/odds` +
          `?apiKey=${apiKey}&markets=${markets}&regions=${regions}&oddsFormat=american`;

        const data = await fetchWithCache(
          url,
          `odds_${p.sport}_${markets}_${regions}`,
          p.force_refresh,
          costTracker,
        );

        return ok(data, `Odds for ${p.sport}`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

async function fetchWithCache(
  url: string,
  cacheKey: string,
  forceRefresh: boolean | undefined,
  costTracker: CostTracker,
): Promise<unknown> {
  // Check cache
  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return { data: cached.data, _cached: true, _age_seconds: Math.round((Date.now() - cached.fetchedAt) / 1000) };
    }
  }

  // Track API usage
  costTracker.trackApiCall("the-odds-api");

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Odds API ${res.status}: ${body}`);
  }

  const data = await res.json();

  // Extract remaining quota from headers
  const remaining = res.headers.get("x-requests-remaining");
  const used = res.headers.get("x-requests-used");
  if (remaining || used) {
    (data as Record<string, unknown>)._quota = {
      remaining: remaining ? Number(remaining) : undefined,
      used: used ? Number(used) : undefined,
    };
  }

  cache.set(cacheKey, { data, fetchedAt: Date.now() });
  return data;
}

function ok(data: unknown, label: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ label, data }, null, 2),
      },
    ],
    details: { label, data },
  };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    details: { error: message },
  };
}
