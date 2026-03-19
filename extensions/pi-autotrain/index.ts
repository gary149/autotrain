/**
 * autotrain — Pi Extension
 *
 * Generic autonomous experiment loop infrastructure.
 * Domain-specific behavior comes from skills (what command to run, what to optimize).
 *
 * Provides:
 * - `run_experiment` tool — submits detached HF Job, returns immediately with job ID
 * - `check_jobs` tool — polls active jobs for status and metrics
 * - `cancel_job` tool — cancels a running job with minimum runtime guard
 * - `log_experiment` tool — records keep/discard with benchmark integrity check
 * - Status widget showing experiment count + best metric + active jobs
 * - Ctrl+Y toggle to expand/collapse full dashboard inline above the editor
 * - Injects autotrain.md into context on every turn via before_agent_start
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import {
  Text,
  truncateToWidth,
  matchesKey,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExperimentResult {
  commit: string;
  metric: number;
  /** Additional tracked metrics: { name: value } */
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  timestamp: number;
  /** Segment index — increments on each config header. Current segment = highest. */
  segment: number;
}

interface MetricDef {
  name: string;
  unit: string;
}

interface ExperimentState {
  results: ExperimentResult[];
  /** Baseline primary metric (from first experiment in current segment) */
  bestMetric: number | null;
  bestDirection: "lower" | "higher";
  metricName: string;
  metricUnit: string;
  /** Definitions for secondary metrics (order preserved) */
  secondaryMetrics: MetricDef[];
  name: string | null;
  /** Current segment index (incremented on each init_experiment) */
  currentSegment: number;
}

interface LogDetails {
  experiment: ExperimentResult;
  state: ExperimentState;
}

// ---------------------------------------------------------------------------
// Tool Schemas
// ---------------------------------------------------------------------------

const InitParams = Type.Object({
  name: Type.String({
    description:
      'Human-readable name for this experiment session (e.g. "Optimizing liquid for fastest execution and parsing")',
  }),
  metric_name: Type.String({
    description:
      'Display name for the primary metric (e.g. "total_µs", "bundle_kb", "val_bpb"). Shown in dashboard headers.',
  }),
  metric_unit: Type.Optional(
    Type.String({
      description:
        'Unit for the primary metric. Use "µs", "ms", "s", "kb", "mb", or "" for unitless. Affects number formatting. Default: ""',
    }),
  ),
  direction: Type.Optional(
    Type.String({
      description:
        'Whether "lower" or "higher" is better for the primary metric. Default: "lower".',
    }),
  ),
  benchmark: Type.Optional(
    Type.Object({
      train_seed: Type.Number({ description: "RNG seed for training split" }),
      eval_seed: Type.Number({ description: "Separate RNG seed for eval split" }),
      test_seed: Type.Number({ description: "Separate RNG seed for test split" }),
      eval_n: Type.Number({ description: "Number of eval examples" }),
      test_n: Type.Optional(Type.Number({ description: "Number of test examples" })),
      acceptance_threshold: Type.Optional(Type.Number({ description: "Minimum improvement to count as real. Default: 0.02" })),
      guardrails: Type.Optional(Type.Array(Type.String(), { description: "Names of guardrail metrics to track" })),
    }),
  ),
});

const RunParams = Type.Object({
  command: Type.String({
    description: "Shell command to run (typically ./autotrain.sh)",
  }),
  experiment_id: Type.Optional(
    Type.Number({
      description:
        "Experiment ID to associate this job with. Required for stage='full' (must match a passed smoke). Auto-generated for smoke.",
    }),
  ),
  stage: Type.Optional(
    StringEnum(["smoke", "full"] as const, {
      description:
        'Job stage. "smoke" = 10-step validation. "full" = real training. Default: "smoke".',
    }),
  ),
  timeout_seconds: Type.Optional(
    Type.Number({
      description: "Kill after this many seconds (default: 600)",
    }),
  ),
});

const CheckJobsParams = Type.Object({
  job_id: Type.Optional(
    Type.String({
      description:
        "Specific job ID to check. Omit to check all active jobs.",
    }),
  ),
});

const CancelJobParams = Type.Object({
  job_id: Type.String({ description: "HF Job ID to cancel" }),
  reason: Type.String({ description: "Why this job is being canceled" }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a number with comma-separated thousands: 15586 → "15,586" */
export function commas(n: number): string {
  const s = String(Math.round(n));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return parts.join(",");
}

/** Format number with commas, preserving one decimal for fractional values */
export function fmtNum(n: number, decimals: number = 0): string {
  if (decimals > 0) {
    const int = Math.floor(Math.abs(n));
    const frac = (Math.abs(n) - int).toFixed(decimals).slice(1); // ".3"
    return (n < 0 ? "-" : "") + commas(int) + frac;
  }
  return commas(n);
}

function formatNum(value: number | null, unit: string): string {
  if (value === null) return "—";
  const u = unit || "";
  // Integers: no decimals
  if (value === Math.round(value)) return fmtNum(value) + u;
  // Fractional: 2 decimal places
  return fmtNum(value, 2) + u;
}

export function isBetter(
  current: number,
  best: number,
  direction: "lower" | "higher",
): boolean {
  return direction === "lower" ? current < best : current > best;
}

/** Get results in the current segment only */
export function currentResults(
  results: ExperimentResult[],
  segment: number,
): ExperimentResult[] {
  return results.filter((r) => r.segment === segment);
}

/** Baseline = first experiment in current segment */
export function findBaselineMetric(
  results: ExperimentResult[],
  segment: number,
): number | null {
  const cur = currentResults(results, segment);
  return cur.length > 0 ? cur[0].metric : null;
}

/**
 * Find secondary metric baselines from the first experiment in current segment.
 * For metrics that didn't exist at baseline time, falls back to the first
 * occurrence of that metric in the current segment.
 */
function findBaselineSecondary(
  results: ExperimentResult[],
  segment: number,
  knownMetrics?: MetricDef[],
): Record<string, number> {
  const cur = currentResults(results, segment);
  const base: Record<string, number> =
    cur.length > 0 ? { ...(cur[0].metrics ?? {}) } : {};

  // Fill in any known metrics missing from baseline with their first occurrence
  if (knownMetrics) {
    for (const sm of knownMetrics) {
      if (base[sm.name] === undefined) {
        for (const r of cur) {
          const val = (r.metrics ?? {})[sm.name];
          if (val !== undefined) {
            base[sm.name] = val;
            break;
          }
        }
      }
    }
  }

  return base;
}

// ---------------------------------------------------------------------------
// JSONL Parser
// ---------------------------------------------------------------------------

export type ParsedEntry =
  | { kind: "config"; data: any }
  | { kind: "result"; data: any }
  | { kind: "job_submitted"; data: any }
  | { kind: "job_completed"; data: any }
  | { kind: "skip"; data?: undefined };

export function parseJsonlLine(line: string): ParsedEntry {
  try {
    const entry = JSON.parse(line);
    if (entry.type === "config") return { kind: "config", data: entry };
    if (entry.type === "job_submitted") return { kind: "job_submitted", data: entry };
    if (entry.type === "job_completed") return { kind: "job_completed", data: entry };
    // Legacy result: no type field but has "run" field
    if (!entry.type && entry.run !== undefined) return { kind: "result", data: entry };
    // Unknown type → skip
    return { kind: "skip" };
  } catch {
    return { kind: "skip" };
  }
}

// ---------------------------------------------------------------------------
// Async Job Types & Utilities
// ---------------------------------------------------------------------------

export interface JobInfo {
  job_id: string;
  experiment_id: number;
  stage: "smoke" | "full";
  command: string;
  script_hash: string;
  started_at: number;
  poll_count: number;
}

export interface SmokeRegistryEntry {
  passed: boolean;
  script_hash: string;
  job_id: string;
  failures: number;
  timestamp: number;
}

export function hashCommand(cmd: string): string {
  return createHash("sha256").update(cmd).digest("hex");
}

export function hashWorkspace(cwd: string, command: string): string {
  const hash = createHash("sha256");
  hash.update(command);
  const files = ["autotrain.sh", "train.py", "config.json", "config.yaml"];
  for (const f of files) {
    const p = path.join(cwd, f);
    try {
      if (fs.existsSync(p)) {
        hash.update(f + ":" + fs.readFileSync(p, "utf-8"));
      }
    } catch {}
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Reconstruction Helpers (pure functions)
// ---------------------------------------------------------------------------

/**
 * Rebuild activeJobs map from parsed JSONL entries.
 * A job is active if it has a job_submitted entry with no matching job_completed.
 */
export function rebuildActiveJobs(
  submitted: any[],
  completed: any[],
): Map<string, JobInfo> {
  const completedIds = new Set(completed.map((c) => c.job_id));
  const jobs = new Map<string, JobInfo>();
  for (const s of submitted) {
    if (!completedIds.has(s.job_id)) {
      jobs.set(s.job_id, {
        job_id: s.job_id,
        experiment_id: s.experiment_id,
        stage: s.stage,
        command: s.command ?? "",
        script_hash: s.script_hash ?? "",
        started_at: s.timestamp ?? 0,
        poll_count: 0,
      });
    }
  }
  return jobs;
}

/**
 * Rebuild smoke registry from job_submitted and job_completed entries.
 * Only smoke-stage entries contribute.
 */
export function rebuildSmokeRegistry(
  submitted: any[],
  completed: any[],
): Map<number, SmokeRegistryEntry> {
  const registry = new Map<number, SmokeRegistryEntry>();

  // Initialize from submitted smoke entries — LATEST wins
  for (const s of submitted) {
    if (s.stage !== "smoke") continue;
    registry.set(s.experiment_id, {
      passed: false,
      script_hash: s.script_hash ?? "",
      job_id: s.job_id,
      failures: registry.get(s.experiment_id)?.failures ?? 0,
      timestamp: s.timestamp ?? 0,
    });
  }

  // Update from completed smoke entries
  for (const c of completed) {
    if (c.stage !== "smoke") continue;
    const entry = registry.get(c.experiment_id);
    if (!entry) continue;
    if (c.status === "completed" && c.metrics) {
      entry.passed = true;
      entry.timestamp = c.timestamp ?? entry.timestamp;
    } else {
      entry.failures++;
      entry.passed = false;
    }
  }

  return registry;
}

// ---------------------------------------------------------------------------
// Status Mapping & Metric Parsing (pure functions for check_jobs)
// ---------------------------------------------------------------------------

/**
 * Map HF Jobs uppercase status to our lowercase status.
 * HF returns status at [0]['status']['stage'] with values like COMPLETED, ERROR, etc.
 */
export function mapHfStatus(
  hfStatus: string,
): "completed" | "error" | "canceled" | "running" {
  switch (hfStatus) {
    case "COMPLETED":
      return "completed";
    case "ERROR":
      return "error";
    case "CANCELED":
      return "canceled";
    case "DELETED":
      return "canceled";
    default:
      return "running";
  }
}

/**
 * Parse METRIC lines from job log output.
 * Format: "METRIC name=value" — one per line.
 * Returns null if no METRIC lines found.
 */
export function parseMetricLines(
  logOutput: string,
): Record<string, number> | null {
  const metrics: Record<string, number> = {};
  let found = false;
  for (const line of logOutput.split("\n")) {
    const match = line.match(/^METRIC\s+(\S+)=(\S+)/);
    if (match) {
      const value = parseFloat(match[2]);
      if (!isNaN(value)) {
        metrics[match[1]] = value;
        found = true;
      }
    }
  }
  return found ? metrics : null;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dashboard table renderer (pure function, no UI deps)
// ---------------------------------------------------------------------------

function renderDashboardLines(
  st: ExperimentState,
  width: number,
  th: Theme,
  maxRows: number = 6,
): string[] {
  const lines: string[] = [];

  if (st.results.length === 0) {
    lines.push(`  ${th.fg("dim", "No experiments yet.")}`);
    return lines;
  }

  const cur = currentResults(st.results, st.currentSegment);
  const kept = cur.filter((r) => r.status === "keep").length;
  const discarded = cur.filter((r) => r.status === "discard").length;
  const crashed = cur.filter((r) => r.status === "crash").length;
  const checksFailed = cur.filter((r) => r.status === "checks_failed").length;

  const baseline = st.bestMetric;
  const baselineSec = findBaselineSecondary(
    st.results,
    st.currentSegment,
    st.secondaryMetrics,
  );

  // Find best kept primary metric and its run number (current segment only)
  let bestPrimary: number | null = null;
  let bestSecondary: Record<string, number> = {};
  let bestRunNum = 0;
  for (let i = st.results.length - 1; i >= 0; i--) {
    const r = st.results[i];
    if (r.segment !== st.currentSegment) continue;
    if (r.status === "keep" && r.metric > 0) {
      if (
        bestPrimary === null ||
        isBetter(r.metric, bestPrimary, st.bestDirection)
      ) {
        bestPrimary = r.metric;
        bestSecondary = r.metrics ?? {};
        bestRunNum = i + 1;
      }
    }
  }

  // Runs summary
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Runs:")} ${th.fg("text", String(st.results.length))}` +
        `  ${th.fg("success", `${kept} kept`)}` +
        (discarded > 0
          ? `  ${th.fg("warning", `${discarded} discarded`)}`
          : "") +
        (crashed > 0 ? `  ${th.fg("error", `${crashed} crashed`)}` : "") +
        (checksFailed > 0
          ? `  ${th.fg("error", `${checksFailed} checks failed`)}`
          : ""),
      width,
    ),
  );

  // Baseline: first run's primary metric
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Baseline:")} ${th.fg("dim", `★ ${st.metricName}: ${formatNum(baseline, st.metricUnit)} #1`)}`,
      width,
    ),
  );

  // Progress: best primary metric with delta + run number
  if (bestPrimary !== null) {
    let progressLine = `  ${th.fg("muted", "Progress:")} ${th.fg("warning", th.bold(`★ ${st.metricName}: ${formatNum(bestPrimary, st.metricUnit)}`))}${th.fg("dim", ` #${bestRunNum}`)}`;

    if (baseline !== null && baseline !== 0 && bestPrimary !== baseline) {
      const pct = ((bestPrimary - baseline) / baseline) * 100;
      const sign = pct > 0 ? "+" : "";
      const color = isBetter(bestPrimary, baseline, st.bestDirection)
        ? "success"
        : "error";
      progressLine += th.fg(color, ` (${sign}${pct.toFixed(1)}%)`);
    }

    lines.push(truncateToWidth(progressLine, width));

    // Progress secondary metrics on next line with deltas
    if (st.secondaryMetrics.length > 0) {
      const secParts: string[] = [];
      for (const sm of st.secondaryMetrics) {
        const val = bestSecondary[sm.name];
        const bv = baselineSec[sm.name];
        if (val !== undefined) {
          let part = `${sm.name}: ${formatNum(val, sm.unit)}`;
          if (bv !== undefined && bv !== 0 && val !== bv) {
            const p = ((val - bv) / bv) * 100;
            const s = p > 0 ? "+" : "";
            const c = val <= bv ? "success" : "error";
            part += th.fg(c, ` ${s}${p.toFixed(1)}%`);
          }
          secParts.push(part);
        }
      }
      if (secParts.length > 0) {
        lines.push(
          truncateToWidth(
            `  ${th.fg("dim", "          ")}${th.fg("muted", secParts.join("  "))}`,
            width,
          ),
        );
      }
    }
  }

  lines.push("");

  // Determine visible rows for column pruning
  const effectiveMax = maxRows <= 0 ? st.results.length : maxRows;
  const startIdx = Math.max(0, st.results.length - effectiveMax);
  const visibleRows = st.results.slice(startIdx);

  // Only show secondary metric columns that have at least one value in visible rows
  const secMetrics = st.secondaryMetrics.filter((sm) =>
    visibleRows.some((r) => (r.metrics ?? {})[sm.name] !== undefined),
  );

  // Column definitions
  const col = { idx: 3, commit: 8, primary: 11, status: 15 };
  const secColWidth = 11;
  const totalSecWidth = secMetrics.length * secColWidth;
  const descW = Math.max(
    10,
    width - col.idx - col.commit - col.primary - totalSecWidth - col.status - 6,
  );

  // Table header — primary metric name bolded with ★
  let headerLine =
    `  ${th.fg("muted", "#".padEnd(col.idx))}` +
    `${th.fg("muted", "commit".padEnd(col.commit))}` +
    `${th.fg("warning", th.bold(("★ " + st.metricName).slice(0, col.primary - 1).padEnd(col.primary)))}`;

  for (const sm of secMetrics) {
    headerLine += th.fg(
      "muted",
      sm.name.slice(0, secColWidth - 1).padEnd(secColWidth),
    );
  }

  headerLine +=
    `${th.fg("muted", "status".padEnd(col.status))}` +
    `${th.fg("muted", "description")}`;

  lines.push(truncateToWidth(headerLine, width));
  lines.push(
    truncateToWidth(`  ${th.fg("borderMuted", "─".repeat(width - 4))}`, width),
  );

  // Baseline values for delta display (current segment only)
  const baselinePrimary = findBaselineMetric(st.results, st.currentSegment);
  const baselineSecondary = findBaselineSecondary(
    st.results,
    st.currentSegment,
    st.secondaryMetrics,
  );

  // Show max 6 recent runs, with a note about hidden earlier ones
  if (startIdx > 0) {
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", `… ${startIdx} earlier run${startIdx === 1 ? "" : "s"}`)}`,
        width,
      ),
    );
  }

  for (let i = startIdx; i < st.results.length; i++) {
    const r = st.results[i];
    const isOld = r.segment !== st.currentSegment;
    const isBaseline =
      !isOld &&
      i === st.results.findIndex((x) => x.segment === st.currentSegment);

    const color = isOld
      ? "dim"
      : r.status === "keep"
        ? "success"
        : r.status === "crash" || r.status === "checks_failed"
          ? "error"
          : "warning";

    // Primary metric with color coding
    const primaryStr = formatNum(r.metric, st.metricUnit);
    let primaryColor: Parameters<typeof th.fg>[0] = isOld ? "dim" : "text";
    if (!isOld) {
      if (isBaseline) {
        primaryColor = "muted"; // baseline row
      } else if (
        baselinePrimary !== null &&
        r.status === "keep" &&
        r.metric > 0
      ) {
        if (isBetter(r.metric, baselinePrimary, st.bestDirection)) {
          primaryColor = "success";
        } else if (r.metric !== baselinePrimary) {
          primaryColor = "error";
        }
      }
    }

    const idxStr = th.fg("dim", String(i + 1).padEnd(col.idx));
    const commitStr = isOld
      ? "(old)".padEnd(col.commit)
      : r.commit.padEnd(col.commit);

    let rowLine =
      `  ${idxStr}` +
      `${th.fg(isOld ? "dim" : "accent", commitStr)}` +
      `${th.fg(primaryColor, isOld ? primaryStr.padEnd(col.primary) : th.bold(primaryStr.padEnd(col.primary)))}`;

    // Secondary metrics
    const rowMetrics = r.metrics ?? {};
    for (const sm of secMetrics) {
      const val = rowMetrics[sm.name];
      if (val !== undefined) {
        const secStr = formatNum(val, sm.unit);
        let secColor: Parameters<typeof th.fg>[0] = "dim";
        if (!isOld) {
          const bv = baselineSecondary[sm.name];
          if (isBaseline) {
            secColor = "muted"; // baseline row
          } else if (bv !== undefined && bv !== 0) {
            secColor = val <= bv ? "success" : "error";
          }
        }
        rowLine += th.fg(secColor, secStr.padEnd(secColWidth));
      } else {
        rowLine += th.fg("dim", "—".padEnd(secColWidth));
      }
    }

    rowLine +=
      `${th.fg(color, r.status.padEnd(col.status))}` +
      `${th.fg("muted", r.description.slice(0, descW))}`;

    lines.push(truncateToWidth(rowLine, width));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function autotrainExtension(pi: ExtensionAPI) {
  let dashboardExpanded = false;
  let autotrainMode = false;
  let lastCtx: ExtensionContext | null = null;

  const MAX_AUTORESUME_TURNS = 20;
  const BENCHMARK_GUARDRAIL =
    "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.";

  // Auto-resume tracking
  let lastAutoResumeTime = 0;
  let experimentsThisSession = 0; // reset on agent_start, incremented on log_experiment
  let autoResumeTurns = 0;

  let overlayTui: { requestRender: () => void } | null = null;
  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;
  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  let state: ExperimentState = {
    results: [],
    bestMetric: null,
    bestDirection: "lower",
    metricName: "metric",
    metricUnit: "",
    secondaryMetrics: [],
    name: null,
    currentSegment: 0,
  };

  // Async job tracking
  let activeJobs: Map<string, JobInfo> = new Map();
  let smokeRegistry: Map<number, SmokeRegistryEntry> = new Map();
  let nextExperimentId = 1;

  const autotrainHelp = () =>
    [
      "Usage: /autotrain [off|clear|<text>]",
      "",
      "<text> enters autotrain mode and starts or resumes the loop.",
      "off leaves autotrain mode.",
      "clear deletes autotrain.jsonl and leaves autotrain mode.",
      "",
      "Examples:",
      "  /autotrain optimize unit test runtime, monitor correctness",
      "  /autotrain model training, run 5 minutes of train.py and note the loss ratio as optimization target",
    ].join("\n");

  // -----------------------------------------------------------------------
  // State reconstruction
  // -----------------------------------------------------------------------

  const reconstructState = async (ctx: ExtensionContext) => {
    state = {
      results: [],
      bestMetric: null,
      bestDirection: "lower",
      metricName: "metric",
      metricUnit: "",
      secondaryMetrics: [],
      name: null,
      currentSegment: 0,
    };

    // Reset async job state
    activeJobs = new Map();
    smokeRegistry = new Map();
    nextExperimentId = 1;

    // Primary: read from autotrain.jsonl (alongside autotrain.md/sh)
    const jsonlPath = path.join(ctx.cwd, "autotrain.jsonl");
    let loadedFromJsonl = false;
    const jobSubmitted: any[] = [];
    const jobCompleted: any[] = [];

    try {
      if (fs.existsSync(jsonlPath)) {
        let segment = 0;
        const lines = fs
          .readFileSync(jsonlPath, "utf-8")
          .trim()
          .split("\n")
          .filter(Boolean);
        for (const line of lines) {
          const parsed = parseJsonlLine(line);

          switch (parsed.kind) {
            case "config": {
              const entry = parsed.data;
              if (entry.name) state.name = entry.name;
              if (entry.metricName) state.metricName = entry.metricName;
              if (entry.metricUnit !== undefined)
                state.metricUnit = entry.metricUnit;
              if (entry.bestDirection)
                state.bestDirection = entry.bestDirection;
              // Increment segment (first config = 0, second = 1, etc.)
              if (state.results.length > 0) segment++;
              state.currentSegment = segment;
              break;
            }

            case "result": {
              const entry = parsed.data;
              state.results.push({
                commit: entry.commit ?? "",
                metric: entry.metric ?? 0,
                metrics: entry.metrics ?? {},
                status: entry.status ?? "keep",
                description: entry.description ?? "",
                timestamp: entry.timestamp ?? 0,
                segment,
              });

              // Register secondary metrics
              for (const name of Object.keys(entry.metrics ?? {})) {
                if (!state.secondaryMetrics.find((m) => m.name === name)) {
                  let unit = "";
                  if (name.endsWith("_µs") || name.includes("µs"))
                    unit = "µs";
                  else if (name.endsWith("_ms") || name.includes("ms"))
                    unit = "ms";
                  else if (name.endsWith("_s") || name.includes("sec"))
                    unit = "s";
                  state.secondaryMetrics.push({ name, unit });
                }
              }
              break;
            }

            case "job_submitted":
              jobSubmitted.push(parsed.data);
              break;

            case "job_completed":
              jobCompleted.push(parsed.data);
              break;

            case "skip":
              // Malformed or unknown — ignore
              break;
          }
        }

        if (state.results.length > 0 || jobSubmitted.length > 0) {
          loadedFromJsonl = true;
          state.bestMetric = findBaselineMetric(
            state.results,
            state.currentSegment,
          );
        }
      }
    } catch {
      // Fall through to session history
    }

    // Fallback: reconstruct from session history (backward compat)
    if (!loadedFromJsonl) {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role !== "toolResult" || msg.toolName !== "log_experiment")
          continue;
        const details = msg.details as LogDetails | undefined;
        if (details?.state) {
          state = details.state;
          if (!state.secondaryMetrics) state.secondaryMetrics = [];
          if (state.metricUnit === "s" && state.metricName === "metric") {
            state.metricUnit = "";
          }
          for (const r of state.results) {
            if (!r.metrics) r.metrics = {};
          }
        }
      }
    }

    // Rebuild async job state from JSONL entries
    activeJobs = rebuildActiveJobs(jobSubmitted, jobCompleted);
    smokeRegistry = rebuildSmokeRegistry(jobSubmitted, jobCompleted);

    // Compute nextExperimentId from max experiment_id seen
    let maxExpId = 0;
    for (const s of jobSubmitted) {
      if (s.experiment_id > maxExpId) maxExpId = s.experiment_id;
    }
    nextExperimentId = maxExpId + 1;

    // Orphan scan: inspect jobs that appear active but may have completed while agent was down
    for (const [jobId, job] of activeJobs) {
      try {
        const inspectResult = await pi.exec(
          "hf",
          ["jobs", "inspect", jobId],
          { cwd: ctx.cwd, timeout: 15000 },
        );
        const inspectData = JSON.parse(inspectResult.stdout);
        const hfStatus = inspectData?.[0]?.status?.stage ?? "UNKNOWN";
        const status = mapHfStatus(hfStatus);

        if (status !== "running") {
          // Job completed while agent was down — finalize it
          let metrics: Record<string, number> | null = null;
          if (status === "completed") {
            try {
              const logsResult = await pi.exec(
                "hf",
                ["jobs", "logs", jobId],
                { cwd: ctx.cwd, timeout: 15000 },
              );
              metrics = parseMetricLines(logsResult.stdout);
            } catch {
              // Logs may not be available
            }
          }

          // Write synthetic job_completed entry
          try {
            const completedEntry = JSON.stringify({
              type: "job_completed",
              job_id: jobId,
              experiment_id: job.experiment_id,
              stage: job.stage,
              status,
              metrics,
              timestamp: Date.now(),
            });
            fs.appendFileSync(jsonlPath, completedEntry + "\n");
          } catch {
            // Non-fatal
          }

          // Update smoke registry if this was a smoke job
          if (job.stage === "smoke") {
            const regEntry = smokeRegistry.get(job.experiment_id);
            if (regEntry) {
              if (status === "completed" && metrics) {
                regEntry.passed = true;
              } else {
                regEntry.failures++;
                regEntry.passed = false;
              }
            }
          }

          activeJobs.delete(jobId);
        }
      } catch {
        // Inspect failed — leave job in activeJobs, agent can check later
      }
    }

    // Auto-enter autotrain mode only when a persisted experiment log exists
    autotrainMode = fs.existsSync(path.join(ctx.cwd, "autotrain.jsonl"));

    updateWidget(ctx);
  };

  const updateWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    lastCtx = ctx;

    if (state.results.length === 0) {
      ctx.ui.setWidget("autotrain", undefined);
      return;
    }

    if (dashboardExpanded) {
      // Expanded: full dashboard table rendered as widget
      ctx.ui.setWidget("autotrain", (_tui, theme) => {
        const width = process.stdout.columns || 120;
        const lines: string[] = [];

        const hintText = " ctrl+x collapse • ctrl+shift+x fullscreen ";
        const labelPrefix = "🔬 autotrain";
        const nameStr = state.name ? `: ${state.name}` : "";
        // 3 leading dashes + space + label + space + fill + hint
        const maxLabelLen = width - 3 - 2 - hintText.length - 1;
        let label = labelPrefix + nameStr;
        if (label.length > maxLabelLen) {
          label = label.slice(0, maxLabelLen - 1) + "…";
        }
        const fillLen = Math.max(
          0,
          width - 3 - 1 - label.length - 1 - hintText.length,
        );
        lines.push(
          truncateToWidth(
            theme.fg("borderMuted", "───") +
              theme.fg("accent", " " + label + " ") +
              theme.fg("borderMuted", "─".repeat(fillLen)) +
              theme.fg("dim", hintText),
            width,
          ),
        );

        lines.push(...renderDashboardLines(state, width, theme));

        return new Text(lines.join("\n"), 0, 0);
      });
    } else {
      // Collapsed: compact one-liner — compute everything inside render
      ctx.ui.setWidget("autotrain", (_tui, theme) => {
        const cur = currentResults(state.results, state.currentSegment);
        const kept = cur.filter((r) => r.status === "keep").length;
        const crashed = cur.filter((r) => r.status === "crash").length;
        const checksFailed = cur.filter(
          (r) => r.status === "checks_failed",
        ).length;
        const baseline = state.bestMetric;
        const baselineSec = findBaselineSecondary(
          state.results,
          state.currentSegment,
          state.secondaryMetrics,
        );

        // Find best kept primary metric, its secondary values, and run number
        let bestPrimary: number | null = null;
        let bestSec: Record<string, number> = {};
        let bestRunNum = 0;
        for (let i = state.results.length - 1; i >= 0; i--) {
          const r = state.results[i];
          if (r.segment !== state.currentSegment) continue;
          if (r.status === "keep" && r.metric > 0) {
            if (
              bestPrimary === null ||
              isBetter(r.metric, bestPrimary, state.bestDirection)
            ) {
              bestPrimary = r.metric;
              bestSec = r.metrics ?? {};
              bestRunNum = i + 1;
            }
          }
        }

        const displayVal = bestPrimary ?? baseline;
        const parts = [
          theme.fg("accent", "🔬"),
          theme.fg("muted", ` ${state.results.length} runs`),
          theme.fg("success", ` ${kept} kept`),
          crashed > 0 ? theme.fg("error", ` ${crashed}💥`) : "",
          checksFailed > 0 ? theme.fg("error", ` ${checksFailed}⚠`) : "",
          activeJobs.size > 0 ? theme.fg("warning", ` ${activeJobs.size} job${activeJobs.size > 1 ? "s" : ""} active`) : "",
          theme.fg("dim", " │ "),
          theme.fg(
            "warning",
            theme.bold(
              `★ ${state.metricName}: ${formatNum(displayVal, state.metricUnit)}`,
            ),
          ),
          bestRunNum > 0 ? theme.fg("dim", ` #${bestRunNum}`) : "",
        ];

        // Show delta % vs baseline for primary
        if (
          baseline !== null &&
          bestPrimary !== null &&
          baseline !== 0 &&
          bestPrimary !== baseline
        ) {
          const pct = ((bestPrimary - baseline) / baseline) * 100;
          const sign = pct > 0 ? "+" : "";
          const deltaColor = isBetter(
            bestPrimary,
            baseline,
            state.bestDirection,
          )
            ? "success"
            : "error";
          parts.push(theme.fg(deltaColor, ` (${sign}${pct.toFixed(1)}%)`));
        }

        // Show secondary metrics with delta %
        if (state.secondaryMetrics.length > 0) {
          for (const sm of state.secondaryMetrics) {
            const val = bestSec[sm.name];
            const bv = baselineSec[sm.name];
            if (val !== undefined) {
              parts.push(theme.fg("dim", "  "));
              let secText = `${sm.name}: ${formatNum(val, sm.unit)}`;
              if (bv !== undefined && bv !== 0 && val !== bv) {
                const p = ((val - bv) / bv) * 100;
                const s = p > 0 ? "+" : "";
                const c = val <= bv ? "success" : "error";
                secText += theme.fg(c, ` ${s}${p.toFixed(1)}%`);
              }
              parts.push(theme.fg("muted", secText));
            }
          }
        }

        if (state.name) {
          parts.push(theme.fg("dim", ` │ ${state.name}`));
        }

        parts.push(
          theme.fg("dim", "  (ctrl+x expand • ctrl+shift+x fullscreen)"),
        );

        return new Text(parts.join(""), 0, 0);
      });
    }
  };

  pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_switch", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_fork", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));

  // Reset per-session experiment counter when agent starts
  pi.on("agent_start", async () => {
    experimentsThisSession = 0;
  });

  // Check ideas file for continuation when agent stops
  pi.on("agent_end", async (_event, ctx) => {

    if (!autotrainMode) return;

    // Don't auto-resume if no experiments ran this session AND no active jobs
    if (experimentsThisSession === 0 && activeJobs.size === 0) return;

    // Rate-limit auto-resume to once every 2 minutes
    const now = Date.now();
    if (now - lastAutoResumeTime < 2 * 60 * 1000) return;
    lastAutoResumeTime = now;

    if (autoResumeTurns >= MAX_AUTORESUME_TURNS) {
      ctx.ui.notify(
        `Autotrain auto-resume limit reached (${MAX_AUTORESUME_TURNS} turns)`,
        "info",
      );
      return;
    }

    // Auto-continue: send a message to resume the loop
    // The agent reads autotrain.md on startup which has all context
    const ideasPath = path.join(ctx.cwd, "autotrain.ideas.md");
    const hasIdeas = fs.existsSync(ideasPath);

    let resumeMsg =
      "Autotrain loop ended (likely context limit). Resume the experiment loop — read autotrain.md and git log for context.";
    resumeMsg += ` Session so far: ${state.results.length} experiments, best ${state.metricName ?? "metric"}: ${state.bestMetric !== null ? formatNum(state.bestMetric, state.metricUnit) : "unknown"}.`;
    if (hasIdeas) {
      resumeMsg +=
        " Check autotrain.ideas.md for promising paths to explore. Prune stale/tried ideas.";
    }
    resumeMsg += ` ${BENCHMARK_GUARDRAIL}`;

    autoResumeTurns++;
    pi.sendUserMessage(resumeMsg);
  });

  // When in autotrain mode, add a static note to the system prompt.
  // Only a short pointer — no file content, fully cache-safe.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!autotrainMode) return;

    const mdPath = path.join(ctx.cwd, "autotrain.md");
    const ideasPath = path.join(ctx.cwd, "autotrain.ideas.md");
    const hasIdeas = fs.existsSync(ideasPath);

    const checksPath = path.join(ctx.cwd, "autotrain.checks.sh");
    const hasChecks = fs.existsSync(checksPath);

    let extra =
      "\n\n## Autotrain Mode (ACTIVE)" +
      "\nYou are in autotrain mode. Optimize the primary metric through an autonomous experiment loop." +
      "\nUse init_experiment, run_experiment, check_jobs, and log_experiment tools. Use run_experiment for ALL training — it submits to HF Jobs and returns immediately. Poll with check_jobs. NEVER STOP until interrupted." +
      `\nExperiment rules: ${mdPath} — read this file at the start of every session and after compaction.` +
      "\nWrite promising but deferred optimizations as bullet points to autotrain.ideas.md — don't let good ideas get lost." +
      `\n${BENCHMARK_GUARDRAIL}`;

    if (hasChecks) {
      extra +=
        "\n\n## Backpressure Checks (ACTIVE)" +
        `\n${checksPath} exists — run it manually after check_jobs reports a completed job.` +
        "\nIf checks fail, use status 'checks_failed' in log_experiment — it behaves like a crash (no commit, revert changes)." +
        "\nYou cannot use status 'keep' when checks have failed." +
        "\nThe checks execution time does NOT affect the primary metric.";
    }

    if (hasIdeas) {
      extra += `\n\n💡 Ideas backlog exists at ${ideasPath} — check it for promising experiment paths. Prune stale entries.`;
    }

    // Inject session state so the agent has instant orientation
    const curResults = currentResults(state.results, state.currentSegment);
    const totalRuns = curResults.length;
    const keptCount = curResults.filter((r) => r.status === "keep").length;
    const bestVal =
      state.bestMetric !== null
        ? formatNum(state.bestMetric, state.metricUnit)
        : "none yet";

    extra += `\n\nSession state: ${totalRuns} experiments, ${keptCount} kept. Best ${state.metricName ?? "metric"}: ${bestVal}.`;

    if (activeJobs.size > 0) {
      extra += `\n\n🔄 ${activeJobs.size} active job${activeJobs.size > 1 ? "s" : ""} from previous session. Call check_jobs to get their status.`;
    }

    // Consecutive discard streak (count backwards from most recent)
    let discardStreak = 0;
    for (let i = curResults.length - 1; i >= 0; i--) {
      if (curResults[i].status !== "keep") discardStreak++;
      else break;
    }
    if (discardStreak >= 3) {
      extra += `\n⚠️ ${discardStreak} consecutive non-keeps. Consider pivoting to a different approach.`;
    }

    return {
      systemPrompt: event.systemPrompt + extra,
    };
  });

  // -----------------------------------------------------------------------
  // init_experiment tool — one-time setup
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "init_experiment",
    label: "Init Experiment",
    description:
      "Initialize the experiment session. Call once before the first run_experiment to set the name, primary metric, unit, and direction. Writes the config header to autotrain.jsonl.",
    promptSnippet:
      "Initialize experiment session (name, metric, unit, direction). Call once before first run.",
    promptGuidelines: [
      "Call init_experiment exactly once at the start of an autotrain session, before the first run_experiment.",
      "If autotrain.jsonl already exists with a config, do NOT call init_experiment again.",
      "If the optimization target changes (different benchmark, metric, or workload), call init_experiment again to insert a new config header and reset the baseline.",
    ],
    parameters: InitParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const isReinit = state.results.length > 0;

      state.name = params.name;
      state.metricName = params.metric_name;
      state.metricUnit = params.metric_unit ?? "";
      if (params.direction === "lower" || params.direction === "higher") {
        state.bestDirection = params.direction;
      }

      // Reset results for new baseline segment
      state.results = [];
      state.bestMetric = null;
      state.secondaryMetrics = [];

      // Write config header to jsonl (append for re-init, create for first)
      try {
        const jsonlPath = path.join(ctx.cwd, "autotrain.jsonl");
        const config = JSON.stringify({
          type: "config",
          name: state.name,
          metricName: state.metricName,
          metricUnit: state.metricUnit,
          bestDirection: state.bestDirection,
        });
        if (isReinit) {
          fs.appendFileSync(jsonlPath, config + "\n");
        } else {
          fs.writeFileSync(jsonlPath, config + "\n");
        }
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `⚠️ Failed to write autotrain.jsonl: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          details: {},
        };
      }

      autotrainMode = true;

      // Write benchmark.json if benchmark param provided
      let benchmarkNote = "";
      if (params.benchmark) {
        try {
          const benchmarkData = {
            frozen_at: new Date().toISOString(),
            primary_metric: state.metricName,
            direction: state.bestDirection,
            guardrails: params.benchmark.guardrails ?? [],
            splits: {
              train_seed: params.benchmark.train_seed,
              eval_seed: params.benchmark.eval_seed,
              test_seed: params.benchmark.test_seed,
              eval_n: params.benchmark.eval_n,
              test_n: params.benchmark.test_n ?? null,
            },
            acceptance_threshold: params.benchmark.acceptance_threshold ?? 0.02,
            noise_note: `eval_n=${params.benchmark.eval_n} → treat +/-${params.benchmark.eval_n < 200 ? "3" : params.benchmark.eval_n < 1000 ? "1.5" : "1"}% as ties`,
          };
          const benchmarkPath = path.join(ctx.cwd, "benchmark.json");
          fs.writeFileSync(benchmarkPath, JSON.stringify(benchmarkData, null, 2) + "\n");

          // Git add + commit benchmark.json
          await pi.exec(
            "bash",
            ["-c", `git add benchmark.json && git commit -m "autotrain: freeze benchmark contract"`],
            { cwd: ctx.cwd, timeout: 10000 },
          );
          benchmarkNote = "\nBenchmark contract written to benchmark.json and committed.";
        } catch (e) {
          benchmarkNote = `\n⚠️ Failed to write/commit benchmark.json: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      updateWidget(ctx);

      const reinitNote = isReinit
        ? " (re-initialized — previous results archived, new baseline needed)"
        : "";
      return {
        content: [
          {
            type: "text",
            text: `✅ Experiment initialized: "${state.name}"${reinitNote}\nMetric: ${state.metricName} (${state.metricUnit || "unitless"}, ${state.bestDirection} is better)\nConfig written to autotrain.jsonl. Now run the baseline smoke with run_experiment.${benchmarkNote}`,
          },
        ],
        details: { state: { ...state } },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("init_experiment "));
      text += theme.fg("accent", args.name ?? "");
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // run_experiment tool — async job submission
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "run_experiment",
    label: "Run Experiment",
    description:
      "Submit a detached HF Job. Returns immediately with a job ID and experiment ID. Default stage is 'smoke' (10-step validation). Use stage='full' after smoke passes.",
    promptSnippet:
      "Run an experiment via HF Jobs (smoke or full). Returns job_id immediately.",
    promptGuidelines: [
      "run_experiment submits training to HF Jobs and returns immediately. Default stage is smoke.",
      "Default stage is 'smoke'. Always run a smoke test before a full training job.",
      "For stage='full', you must provide the experiment_id from the passed smoke.",
      "After run_experiment, call check_jobs to poll for completion.",
    ],
    parameters: RunParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const stage = params.stage ?? "smoke";
      const timeout = (params.timeout_seconds ?? 600) * 1000;
      const command = params.command;
      const scriptHash = hashWorkspace(ctx.cwd, command);
      const jsonlPath = path.join(ctx.cwd, "autotrain.jsonl");

      // For full stage: validate smoke gate
      let experimentId = params.experiment_id;
      if (stage === "full") {
        if (!experimentId) {
          return {
            content: [{ type: "text", text: "❌ experiment_id is required for stage='full'. Provide the experiment_id from the passed smoke." }],
            details: {},
          };
        }
        const reg = smokeRegistry.get(experimentId);
        if (!reg?.passed) {
          return {
            content: [{ type: "text", text: `❌ Smoke for experiment ${experimentId} has not passed. Run a smoke first.` }],
            details: {},
          };
        }
        if (scriptHash !== reg.script_hash) {
          return {
            content: [{ type: "text", text: `❌ Training script changed since smoke passed for experiment ${experimentId}. Re-run smoke with the updated script.` }],
            details: {},
          };
        }
      }

      // For smoke: auto-generate experiment_id
      if (stage === "smoke") {
        experimentId = params.experiment_id ?? nextExperimentId++;

        // 3-strike circuit breaker
        const reg = smokeRegistry.get(experimentId);
        if (reg && reg.failures >= 3 && !reg.passed) {
          return {
            content: [{ type: "text", text: `❌ Experiment ${experimentId} has failed smoke 3 times. Log as smoke_failed and start a new experiment, or document the root cause in autotrain.md before retrying.` }],
            details: {},
          };
        }
      }

      // Benchmark integrity check — refuse to submit if benchmark.json is dirty
      const benchmarkPath = path.join(ctx.cwd, "benchmark.json");
      if (fs.existsSync(benchmarkPath)) {
        try {
          const diffResult = await pi.exec(
            "git", ["diff", "HEAD", "--", "benchmark.json"],
            { cwd: ctx.cwd, timeout: 5000 },
          );
          const diffOutput = (diffResult.stdout || "").trim();
          if (diffOutput) {
            return {
              content: [{ type: "text", text: "❌ Cannot submit — benchmark.json has uncommitted changes.\n\nRevert with: git checkout -- benchmark.json" }],
              details: {},
            };
          }
        } catch {}
      }

      // Execute the command
      let result;
      try {
        result = await pi.exec("bash", ["-c", command], {
          signal,
          timeout,
          cwd: ctx.cwd,
        });
      } catch (e) {
        return {
          content: [{ type: "text", text: `❌ Command failed: ${e instanceof Error ? e.message : String(e)}` }],
          details: {},
        };
      }

      // Parse job ID (24-char hex) from stdout
      const stdout = (result.stdout + "\n" + result.stderr).trim();
      const jobIdMatch = stdout.match(/[0-9a-f]{24}/);
      if (!jobIdMatch) {
        return {
          content: [{ type: "text", text: `❌ No 24-char hex job ID found in output:\n${stdout.slice(-500)}` }],
          details: {},
        };
      }

      const jobId = jobIdMatch[0];
      const startedAt = Date.now();

      // Add to activeJobs
      const jobInfo: JobInfo = {
        job_id: jobId,
        experiment_id: experimentId!,
        stage,
        command,
        script_hash: scriptHash,
        started_at: startedAt,
        poll_count: 0,
      };
      activeJobs.set(jobId, jobInfo);

      // Initialize or update smoke registry for smoke stage
      if (stage === "smoke") {
        if (!smokeRegistry.has(experimentId!)) {
          smokeRegistry.set(experimentId!, {
            passed: false,
            script_hash: scriptHash,
            job_id: jobId,
            failures: 0,
            timestamp: startedAt,
          });
        } else {
          const reg = smokeRegistry.get(experimentId!)!;
          reg.job_id = jobId;
          reg.script_hash = scriptHash;
          reg.passed = false;
          reg.failures = 0;
        }
      }

      // Append job_submitted to JSONL
      try {
        const entry = JSON.stringify({
          type: "job_submitted",
          job_id: jobId,
          experiment_id: experimentId,
          stage,
          command,
          script_hash: scriptHash,
          timestamp: startedAt,
        });
        fs.appendFileSync(jsonlPath, entry + "\n");
      } catch {
        // Non-fatal
      }

      experimentsThisSession++;

      return {
        content: [{
          type: "text",
          text: `✅ Job submitted (${stage})\nJob ID: ${jobId}\nExperiment ID: ${experimentId}\nStage: ${stage}\nScript hash: ${scriptHash.slice(0, 12)}…\n\nCall check_jobs to poll for completion.`,
        }],
        details: {
          job_id: jobId,
          experiment_id: experimentId,
          stage,
          started_at: startedAt,
          script_hash: scriptHash,
        },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("run_experiment "));
      text += theme.fg("muted", args.stage ?? "smoke");
      text += " " + theme.fg("dim", args.command ?? "");
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // check_jobs tool — poll active job status
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "check_jobs",
    label: "Check Jobs",
    description:
      "Check status of all active jobs (or one specific job). Returns status, elapsed time, metrics (if completed), and tail output.",
    promptSnippet:
      "Poll active HF Jobs for status and metrics",
    promptGuidelines: [
      "Call check_jobs after every 2-3 other tool calls while jobs are running.",
      "Do not busy-loop — always do at least one productive action between polls.",
      "When a job completes, metrics are parsed from METRIC lines in the logs.",
    ],
    parameters: CheckJobsParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const jobsToCheck = params.job_id
        ? activeJobs.has(params.job_id)
          ? [activeJobs.get(params.job_id)!]
          : []
        : [...activeJobs.values()];

      if (jobsToCheck.length === 0) {
        return {
          content: [{ type: "text", text: params.job_id ? `❌ Job ${params.job_id} not found in active jobs.` : "No active jobs." }],
          details: { jobs: [] },
        };
      }

      const results: any[] = [];
      const jsonlPath = path.join(ctx.cwd, "autotrain.jsonl");

      for (const job of jobsToCheck) {
        const now = Date.now();
        const elapsedSeconds = Math.round((now - job.started_at) / 1000);

        let status: "running" | "completed" | "error" | "canceled" = "running";
        let metrics: Record<string, number> | null = null;
        let tailOutput = "";

        try {
          const inspectResult = await pi.exec(
            "hf",
            ["jobs", "inspect", job.job_id],
            { cwd: ctx.cwd, timeout: 15000, signal },
          );
          const inspectData = JSON.parse(inspectResult.stdout);
          const hfStatus = inspectData?.[0]?.status?.stage ?? "UNKNOWN";
          status = mapHfStatus(hfStatus);
        } catch {
          // If inspect fails, assume still running
        }

        // Fetch logs for terminal states
        if (status !== "running") {
          try {
            const logsResult = await pi.exec(
              "hf",
              ["jobs", "logs", job.job_id],
              { cwd: ctx.cwd, timeout: 15000, signal },
            );
            const logText = logsResult.stdout;
            if (status === "completed") {
              metrics = parseMetricLines(logText);
            }
            tailOutput = logText.split("\n").slice(-40).join("\n");
          } catch {
            tailOutput = "(logs unavailable)";
          }

          // Write job_completed to JSONL
          try {
            const completedEntry = JSON.stringify({
              type: "job_completed",
              job_id: job.job_id,
              experiment_id: job.experiment_id,
              stage: job.stage,
              status,
              metrics,
              timestamp: Date.now(),
            });
            fs.appendFileSync(jsonlPath, completedEntry + "\n");
          } catch {
            // Non-fatal
          }

          // Update smoke registry
          if (job.stage === "smoke") {
            const reg = smokeRegistry.get(job.experiment_id);
            if (reg) {
              if (status === "completed" && metrics) {
                reg.passed = true;
              } else {
                reg.failures++;
                reg.passed = false;
              }
            }
          }

          // Remove from active jobs
          activeJobs.delete(job.job_id);
        } else {
          // For running jobs, try to get recent logs
          try {
            const logsResult = await pi.exec(
              "hf",
              ["jobs", "logs", job.job_id],
              { cwd: ctx.cwd, timeout: 15000, signal },
            );
            tailOutput = logsResult.stdout.split("\n").slice(-40).join("\n");
          } catch {
            tailOutput = "";
          }
        }

        // Context protection: suppress tail_output after 5 polls
        const showTail = job.poll_count < 5;
        job.poll_count++;

        results.push({
          job_id: job.job_id,
          experiment_id: job.experiment_id,
          stage: job.stage,
          status,
          elapsed_seconds: elapsedSeconds,
          metrics,
          tail_output: showTail ? tailOutput : "",
          poll_count: job.poll_count,
        });
      }

      // Build response text
      const lines: string[] = [];
      for (const r of results) {
        const icon = r.status === "completed" ? "✅" : r.status === "running" ? "⏳" : "❌";
        lines.push(`${icon} Job ${r.job_id.slice(0, 8)}… (exp ${r.experiment_id}, ${r.stage}): ${r.status} — ${r.elapsed_seconds}s`);
        if (r.metrics) {
          lines.push(`   Metrics: ${Object.entries(r.metrics).map(([k, v]) => `${k}=${v}`).join(", ")}`);
        }
        if (r.tail_output) {
          lines.push(`   Output:\n${r.tail_output}`);
        } else if (r.poll_count > 5 && r.status === "running") {
          lines.push(`   (tail output suppressed after 5 polls — status/metrics still shown)`);
        }
      }

      updateWidget(ctx);
      if (overlayTui) overlayTui.requestRender();

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { jobs: results },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("check_jobs"));
      if (args.job_id) text += " " + theme.fg("dim", args.job_id);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // cancel_job tool
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "cancel_job",
    label: "Cancel Job",
    description:
      "Cancel a running HF Job. Refuses to cancel smoke jobs that have been running less than 120 seconds.",
    promptSnippet: "Cancel a running HF Job by job_id",
    promptGuidelines: [
      "Only cancel jobs when there is a clear reason (e.g., wrong configuration, known bug).",
      "Smoke jobs under 2 minutes old cannot be canceled — wait for completion.",
    ],
    parameters: CancelJobParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const job = activeJobs.get(params.job_id);
      if (!job) {
        return {
          content: [{ type: "text", text: `❌ Job ${params.job_id} not found in active jobs.` }],
          details: {},
        };
      }

      // Minimum runtime guard for smoke jobs
      const elapsed = (Date.now() - job.started_at) / 1000;
      if (job.stage === "smoke" && elapsed < 120) {
        return {
          content: [{ type: "text", text: `❌ Smoke has only been running ${Math.round(elapsed)}s. Wait for completion or natural timeout (minimum 120s before cancel).` }],
          details: {},
        };
      }

      // Execute cancel
      try {
        await pi.exec("hf", ["jobs", "cancel", params.job_id], {
          cwd: ctx.cwd,
          timeout: 15000,
        });
      } catch (e) {
        return {
          content: [{ type: "text", text: `❌ Failed to cancel job: ${e instanceof Error ? e.message : String(e)}` }],
          details: {},
        };
      }

      // Write job_completed for the canceled job
      const jsonlPath = path.join(ctx.cwd, "autotrain.jsonl");
      try {
        const completedEntry = JSON.stringify({
          type: "job_completed",
          job_id: params.job_id,
          experiment_id: job.experiment_id,
          stage: job.stage,
          status: "canceled",
          metrics: null,
          timestamp: Date.now(),
        });
        fs.appendFileSync(jsonlPath, completedEntry + "\n");
      } catch {}

      // Update smoke registry — canceled smoke counts as failure
      if (job.stage === "smoke") {
        const reg = smokeRegistry.get(job.experiment_id);
        if (reg) {
          reg.failures++;
          reg.passed = false;
        }
      }

      activeJobs.delete(params.job_id);

      return {
        content: [{ type: "text", text: `✅ Canceled job ${params.job_id}. Reason: ${params.reason}` }],
        details: { job_id: params.job_id, reason: params.reason },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("cancel_job "));
      text += theme.fg("dim", args.job_id ?? "");
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // log_experiment tool — record experiment decision with benchmark check
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "log_experiment",
    label: "Log Experiment",
    description:
      "Record an experiment decision (keep/discard/crash/smoke_failed). Checks benchmark.json integrity on keep.",
    promptSnippet:
      "Log experiment result with benchmark integrity check",
    promptGuidelines: [
      "Use log_experiment after check_jobs shows a completed job.",
      "On 'keep', benchmark.json must not have uncommitted changes.",
      "Use 'smoke_failed' when a smoke test fails — this counts toward anti-thrash.",
    ],
    parameters: Type.Object({
      commit: Type.String({ description: "Git commit hash (short, 7 chars)" }),
      metric: Type.Number({
        description: "The primary optimization metric value. 0 for crashes/smoke_failed.",
      }),
      status: StringEnum(["keep", "discard", "crash", "checks_failed", "smoke_failed"] as const),
      description: Type.String({ description: "Short description of what this experiment tried" }),
      metrics: Type.Optional(
        Type.Record(Type.String(), Type.Number(), {
          description: "Additional metrics to track as { name: value } pairs.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: "Set to true to allow adding a new secondary metric.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Benchmark integrity check on keep
      if (params.status === "keep") {
        const benchmarkPath = path.join(ctx.cwd, "benchmark.json");
        if (fs.existsSync(benchmarkPath)) {
          try {
            const diffResult = await pi.exec(
              "git",
              ["diff", "HEAD", "--", "benchmark.json"],
              { cwd: ctx.cwd, timeout: 5000 },
            );
            const diffOutput = (diffResult.stdout || "").trim();
            if (diffOutput) {
              return {
                content: [{
                  type: "text",
                  text: `❌ Cannot keep — benchmark.json has uncommitted changes.\n\nRevert with: git checkout -- benchmark.json\n\nDiff:\n${diffOutput.slice(0, 500)}`,
                }],
                details: {},
              };
            }
          } catch {
            // If git diff fails, proceed cautiously
          }
        }
      }

      const secondaryMetrics = params.metrics ?? {};

      // Validate secondary metrics consistency
      if (state.secondaryMetrics.length > 0) {
        const knownNames = new Set(state.secondaryMetrics.map((m) => m.name));
        const providedNames = new Set(Object.keys(secondaryMetrics));
        const missing = [...knownNames].filter((n) => !providedNames.has(n));
        if (missing.length > 0) {
          return {
            content: [{
              type: "text",
              text: `❌ Missing secondary metrics: ${missing.join(", ")}\nExpected: ${[...knownNames].join(", ")}`,
            }],
            details: {},
          };
        }
        const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
        if (newMetrics.length > 0 && !params.force) {
          return {
            content: [{
              type: "text",
              text: `❌ New secondary metric(s) not previously tracked: ${newMetrics.join(", ")}. Use force: true to add.`,
            }],
            details: {},
          };
        }
      }

      const experiment: ExperimentResult = {
        commit: params.commit.slice(0, 7),
        metric: params.metric,
        metrics: secondaryMetrics,
        status: params.status === "smoke_failed" ? "crash" : params.status,
        description: params.description,
        timestamp: Date.now(),
        segment: state.currentSegment,
      };

      state.results.push(experiment);
      experimentsThisSession++;

      // Register secondary metrics
      for (const name of Object.keys(secondaryMetrics)) {
        if (!state.secondaryMetrics.find((m) => m.name === name)) {
          let unit = "";
          if (name.endsWith("_µs") || name.includes("µs")) unit = "µs";
          else if (name.endsWith("_ms") || name.includes("ms")) unit = "ms";
          else if (name.endsWith("_s") || name.includes("sec")) unit = "s";
          state.secondaryMetrics.push({ name, unit });
        }
      }

      state.bestMetric = findBaselineMetric(state.results, state.currentSegment);

      let text = `Logged #${state.results.length}: ${params.status} — ${experiment.description}`;

      if (state.bestMetric !== null) {
        text += `\nBaseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`;
      }

      // Auto-commit on keep
      if (params.status === "keep") {
        try {
          const resultData: Record<string, unknown> = {
            status: params.status,
            [state.metricName || "metric"]: params.metric,
            ...secondaryMetrics,
          };
          const trailerJson = JSON.stringify(resultData);
          const commitMsg = `${params.description}\n\nResult: ${trailerJson}`;
          const gitResult = await pi.exec(
            "bash",
            ["-c", `git add -A && git diff --cached --quiet && echo "NOTHING_TO_COMMIT" || git commit -m ${JSON.stringify(commitMsg)}`],
            { cwd: ctx.cwd, timeout: 10000 },
          );
          const gitOutput = (gitResult.stdout + gitResult.stderr).trim();
          if (gitOutput.includes("NOTHING_TO_COMMIT")) {
            text += `\n📝 Git: nothing to commit`;
          } else if (gitResult.code === 0) {
            text += `\n📝 Git: committed — ${gitOutput.split("\n")[0] || ""}`;
            try {
              const shaResult = await pi.exec("git", ["rev-parse", "--short=7", "HEAD"], { cwd: ctx.cwd, timeout: 5000 });
              const newSha = (shaResult.stdout || "").trim();
              if (newSha && newSha.length >= 7) experiment.commit = newSha;
            } catch {}
          } else {
            text += `\n⚠️ Git commit failed: ${gitOutput.slice(0, 200)}`;
          }
        } catch (e) {
          text += `\n⚠️ Git error: ${e instanceof Error ? e.message : String(e)}`;
        }
      } else {
        text += `\n📝 Git: skipped commit (${params.status}) — revert with git checkout -- .`;
      }

      // Persist to autotrain.jsonl
      try {
        const jsonlPath = path.join(ctx.cwd, "autotrain.jsonl");
        fs.appendFileSync(
          jsonlPath,
          JSON.stringify({ run: state.results.length, ...experiment }) + "\n",
        );
      } catch {}

      updateWidget(ctx);
      if (overlayTui) overlayTui.requestRender();

      return {
        content: [{ type: "text", text }],
        details: { experiment, state: { ...state } } as LogDetails,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("log_experiment "));
      const color = args.status === "keep" ? "success" : args.status === "crash" || args.status === "smoke_failed" ? "error" : "warning";
      text += theme.fg(color, args.status);
      text += " " + theme.fg("dim", args.description);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // Ctrl+X — toggle dashboard expand/collapse
  // -----------------------------------------------------------------------

  pi.registerShortcut("ctrl+x", {
    description: "Toggle autotrain dashboard",
    handler: async (ctx) => {
      if (state.results.length === 0) {
        if (
          !autotrainMode &&
          !fs.existsSync(path.join(ctx.cwd, "autotrain.md"))
        ) {
          ctx.ui.notify(
            "No experiments yet — run /autotrain to get started",
            "info",
          );
        } else {
          ctx.ui.notify("No experiments yet", "info");
        }
        return;
      }
      dashboardExpanded = !dashboardExpanded;
      updateWidget(ctx);
    },
  });

  // -----------------------------------------------------------------------
  // Ctrl+Shift+X — fullscreen scrollable dashboard overlay
  // -----------------------------------------------------------------------

  pi.registerShortcut("ctrl+shift+x", {
    description: "Fullscreen autotrain dashboard",
    handler: async (ctx) => {
      if (state.results.length === 0) {
        ctx.ui.notify("No experiments yet", "info");
        return;
      }

      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          let scrollOffset = 0;
          // Store tui ref so run_experiment can trigger re-renders
          overlayTui = tui;

          // Start spinner interval for elapsed time animation
          spinnerInterval = setInterval(() => {
            spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
            if (activeJobs.size > 0) tui.requestRender();
          }, 80);

          function formatElapsed(ms: number): string {
            const s = Math.floor(ms / 1000);
            const m = Math.floor(s / 60);
            const sec = s % 60;
            return m > 0 ? `${m}m${String(sec).padStart(2, "0")}s` : `${sec}s`;
          }

          return {
            render(width: number): string[] {
              const termH = process.stdout.rows || 40;
              // Content gets the full width — no box borders
              const content = renderDashboardLines(state, width, theme, 0);

              // Add active async jobs
              for (const [, job] of activeJobs) {
                const elapsed = formatElapsed(Date.now() - job.started_at);
                const frame = SPINNER[spinnerFrame % SPINNER.length];
                content.push(
                  truncateToWidth(
                    `  ${theme.fg("dim", `exp${job.experiment_id}`.padEnd(3))}` +
                      theme.fg("warning", `${frame} ${job.stage} ${job.job_id.slice(0, 8)}… ${elapsed}`),
                    width,
                  ),
                );
              }

              const totalRows = content.length;
              const viewportRows = Math.max(4, termH - 4); // leave room for header/footer

              // Clamp scroll
              const maxScroll = Math.max(0, totalRows - viewportRows);
              if (scrollOffset > maxScroll) scrollOffset = maxScroll;
              if (scrollOffset < 0) scrollOffset = 0;

              const out: string[] = [];

              // Header line
              const titlePrefix = "🔬 autotrain";
              const nameStr = state.name ? `: ${state.name}` : "";
              const maxTitleLen = width - 6;
              let title = titlePrefix + nameStr;
              if (title.length > maxTitleLen) {
                title = title.slice(0, maxTitleLen - 1) + "…";
              }
              const fillLen = Math.max(0, width - 3 - 1 - title.length - 1);
              out.push(
                truncateToWidth(
                  theme.fg("borderMuted", "───") +
                    theme.fg("accent", " " + title + " ") +
                    theme.fg("borderMuted", "─".repeat(fillLen)),
                  width,
                ),
              );

              // Content rows
              const visible = content.slice(
                scrollOffset,
                scrollOffset + viewportRows,
              );
              for (const line of visible) {
                out.push(truncateToWidth(line, width));
              }
              // Fill remaining viewport
              for (let i = visible.length; i < viewportRows; i++) {
                out.push("");
              }

              // Footer line
              const scrollInfo =
                totalRows > viewportRows
                  ? ` ${scrollOffset + 1}-${Math.min(scrollOffset + viewportRows, totalRows)}/${totalRows}`
                  : "";
              const helpText = ` ↑↓/j/k scroll • esc close${scrollInfo} `;
              const footFill = Math.max(0, width - helpText.length);
              out.push(
                truncateToWidth(
                  theme.fg("borderMuted", "─".repeat(footFill)) +
                    theme.fg("dim", helpText),
                  width,
                ),
              );

              return out;
            },

            handleInput(data: string): void {
              const termH = process.stdout.rows || 40;
              const viewportRows = Math.max(4, termH - 4);
              const totalRows =
                state.results.length + activeJobs.size + 15; // rough estimate
              const maxScroll = Math.max(0, totalRows - viewportRows);

              if (matchesKey(data, "escape") || data === "q") {
                done(undefined);
                return;
              }
              if (matchesKey(data, "up") || data === "k") {
                scrollOffset = Math.max(0, scrollOffset - 1);
              } else if (matchesKey(data, "down") || data === "j") {
                scrollOffset = Math.min(maxScroll, scrollOffset + 1);
              } else if (matchesKey(data, "pageUp") || data === "u") {
                scrollOffset = Math.max(0, scrollOffset - viewportRows);
              } else if (matchesKey(data, "pageDown") || data === "d") {
                scrollOffset = Math.min(maxScroll, scrollOffset + viewportRows);
              } else if (data === "g") {
                scrollOffset = 0;
              } else if (data === "G") {
                scrollOffset = maxScroll;
              }
              tui.requestRender();
            },

            invalidate(): void {},

            dispose(): void {
              overlayTui = null;
              if (spinnerInterval) {
                clearInterval(spinnerInterval);
                spinnerInterval = null;
              }
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            width: "95%",
            maxHeight: "90%",
            anchor: "center" as const,
          },
        },
      );
    },
  });

  // -----------------------------------------------------------------------
  // /autotrain command — enter autotrain mode
  // -----------------------------------------------------------------------

  pi.registerCommand("autotrain", {
    description: "Start, stop, clear, or resume autotrain mode",
    handler: async (args, ctx) => {
      const trimmedArgs = (args ?? "").trim();
      const command = trimmedArgs.toLowerCase();

      if (!trimmedArgs) {
        ctx.ui.notify(autotrainHelp(), "info");
        return;
      }

      if (command === "off") {
        autotrainMode = false;
        autoResumeTurns = 0;
        experimentsThisSession = 0;
        ctx.ui.notify("Autotrain mode OFF", "info");
        return;
      }

      if (command === "clear") {
        const jsonlPath = path.join(ctx.cwd, "autotrain.jsonl");
        autotrainMode = false;
        autoResumeTurns = 0;
        experimentsThisSession = 0;
        state = {
          results: [],
          bestMetric: null,
          bestDirection: "lower",
          metricName: "metric",
          metricUnit: "",
          secondaryMetrics: [],
          name: null,
          currentSegment: 0,
        };
        updateWidget(ctx);

        if (fs.existsSync(jsonlPath)) {
          fs.unlinkSync(jsonlPath);
          ctx.ui.notify(
            "Deleted autotrain.jsonl and turned autotrain mode OFF",
            "info",
          );
        } else {
          ctx.ui.notify(
            "No autotrain.jsonl found. Autotrain mode OFF",
            "info",
          );
        }
        return;
      }

      // Check HF auth before starting — fail fast if not logged in
      try {
        const hfResult = await pi.exec("hf", ["auth", "whoami"], {
          cwd: ctx.cwd,
          timeout: 10000,
        });
        const hfOutput = (hfResult.stdout + "\n" + hfResult.stderr).trim();
        if (hfOutput.includes("Not logged in") || hfResult.code !== 0) {
          ctx.ui.notify(
            "Not logged in to Hugging Face. Run: hf auth login",
            "error",
          );
          return;
        }
      } catch {
        ctx.ui.notify(
          "hf CLI not found. Install: pip install huggingface_hub[cli]",
          "error",
        );
        return;
      }

      autotrainMode = true;
      autoResumeTurns = 0;

      const mdPath = path.join(ctx.cwd, "autotrain.md");
      const hasRules = fs.existsSync(mdPath);

      if (hasRules) {
        ctx.ui.notify(
          "Autotrain mode ON — rules loaded from autotrain.md",
          "info",
        );
        pi.sendUserMessage(
          `Autotrain mode active. ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`,
        );
      } else {
        ctx.ui.notify(
          "Autotrain mode ON — no autotrain.md found, setting up",
          "info",
        );
        pi.sendUserMessage(
          `Start autotrain: ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`,
        );
      }
    },
  });
}
