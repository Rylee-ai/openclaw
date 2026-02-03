/**
 * SHARPS EDGE - Get Injuries Tool
 *
 * Fetches injury reports from ESPN public endpoints.
 * Surfaces role player injuries the market underprices.
 * FREE - no key required.
 */

import { Type } from "@sinclair/typebox";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

// Cache: sport/team → { data, fetchedAt }
const cache = new Map<string, { data: unknown; fetchedAt: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min - injury reports update periodically

// Position impact tiers: how much a position absence affects the line
// These are the underpriced positions the public ignores
const POSITION_IMPACT: Record<string, Record<string, number>> = {
  nfl: {
    QB: 10, // Fully priced by market
    RB: 4,
    WR: 3,
    TE: 2,
    OL: 6, // Underpriced - huge impact on run/pass game
    OT: 7, // Underpriced
    OG: 5, // Underpriced
    C: 5, // Underpriced
    DL: 4,
    DE: 4,
    DT: 3,
    LB: 3,
    CB: 5, // Underpriced when facing elite WRs
    S: 3,
    K: 3, // Underpriced in close games
    P: 2,
  },
  nba: {
    PG: 7,
    SG: 5,
    SF: 5,
    PF: 5,
    C: 6,
  },
  mlb: {
    SP: 9, // Starting pitcher fully priced
    RP: 4, // Bullpen underpriced
    CP: 6, // Closer underpriced
    C: 3,
    "1B": 2,
    "2B": 3,
    SS: 4,
    "3B": 3,
    LF: 2,
    CF: 3,
    RF: 2,
    DH: 2,
  },
};

// High-impact role players: positions where backup quality matters most
const ROLE_PLAYER_ALERT_POSITIONS: Record<string, string[]> = {
  nfl: ["OL", "OT", "OG", "C", "CB", "K"],
  mlb: ["RP", "CP"],
  nba: [], // NBA is more star-driven
};

export const GetInjuriesSchema = Type.Object(
  {
    sport: Type.String({
      description:
        "Sport: football/nfl, basketball/nba, baseball/mlb, hockey/nhl",
    }),
    team: Type.Optional(
      Type.String({
        description: "Team abbreviation (e.g. DAL, PHI, BOS). Omit for league-wide.",
      }),
    ),
    force_refresh: Type.Optional(
      Type.Boolean({ description: "Bypass cache." }),
    ),
  },
  { additionalProperties: false },
);

type GetInjuriesParams = {
  sport: string;
  team?: string;
  force_refresh?: boolean;
};

// ESPN sport path mapping
const SPORT_PATHS: Record<string, string> = {
  nfl: "football/nfl",
  football: "football/nfl",
  nba: "basketball/nba",
  basketball: "basketball/nba",
  mlb: "baseball/mlb",
  baseball: "baseball/mlb",
  nhl: "hockey/nhl",
  hockey: "hockey/nhl",
};

export function createGetInjuriesTool() {
  return {
    name: "get_injuries",
    label: "Get Injuries",
    description:
      "Fetch injury reports from ESPN. Highlights role player injuries that the " +
      "market underprices (O-line, bullpen, corners). Each injury includes a " +
      "position impact score and whether it's likely already priced into the line. " +
      "FREE - no API key required.",
    parameters: GetInjuriesSchema,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details: unknown;
    }> {
      const p = params as GetInjuriesParams;
      const sportPath = SPORT_PATHS[p.sport.toLowerCase()];

      if (!sportPath) {
        return err(
          `Unknown sport '${p.sport}'. Options: nfl, nba, mlb, nhl`,
        );
      }

      const sportKey = sportPath.split("/")[1]; // nfl, nba, etc.

      try {
        // Fetch team or league injuries
        let injuries: InjuryEntry[];

        if (p.team) {
          injuries = await fetchTeamInjuries(sportPath, p.team.toUpperCase(), p.force_refresh);
        } else {
          injuries = await fetchLeagueInjuries(sportPath, p.force_refresh);
        }

        // Enrich with impact analysis
        const analyzed = injuries.map((inj) => {
          const posImpact = POSITION_IMPACT[sportKey]?.[inj.position] ?? 3;
          const isRolePlayer = ROLE_PLAYER_ALERT_POSITIONS[sportKey]?.includes(inj.position) ?? false;

          // Star players (impact >= 8) are priced in. Role players are the edge.
          const likelyPriced = posImpact >= 8 && inj.status === "Out";
          const edgeSignal = isRolePlayer && !likelyPriced;

          return {
            ...inj,
            position_impact: posImpact,
            likely_priced_in: likelyPriced,
            edge_signal: edgeSignal,
            note: edgeSignal
              ? `UNDERPRICED: ${inj.position} absence often missed by market`
              : likelyPriced
                ? "Likely priced in - star/key position, status known"
                : "Monitor - moderate market awareness",
          };
        });

        // Sort: edge signals first, then by impact
        analyzed.sort((a, b) => {
          if (a.edge_signal && !b.edge_signal) return -1;
          if (!a.edge_signal && b.edge_signal) return 1;
          return b.position_impact - a.position_impact;
        });

        const edgeCount = analyzed.filter((a) => a.edge_signal).length;

        return ok(
          {
            sport: sportKey,
            team: p.team?.toUpperCase() ?? "ALL",
            total_injuries: analyzed.length,
            edge_signals: edgeCount,
            injuries: analyzed,
          },
          `Injuries: ${p.team?.toUpperCase() ?? sportKey.toUpperCase()}`,
        );
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

// Exported for use by check-edge orchestrator
export { fetchTeamInjuries, POSITION_IMPACT, ROLE_PLAYER_ALERT_POSITIONS, SPORT_PATHS as INJURY_SPORT_PATHS };
export type { InjuryEntry };

type InjuryEntry = {
  player: string;
  team: string;
  position: string;
  status: string; // Out, Doubtful, Questionable, Probable
  injury: string;
  updated: string;
};

async function fetchTeamInjuries(
  sportPath: string,
  team: string,
  forceRefresh?: boolean,
): Promise<InjuryEntry[]> {
  const cacheKey = `injuries_${sportPath}_${team}`;
  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data as InjuryEntry[];
    }
  }

  // ESPN teams endpoint with injuries
  const url = `${ESPN_BASE}/${sportPath}/teams/${team}?enable=injuries`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN API ${res.status} for team ${team}`);
  }

  const data = await res.json();
  const injuries = parseEspnInjuries(data, team);
  cache.set(cacheKey, { data: injuries, fetchedAt: Date.now() });
  return injuries;
}

async function fetchLeagueInjuries(
  sportPath: string,
  forceRefresh?: boolean,
): Promise<InjuryEntry[]> {
  const cacheKey = `injuries_${sportPath}_all`;
  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data as InjuryEntry[];
    }
  }

  const url = `${ESPN_BASE}/${sportPath}/injuries`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN API ${res.status} for league injuries`);
  }

  const data = await res.json();
  const injuries = parseEspnLeagueInjuries(data);
  cache.set(cacheKey, { data: injuries, fetchedAt: Date.now() });
  return injuries;
}

function parseEspnInjuries(data: Record<string, unknown>, teamAbbr: string): InjuryEntry[] {
  const results: InjuryEntry[] = [];
  try {
    const team = data.team as Record<string, unknown> | undefined;
    const injuries = (team?.injuries as Array<Record<string, unknown>>) ?? [];

    for (const group of injuries) {
      const items = (group.items as Array<Record<string, unknown>>) ?? [];
      for (const item of items) {
        const athlete = item.athlete as Record<string, unknown> | undefined;
        results.push({
          player: (athlete?.displayName as string) ?? "Unknown",
          team: teamAbbr,
          position: (athlete?.position as Record<string, unknown>)?.abbreviation as string ?? "??",
          status: (item.status as string) ?? "Unknown",
          injury: (item.longComment as string) ?? (item.shortComment as string) ?? "",
          updated: (item.date as string) ?? "",
        });
      }
    }
  } catch {
    // ESPN API shape varies - return what we got
  }
  return results;
}

function parseEspnLeagueInjuries(data: Record<string, unknown>): InjuryEntry[] {
  const results: InjuryEntry[] = [];
  try {
    const groups = (data.items as Array<Record<string, unknown>>) ?? [];
    for (const group of groups) {
      const teamData = group.team as Record<string, unknown> | undefined;
      const teamAbbr = (teamData?.abbreviation as string) ?? "??";
      const injuries = (group.injuries as Array<Record<string, unknown>>) ?? [];

      for (const item of injuries) {
        const athlete = item.athlete as Record<string, unknown> | undefined;
        results.push({
          player: (athlete?.displayName as string) ?? "Unknown",
          team: teamAbbr,
          position: (athlete?.position as Record<string, unknown>)?.abbreviation as string ?? "??",
          status: (item.status as string) ?? "Unknown",
          injury: (item.longComment as string) ?? (item.shortComment as string) ?? "",
          updated: (item.date as string) ?? "",
        });
      }
    }
  } catch {
    // ESPN API shape varies
  }
  return results;
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
