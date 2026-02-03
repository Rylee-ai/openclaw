/**
 * ESPN Injuries client for Cloudflare Workers.
 * Free public API, cached in KV.
 */

type ModelResult = {
  model: string;
  signal: boolean;
  direction: "home" | "away" | "over" | "under" | "neutral";
  confidence: number;
  weight: number;
  reasoning: string;
};

type Injury = {
  player: string;
  position: string;
  status: string;
};

const SPORT_PATHS: Record<string, string> = {
  nfl: "football/nfl",
  nba: "basketball/nba",
  mlb: "baseball/mlb",
  nhl: "hockey/nhl",
};

// Underpriced role player positions (market focuses on stars, misses these)
const ROLE_POSITIONS: Record<string, string[]> = {
  nfl: ["OL", "OT", "OG", "C", "CB", "S", "LB", "DT", "DE", "TE"],
  nba: ["PF", "C", "SG"],
  mlb: ["RP", "CP", "C", "SS"],
  nhl: ["D", "G"],
};

const POSITION_IMPACT: Record<string, Record<string, number>> = {
  nfl: { QB: 10, RB: 7, WR: 6, TE: 5, OL: 6, OT: 6, OG: 5, C: 5, CB: 6, S: 5, LB: 5, DT: 4, DE: 5 },
  nba: { PG: 8, SG: 7, SF: 7, PF: 6, C: 7 },
  mlb: { SP: 9, RP: 5, CP: 6, C: 5, SS: 5, CF: 5 },
  nhl: { C: 7, LW: 6, RW: 6, D: 6, G: 9 },
};

export class InjuriesClient {
  constructor(private cache: KVNamespace) {}

  async analyzeContext(away: string, home: string, sport: string): Promise<ModelResult> {
    const sportPath = SPORT_PATHS[sport];
    if (!sportPath) {
      return {
        model: "injury_context", signal: false, direction: "neutral",
        confidence: 0, weight: 5,
        reasoning: `Unsupported sport: ${sport}`,
      };
    }

    const sportKey = sport;

    const [awayInj, homeInj] = await Promise.all([
      this.fetchInjuries(sportPath, away).catch(() => []),
      this.fetchInjuries(sportPath, home).catch(() => []),
    ]);

    const awayEdge = this.countEdgeSignals(awayInj, sportKey);
    const homeEdge = this.countEdgeSignals(homeInj, sportKey);
    const diff = awayEdge.count - homeEdge.count;

    if (awayEdge.count === 0 && homeEdge.count === 0) {
      return {
        model: "injury_context", signal: false, direction: "neutral",
        confidence: 0, weight: 5,
        reasoning: `Away: ${awayInj.length} injuries, Home: ${homeInj.length} injuries. No underpriced signals.`,
      };
    }

    let direction: ModelResult["direction"] = "neutral";
    if (diff > 0) direction = "home";
    else if (diff < 0) direction = "away";

    const confidence = Math.min(
      Math.max(awayEdge.count, homeEdge.count) * 15 + Math.abs(diff) * 10,
      70,
    );

    const reasons: string[] = [];
    if (awayEdge.missing.length > 0) reasons.push(`${away.toUpperCase()} missing: ${awayEdge.missing.join(", ")}`);
    if (homeEdge.missing.length > 0) reasons.push(`${home.toUpperCase()} missing: ${homeEdge.missing.join(", ")}`);

    return {
      model: "injury_context", signal: true, direction, confidence, weight: 5,
      reasoning: reasons.join(". ") + `. Edge signals: away=${awayEdge.count}, home=${homeEdge.count}.`,
    };
  }

  private async fetchInjuries(sportPath: string, team: string): Promise<Injury[]> {
    const cacheKey = `injuries_${sportPath}_${team}`;
    const cached = await this.cache.get(cacheKey, "json");
    if (cached) return cached as Injury[];

    const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/teams/${team}/injuries`;
    const resp = await fetch(url);
    if (!resp.ok) return [];

    const data = (await resp.json()) as {
      team?: { injuries?: Array<{ athlete: { displayName: string; position: { abbreviation: string } }; status: string }> };
    };

    const injuries: Injury[] = (data.team?.injuries ?? []).map((i) => ({
      player: i.athlete.displayName,
      position: i.athlete.position.abbreviation,
      status: i.status,
    }));

    await this.cache.put(cacheKey, JSON.stringify(injuries), {
      expirationTtl: 1800,
    });

    return injuries;
  }

  private countEdgeSignals(injuries: Injury[], sport: string) {
    let count = 0;
    const missing: string[] = [];

    for (const inj of injuries) {
      if (inj.status !== "Out" && inj.status !== "Doubtful") continue;
      const impact = POSITION_IMPACT[sport]?.[inj.position] ?? 3;
      const isRole = ROLE_POSITIONS[sport]?.includes(inj.position) ?? false;
      const likelyPriced = impact >= 8;

      if (isRole && !likelyPriced) {
        count++;
        missing.push(`${inj.player} (${inj.position})`);
      }
    }

    return { count, missing };
  }
}
