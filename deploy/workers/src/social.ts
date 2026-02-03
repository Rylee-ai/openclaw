/**
 * ESPN News / Social Signals client for Cloudflare Workers.
 * Analyzes team news for sentiment signals that affect games.
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

type Article = { headline: string; published: string };

// Sentiment keyword patterns
const NEGATIVE_PATTERNS: Array<{ pattern: RegExp; category: string; weight: number }> = [
  { pattern: /suspend|suspen/i, category: "suspension", weight: 8 },
  { pattern: /trade request|wants out|demand/i, category: "trade_drama", weight: 6 },
  { pattern: /locker room|rift|feud|conflict|tension/i, category: "locker_room", weight: 7 },
  { pattern: /fire[ds]|dismiss|coach.*out/i, category: "coaching_turmoil", weight: 8 },
  { pattern: /arrest|charge[ds]|legal/i, category: "legal_trouble", weight: 7 },
  { pattern: /blow ?out loss|embarrass|humiliat/i, category: "morale_blow", weight: 5 },
  { pattern: /losing streak|lost \d+ (straight|in a row)/i, category: "losing_streak", weight: 5 },
];

const POSITIVE_PATTERNS: Array<{ pattern: RegExp; category: string; weight: number }> = [
  { pattern: /return.*lineup|back from injury|cleared to play/i, category: "key_return", weight: 6 },
  { pattern: /winning streak|won \d+ (straight|in a row)/i, category: "winning_streak", weight: 4 },
  { pattern: /contract extension|committed/i, category: "commitment", weight: 3 },
  { pattern: /playoff|clinch/i, category: "motivation", weight: 4 },
];

export class SocialClient {
  constructor(private cache: KVNamespace) {}

  async analyzeSignals(away: string, home: string, sport: string): Promise<ModelResult> {
    const sportPath = SPORT_PATHS[sport];
    if (!sportPath) {
      return {
        model: "social_signals", signal: false, direction: "neutral",
        confidence: 0, weight: 4,
        reasoning: `Unsupported sport: ${sport}`,
      };
    }

    const [awayArticles, homeArticles] = await Promise.all([
      this.fetchNews(sportPath, away).catch(() => []),
      this.fetchNews(sportPath, home).catch(() => []),
    ]);

    const awaySent = this.scoreSentiment(awayArticles);
    const homeSent = this.scoreSentiment(homeArticles);

    const awayNet = awaySent.positive - awaySent.negative;
    const homeNet = homeSent.positive - homeSent.negative;
    const diff = homeNet - awayNet;

    if (Math.abs(diff) < 3) {
      return {
        model: "social_signals", signal: false, direction: "neutral",
        confidence: 0, weight: 4,
        reasoning: `${away.toUpperCase()}: ${awayNet} net (${awayArticles.length} articles). ${home.toUpperCase()}: ${homeNet} net. No differential.`,
      };
    }

    const direction: ModelResult["direction"] = diff > 0 ? "home" : "away";
    const confidence = Math.min(Math.abs(diff) * 5, 60);

    const reasons: string[] = [];
    if (awaySent.negCategories.length > 0) reasons.push(`${away.toUpperCase()} negatives: ${awaySent.negCategories.join(", ")}`);
    if (homeSent.negCategories.length > 0) reasons.push(`${home.toUpperCase()} negatives: ${homeSent.negCategories.join(", ")}`);

    return {
      model: "social_signals", signal: true, direction, confidence, weight: 4,
      reasoning: reasons.join(". ") + `. Differential favors ${direction}.`,
    };
  }

  private async fetchNews(sportPath: string, team: string): Promise<Article[]> {
    const cacheKey = `news_${sportPath}_${team}`;
    const cached = await this.cache.get(cacheKey, "json");
    if (cached) return cached as Article[];

    const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/teams/${team}/news`;
    const resp = await fetch(url);
    if (!resp.ok) return [];

    const data = (await resp.json()) as {
      articles?: Array<{ headline: string; published: string }>;
    };

    const articles: Article[] = (data.articles ?? [])
      .slice(0, 10)
      .map((a) => ({ headline: a.headline, published: a.published }));

    await this.cache.put(cacheKey, JSON.stringify(articles), {
      expirationTtl: 3600,
    });

    return articles;
  }

  private scoreSentiment(articles: Article[]) {
    let negative = 0;
    let positive = 0;
    const negCategories: string[] = [];

    for (const article of articles) {
      for (const pat of NEGATIVE_PATTERNS) {
        if (pat.pattern.test(article.headline)) {
          negative += pat.weight;
          if (!negCategories.includes(pat.category)) negCategories.push(pat.category);
        }
      }
      for (const pat of POSITIVE_PATTERNS) {
        if (pat.pattern.test(article.headline)) {
          positive += pat.weight;
        }
      }
    }

    return { negative, positive, negCategories };
  }
}
