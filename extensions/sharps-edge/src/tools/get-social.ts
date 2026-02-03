/**
 * SHARPS EDGE - Social / Locker Room Intelligence Tool
 *
 * Monitors public signals for team chemistry, coaching conflicts,
 * player drama, and motivation factors the market underprices.
 *
 * Sources: ESPN news, public reports.
 * This tool aggregates context the agent uses for edge scoring.
 */

import { Type } from "@sinclair/typebox";

const ESPN_NEWS_BASE = "https://site.api.espn.com/apis/site/v2/sports";

const cache = new Map<string, { data: unknown; fetchedAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min - social signals are slow-moving

// Sentiment keywords and their impact weights
const NEGATIVE_SIGNALS: Array<{ pattern: RegExp; category: string; weight: number }> = [
  // Coaching
  { pattern: /fired|firing|terminated|let go/i, category: "coaching_change", weight: 8 },
  { pattern: /interim\s+(head\s+)?coach/i, category: "coaching_instability", weight: 6 },
  { pattern: /play\s*calling\s*(criticized|questioned|controversy)/i, category: "scheme_conflict", weight: 4 },
  { pattern: /coach.*frustrated|frustrated.*coach/i, category: "coaching_frustration", weight: 5 },

  // Player conflicts
  { pattern: /trade\s+request|requested\s+trade|wants\s+(out|traded)/i, category: "player_wants_out", weight: 7 },
  { pattern: /locker\s*room\s*(issues?|tensions?|divided|rift|drama)/i, category: "locker_room", weight: 7 },
  { pattern: /fight\s*(in|during)\s*(practice|training)/i, category: "team_conflict", weight: 6 },
  { pattern: /benched|benching|demoted/i, category: "player_demotion", weight: 5 },
  { pattern: /suspension|suspended/i, category: "suspension", weight: 6 },
  { pattern: /holdout|hold\s*out|contract\s+dispute/i, category: "contract_dispute", weight: 5 },
  { pattern: /arrest(ed)?|charged\s+with|legal\s+issue/i, category: "off_field_legal", weight: 6 },

  // Motivation / focus
  { pattern: /distracted|distraction|off.?field\s+(issues?|drama)/i, category: "distraction", weight: 4 },
  { pattern: /quit\s+on|gave\s+up|lack\s+of\s+effort/i, category: "effort_concerns", weight: 7 },
  { pattern: /losing\s+streak|lost\s+\d+\s+(straight|consecutive|in\s+a\s+row)/i, category: "losing_skid", weight: 4 },
];

const POSITIVE_SIGNALS: Array<{ pattern: RegExp; category: string; weight: number }> = [
  { pattern: /return(ing|s)?\s+(from|after)\s+injury/i, category: "key_return", weight: 5 },
  { pattern: /cleared\s+to\s+play|activated\s+from/i, category: "key_return", weight: 6 },
  { pattern: /revenge\s+game|facing\s+former\s+team/i, category: "motivation_boost", weight: 3 },
  { pattern: /playoff\s+(clinch|race|implications)/i, category: "high_stakes", weight: 4 },
  { pattern: /elimination\s+game|must.?win/i, category: "desperation", weight: 5 },
  { pattern: /winning\s+streak|won\s+\d+\s+(straight|consecutive|in\s+a\s+row)/i, category: "momentum", weight: 3 },
  { pattern: /new\s+(signing|addition|acquisition)\s+(debut|first\s+game)/i, category: "fresh_talent", weight: 3 },
];

export const GetSocialSchema = Type.Object(
  {
    sport: Type.String({
      description: "Sport: nfl, nba, mlb, nhl",
    }),
    team: Type.String({
      description: "Team abbreviation (e.g. DAL, PHI, BOS)",
    }),
    force_refresh: Type.Optional(
      Type.Boolean({ description: "Bypass cache" }),
    ),
  },
  { additionalProperties: false },
);

type GetSocialParams = {
  sport: string;
  team: string;
  force_refresh?: boolean;
};

const SPORT_PATHS: Record<string, string> = {
  nfl: "football/nfl",
  nba: "basketball/nba",
  mlb: "baseball/mlb",
  nhl: "hockey/nhl",
};

export function createGetSocialTool() {
  return {
    name: "get_social",
    label: "Social / Locker Room Intel",
    description:
      "Scan public ESPN news for team chemistry signals: coaching conflicts, " +
      "player drama, trade requests, locker room issues, motivation factors. " +
      "Returns categorized signals with impact weights. The market underprices " +
      "team chemistry - this is edge. FREE - no API key required.",
    parameters: GetSocialSchema,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details: unknown;
    }> {
      const p = params as GetSocialParams;
      const sportPath = SPORT_PATHS[p.sport.toLowerCase()];

      if (!sportPath) {
        return err(`Unknown sport '${p.sport}'. Options: nfl, nba, mlb, nhl`);
      }

      const team = p.team.toUpperCase();

      try {
        const articles = await fetchTeamNews(sportPath, team, p.force_refresh);
        const signals = analyzeSignals(articles);

        // Net sentiment: negative signals reduce, positive increase
        const negativeTotal = signals.negative.reduce((s, n) => s + n.weight, 0);
        const positiveTotal = signals.positive.reduce((s, n) => s + n.weight, 0);
        const netSentiment = positiveTotal - negativeTotal;

        let assessment: string;
        if (netSentiment <= -10) {
          assessment = "STRONG NEGATIVE: Major dysfunction signals. Market may not fully price this.";
        } else if (netSentiment <= -5) {
          assessment = "MODERATE NEGATIVE: Notable concerns. Check if line has adjusted.";
        } else if (netSentiment >= 5) {
          assessment = "POSITIVE: Momentum/motivation factors present. May boost performance.";
        } else {
          assessment = "NEUTRAL: No strong social signals detected.";
        }

        return ok(
          {
            team,
            sport: p.sport.toLowerCase(),
            articles_scanned: articles.length,
            net_sentiment: netSentiment,
            assessment,
            negative_signals: signals.negative,
            positive_signals: signals.positive,
            recent_headlines: articles.slice(0, 10).map((a) => ({
              headline: a.headline,
              date: a.published,
            })),
          },
          `Social intel: ${team}`,
        );
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

// Exported for use by check-edge orchestrator
export { fetchTeamNews, analyzeSignals, SPORT_PATHS as SOCIAL_SPORT_PATHS };

type Article = {
  headline: string;
  description: string;
  published: string;
};

type Signal = {
  category: string;
  weight: number;
  source_headline: string;
};

async function fetchTeamNews(
  sportPath: string,
  team: string,
  forceRefresh?: boolean,
): Promise<Article[]> {
  const cacheKey = `social_${sportPath}_${team}`;
  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data as Article[];
    }
  }

  const url = `${ESPN_NEWS_BASE}/${sportPath}/teams/${team}/news`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN news API ${res.status} for ${team}`);
  }

  const data = await res.json();
  const articles: Article[] = [];

  try {
    const items = ((data as Record<string, unknown>).articles as Array<Record<string, unknown>>) ?? [];
    for (const item of items) {
      articles.push({
        headline: (item.headline as string) ?? "",
        description: (item.description as string) ?? "",
        published: (item.published as string) ?? "",
      });
    }
  } catch {
    // ESPN shape varies
  }

  cache.set(cacheKey, { data: articles, fetchedAt: Date.now() });
  return articles;
}

function analyzeSignals(articles: Article[]): {
  negative: Signal[];
  positive: Signal[];
} {
  const negative: Signal[] = [];
  const positive: Signal[] = [];

  for (const article of articles) {
    const text = `${article.headline} ${article.description}`;

    for (const sig of NEGATIVE_SIGNALS) {
      if (sig.pattern.test(text)) {
        negative.push({
          category: sig.category,
          weight: sig.weight,
          source_headline: article.headline,
        });
      }
    }

    for (const sig of POSITIVE_SIGNALS) {
      if (sig.pattern.test(text)) {
        positive.push({
          category: sig.category,
          weight: sig.weight,
          source_headline: article.headline,
        });
      }
    }
  }

  // Deduplicate by category (keep highest weight)
  const dedup = (signals: Signal[]): Signal[] => {
    const byCategory = new Map<string, Signal>();
    for (const s of signals) {
      const existing = byCategory.get(s.category);
      if (!existing || s.weight > existing.weight) {
        byCategory.set(s.category, s);
      }
    }
    return Array.from(byCategory.values()).sort((a, b) => b.weight - a.weight);
  };

  return { negative: dedup(negative), positive: dedup(positive) };
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
