# Autotrain Session Report — March 2026

This document captures three autonomous training sessions run on a Hetzner server (`root@95.217.232.252`) using Pi (coding agent v0.57.1) with GPT-5.4 via ChatGPT Pro, orchestrated through OpenClaw (v2026.3.8+). The goal is to show exactly how the agent works, what decisions it made, where it succeeded, and where it failed.

---

## Architecture

```
User (Telegram / Web UI)
  └─ OpenClaw Gateway (Gemini 3.1 Flash Lite)
       └─ Pi (GPT-5.4 via ChatGPT Pro, openai-codex provider)
            └─ HF Jobs (remote GPUs: A10G on Hugging Face)
```

- **OpenClaw** is the user-facing assistant. It receives messages via Telegram, interprets the request, and delegates training tasks to Pi via `exec`.
- **Pi** is a standalone coding agent that runs autonomously. It uses the `autotrain-create` skill to structure experiments, and the `autotrain` extension tools (`init_experiment`, `run_experiment`, `log_experiment`) to track results.
- **HF Jobs** provides remote GPU compute. Pi submits Python training scripts via `hf jobs uv run`, polls for completion, and reads logs to extract metrics.
- **Model weights** are fine-tuned with QLoRA (4-bit quantized base + LoRA adapters) to fit on a single A10G (24GB VRAM).

### How the autotrain loop works

1. Pi reads `autotrain.md` (living session doc) to understand the current state
2. Pi decides what to try next based on the experiment priority order (data quality > format > architecture > hyperparameters > regularization)
3. Pi edits the training script or config, then calls `run_experiment` which executes `autotrain.sh`
4. `autotrain.sh` submits the job to HF Jobs in detached mode, polls until completion, and returns logs
5. Pi reads the METRIC lines from the output, compares to the current best
6. Pi calls `log_experiment` with `keep` (commits changes) or `discard` (reverts with `git checkout -- .`)
7. Pi updates `autotrain.md` and repeats

### Key files in each training directory

| File | Purpose |
|------|---------|
| `autotrain.md` | Living memory — objective, strategy, results, dead ends. Enables session resume. |
| `autotrain.sh` | Job launcher — submits to HF Jobs, polls, returns logs |
| `autotrain.checks.sh` | Pre-flight validation (syntax checks before spending GPU time) |
| `autotrain.jsonl` | Append-only experiment log (metric, status, commit, description) |
| `autotrain.ideas.md` | Backlog of ideas to try, tagged by phase |
| `qwen35_*.py` | The actual training script sent to HF Jobs |

---

## Session 1: DOOM Action Prediction (VLM Fine-tuning)

**Task:** Train Qwen3.5-0.8B (a vision-language model) to predict the next player action from DOOM gameplay frames.

**Dataset:** `lucrbrtv/doom-e1-gameplay` — 42,807 frames across episodes E1M1–E1M9, each with a 9-bit action vector.

**Model:** `Qwen/Qwen3.5-0.8B` with QLoRA (4-bit base, LoRA r=16/alpha=32, 6.4M trainable params out of 859M total).

**Hardware:** HF Jobs `a10g-small` (4 vCPU, 15GB RAM, 1x A10G 24GB VRAM) at $1.00/hr.

**Input format:** 1 or 4 DOOM frames → model predicts `{"action":"A_101000000"}` as strict JSON.

**Train/eval split:** Train on E1M1–E1M7, eval on E1M8–E1M9 (tests map transfer, not just nearby-frame memorization).

**Primary metric:** `action_top1_pct` (exact action match on 64 held-out eval examples).

### How Pi was launched

Pi was started in RPC mode via a FIFO pipe so it survives context window resets:

```bash
PIPE=/tmp/pi-autotrain.fifo
mkfifo "$PIPE"
(sleep infinity > "$PIPE" &)
cat "$PIPE" | pi --mode rpc --provider openai-codex --model gpt-5.4 --thinking high > /tmp/pi-autotrain.jsonl 2>&1 &
```

Then the task was sent via:
```bash
printf '{"type":"prompt","message":"Use the autotrain-create skill. Fine-tune Qwen/Qwen3.5-0.8B to play DOOM..."}\n' > /tmp/pi-autotrain.fifo
```

### What Pi did first (setup phase)

1. **Dataset scouting** — Pi searched HuggingFace for DOOM gameplay datasets. It found 5 candidates, analyzed each with `hf datasets sql` queries, and correctly chose `lucrbrtv/doom-e1-gameplay` as the cleanest starting point.
2. **Strategy design** — Pi wrote a multi-stage plan in `autotrain.md`: start with single-frame offline imitation, move to 4-frame temporal context, save multi-dataset augmentation for later.
3. **Training script** — Pi wrote `qwen35_doom_job.py` from scratch (~400 lines): dataset loading, sliding window construction, VLM prompt formatting, QLoRA setup, HuggingFace Trainer integration, and a custom evaluation loop that parses JSON action predictions and computes exact-match + per-button F1.
4. **Action encoding** — Pi chose 9-bit binary strings (`A_101000000`) over English action names because the dataset already uses binary vectors. This avoids ambiguous label mapping.

### Experiment timeline

#### Segment 1: Single-frame

| # | Status | Config | Result | Time | Notes |
|---|--------|--------|--------|------|-------|
| 1 | crash | Zero-shot baseline | — | ~5min | Missing `torchvision` dependency in remote env |
| 2 | keep | Zero-shot baseline | 0.0% top-1, 0.0% valid JSON | ~30min | Proves base model can't play DOOM without fine-tuning |
| 3 | **keep** | 4096 win, 200 steps | **18.75%** top-1, 100% JSON | ~2.5h | First successful LoRA SFT. Huge jump from 0%. |
| 4 | discard | 4096 win, 400 steps | 15.63% | ~2.5h | More steps = worse. Overfitting to majority actions. |
| 5 | discard | 4096 win, 200 steps, cap=224 | 17.19% | ~2.5h | Class balancing via hard cap hurt performance. |
| 6 | **keep** | 8192 win, 200 steps | **21.875%** | ~2.5h | Doubling data helped. New best. |
| 7 | crash | 8192 win, 400 steps | — | cancelled | Job cancelled by platform mid-training. |
| 8 | crash | — | — | — | 402: insufficient HF credits (a10g-large triggered it). |
| 9 | crash | — | — | — | 402: still no credits even on a10g-small. |
| 10 | discard | 8192 win, 300 steps | 17.19% | ~2.5h | Overfitting again with more steps on single-frame. |
| 11 | discard | 16384 win, 200 steps | 21.875% | ~2.5h | More data didn't help — flat result. |

**Segment 1 conclusion:** Single-frame peaks at 21.875% with 8192 windows and 200 steps. More data or more steps both plateau or overfit.

#### Segment 2: 4-frame temporal context

Pi started a new experiment segment with `FRAME_STACK=4, FRAME_STRIDE=2` (4 frames spaced 2 timesteps apart as multi-image input).

| # | Status | Config | Result | Notes |
|---|--------|--------|--------|-------|
| 1 | keep | 4096 win, 100 steps | 10.94% | 4-frame baseline. Weaker than single-frame (expected — fewer steps). |
| 2 | keep | 4096 win, 200 steps | 21.875% | Matches single-frame best. Temporal context viable. |
| 3 | discard | 8192 win, 200 steps | 18.75% | More data hurt with 4-frame (similar to single-frame pattern). |
| 4 | **keep** | 4096 win, 300 steps | **26.5625%** | **New overall best.** Temporal context + right training budget wins. |
| 5 | discard | 4096 win, 400 steps | 23.44% | Overfitting past 300 steps (same pattern as single-frame). |

**Session best: 26.5625% action_top1** (4-frame, 4096 windows, 300 steps).

### Key agent decisions and insights

1. **Phase discipline:** Pi followed the skill's experiment priority order. It exhausted data scaling (Phase 1) before trying hyperparameters. When class balancing failed, it moved to temporal context (Phase 2) instead of thrashing.

2. **Overfitting detection:** Pi consistently identified the pattern: more steps beyond the sweet spot causes overfitting to majority actions. It logged this in `autotrain.md` as a dead end.

3. **Data analysis between experiments:** After the overfitting discovery, Pi ran inline Python to analyze action distributions, computed majority-class baselines, and tested various cap values before settling on the next experiment.

4. **Segment transitions:** When single-frame experiments plateaued, Pi started a new segment for 4-frame context with a fresh baseline, rather than continuing to tweak the exhausted recipe.

### Bottlenecks observed

- **Training speed:** Each 200-step run took ~2.5 hours on a10g-small. The bottleneck was 15GB RAM (100% used), not GPU (only 16% utilized). The dataset loading caused memory swapping, starving the GPU.
- **Blocking `run_experiment`:** Pi was frozen inside `run_experiment` for the entire duration of each HF Job (2.5h+). It couldn't analyze data, plan, or do anything else while waiting. The `monitor_job` tool (in development) would fix this.
- **Logging frequency:** Pi set `logging_steps=20`, which meant ~15 minutes of silent output between log lines. For VLM training at 45s/step, this made it impossible to tell if training was progressing or stuck.
- **Credit exhaustion:** Changing the default flavor to `a10g-large` ($1.50/hr) depleted HF credits faster. Pi detected the 402 error and stopped retrying after 2 attempts.

---

## Session 2: Named Entity Recognition (NER JSON Extraction)

**Task:** Train Qwen3.5-0.8B to extract people, places, and dates from sentences as JSON.

**Dataset:** `tner/ontonotes5` — converted token-level NER labels into sentence → JSON format.

**Model:** Same Qwen3.5-0.8B with QLoRA.

**Hardware:** HF Jobs `a10g-small`.

**Input format:** Sentence → `{"people": ["John"], "places": ["Paris"], "dates": ["March 2026"]}`

**Primary metric:** `entity_f1` (F1 score on extracted entities).

### How it was launched

This session was launched from the OpenClaw gateway (Gemini 3.1 Flash Lite). The OpenClaw agent:
1. Read the `autotrain` skill
2. Verified Pi CLI was installed
3. Launched Pi via `exec` with the autotrain-create skill and the NER task description
4. Pi ran autonomously from there

### Experiment timeline

| # | Status | Config | Result (entity_f1) | Notes |
|---|--------|--------|---------------------|-------|
| 1 | crash | Full 750-step run | 46.35% (baseline only) | Legacy `datasets` loader failed. Switched to raw JSON shards. |
| 2 | crash | Resumed in-flight job | — | HF marked job as CANCELED mid-training (~step 313/750). |
| 3 | keep | 300 steps | **81.69%** | First stable run. Switched to raw JSON loading. |
| 4 | **keep** | 300 steps + prompt-only loss masking | **89.51%** | Masking prompt tokens so loss only applies to assistant JSON output. Big improvement. |
| 5 | discard | Explicit span-copying prompt | 87.50% | More explicit prompt wording didn't help. |
| 6 | discard | 8000 train examples (was 12000) | 86.11% | Less data = worse. |
| 7 | discard | Higher negative ratio (0.25) | 89.05% | More negative examples didn't help F1. |
| 8 | discard | Lower negative ratio (0.10) | 96.77%* | *Harness bug: train/eval shared RNG, so metric was unreliable. |
| — | — | **Benchmark reset** | — | Pi discovered and fixed the RNG bug. New segment with stable eval slice. |
| 9 | keep | Stable eval, 300 steps | **94.44%** | Baseline on fixed eval. |
| 10 | discard | Negative ratio 0.10 | 92.96% | Fewer negatives hurt on stable eval. |
| 11 | keep | 450 steps | **95.10%** | More steps helped here (unlike Doom). |
| 12 | **keep** | 450 steps + LoRA r=32, alpha=64 | **97.26%** | Doubling LoRA capacity = best result. |
| 13 | discard | Narrower LoRA targets (attention-only) | 95.10% | Fewer LoRA targets = worse. |

**Session best: 97.26% entity_f1** (450 steps, LoRA r=32/alpha=64, assistant-only loss masking).

### Key agent decisions

1. **Bug discovery and fix:** Pi found that changing training hyperparameters also changed the eval slice (shared RNG). It reset the benchmark with separate RNGs — a critical integrity fix that most humans would miss.
2. **Loss masking:** Pi's most impactful change was masking the prompt tokens so the model only learns from the JSON output, not from predicting the input sentence. This jumped F1 from 81.69% to 89.51%.
3. **LoRA scaling:** Unlike Doom (where more capacity didn't help), NER benefited from doubling LoRA rank/alpha. Pi correctly identified this as a Phase 3 experiment after exhausting Phase 1 (data) and Phase 2 (format).
4. **Model pushed to Hub:** Final adapters were pushed to `Mike0021/qwen35-0.8b-ner-json-lora`.

---

## Session 3: "Chess" Fine-tuning (Failed OpenClaw Delegation)

**Task:** User asked OpenClaw to "use your autoresearch tool to finetune Qwen/Qwen3.5-0.8B to be as good as possible."

**What actually happened:** This session demonstrates a model quality failure. OpenClaw's Gemini 3.1 Flash Lite did NOT follow the autotrain skill instructions.

### Timeline

1. **User request** (Mar 13, 16:28 UTC): "use your autoresearch tool to finetune Qwen/Qwen3.5-0.8B to be as good as possible"

2. **OpenClaw reads the skill** — it found `autoresearch/SKILL.md` and verified `pi --version` returned 0.57.1.

3. **OpenClaw ignores the skill instructions** — instead of using `exec` to launch Pi (as the skill explicitly says), it used `sessions_spawn` (OpenClaw's built-in subagent system).

4. **Three failed spawn attempts:**
   - Attempt 1: `agentId is not allowed for sessions_spawn` — tried specifying an agent ID that doesn't exist
   - Attempt 2: `Invalid thinking level "detailed"` — used a non-existent thinking level
   - Attempt 3: `model not allowed: openrouter/google/gemini-3.1-flash-lite-preview` — model blocked for subagents

5. **Fourth attempt succeeds** — spawned a subagent with `thinking: "high"` and no model override.

6. **Subagent completes in 17 seconds** — it generated a vague response about "setting up the training pipeline" without doing any actual work. No training script was written, no HF Job was submitted, no data was downloaded.

7. **OpenClaw reports success** — "The sub-agent wrapped up the optimization! You should now have the recommended configuration and weights saved."

### Why it failed

- **Model quality:** Gemini 3.1 Flash Lite (FACTS score 40.6%) lacks the reasoning ability to follow multi-step skill instructions. The skill says "use `exec` to run Pi with this EXACT command template" — Flash Lite used `sessions_spawn` instead.
- **No Pi involvement:** Pi was never launched. The "training" was a hallucinated response from a weak subagent running the same Flash Lite model.
- **No validation:** OpenClaw didn't verify the subagent's output. A 17-second "fine-tuning" of an 859M parameter model should have been flagged as suspicious.

### Lesson learned

The autotrain OpenClaw skill was subsequently updated with explicit warnings:
```
IMPORTANT: NEVER train models yourself. ALWAYS delegate to Pi via exec.
Do NOT use sessions_spawn — it is not configured on this instance and will fail.
```

---

## Cross-session Patterns

### What the agent does well

1. **Systematic exploration** — follows the phase priority order (data > format > architecture > hyperparameters) rather than randomly tweaking
2. **Dead end tracking** — logs failed approaches in `autotrain.md` so resumed sessions don't repeat them
3. **Bug detection** — found the shared-RNG eval bug in NER and fixed it (most humans wouldn't catch this)
4. **Data analysis** — runs inline Python for dataset profiling (action distributions, class balance, coverage analysis) to inform experiment design
5. **Appropriate discarding** — correctly identifies overfitting (more steps = worse accuracy) and doesn't chase noise

### What the agent does poorly

1. **No smoke testing** — launches full 2.5-hour runs without first doing a 5-minute sanity check (10 steps with `logging_steps=1`)
2. **Blocking architecture** — `run_experiment` blocks for the entire training duration, wasting GPT-5.4 context time
3. **Small eval set** — 64 examples means +/-3% changes are noise, but the agent treats 1-2% differences as signal
4. **No cost awareness** — doesn't estimate job cost before submitting, leading to credit exhaustion
5. **Slow iteration** — VLM training at 45s/step on a10g-small with 15GB RAM (GPU only 16% utilized due to RAM bottleneck)

### Infrastructure lessons

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| 2.5h per experiment | 15GB RAM bottleneck, GPU starved | Use `a10g-large` (46GB RAM, $1.50/hr) |
| Pi blocked during training | `run_experiment` is synchronous | Use `monitor_job` tool (in development) |
| Credit exhaustion | Flavor change + no balance check | Add credit check before job submission |
| Silent progress | `logging_steps=20` on 45s/step workload | Set `logging_steps=5` for VLM |
| Shared eval RNG | Harness bug in NER | Separate train/eval RNGs |
| OpenClaw used wrong tool | Flash Lite ignored skill instructions | Explicit "NEVER use sessions_spawn" in skill |

### Cost summary

All training ran on HF Jobs at $1.00/hr (a10g-small):

- **Doom:** ~16 experiments × ~2.5h average = ~40 GPU-hours ≈ **$40**
- **NER:** ~13 experiments × ~1h average = ~13 GPU-hours ≈ **$13**
- **Chess:** $0 (never actually ran)
- **Pi (GPT-5.4):** Free via ChatGPT Pro subscription. Without the subscription, ~160K tokens per session at OpenAI API rates would cost ~$5-10 per session.
