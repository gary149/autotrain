# Autotrain 2 — Minimal First Integration

Three changes to the current codebase. Everything else stays the same.

---

## What we're fixing

| Problem | Session evidence | Fix |
|---------|-----------------|-----|
| Agent blocked for hours | 2.5h per DOOM run, ~40h total idle | Async job submission + polling |
| One job at a time | 16 serial DOOM experiments, no overlap | Pipelined jobs — smoke B while full A runs |
| No smoke test | First DOOM run crashed on missing dep | Mandatory 10-step smoke before full run |
| Eval integrity broken | NER shared-RNG produced fake 96.77% | Frozen benchmark file with fixed splits |

## What we're NOT changing

- `autotrain.md` — still the living memory, same format
- `autotrain.jsonl` — still the append-only experiment log (new entry types added)
- Skill structure (SKILL.md, references) — same setup steps, phase order, anti-thrash rules
- Dashboard widget + Ctrl+Y — same UI (extended for multiple active jobs)
- Auto-resume on context limit — same behavior (trigger condition updated)
- Git auto-commit on keep, revert on discard — same
- HF integration (uploads, model cards) — same
- Phase discipline (data > format > architecture > HP > regularization) — same

---

## Change 1: Async jobs

Replace the blocking `run_experiment` with three tools.

### How `submit_job` is non-blocking

There is no background-process API in the pi extension system. `pi.exec()` always blocks until the subprocess exits. **The non-blocking behavior comes from the script contract, not the extension:**

`autotrain.sh` calls `hf jobs uv run -d` (detached mode) which submits the job to HF's infrastructure and prints a job ID in seconds. The script exits immediately. `pi.exec()` resolves in seconds because the process it ran exits in seconds. The GPU training runs remotely on HF.

If `autotrain.sh` ever blocks (local mode, missing `-d` flag), `submit_job` blocks too. The extension cannot prevent this. The skill must enforce the contract: "autotrain.sh must exit in seconds."

### `submit_job`

Submits a detached HF Job. Returns immediately with a job ID and experiment ID.

```typescript
const SubmitJobParams = Type.Object({
  command: Type.String({
    description: "Shell command to submit (typically ./autotrain.sh)",
  }),
  experiment_id: Type.Optional(
    Type.Number({
      description: "Experiment ID to associate this job with. Required for stage='full' (must match a passed smoke). Auto-generated for smoke.",
    }),
  ),
  stage: Type.Optional(
    StringEnum(["smoke", "full"] as const, {
      description: 'Job stage. "smoke" = 10-step validation. "full" = real training. Default: "smoke".',
    }),
  ),
  timeout_seconds: Type.Optional(
    Type.Number({ description: "Kill after this many seconds (default: 600)" }),
  ),
});

// Returns:
// {
//   job_id: string,        // HF Job ID (24-char hex)
//   experiment_id: number,  // sequential experiment number (auto-generated for smoke, echoed for full)
//   stage: "smoke" | "full",
//   started_at: number,     // timestamp
//   script_hash: string,    // SHA-256 of the command string (for smoke gate integrity)
// }
```

**On submit:** The extension computes a SHA-256 of the `command` string and stores it keyed by `experiment_id`. This is the **script hash** used by the smoke gate (see Change 2).

**Default stage is `smoke`, not `full`.** This nudges the agent toward smoking first.

### `check_jobs`

Checks status of all active jobs (or one specific job). The agent calls this between doing other work.

```typescript
const CheckJobsParams = Type.Object({
  job_id: Type.Optional(
    Type.String({ description: "Specific job ID to check. Omit to check all active jobs." }),
  ),
});

// Returns an array — one entry per active job:
// [{
//   job_id: string,
//   experiment_id: number,
//   stage: "smoke" | "full",
//   status: "running" | "completed" | "error" | "canceled" | "timeout",
//   elapsed_seconds: number,
//   metrics: Record<string, number> | null,  // parsed METRIC lines if completed
//   tail_output: string,                     // last 40 lines of logs (suppressed after 5 polls)
//   poll_count: number,                      // how many times this job has been polled
// }]
```

**Implementation:**

1. Iterates over the active jobs map.
2. For each, calls `hf jobs inspect <job_id> --format json`.
3. **HF Jobs returns uppercase status** nested at `[0]['status']['stage']`: `COMPLETED`, `ERROR`, `CANCELED`, `TIMEOUT`. The extension maps these to lowercase for the return type. Any non-terminal value (e.g., `RUNNING`, `PENDING`, `QUEUED`) maps to `"running"`.
4. If completed, calls `hf jobs logs <job_id>` and parses `METRIC name=value` lines.
5. Removes completed/failed/canceled jobs from the active map.
6. **Context protection:** After 5 polls of the same job, `tail_output` is suppressed (empty string). The agent can still see `status`, `elapsed_seconds`, and `metrics`. This prevents 50-poll context exhaustion.

**Parallelism is built in.** The agent can call `submit_job` multiple times before calling `check_jobs`. The map holds N active jobs. `check_jobs` returns all of them in one call.

### `cancel_job`

Cancels a running job.

```typescript
const CancelJobParams = Type.Object({
  job_id: Type.String({ description: "HF Job ID to cancel" }),
  reason: Type.String({ description: "Why this job is being canceled" }),
});
```

**Implementation:** Calls `hf jobs cancel <job_id>`.

**Minimum runtime guard:** If the job is a smoke that has been running for less than 120 seconds, `cancel_job` refuses with an error: "Smoke has only been running Xs. Wait for completion or natural timeout." This prevents the premature-cancellation loop where the agent cancels smokes before they finish data loading.

### What happens to `run_experiment`?

Keep it as a fallback for local/synchronous use. The skill guides the agent toward `submit_job` + `check_jobs` for HF Jobs campaigns.

### The pipelined loop

```
1. submit_job(smoke, experiment A)      → returns immediately, gets experiment_id=1
2. while smoke runs:
     plan experiment B config
     profile dataset with hf datasets sql
     write plan to autotrain.ideas.md      ← externalize state before context reset
3. check_jobs                             → smoke A completed
4. submit_job(full, experiment_id=1)      → returns immediately
5. submit_job(smoke, experiment B)        → returns immediately, gets experiment_id=2
6. while both run:
     do 1-2 planning steps, then check_jobs
     repeat until a job completes
7. check_jobs                             → full A completed
8. log_decision(A)                        → keep/discard
9. check_jobs                             → smoke B completed
10. submit_job(full, experiment_id=2)     → returns immediately
... and so on
```

**Parallelism is pipelining, not concurrent editing.** The agent submits smoke for the *next* experiment while the *current* experiment's full run trains. Both use the same training script — only env var configs differ. The agent does NOT edit files while a full run is active. This avoids the `git add -A` contamination problem (see Design decisions below).

**Polling cadence rule for the skill:** "Call `check_jobs` after every 2-3 other tool calls, or immediately if you have no planning work left. Do not call `check_jobs` in a tight loop — always do at least one productive action between polls."

### Active jobs state

The extension tracks active jobs in memory and persists them to `autotrain.jsonl`:

```json
{"type": "job_submitted", "job_id": "abc123", "experiment_id": 5, "stage": "smoke", "command": "...", "script_hash": "a1b2c3...", "timestamp": 1234}
{"type": "job_completed", "job_id": "abc123", "experiment_id": 5, "stage": "smoke", "status": "completed", "metrics": {"entity_f1": 0.89}, "timestamp": 1235}
```

### Session resume and orphan scan

On session resume (`reconstructState`), the extension:

1. **Parses JSONL with type dispatch.** Entries with `type: "config"` → metric config. Entries with `type: "job_submitted"` / `type: "job_completed"` → active jobs map. Everything else → experiment results. **No fallthrough** — unknown types are skipped, not pushed to `state.results`.

2. **Builds the active jobs map** from `job_submitted` entries that have no matching `job_completed` entry (matched by `job_id`).

3. **Runs an orphan scan:** For each active-but-incomplete job, calls `hf jobs inspect <job_id> --format json`. If the job completed while the agent was down, fetches logs, parses metrics, writes a synthetic `job_completed` entry to JSONL, and presents the result to the agent on first `check_jobs` call.

4. **Reconstructs smoke gate state** from `job_completed` entries (see Change 2).

5. **Notifies the agent on resume:** The `before_agent_start` injection includes "Found N active jobs from previous session" so the agent knows to call `check_jobs`.

### Auto-resume trigger update

The current auto-resume guard (`experimentsThisSession === 0 → don't resume`) breaks with async tools because the agent may only poll (no `log_decision` calls). Fix: also check `activeJobs.size > 0`. If there are active jobs, always auto-resume even if no experiments were logged this session.

The 5-minute rate limit is reduced to 2 minutes — smoke tests take ~2 minutes, so the agent should resume shortly after a smoke completes.

### Dashboard update

`runningExperiment` (currently a singleton `{ startedAt, command } | null`) becomes a list derived from the active jobs map. The fullscreen overlay renders one row per active job with stage label and elapsed time. The collapsed widget shows "N jobs active" instead of a single spinner.

---

## Change 2: Smoke gate

Every experiment must pass a 10-step smoke test before receiving full training budget.

### How it works

The smoke test is the same training script, run with overridden env vars:

```bash
# In autotrain.sh, the smoke mode:
if [ "$AUTOTRAIN_STAGE" = "smoke" ]; then
  export MAX_STEPS=10
  export LOGGING_STEPS=1
  export EVAL_STEPS=10
fi
```

The agent calls `submit_job` with `stage: "smoke"`. The job runs 10 steps, emits METRIC lines, and exits. Cost: ~$0.05, time: ~2 minutes.

### What smoke catches

- Missing dependencies (saved 2.5h in DOOM experiment 1)
- Data loading errors
- Shape mismatches, dtype errors
- OOM on the selected hardware
- Broken metric extraction

### Gate logic

When `check_jobs` returns a completed smoke job:
- If exit code 0 AND metrics parsed successfully → agent may `submit_job` with `stage: "full"` for that experiment ID
- If exit code != 0 OR no metrics → agent calls `log_decision` with status `smoke_failed`, fixes the issue, tries again

### Enforcement: per-experiment with script hash

The `last_smoke_passed: boolean` approach from the earlier draft is **wrong for parallel jobs.** A global boolean breaks when multiple experiments are in flight.

Instead, the extension maintains a **smoke registry** keyed by experiment ID:

```typescript
// In extension state:
smokeRegistry: Map<number, {  // keyed by experiment_id
  passed: boolean,
  script_hash: string,         // SHA-256 of the command at smoke time
  job_id: string,
  timestamp: number,
}>
```

**On `submit_job(stage="smoke")`:** Auto-generates an `experiment_id`. Computes `script_hash` from the command string. Stores `{ passed: false, script_hash, job_id }` in the registry.

**On smoke completion (in `check_jobs`):** Sets `passed: true` for that `experiment_id`.

**On `submit_job(stage="full", experiment_id=N)`:**
1. Checks `smokeRegistry.get(N)?.passed === true`. If not → error: "Smoke for experiment N has not passed."
2. Computes the script hash of the current command. Compares to `smokeRegistry.get(N).script_hash`. If different → error: "Training script changed since smoke passed. Re-run smoke."

This prevents both the parallel-boolean bug AND the script-substitution attack (where the agent edits the script between smoke-pass and full-submit).

### Smoke failure circuit breaker

Anti-thrash rules don't cover smoke failures (they count discards of completed experiments). Add:

- **3-strike rule:** If an experiment ID has 3 consecutive smoke failures, `submit_job(stage="smoke")` for that experiment returns an error: "Experiment N has failed smoke 3 times. Log as `smoke_failed` and start a new experiment, or document the root cause in autotrain.md before retrying."
- **Smoke failures count toward anti-thrash.** The "5+ consecutive discards → pivot phase" rule is broadened to "5+ consecutive failures (smoke or full)."

### Reconstruction on resume

The smoke registry is reconstructed from `job_completed` entries in JSONL where `stage: "smoke"` and `status: "completed"` with metrics. The `script_hash` is stored in the `job_submitted` entry and carried forward.

---

## Change 3: Frozen benchmark

A `benchmark.json` file that locks down the eval contract before any GPU spend.

### File format

```json
{
  "frozen_at": "2026-03-19T10:30:00Z",
  "primary_metric": "entity_f1",
  "direction": "higher",
  "guardrails": ["json_validity_pct"],
  "splits": {
    "train_seed": 42,
    "eval_seed": 999,
    "test_seed": 777,
    "eval_n": 200,
    "test_n": 500
  },
  "acceptance_threshold": 0.02,
  "noise_note": "eval_n=200 → treat +/-1.5% as ties"
}
```

### How it's created

During `init_campaign` (the new `init_experiment`), the agent specifies the benchmark config. The extension writes `benchmark.json` and commits it.

```typescript
const InitCampaignParams = Type.Object({
  name: Type.String({ description: "Campaign name" }),
  metric_name: Type.String({ description: "Primary metric name" }),
  metric_unit: Type.Optional(Type.String()),
  direction: Type.Optional(StringEnum(["lower", "higher"] as const)),
  // New fields:
  benchmark: Type.Optional(Type.Object({
    train_seed: Type.Number({ description: "RNG seed for training split" }),
    eval_seed: Type.Number({ description: "Separate RNG seed for eval split" }),
    test_seed: Type.Number({ description: "Separate RNG seed for test split" }),
    eval_n: Type.Number({ description: "Number of eval examples" }),
    test_n: Type.Optional(Type.Number({ description: "Number of test examples" })),
    acceptance_threshold: Type.Optional(Type.Number({ description: "Minimum improvement to count as real. Default: 0.02" })),
    guardrails: Type.Optional(Type.Array(Type.String(), { description: "Names of guardrail metrics to track" })),
  })),
});
```

### Freeze enforcement

Once `benchmark.json` is committed:
- `log_decision` with status `keep` runs `git diff HEAD -- benchmark.json` BEFORE `git add -A`. If there are any uncommitted changes to `benchmark.json`, the keep is refused with an integrity warning.
- The agent must revert the benchmark file before retrying.

**Why `git diff` instead of stored SHA:** A stored SHA in extension memory is lost on restart. A SHA in JSONL requires parser changes. `git diff HEAD -- benchmark.json` always works — it compares the working tree to the last commit. Zero stored state needed. One `pi.exec` call.

### What this prevents

- The NER shared-RNG bug: train and eval seeds are explicitly separate
- Score hacking via eval set manipulation: the file is frozen
- Noise-as-signal: `acceptance_threshold` + `noise_note` remind the agent that small swings don't count

### What this does NOT do (deferred)

- Automatic split generation (the agent still writes the data prep code — seeds just have to match)
- Multi-objective gate enforcement (guardrails are tracked but advisory, not hard-blocked)
- Protected path enforcement beyond benchmark.json

---

## Design decisions from review

### Why pipelining, not true parallelism

The review team found that true parallel editing (agent modifies training scripts for experiments A and B simultaneously) breaks git:

- `git add -A` on keep for A commits B's in-progress edits
- `git checkout -- .` on discard for A reverts B's edits
- The commit for experiment B may have no diff because A's commit already captured everything

**The fix is a constraint, not more infrastructure.** The agent does one thing at a time in the working tree, but jobs run concurrently on HF:

| What | Serial | Parallel |
|------|--------|----------|
| File edits in working tree | Yes — one experiment's changes at a time | No |
| HF Jobs running remotely | No — pipelined (smoke B runs while full A trains) | Yes |
| Planning and analysis | Yes — between polls | N/A |

**Skill rule:** "Do not edit training scripts or configs while a full job is active. Make all code changes before `submit_job`, not after. Only modify `autotrain.md` and `autotrain.ideas.md` while jobs run."

This is a deliberate simplification. True parallel git isolation (worktrees per experiment) is deferred to a future version.

### Why phase discipline stays sequential

The review found that the phase order ("exhaust Phase 1 before Phase 2") is logically incompatible with parallel Phase 1 + Phase 2 experiments. Phase 1 results should inform Phase 2 choices.

**Rule for the skill:** "Parallelism is within-phase only. You may pipeline multiple Phase 1 experiments (e.g., smoke for curation strategy B while full run for curation strategy A trains). You must not submit Phase N+1 experiments until at least one Phase N full run has completed and you've analyzed the results."

### Why `git diff` for benchmark instead of SHA

- No stored state needed — works on cold resume
- No JSONL schema changes
- Catches uncommitted modifications that a SHA comparison would miss if the agent modified and restored the file within the same session
- One `pi.exec("git", ["diff", "HEAD", "--", "benchmark.json"])` call

---

## Tool summary

| Tool | Replaces | What it does |
|------|----------|--------------|
| `init_campaign` | `init_experiment` | Same + creates `benchmark.json` |
| `submit_job` | `run_experiment` (async) | Submits job, returns immediately. Enforces smoke gate. |
| `check_jobs` | (new) | Polls job status, parses metrics. Context-aware output. |
| `cancel_job` | (new) | Cancels a running job. Minimum runtime guard. |
| `log_decision` | `log_experiment` | Same + benchmark integrity check via `git diff`. |
| `run_experiment` | (kept as fallback) | Synchronous run for local/quick tasks |

Total: 4 new tools, 1 modified tool, 1 kept as-is.

---

## JSONL schema

All entries in `autotrain.jsonl`. Existing entries are unchanged. New entries have explicit `type` fields.

```
# Existing (unchanged):
{"type": "config", "name": "...", "metricName": "...", "metricUnit": "...", "bestDirection": "..."}
{"run": 1, "commit": "abc1234", "metric": 0.85, "metrics": {...}, "status": "keep", "description": "...", "timestamp": 1234, "segment": 0}

# New:
{"type": "job_submitted", "job_id": "abc123", "experiment_id": 5, "stage": "smoke", "command": "...", "script_hash": "a1b2c3...", "timestamp": 1234}
{"type": "job_completed", "job_id": "abc123", "experiment_id": 5, "stage": "smoke", "status": "completed", "metrics": {"entity_f1": 0.89}, "timestamp": 1235}
{"type": "job_completed", "job_id": "def456", "experiment_id": 5, "stage": "full", "status": "error", "metrics": null, "timestamp": 1236}
```

**Parser rules for `reconstructState`:**
- `type === "config"` → metric config, segment bump (unchanged)
- `type === "job_submitted"` → add to active jobs map
- `type === "job_completed"` → remove from active jobs map, update smoke registry
- No `type` field + has `run` field → experiment result (unchanged, backward compatible)
- Unknown `type` → skip silently

---

## Skill changes

The SKILL.md loop rules change from:

```
init_experiment → run baseline → log_experiment → loop (serial, blocking)
```

to:

```
init_campaign (with benchmark)
→ submit_job(smoke, A)
→ while waiting: plan B, write plan to ideas.md
→ check_jobs → smoke A passed
→ submit_job(full, experiment_id=A)
→ submit_job(smoke, B)                    ← pipeline: smoke B while full A trains
→ while both run: 1-2 planning steps, then check_jobs, repeat
→ check_jobs → full A completed
→ log_decision(A)
→ check_jobs → smoke B completed
→ submit_job(full, experiment_id=B)
→ loop
```

**New skill rules to add:**

1. **Polling cadence:** "Call `check_jobs` after every 2-3 other tool calls. If no planning work remains, call `check_jobs` directly. Do not busy-loop — always do at least one productive action between polls."

2. **No file edits during active full runs:** "Do not modify training scripts while a full job is active. Make all code changes before `submit_job`. While jobs run, only update `autotrain.md`, `autotrain.ideas.md`, and do analysis."

3. **Within-phase parallelism only:** "You may pipeline multiple experiments from the same phase. Do not submit Phase N+1 experiments until at least one Phase N full run has completed."

4. **Externalize plans before polling:** "Before calling `check_jobs`, write your current experiment plan to `autotrain.ideas.md`. This survives context resets."

5. **Smoke failures count toward anti-thrash:** "5+ consecutive failures (smoke_failed or discard) → pivot phase."

---

## What this doesn't include (deferred to later)

| Feature | Why deferred |
|---------|-------------|
| Budget/cost estimation | Adds complexity. Agent can track cost manually in autotrain.md. |
| Recipe library | Agent still writes training code from scratch (works fine). Recipes come later. |
| Concurrency limits | Pipelining constraint (1 full + 1 smoke) is enforced by skill rules, not extension code. |
| Git worktrees per experiment | Pipelining + "no edits during full runs" rule avoids git conflicts for now. |
| Integrity monitors (diff scanner, timing checks) | `git diff` on benchmark.json + script hash on smoke gate is enough for now. |
| Accept rate tracking | Anti-thrash rules cover this manually. |
| `leaderboard.json` / `campaign.json` | `autotrain.jsonl` + `autotrain.md` is enough state. |

---

## Implementation order

### Step 1: `submit_job` + `check_jobs` + `cancel_job`

The async core.

- Add active jobs map to extension state (`Map<string, JobInfo>`)
- Add `type` dispatch to `reconstructState` JSONL parser (critical: prevent `job_submitted`/`job_completed` from corrupting `state.results`)
- `submit_job`: run `autotrain.sh` via `pi.exec()` (exits in seconds due to `-d`), parse job ID from stdout, write `job_submitted` to JSONL, return
- `check_jobs`: iterate active map, call `hf jobs inspect --format json` (parse `[0]['status']['stage']` — map uppercase to lowercase), fetch logs on completion, parse METRIC lines, write `job_completed` to JSONL. Suppress `tail_output` after 5 polls.
- `cancel_job`: call `hf jobs cancel`, enforce 120s minimum for smoke jobs
- Orphan scan on `reconstructState`: inspect all submitted-without-completed jobs
- Update auto-resume: trigger when `activeJobs.size > 0` even if `experimentsThisSession === 0`. Reduce rate limit from 5 minutes to 2 minutes.
- Update dashboard: `runningExperiment` becomes list from active jobs map

**Test:** Submit a real HF Job, poll with check_jobs, verify metrics parsed. Kill process, restart, verify orphan scan finds the job.

### Step 2: Smoke gate

- Add `experiment_id` (auto-increment for smoke, input for full) to `submit_job`
- Add smoke registry: `Map<number, { passed, script_hash, job_id, failures }>`
- On smoke completion: set `passed: true` in registry
- On `submit_job(stage="full")`: check `smokeRegistry.get(experiment_id)?.passed` AND compare script hash
- 3-strike circuit breaker on smoke failures per experiment
- Reconstruct smoke registry from JSONL `job_completed` entries on resume

**Test:** Submit smoke, verify pass. Edit script, try full — verify blocked. Submit 3 failing smokes — verify circuit breaker.

### Step 3: `init_campaign` + `benchmark.json`

- Extend `init_experiment` params with benchmark config
- Write `benchmark.json` on init, `git add benchmark.json && git commit`
- On `log_decision(keep)`: run `git diff HEAD -- benchmark.json` BEFORE `git add -A`. Non-empty diff → refuse keep.
- Persist benchmark SHA in JSONL config entry (optional, for dashboard display)

**Test:** Create benchmark, modify it, try to keep — verify refused.

### Step 4: Update skill

- Update SKILL.md loop rules to use new tools
- Add polling cadence rule
- Add "no file edits during full runs" rule
- Add "within-phase parallelism only" rule
- Add "externalize plans before polling" rule
- Add "smoke failures count toward anti-thrash" rule
- Update `autotrain.sh` template for stage awareness
- Update `autotrain.md` template with benchmark contract section
- Keep `run_experiment` available for local mode fallback

---

## Migration

The new tools coexist with the old ones. No breaking change.

- `init_experiment` still works (just doesn't create benchmark.json)
- `run_experiment` still works (still synchronous, still blocking)
- `log_experiment` still works (just doesn't check benchmark integrity)

The skill guides the agent toward the new tools. Old campaigns resume with old tools. New campaigns use new tools. Eventually the old tools get deprecated.
