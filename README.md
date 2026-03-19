# pi-autotrain — autonomous training loop for pi

**[Install](#install)** · **[Usage](#usage)** · **[How it works](#how-it-works)**

*Gather requirements, curate data, submit training jobs, optimize through structured phases — all autonomously.*

A specialized [autoresearch](https://github.com/karpathy/autoresearch) variant for model training. Instead of generic optimization, autotrain encodes training domain knowledge: experiment phase ordering (data > format > architecture > hyperparameters), evaluation strategy design, overfitting detection, anti-thrash safeguards, and automatic HuggingFace Hub integration.

Training runs on **HF Jobs** — billed per-second on cloud GPUs, no local GPU required.

Supports any training paradigm: SFT, DPO, GRPO, RL, pretraining, VLM fine-tuning, reward modeling, distillation.

---

![pi-autotrain dashboard](pi-autotrain.png)

---

## What's included

| Component | Description |
|---|---|
| **Extension** | Tools + live widget + `/autotrain` dashboard |
| **Skill** | Gathers requirements, selects hardware, designs evaluation strategy, writes session files, starts the training loop |

### Extension tools

| Tool | Description |
|------|-------------|
| `init_experiment` | One-time session config — name, metric, unit, direction, optional benchmark contract |
| `submit_job` | Submit a detached HF Job. Returns immediately with job ID. Default stage: `smoke` (10-step validation). Use `stage='full'` after smoke passes |
| `check_jobs` | Poll active jobs for status, elapsed time, metrics, and tail output |
| `cancel_job` | Cancel a running HF Job. Refuses to cancel smoke jobs under 120 seconds |
| `log_decision` | Record experiment decision (keep/discard/crash/smoke\_failed). Checks `benchmark.json` integrity on keep |
| `run_experiment` | Synchronous command runner for local utility tasks (data prep, eval scripts). NOT for training |
| `log_experiment` | Record a local utility run result |

### Supported paradigms

- **SFT** — supervised fine-tuning with LoRA/full
- **DPO** — direct preference optimization
- **GRPO** — group relative policy optimization
- **RL** — reinforcement learning (games, robotics, control)
- **Pretraining** — training from scratch on domain text
- **VLM fine-tuning** — vision-language model adaptation
- **Reward modeling** — training reward models for RLHF
- **Distillation** — compressing a large teacher model into a smaller student

### Execution mode

| Mode | Hardware | Notes |
|------|----------|-------|
| **HF Jobs** | Cloud A100/H200 GPUs | Billed per-second, no local GPU required. Run `hf jobs hardware` for available flavors |

### HuggingFace integration

After every successful experiment (`keep`):
- Model output uploaded to HF Hub
- Session notes synced
- Model card created and updated with results table

### Skill

`autotrain-create` gathers your goal, training paradigm, model, dataset/environment, and constraints — then:

1. Selects hardware flavor
2. Designs an evaluation strategy (dataset splits, rollout protocol, or hybrid)
3. Writes session files and commits them
4. Submits a baseline smoke job and starts the optimization loop

### Session files

| File | Purpose |
|------|---------|
| `autotrain.md` | Living session document — objective, paradigm, model config, metrics, evaluation strategy, phase ordering, anti-thrash rules, what's been tried. A fresh agent can resume from this alone. |
| `autotrain.sh` | Training + evaluation script — pre-checks, trains the model, evaluates on test split, outputs `METRIC name=number` lines. |
| `autotrain.jsonl` | Append-only log of job submissions, completions, decisions, and results. |
| `benchmark.json` | Frozen eval contract — committed once, never modified. Blocks submission if dirty. |
| `autotrain.ideas.md` | Experiment backlog — planned ideas for context survival across resets. |
| `autotrain.checks.sh` | *(optional)* Backpressure checks — correctness validation that blocks `keep` on failure. |

---

## Install

```bash
pi install https://github.com/gary149/autotrain
```

<details>
<summary>Manual install</summary>

```bash
cp -r extensions/pi-autotrain ~/.pi/agent/extensions/
cp -r skills/autotrain-create ~/.pi/agent/skills/
```

Then `/reload` in pi.

</details>

---

## Usage

### 1. Start autotrain

```
/skill:autotrain-create
```

The agent asks about your goal, training paradigm, model, dataset/environment, and constraints. It then:
- Selects hardware flavor via `hf jobs hardware`
- Designs the evaluation strategy
- Writes `autotrain.md` and `autotrain.sh`
- Commits everything
- Submits the baseline smoke and starts the async loop

### 2. The async pipelined workflow

Training is fully asynchronous. The agent pipelines smoke tests and full runs to maximize GPU utilization:

```
submit_job(smoke A) → plan B while A runs → check_jobs → smoke passed →
submit_job(full A) + submit_job(smoke B) → check_jobs → log_decision
```

The agent uses wait time productively — planning the next experiment, curating data, or reviewing results while jobs run on HF infrastructure.

### 3. Phase ordering

Autotrain follows a **strict phase order**:

```
Phase 1: Data Quality              ← HIGHEST leverage, explore first
Phase 2: Input & Output Format
Phase 3: Model & Architecture Config
Phase 4: Training Hyperparameters
Phase 5: Regularization            ← only if overfitting visible
```

The agent won't jump to hyperparameter tuning before exhausting data and format improvements. This prevents the most common training mistake: tweaking learning rates when the training data needs curation.

### 4. Anti-thrash safeguards

The agent monitors its own progress and self-corrects:
- **5+ consecutive failures** (smoke\_failed or discard) → pivots to a different phase
- **Same metric for 8+ runs** → makes a structural change
- **Stuck on Phase 4** → goes back to Phases 1-3
- **20+ minutes without improvement** → runs fresh validation, then pivots

### 5. Validation protocol

Evaluation strategy depends on the paradigm:
- **Dataset-based** (SFT, DPO, RM) — three-way split: train/val/test
- **Rollout-based** (RL, games) — fixed eval environment/seed
- **Hybrid** (RLHF) — both

Plus **fresh validation** every 10 experiments to catch overfitting to the test set.

### 6. Monitor progress

- **Widget** — always visible above the editor
- **`/autotrain`** — full dashboard with results table
- **`Escape`** — interrupt anytime
- **[pi-session-tracker](https://github.com/gary149/pi-session-tracker)** — run in a separate Claude/Codex/Pi session to get a structured report of what the agent is doing. Autotrain sessions run autonomously for hours — the tracker lets you understand what happened (what the agent tried, what worked, what it missed) without reading through hundreds of tool calls.

---

## Example session

```
> /skill:autotrain-create

Goal: Chess move prediction from FEN positions
Base model: Qwen/Qwen2.5-3B
Dataset: lichess_games_2024.csv (1.2M games)

🔧 Hardware: H200 1x via HF Jobs
📊 Created splits: train=50K, val=5K, test=2K
📝 Wrote autotrain.md, autotrain.sh, benchmark.json
✓ Committed initial setup

Phase 1: Data Quality
  #1  smoke baseline         → passed (10 steps OK)
      full baseline          exact_accuracy=8.47%    keep
  #2  smoke filter ELO>1500  → passed
      full filter ELO>1500   exact_accuracy=12.3%    keep  ← data curation wins
  #3  smoke filter ELO>1800  → passed
      full filter ELO>1800   exact_accuracy=11.1%    discard (too little data)
  #4  smoke dedup positions  → passed
      full dedup positions   exact_accuracy=14.2%    keep

Phase 2: Prompt Format
  #5  smoke SAN format       → passed
      full SAN format        exact_accuracy=18.6%    keep  ← format matters
  #6  smoke add piece counts → smoke_failed (loss NaN at step 4)

Phase 3: Model & Architecture Config
  #7  smoke rank 16→32       → passed
      full rank 16→32        exact_accuracy=19.1%    keep

Phase 4: Training Hyperparameters
  #8  smoke LR 6e-5          → passed
      full LR 6e-5           exact_accuracy=22.0%    keep
  ...
```

---

## How it works

The **extension** is domain-agnostic infrastructure. The **skill** encodes training domain knowledge. This separation means the extension handles all the plumbing (git, metrics, dashboard, job orchestration) while the skill knows about experiment phases, evaluation strategies, and training workflows.

```
┌───────────────────────────┐     ┌────────────────────────────────┐
│  Extension (global)       │     │  Skill (training domain)       │
│                           │     │                                │
│  submit_job / check_jobs  │◄────│  phases: data > format > arch  │
│  log_decision             │     │  evaluation: splits / rollouts │
│  widget + dashboard       │     │  anti-thrash: self-monitoring  │
│                           │     │  HF Jobs + HF Hub integration  │
└───────────────────────────┘     └────────────────────────────────┘
```

Three files keep the session alive across restarts and context resets:

```
autotrain.jsonl      — append-only log of every submission, completion, and decision
autotrain.md         — living document: objective, paradigm, phases, what's been tried
autotrain.ideas.md   — experiment backlog for context survival
```

A fresh agent with no memory can read these files and continue exactly where the previous session left off.

---

## Safety features

### Smoke gate

Every experiment runs a **10-step smoke test** before committing to full training. Catches script errors, data loading failures, and NaN losses early — saving GPU hours.

### Workspace hashing

When a smoke test passes, the extension hashes the training script. If the script changes before submitting the full run, submission is blocked. This ensures the full run matches what was validated in smoke.

### Benchmark freeze

`benchmark.json` is committed once during `init_experiment` and never modified. Both `submit_job` and `log_decision` refuse to proceed if `benchmark.json` has uncommitted changes — preventing accidental evaluation drift.

### 3-strike circuit breaker

If an experiment fails smoke 3 times consecutively, the extension blocks further attempts. The agent must fix the root cause or start a new experiment.

### Canceled job persistence

Canceled jobs are recorded in `autotrain.jsonl` and count toward anti-thrash tracking, preventing the agent from hiding failures by canceling.

---

## Backpressure checks (optional)

Create `autotrain.checks.sh` to run correctness checks after every passing benchmark.

```bash
#!/bin/bash
set -euo pipefail
python -m pytest tests/ -x --tb=short 2>&1 | tail -50
```

If checks fail, the experiment is logged as `checks_failed` — no commit, revert changes.

---

## License

MIT
