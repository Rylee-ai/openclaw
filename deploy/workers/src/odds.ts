/**
 * The Odds API client for Cloudflare Workers.
 * Uses KV for caching to stay within the 500 req/mo free tier.
 */

const API_BASE = "https://api.the-odds-api.com/v4";
const CACHE_TTL = 600; // 10 minutes

const SPORT_KEYS: Record<string, string> = {
  nfl: "americanfootball_nfl",
  nba: "basketball_nba",
  mlb: "baseball_mlb",
  nhl: "icehockey_nhl",
};

export type OddsEvent = {
  id: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  bookmakers: Array<{
    key: string;
    title: string;
    markets: Array<{
      key: string;
      outcomes: Array<{
        name: string;
        price: number;
        point?: number;
      }>;
    }>;
  }>;
};

export class OddsClient {
  constructor(
    private apiKey: string,
    private cache: KVNamespace,
  ) {}

  async getOdds(sport: string): Promise<OddsEvent[]> {
    const sportKey = SPORT_KEYS[sport];
    if (!sportKey) return [];

    const cacheKey = `odds_${sport}`;
    const cached = await this.cache.get(cacheKey, "json");
    if (cached) return cached as OddsEvent[];

    if (!this.apiKey) return [];

    const url =
      `${API_BASE}/sports/${sportKey}/odds` +
      `?apiKey=${this.apiKey}&markets=h2h,spreads,totals&regions=us,us2&oddsFormat=american`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Odds API: ${resp.status}`);

    const data = (await resp.json()) as OddsEvent[];
    await this.cache.put(cacheKey, JSON.stringify(data), {
      expirationTtl: CACHE_TTL,
    });

    return data;
  }

  findGame(events: OddsEvent[], away: string, home: string): OddsEvent | null {
    const awayUp = away.toUpperCase();
    const homeUp = home.toUpperCase();
    return (
      events.find((e) => {
        const eHome = e.home_team.toUpperCase();
        const eAway = e.away_team.toUpperCase();
        return (
          (eAway.includes(awayUp) || awayUp.includes(eAway.slice(0, 3))) &&
          (eHome.includes(homeUp) || homeUp.includes(eHome.slice(0, 3)))
        );
      }) ?? null
    );
  }
}
