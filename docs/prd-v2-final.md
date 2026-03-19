# Autotrain 2 — Final PRD

## Autonomous fine-tuning campaigns with built-in integrity

**Status:** Final
**Version:** 1.0
**Date:** 2026-03-19
**Basis:** spec-v1 (architecture), spec-v2 (integrity), session report (data), 0xSero article (external validation), current codebase (constraints)

---

## 1. What this is

Autotrain 2 is an autonomous fine-tuning campaign manager. It replaces the current blocking single-experiment loop with an async pipeline that smokes, screens, promotes, and cancels training runs on HF Jobs — without requiring human intervention.

The current system works but has five structural flaws proven by the March 2026 sessions:

| Flaw | Evidence | Cost |
|------|----------|------|
| Blocking `run_experiment` | Agent frozen for 2.5h per DOOM experiment, ~40h total | GPT-5.4 context wasted |
| No smoke testing | First DOOM run crashed on missing `torchvision` | 2.5h + $2.50 per avoidable crash |
| No benchmark integrity | NER shared-RNG bug produced fake 96.77% result | Invalid experiment comparisons |
| No cost awareness | Flavor switch to a10g-large depleted credits | Two 402 errors, session halted |
| Flat keep/discard loop | Every candidate gets the same budget regardless of promise | DOOM spent $40 for 26.5% accuracy |

Autotrain 2 fixes all five. The target is 5-10x more useful experiments per dollar.

---

## 2. Operating principle

> **Agents search. Judges stay frozen. The system self-distrusts.**

No human-in-the-loop is required. Instead, integrity is enforced structurally:

- The **benchmark contract** is frozen before any GPU spend. The agent cannot edit it.
- The **proposer** generates candidate configs. It can be creative.
- The **judge** (eval pipeline + benchmark) validates independently. It cannot be modified during a campaign.
- **Integrity monitors** detect score hacking, file sprawl, and fake completions automatically.
- **Accept rate** drives automatic phase pivots — not human review.

The agent loops forever. It pauses only on integrity violations, budget exhaustion, or explicit user interrupt.

---

## 3. Goals

1. Produce stronger fine-tunes with zero human supervision after launch.
2. Maximize useful signal per dollar — no wasted full-budget runs.
3. Enforce benchmark integrity without requiring human audits.
4. Keep every campaign resumable from disk state alone.
5. Stay simple enough to implement on top of the existing pi extension system.

### Non-goals for V1

- Local compute backends (HF Jobs only)
- Full pretraining from scratch
- Arbitrary RL environments
- Multi-agent orchestration
- Harness self-evolution (reserved for V2)

---

## 4. What changes from v1

| Current (v1) | Autotrain 2 |
|--------------|-------------|
| `run_experiment` blocks for hours | `submit_job` + `check_jobs` — async, never blocks |
| Flat keep/discard loop | smoke → screen → full pipeline with budget gates |
| Agent writes training scripts from scratch | Recipe-first: search config space, codegen only when recipes fail |
| Ad-hoc eval with shared RNG | Frozen `benchmark.json` with deterministic splits |
| No cost awareness | Cost estimation before every GPU submission |
| `init_experiment` / `run_experiment` / `log_experiment` | `init_campaign` / `submit_job` / `check_jobs` / `cancel_job` / `log_decision` |
| `autotrain.md` + `autotrain.jsonl` | `campaign.json` + `benchmark.json` + `experiments.jsonl` + `autotrain.md` |
| Skill writes all training code | Recipe library with searchable knobs + fallback to codegen |

---

## 5. End-to-end flow

### 5.1 Intake

The agent receives a task (via skill invocation or user message) and creates:
- Campaign directory
- `campaign.json` — objective, budget cap, time cap, constraints
- Initial `autotrain.md` — living session memory (same format as v1)

### 5.2 Recon

Before any GPU spend, the agent:
- Inspects the model on the Hub (`hf models info`, check `pipeline_tag`, architecture, config)
- Inspects the dataset (`hf datasets info`, `hf datasets sql` for profiling)
- Scouts alternative datasets and models if needed
- Selects a recipe family (see section 8)
- Selects hardware flavor based on model size and task type

This is the same Step 1/Step 4 recon from the current skill — it works well and doesn't change.

### 5.3 Benchmark contract

The agent creates `benchmark.json` — a frozen file that defines success:

```json
{
  "task": "NER JSON extraction",
  "primary_metric": "entity_f1",
  "direction": "higher",
  "guardrail_metrics": ["json_validity_pct", "wall_clock_s"],
  "acceptance_threshold": 0.02,
  "splits": {
    "train": { "source": "prepared/train.jsonl", "n": 12000, "seed": 42 },
    "dev_small": { "source": "prepared/dev_small.jsonl", "n": 200, "seed": 99 },
    "dev_full": { "source": "prepared/dev_full.jsonl", "n": 1000, "seed": 99 },
    "test_frozen": { "source": "prepared/test.jsonl", "n": 500, "seed": 777 }
  },
  "smoke_config": { "max_steps": 10, "logging_steps": 1 },
  "screen_config": { "max_steps": 100 },
  "significance_rule": "improvement > acceptance_threshold OR confirmatory_eval"
}
```

**Rules:**
- `benchmark.json` must exist before any GPU job is submitted.
- Once created, the agent cannot modify it during the campaign.
- Train/dev/test splits use separate fixed seeds (prevents the shared-RNG bug).
- `dev_small` is used for smoke and screen. `test_frozen` is used for final champion eval only.
- Minimum `dev_small` size: 200 examples. Below this, treat +/-3% as ties.

### 5.4 Data preparation

The agent launches a CPU prep job (via `submit_job` with `stage: "prep"`) that:
- Validates schema
- Deduplicates
- Builds deterministic train/dev/test splits from the fixed seeds
- Creates prompt/response renderings in the recipe's expected format
- Pushes prepared data to a Hub dataset repo

Prepared data is versioned and immutable within the campaign.

### 5.5 Smoke gate

Every candidate config must pass a smoke test before receiving screen budget.

**Smoke test checks:**
- Dependencies import successfully
- Model and tokenizer load
- Prompt template renders correctly
- One forward + backward pass succeeds
- Metric extraction (`METRIC name=value`) works
- Output parser round-trips correctly
- No OOM on the target hardware

**Implementation:** A smoke test is a real HF Job with `max_steps=10` and `logging_steps=1`. Cost: ~$0.05, time: ~2 minutes. This would have caught the DOOM `torchvision` crash before wasting 2.5 hours.

A candidate that fails smoke is logged as `smoke_failed` and never receives more budget.

### 5.6 Screening runs

Candidates that pass smoke are launched as short screening runs (e.g., 100 steps) in parallel.

**Purpose:**
- Measure learning signal direction — is the metric moving?
- Estimate throughput and cost for the full run
- Verify output validity at scale (not just 10 steps)
- Identify obvious losers fast

**Key design:** The orchestrator can have multiple screen jobs running simultaneously. While they run, it continues scouting, analyzing results, and queuing the next wave. This is the core architectural change — the agent is never blocked.

**Default concurrency:**
- 1 CPU prep slot
- 2 GPU screen slots
- 1 GPU full-train slot
- Max 4 active jobs

### 5.7 Promotion

Only the best screened candidates receive full training budget.

**Promotion criteria:**
- Metric above a kill threshold (not obviously losing)
- Guardrail metrics passing (output validity, cost within budget)
- Estimated full-run cost within remaining campaign budget

**Successive halving:** Many smoke candidates → fewer screen candidates → very few full runs. This is how DOOM's $40 spend becomes $15 for the same or better result.

### 5.8 Full training

Promoted candidates train with full budget (the step count the agent determined works for this task — e.g., 300 steps for DOOM, 450 for NER).

Full runs:
- Use the stable prepared dataset artifact
- Report metrics at predictable cadence (`logging_steps=5` for VLM, `logging_steps=10` for text)
- Upload artifacts to Hub before exit
- Print `METRIC name=value` lines for extraction

### 5.9 Champion policy

A challenger beats the current champion only if:
- Primary metric exceeds champion by `acceptance_threshold`
- All guardrail metrics pass
- If margin is within 2× the threshold, a confirmatory eval on `dev_full` is required

When a new champion is crowned:
- Artifacts are uploaded to Hub
- Model card is created/updated
- `autotrain.md` is updated and committed

### 5.10 Continuous scouting

While jobs are running, the orchestrator:
- Inspects logs via `check_jobs` — cancels obvious losers
- Analyzes results from completed experiments
- Profiles the dataset for Phase 1 insights
- Queues the next wave of candidates
- Updates `autotrain.md`

This is the key change. The agent is always productive.

---

## 6. Recipe library

Autotrain 2 searches config space instead of rewriting training scripts for every experiment.

### 6.1 `text_sft`

For text-only supervised fine-tuning.

Searchable knobs:
- `base_model` — model ID on Hub
- `lora_mode` — `qlora_4bit` | `qlora_8bit` | `lora` | `full`
- `lora_r` — 8, 16, 32, 64
- `lora_alpha` — typically 2× r
- `lora_targets` — `all_linear` | `attention_only` | explicit list
- `max_seq_length` — from model's `max_position_embeddings`
- `loss_masking` — `none` | `prompt_only` (masks input, trains on output only)
- `packing` — `true` | `false`
- `steps` — training step budget
- `lr` — learning rate (log scale 1e-6 to 1e-3)
- `scheduler` — `cosine` | `linear` | `constant_with_warmup`
- `warmup_ratio` — 0.0 to 0.1
- `batch_size` — effective batch size

**Loss masking is a Phase 2 knob, not Phase 4.** It was the biggest single win in NER (+7.8 F1 points). The recipe makes this searchable from the start.

### 6.2 `vlm_sft`

For vision-language model fine-tuning.

Additional knobs beyond `text_sft`:
- `frame_count` — 1, 2, 4, 8
- `frame_stride` — temporal spacing between frames
- `resize_policy` — how to handle different image sizes
- `logging_steps` — default 5 (VLM steps are slow)

**VLM-specific rule:** Always estimate RAM requirements and select hardware flavor accordingly. VLM bottleneck is system RAM, not VRAM (DOOM: 100% RAM at 16% GPU utilization on a10g-small).

### 6.3 `dpo`

For preference tuning.

Knobs: base model, prompt format, truncation, dataset balance, LoRA config, beta, reference model handling.

### Recipe contract

Each recipe declares:
- Supported task types
- Required dataset schema
- Searchable knobs with ranges and defaults
- Smoke command template
- Train command template
- Metric extraction rule
- Hardware requirements by model size

**Codegen fallback:** If no recipe fits the task, the agent falls back to writing a training script from scratch — same as v1. But this is the exception, not the rule.

---

## 7. Tool surface

The old `init_experiment` / `run_experiment` / `log_experiment` trio is replaced.

### 7.1 `init_campaign`

Creates campaign directory, `campaign.json`, and drafts `benchmark.json`.

Input: objective, task type, budget cap, time cap, constraints
Output: campaign ID, campaign path, initial status

### 7.2 `submit_job`

Submits a detached HF Job for any stage.

Input: campaign ID, stage (`prep` | `smoke` | `screen` | `full`), recipe + config, hardware flavor, timeout
Output: job ID, experiment ID, estimated cost

**Cost check:** Before submission, estimates `flavor_cost_per_hour × expected_duration`. Blocks if remaining budget < estimated cost.

### 7.3 `check_jobs`

Returns status, log tails, parsed metrics, and health signals for all active jobs.

Input: campaign ID (or specific job IDs)
Output: per-job status, metric updates, cancel recommendations

**This is the async primitive.** The agent calls `check_jobs` in a polling pattern while doing other work between calls. No blocking.

### 7.4 `cancel_job`

Cancels a running HF Job.

Input: job ID, reason
Output: final status

### 7.5 `log_decision`

Records an experiment decision to persistent history.

Input: campaign ID, experiment ID, decision (`keep` | `discard` | `promote` | `cancel` | `champion` | `smoke_failed` | `screen_failed`), reason, evidence, cost
Output: log record ID

**On `keep`:** auto-commits code, uploads artifacts to Hub, updates `autotrain.md`.
**On `discard`/`cancel`:** reverts working tree (`git checkout -- .`).

### 7.6 Optional tools (V1 if time permits)

- `scout_assets` — search Hub for datasets, models, papers
- `package_winner` — final model card, artifact packaging, tagging
- `resume_campaign` — read campaign state and continue

---

## 8. Benchmark integrity

This is the most important section. Everything learned from the sessions and the 0xSero article says: **agents will hack any score they can touch.**

### 8.1 Frozen judge

During a live campaign, the agent cannot change:
- `benchmark.json` definitions
- Dev/test split contents or seeds
- Metric definitions or parsers
- Acceptance thresholds

**Implementation:** `benchmark.json` is committed once, then added to a protected path list. `log_decision` refuses to accept results from a campaign where `benchmark.json` has been modified since freeze.

### 8.2 Multi-objective gate

No experiment is accepted on a single score. Every judged experiment must track:
- Primary quality metric (e.g., `entity_f1`)
- Validity metric (e.g., `json_validity_pct`)
- Cost metric (wall-clock time, dollar cost)
- Reproducibility (config hash, artifact existence)

The NER session showed this: loss masking improved F1 AND improved training efficiency. A single-metric gate would miss the cost signal.

### 8.3 Noise-aware comparison

From the session report: 64 eval examples means ±5-10% is noise.

Rules:
- `acceptance_threshold` in `benchmark.json` defines minimum meaningful improvement
- When the margin is within 2× threshold, confirmatory eval on `dev_full` is required
- The agent must not treat sub-threshold differences as signal

### 8.4 Integrity monitors

The system watches for patterns that indicate score hacking or fake completions:

| Signal | Response |
|--------|----------|
| `benchmark.json` modified after freeze | Block all promotions. Log integrity alert. |
| Experiment "completes" in < 60 seconds for a task that takes minutes+ | Flag as suspicious. Require job ID + log evidence. |
| Sudden large metric jump without corresponding config change | Require confirmatory eval before promotion. |
| No HF Job ID in completed experiment | Reject. Cannot promote without proof. |
| Eval file touched by training code | Block promotion. Log integrity alert. |
| Accept rate drops below 10% for 10+ experiments | Auto-pivot to different phase. |

### 8.5 Accept rate tracking

Accept rate = promoted experiments / proposed experiments.

This is tracked automatically. When accept rate drops:
1. Below 20% for 5+ experiments → tighten search space, bias toward lower-risk proposals
2. Below 10% for 10+ experiments → pivot phase entirely (same as anti-thrash rule #1)
3. Below 5% → log a strategic pause, re-read all dead ends, write a new strategy before continuing

This replaces human review. The system self-corrects based on its own calibration.

---

## 9. Campaign state

All state is persisted to disk. A fresh agent reads these files and resumes without context from the previous session.

### 9.1 Machine-readable

| File | Purpose | Mutability |
|------|---------|------------|
| `campaign.json` | Objective, budget, constraints, status | Set once, budget decremented |
| `benchmark.json` | Frozen benchmark contract | Immutable after freeze |
| `experiments.jsonl` | Append-only experiment log (replaces `autotrain.jsonl`) | Append-only |
| `leaderboard.json` | Ordered candidate results, current champion | Updated on promotion |

### 9.2 Human-readable

| File | Purpose | Mutability |
|------|---------|------------|
| `autotrain.md` | Living session memory — same as v1 | Updated every keep + every 10 experiments |
| `autotrain.ideas.md` | Backlog of untried ideas tagged by phase | Pruned on resume |

### 9.3 Per-experiment

Each experiment gets a row in `experiments.jsonl` with:
- Experiment ID
- Parent experiment ID (if iterating on a previous config)
- Stage (smoke, screen, full)
- Recipe + full config
- HF Job ID
- Metrics from the judge
- Decision + reason
- Cost (time + dollars)
- Artifact refs

No per-experiment directory tree. The JSONL row is the source of truth. Artifacts live on the Hub.

---

## 10. Decision policy

### 10.1 Search order

Same phase discipline as v1 — this works and is the system's strongest pattern:

1. **Benchmark integrity and task framing** — is the eval measuring what we care about?
2. **Data quality** — volume, curation, filtering, dedup (HIGHEST leverage)
3. **Input/output format** — loss masking, chat template, label format
4. **Base model family** — different models for the same task
5. **Recipe config** — LoRA rank, target modules, architecture knobs
6. **Hyperparameters** — LR, steps, scheduler
7. **Regularization** — only if overfitting is visible

### 10.2 Anti-thrash rules

Same as v1 — these work:
1. 5+ consecutive discards → pivot phase
2. Same metric ±noise for 8+ experiments → structural change
3. All ideas are Phase 6-7 but Phases 1-5 not exhausted → go back up
4. Accept rate < 10% for 10+ experiments → strategic pause + replanning
5. Eval metrics diverging from train metrics → overfitting, stop and investigate

### 10.3 Dead-end tracking

Every failed idea is logged in `autotrain.md` with:
- What was tried
- Why it failed
- Whether the failure is general or task-specific

This is the agent's strongest behavior from v1 sessions. Keep it.

---

## 11. Cost awareness

Before every GPU submission, the agent must estimate:
- Expected wall-clock duration (from screen run throughput or recipe defaults)
- Estimated cost = `duration × flavor_cost_per_hour`
- Remaining campaign budget
- Whether this run is allowed under policy

**Hard rules:**
- Never submit a job that would exceed remaining budget
- VLM tasks must use RAM-appropriate hardware (learned: a10g-large for ≤1B VLM, not a10g-small)
- `bf16=True` on Ampere GPUs, `fp16=True` on T4 only
- Always use detached mode (`-d`)
- Set `--timeout` to `estimated_duration × 1.5`

**Cost tracking:**
```
Campaign budget: $50.00
Spent: $23.40 (12 experiments: 3 smoke, 7 screen, 2 full)
Remaining: $26.60
Next estimated: $1.50 (full run, a10g-small, ~1.5h)
```

This is written to `campaign.json` and shown in `autotrain.md`.

---

## 12. File hygiene

From the 0xSero article: "Left to their own devices they will make hundreds of files."

### 12.1 File allowlist

The campaign declares which files the agent may modify. By default:
- Recipe config files
- `autotrain.md`, `autotrain.ideas.md`
- The training script (one file, not N variants)
- Data preparation script (one file)

### 12.2 No new files in judged paths

Experiments may not create new files in benchmark-critical paths. The training script is modified in-place, not copied.

### 12.3 Cleanup cadence

Every 10 experiments, the agent consolidates:
- Remove stale markdown files
- Remove abandoned script variants
- Prune `autotrain.ideas.md` of tried/stale entries

---

## 13. Implementation plan

### Milestone 1 — Async core (replaces blocking architecture)

Deliver:
- `submit_job` with detached HF Job submission + cost estimation
- `check_jobs` with polling, log tailing, metric extraction
- `cancel_job`
- `log_decision` with auto-commit/revert
- `campaign.json` state file
- Remove `run_experiment` as the primary primitive

**Success:** No more blocking. Agent can do work while jobs run.

### Milestone 2 — Benchmark contract + smoke gate

Deliver:
- `benchmark.json` creation and freeze enforcement
- Deterministic split generation with separate seeds
- Smoke gate: 10-step validation before screen budget
- Protected path enforcement (benchmark files immutable)

**Success:** No more shared-RNG bugs. No more 2.5h crashes on missing dependencies.

### Milestone 3 — Screening + promotion pipeline

Deliver:
- `submit_job` with stage awareness (smoke, screen, full)
- Parallel screen slot management
- Successive halving: many smokes → fewer screens → few full runs
- Champion/challenger policy with acceptance threshold
- Confirmatory eval for close margins

**Success:** GPU spend is earned, not given. Most experiments are cheap screens.

### Milestone 4 — Recipe library

Deliver:
- `text_sft` recipe with searchable knobs
- `vlm_sft` recipe
- `dpo` recipe
- Recipe contract format
- Codegen fallback when no recipe fits

**Success:** Most campaigns don't require writing training scripts from scratch.

### Milestone 5 — Integrity + accept rate

Deliver:
- Integrity monitor (benchmark modification detection, suspicious timing, missing job IDs)
- Accept rate tracking with automatic phase pivots
- Multi-objective gate enforcement
- Campaign final report generation

**Success:** The system self-corrects without human intervention.

---

## 14. What stays the same

Not everything needs to change. These v1 patterns work and should be preserved:

- **`autotrain.md` as living memory** — the best thing about v1. A fresh agent reads it and knows everything.
- **Phase discipline** — data > format > architecture > hyperparameters > regularization. Proven across sessions.
- **Dead-end tracking** — the agent's strongest behavior.
- **`autotrain.ideas.md` backlog** — prevents losing good ideas on context reset.
- **Auto-resume on context limit** — the extension sends a resume message with session state.
- **Dashboard widget (Ctrl+Y)** — immediate experiment visibility.
- **HF integration** — uploads after every keep, model cards, bucket sync.
- **Git-based state** — auto-commit on keep, revert on discard.

---

## 15. What gets deleted

- **`run_experiment` as the main primitive** — replaced by async `submit_job` + `check_jobs`
- **`init_experiment`** — replaced by `init_campaign` (campaign-level, not experiment-level)
- **Synchronous blocking loop** — the entire "submit, wait 2.5h, read output" pattern
- **Freeform codegen as the default** — recipe-first, codegen as fallback
- **Human review checkpoints** (from spec-v2) — replaced by self-distrusting integrity monitors
- **Local compute backends** (for V1) — HF Jobs only. Simplifies everything.

---

## 16. Success metrics

### Target improvements vs current system

| Metric | Current (v1) | Target (v2) |
|--------|-------------|-------------|
| Experiments per day | 6-8 (blocked 2.5h each) | 30-50 (parallel screens + async) |
| Wasted GPU spend | ~30% (crashes, obvious losers) | <10% (smoke gate + early cancel) |
| Time to first valid signal | 2.5h (first full run) | <10 min (smoke result) |
| False-win rate | ~15% (small eval, shared RNG) | <5% (frozen benchmark, noise-aware) |
| Cost per campaign (0.8B model) | $40-53 | $10-20 for same or better results |
| Agent idle time | ~40h (blocked during jobs) | ~0 (async, always scouting) |

### Product KPIs

- Useful experiments per dollar
- Smoke-to-screen promotion rate
- Screen-to-full promotion rate
- Accept rate over campaign lifetime
- Campaign resume success rate
- Time from launch to first champion

---

## 17. One-sentence summary

> **Autotrain 2 autonomously manages benchmarked fine-tuning campaigns on HF Jobs: prepare cheaply, smoke fast, screen in parallel, promote carefully, cancel aggressively, confirm wins, self-distrust by default, and loop forever.**
