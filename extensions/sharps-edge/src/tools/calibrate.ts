/**
 * SHARPS EDGE - Probability Calibration Engine
 *
 * The trust engine. Tracks whether our confidence predictions match reality.
 * If we say "65% confident" and win 65% of those picks, we're calibrated.
 * If not, we apply corrections.
 *
 * Calibrated probability IS the product. x402 customers pay because they
 * trust the number. This tool earns that trust mathematically.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { Type } from "@sinclair/typebox";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export const CalibrateSchema = Type.Object(
  {
    action: Type.Unsafe<"check" | "report" | "adjust" | "correct">({
      type: "string",
      enum: ["check", "report", "adjust", "correct"],
      description:
        "Action: 'check' current calibration status, 'report' full calibration " +
        "breakdown by bucket, 'adjust' apply corrections to future predictions, " +
        "'correct' recalculate correction factors from all data",
    }),
    confidence: Type.Optional(
      Type.Number({
        description:
          "For 'check': a raw confidence value (0-100) to get the calibrated version",
      }),
    ),
    period: Type.Optional(
      Type.String({ description: "Period: 'month', 'all'. Default: all" }),
    ),
  },
  { additionalProperties: false },
);

// Calibration buckets: predicted confidence → actual win rate
type CalibrationBucket = {
  range_low: number;
  range_high: number;
  midpoint: number;
  total_picks: number;
  wins: number;
  losses: number;
  pushes: number;
  actual_win_rate: number;
  predicted_midpoint: number;
  calibration_error: number; // |actual - predicted|
  correction_factor: number; // actual / predicted (multiply raw confidence by this)
};

type CalibrationState = {
  last_updated: string;
  total_calibrated_picks: number;
  overall_error: number;
  status: "calibrated" | "acceptable" | "needs_work" | "miscalibrated" | "insufficient_data";
  buckets: CalibrationBucket[];
  corrections: Record<string, number>; // "50-55" → correction factor
};

type Pick = {
  id: string;
  timestamp: string;
  edge_score: number;
  outcome?: "win" | "loss" | "push";
};

const BUCKET_RANGES = [
  { low: 30, high: 40 },
  { low: 40, high: 50 },
  { low: 50, high: 55 },
  { low: 55, high: 60 },
  { low: 60, high: 65 },
  { low: 65, high: 70 },
  { low: 70, high: 80 },
  { low: 80, high: 100 },
];

export function createCalibrateTool(api: OpenClawPluginApi) {
  const dataDir = api.resolvePath("~/.openclaw/workspace/data");
  const picksDir = path.join(dataDir, "picks");
  const calibrationFile = path.join(dataDir, "calibration.json");

  return {
    name: "calibrate",
    label: "Probability Calibration",
    description:
      "The trust engine. Checks whether predicted confidence matches actual outcomes. " +
      "Use 'check' to get calibrated confidence for a raw value. Use 'report' for " +
      "full breakdown. Use 'correct' to recalculate from all data. Use 'adjust' " +
      "to apply corrections. Calibrated probability is what x402 customers pay for.",
    parameters: CalibrateSchema,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details: unknown;
    }> {
      const action = params.action as string;

      try {
        await fs.mkdir(dataDir, { recursive: true });

        switch (action) {
          case "check": {
            const rawConfidence = params.confidence as number;
            if (rawConfidence == null) {
              return err("Provide 'confidence' (0-100) to get calibrated value");
            }

            // Load current corrections
            const state = await loadCalibrationState(calibrationFile);
            const bucket = findBucket(rawConfidence);
            const key = `${bucket.low}-${bucket.high}`;
            const correction = state?.corrections[key] ?? 1.0;
            const calibrated = Math.min(Math.round(rawConfidence * correction), 99);

            return ok(
              {
                raw_confidence: rawConfidence,
                calibrated_confidence: calibrated,
                correction_factor: correction,
                bucket: key,
                data_points: state?.buckets.find(
                  (b) => b.range_low === bucket.low,
                )?.total_picks ?? 0,
                note:
                  correction === 1.0
                    ? "No calibration data yet. Raw confidence returned unchanged."
                    : `Correction applied: ${correction.toFixed(3)}x`,
              },
              `Calibrated: ${rawConfidence}% → ${calibrated}%`,
            );
          }

          case "report": {
            const picks = await loadResolvedPicks(picksDir, params.period as string);

            if (picks.length < 20) {
              return ok(
                {
                  status: "insufficient_data",
                  resolved_picks: picks.length,
                  minimum_needed: 20,
                  message:
                    "Need 20+ resolved picks for meaningful calibration. " +
                    "Keep tracking picks and backfilling results.",
                },
                "Calibration report - insufficient data",
              );
            }

            const buckets = calculateBuckets(picks);
            const overallError = calculateOverallError(buckets);
            const status = classifyCalibration(overallError, picks.length);

            const report: CalibrationState = {
              last_updated: new Date().toISOString(),
              total_calibrated_picks: picks.length,
              overall_error: overallError,
              status,
              buckets,
              corrections: buildCorrections(buckets),
            };

            // Interpretation
            const insights: string[] = [];
            for (const b of buckets) {
              if (b.total_picks >= 10) {
                if (b.calibration_error > 5) {
                  if (b.actual_win_rate > b.predicted_midpoint) {
                    insights.push(
                      `Bucket ${b.range_low}-${b.range_high}%: UNDERCONFIDENT. ` +
                        `Predicted ${b.predicted_midpoint}%, actual ${b.actual_win_rate.toFixed(1)}%. ` +
                        `We're leaving edge on the table.`,
                    );
                  } else {
                    insights.push(
                      `Bucket ${b.range_low}-${b.range_high}%: OVERCONFIDENT. ` +
                        `Predicted ${b.predicted_midpoint}%, actual ${b.actual_win_rate.toFixed(1)}%. ` +
                        `Customers seeing inflated confidence.`,
                    );
                  }
                }
              }
            }

            if (insights.length === 0) {
              insights.push("All buckets with sufficient data are well-calibrated.");
            }

            return ok(
              { ...report, insights },
              `Calibration: ${status} (error: ${overallError.toFixed(2)}%)`,
            );
          }

          case "correct": {
            const picks = await loadResolvedPicks(picksDir, "all");

            if (picks.length < 20) {
              return ok(
                { message: "Need 20+ resolved picks to calculate corrections." },
                "Calibration - insufficient data",
              );
            }

            const buckets = calculateBuckets(picks);
            const overallError = calculateOverallError(buckets);
            const status = classifyCalibration(overallError, picks.length);
            const corrections = buildCorrections(buckets);

            const state: CalibrationState = {
              last_updated: new Date().toISOString(),
              total_calibrated_picks: picks.length,
              overall_error: overallError,
              status,
              buckets,
              corrections,
            };

            await fs.writeFile(calibrationFile, JSON.stringify(state, null, 2));

            return ok(
              {
                corrections_updated: true,
                overall_error: overallError,
                status,
                corrections,
                message:
                  "Correction factors saved. Future check_edge calls will " +
                  "use calibrate check to apply these corrections.",
              },
              "Calibration corrections recalculated",
            );
          }

          case "adjust": {
            // Show what the corrections would do to edge score thresholds
            const state = await loadCalibrationState(calibrationFile);

            if (!state || Object.keys(state.corrections).length === 0) {
              return ok(
                {
                  message:
                    "No calibration data. Run 'correct' first after accumulating picks.",
                },
                "No calibration data to adjust",
              );
            }

            const examples = [30, 40, 50, 55, 60, 65, 70, 80].map((raw) => {
              const bucket = findBucket(raw);
              const key = `${bucket.low}-${bucket.high}`;
              const correction = state.corrections[key] ?? 1.0;
              return {
                raw,
                calibrated: Math.min(Math.round(raw * correction), 99),
                correction: correction.toFixed(3),
              };
            });

            return ok(
              {
                calibration_status: state.status,
                overall_error: state.overall_error,
                last_updated: state.last_updated,
                examples,
                message:
                  "These corrections are applied when using 'check' with a confidence value.",
              },
              "Calibration adjustment map",
            );
          }

          default:
            return err(`Unknown action '${action}'`);
        }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

// Exported for use by check-edge orchestrator
export { loadCalibrationState, findBucket };
export type { CalibrationState };

// --- Internals ---

async function loadCalibrationState(
  filePath: string,
): Promise<CalibrationState | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as CalibrationState;
  } catch {
    return null;
  }
}

async function loadResolvedPicks(
  picksDir: string,
  period?: string,
): Promise<Pick[]> {
  const files = await fs.readdir(picksDir).catch(() => []);
  const picks: Pick[] = [];
  const now = Date.now();
  const cutoff =
    period === "month"
      ? 30 * 24 * 60 * 60 * 1000
      : Infinity;

  for (const file of files.sort()) {
    if (!file.endsWith(".jsonl")) continue;
    const content = await fs.readFile(path.join(picksDir, file), "utf-8");
    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const pick = JSON.parse(line) as Pick;
        if (pick.outcome && pick.edge_score > 0) {
          if (now - new Date(pick.timestamp).getTime() < cutoff) {
            picks.push(pick);
          }
        }
      } catch { /* skip */ }
    }
  }

  return picks;
}

function findBucket(confidence: number): { low: number; high: number } {
  for (const range of BUCKET_RANGES) {
    if (confidence >= range.low && confidence < range.high) {
      return range;
    }
  }
  return BUCKET_RANGES[BUCKET_RANGES.length - 1];
}

function calculateBuckets(picks: Pick[]): CalibrationBucket[] {
  return BUCKET_RANGES.map((range) => {
    const inBucket = picks.filter(
      (p) => p.edge_score >= range.low && p.edge_score < range.high,
    );
    const wins = inBucket.filter((p) => p.outcome === "win").length;
    const losses = inBucket.filter((p) => p.outcome === "loss").length;
    const pushes = inBucket.filter((p) => p.outcome === "push").length;
    const decided = wins + losses;
    const actualRate = decided > 0 ? (wins / decided) * 100 : 0;
    const midpoint = (range.low + range.high) / 2;
    const error = decided >= 5 ? Math.abs(actualRate - midpoint) : 0;
    const correction = decided >= 5 && midpoint > 0 ? actualRate / midpoint : 1.0;

    return {
      range_low: range.low,
      range_high: range.high,
      midpoint,
      total_picks: inBucket.length,
      wins,
      losses,
      pushes,
      actual_win_rate: actualRate,
      predicted_midpoint: midpoint,
      calibration_error: error,
      correction_factor: correction,
    };
  });
}

function calculateOverallError(buckets: CalibrationBucket[]): number {
  const withData = buckets.filter((b) => b.total_picks >= 5);
  if (withData.length === 0) return 0;
  return (
    withData.reduce((s, b) => s + b.calibration_error, 0) / withData.length
  );
}

function classifyCalibration(
  error: number,
  totalPicks: number,
): CalibrationState["status"] {
  if (totalPicks < 20) return "insufficient_data";
  if (error < 3) return "calibrated";
  if (error < 5) return "acceptable";
  if (error < 8) return "needs_work";
  return "miscalibrated";
}

function buildCorrections(
  buckets: CalibrationBucket[],
): Record<string, number> {
  const corrections: Record<string, number> = {};
  for (const b of buckets) {
    const key = `${b.range_low}-${b.range_high}`;
    // Only apply correction if we have enough data
    corrections[key] = b.total_picks >= 10 ? b.correction_factor : 1.0;
  }
  return corrections;
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
