# pi-autotrain — autonomous training loop for pi

**[Install](#install)** · **[Usage](#usage)** · **[How it works](#how-it-works)**

*Gather requirements, curate data, train models, optimize through structured phases — all autonomously.*

A specialized [autoresearch](https://github.com/karpathy/autoresearch) variant for model training. Instead of generic optimization, autotrain encodes training domain knowledge: experiment phase ordering (data > format > architecture > hyperparameters), evaluation strategy design, overfitting detection, anti-thrash safeguards, and automatic HuggingFace Hub integration.

Supports any training paradigm: SFT, DPO, GRPO, RL, pretraining, VLM fine-tuning, reward modeling.

---

![pi-autotrain dashboard](pi-autotrain.png)

---

## What's included

| Component | Description |
|---|---|
| **Extension** | Tools + live widget + `/autotrain` dashboard |
| **Skill** | Gathers requirements, selects execution mode, designs evaluation strategy, writes session files, starts the training loop |

### Extension tools

| Tool | Description |
|------|-------------|
| `init_experiment` | One-time session config — name, metric, unit, direction |
| `run_experiment` | Runs any command, times wall-clock duration, captures output |
| `log_experiment` | Records result, auto-commits, updates widget and dashboard |

### Supported paradigms

- **SFT** — supervised fine-tuning with LoRA/full
- **DPO** — direct preference optimization
- **GRPO** — group relative policy optimization
- **RL** — reinforcement learning (games, robotics, control)
- **Pretraining** — training from scratch on domain text
- **VLM fine-tuning** — vision-language model adaptation
- **Reward modeling** — training reward models for RLHF

### Execution modes

| Mode | Hardware | Notes |
|------|----------|-------|
| **HF Jobs** (default) | Cloud A100/H200 GPUs | Billed per-second, no local GPU required |
| **Local — mlx-lm** | Apple Silicon Mac | Native Metal acceleration, unified memory |
| **Local — unsloth** | NVIDIA GPU | 2-5x faster than TRL, 50-70% less VRAM |
| **Local — TRL + PEFT** | NVIDIA GPU (fallback) | When unsloth doesn't support the model |
| **Local — native PyTorch** | Any GPU | For paradigms without framework support |

### HuggingFace integration

After every successful experiment (`keep`):
- Model output uploaded to HF Hub
- Session notes synced
- Model card created and updated with results table

### Skill

`autotrain-create` gathers your goal, training paradigm, model, dataset/environment, and constraints — then:

1. Selects execution mode and hardware
2. Designs an evaluation strategy (dataset splits, rollout protocol, or hybrid)
3. Writes session files and commits them
4. Runs a baseline and starts the optimization loop

### Session files

| File | Purpose |
|------|---------|
| `autotrain.md` | Living session document — objective, paradigm, model config, metrics, evaluation strategy, phase ordering, anti-thrash rules, what's been tried. A fresh agent can resume from this alone. |
| `autotrain.sh` | Training + evaluation script — pre-checks, trains the model, evaluates on test split, outputs `METRIC name=number` lines. |
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
- Selects execution mode and hardware
- Designs the evaluation strategy
- Writes `autotrain.md` and `autotrain.sh`
- Commits everything
- Runs the baseline and starts looping

### 2. The structured loop

Autotrain follows a **strict phase order**:

```
Phase 1: Data Quality              ← HIGHEST leverage, explore first
Phase 2: Input & Output Format
Phase 3: Model & Architecture Config
Phase 4: Training Hyperparameters
Phase 5: Regularization            ← only if overfitting visible
```

The agent won't jump to hyperparameter tuning before exhausting data and format improvements. This prevents the most common training mistake: tweaking learning rates when the training data needs curation.

### 3. Anti-thrash safeguards

The agent monitors its own progress and self-corrects:
- **5+ consecutive discards** → pivots to a different phase
- **Same metric for 8+ runs** → makes a structural change
- **Stuck on Phase 4** → goes back to Phases 1-3
- **20+ minutes without improvement** → runs fresh validation, then pivots

### 4. Validation protocol

Evaluation strategy depends on the paradigm:
- **Dataset-based** (SFT, DPO, RM) — three-way split: train/val/test
- **Rollout-based** (RL, games) — fixed eval environment/seed
- **Hybrid** (RLHF) — both

Plus **fresh validation** every 10 experiments to catch overfitting to the test set.

### 5. Monitor progress

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

🔍 Hardware detected: Apple M2 Max 64GB → using mlx-lm
📊 Created splits: train=50K, val=5K, test=2K
📝 Wrote autotrain.md, autotrain.sh
✓ Committed initial setup

Phase 1: Data Quality
  #1  baseline          exact_accuracy=8.47%    keep
  #2  filter ELO>1500   exact_accuracy=12.3%    keep  ← data curation wins
  #3  filter ELO>1800   exact_accuracy=11.1%    discard (too little data)
  #4  dedup positions   exact_accuracy=14.2%    keep

Phase 2: Prompt Format
  #5  SAN instead of UCI  exact_accuracy=18.6%  keep  ← format matters
  #6  add piece counts    exact_accuracy=18.4%  discard

Phase 3: Model & Architecture Config
  #7  rank 16→32        exact_accuracy=19.1%    keep

Phase 4: Training Hyperparameters
  #8  LR 1e-5→6e-5     exact_accuracy=22.0%    keep
  ...
```

---

## How it works

The **extension** is domain-agnostic infrastructure. The **skill** encodes training domain knowledge. This separation means the extension handles all the plumbing (git, metrics, dashboard) while the skill knows about experiment phases, evaluation strategies, and training workflows.

```
┌──────────────────────┐     ┌────────────────────────────────┐
│  Extension (global)  │     │  Skill (training domain)       │
│                      │     │                                │
│  run_experiment      │◄────│  phases: data > format > arch   │
│  log_experiment      │     │  evaluation: splits / rollouts  │
│  widget + dashboard  │     │  anti-thrash: self-monitoring   │
│                      │     │  references: HF Jobs, local,   │
└──────────────────────┘     │    HF integration              │
                             └────────────────────────────────┘
```

Two files keep the session alive across restarts and context resets:

```
autotrain.jsonl      — append-only log of every run (metric, status, commit, description)
autotrain.md         — living document: objective, paradigm, phases, what's been tried
```

A fresh agent with no memory can read these two files and continue exactly where the previous session left off.

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
