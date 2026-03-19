# Practical Training Guide — Lessons from Real Sessions

Distilled from autonomous training sessions (DOOM VLM fine-tuning, NER JSON extraction, and a failed Chess delegation). These are battle-tested patterns — not theory.

---

## QLoRA Configuration Patterns

### What works

| Setting | Value | Why |
|---------|-------|-----|
| LoRA rank (r) | 16 for simple tasks, 32 for structured output | NER jumped from 89.51% → 97.26% when doubling r from 16→32. DOOM saw no benefit — rank was never the bottleneck for action prediction. Match rank to output complexity. |
| LoRA alpha | 2× rank (alpha = 2r) | Standard scaling ratio. Keeps the effective learning rate stable as you change rank. |
| Quantization | 4-bit (QLoRA) | Fits 0.8B models on 24GB A10G with room to spare. Always set `bnb_4bit_compute_dtype=torch.bfloat16` on Ampere GPUs. |
| Precision | `bf16=True` on Ampere (A10G, A100, L40S) | `fp16=True` causes AMP unscale errors with bitsandbytes 4-bit. Only use `fp16` on T4. |
| LoRA targets | All linear layers (default) | Attention-only targets (`q_proj`, `v_proj`) consistently underperformed vs targeting all projections — NER dropped from 97.26% → 95.10% with attention-only. |
| Dropout | 0 | Required for unsloth fast kernels. Even outside unsloth, dropout on LoRA adapters rarely helps at low step counts. |

### Steps and overfitting

The sweet spot is narrow and task-dependent:

**DOOM (VLM, action prediction):**
- 200 steps: 18.75% → 21.875% (good range)
- 300 steps (4-frame): **26.5625%** (session best)
- 400 steps: always worse — overfits to majority actions every time

**NER (text → JSON extraction):**
- 300 steps: 94.44% entity_f1 (solid)
- 450 steps: 95.10% → **97.26%** with r=32 (session best)
- More steps helped here — structured JSON output benefits from longer training

**Rule of thumb:** Start at 200 steps. If the metric improves, try 300. If it improves again, try 450. The moment it drops, you've found the ceiling.

### Data scaling

More data does NOT always help:
- DOOM single-frame: 4096 → 8192 windows improved (18.75% → 21.875%), but 16384 was flat
- DOOM 4-frame: 8192 windows was *worse* than 4096 — multi-image inputs change the effective dataset size
- NER: reducing from 12,000 → 8,000 examples cost 3.4 F1 points — don't cut data to speed up iteration for NLP tasks

### Scaling LoRA rank

Only increase rank *after* exhausting data and format changes (Phases 1–2). Rank changes are Phase 3.

- Simple tasks (binary classification, action prediction): r=16 is enough
- Structured output (JSON extraction, multi-field): r=32/alpha=64 is worth trying
- If doubling rank doesn't help, the bottleneck is elsewhere — don't keep increasing

---

## Hardware Selection and Cost

### The RAM bottleneck

On `a10g-small` (4 vCPU, 15GB RAM, 1× A10G 24GB):
- RAM hit 100% utilization while GPU sat at 16%
- VLM experiments took ~2.5 hours each because the GPU was starved for data
- Training ran at 45s/step — extremely slow for a 0.8B parameter model
- **Fix:** Use `a10g-large` (8 vCPU, 46GB RAM, $1.50/hr) for VLM tasks. The 50% cost increase is offset by 3–5× faster iteration.

### Cost estimation before submitting

| Task type | Hardware | Time/experiment | Cost/experiment |
|-----------|----------|-----------------|-----------------|
| VLM (0.8B, images) | a10g-small | ~2.5 hours | ~$2.50 |
| VLM (0.8B, images) | a10g-large | ~30–45 min | ~$0.75–1.13 |
| NLP (0.8B, text-only) | a10g-small | ~1 hour | ~$1.00 |

Budget for 10–15 experiments per session. Real cost across sessions: DOOM ~$40 (16 experiments), NER ~$13 (13 experiments).

### Hardware selection by model size

| Model size | Minimum flavor | Cost/hr | Notes |
|------------|---------------|---------|-------|
| ≤1B text | t4-small | $0.40 | Text-only tasks. Use `fp16` on T4. |
| ≤1B VLM | a10g-large | $1.50 | Images need RAM, not just VRAM |
| 1B–3B | a10g-small | $1.00 | Text-only |
| 3B–8B | a10g-large | $1.50 | Or a100-large for faster iteration |
| 8B+ | a100-large | $3.50 | Or h200 for 70B+ models |

---

## Evaluation Strategy

### Eval set sizing

| Eval set size | Reliability | Noise margin |
|---------------|-------------|--------------|
| < 64 examples | Unreliable | ±5–10% is noise |
| 64–200 | Noisy | ±3% is noise |
| 200–1000 | Usable | ±1.5% is noise |
| 1000+ | Reliable | ±1% is meaningful |

Both sessions suffered from small eval sets. DOOM used 64 eval examples — a 1-example change is a 1.5625% swing. **Target 200+ eval examples minimum.**

### The shared-RNG bug

In the NER session, changing hyperparameters also changed which examples landed in the eval split (train/eval shared a single random seed). Experiment 8 produced a suspicious 96.77% — the agent caught it and reset the benchmark.

**Fix:** Always use separate, fixed random seeds for train/eval splitting:
```python
# WRONG — eval changes when you change training config
rng = random.Random(42)
train, eval = split(data, rng)

# RIGHT — eval is always the same examples
train_rng = random.Random(42)
eval_rng = random.Random(999)
eval_set = select_eval(data, eval_rng)  # fixed forever
train_set = select_train(data, train_rng)  # can change
```

### Three-way split discipline

- **Train:** Used for gradient updates. May be re-curated between experiments.
- **Val:** Used for checkpoint selection (in-loop, during training). May be re-curated.
- **Test:** Sacred. Fixed at session start. Never modified, never trained on, never used for checkpoint selection. This is the metric you use for keep/discard decisions.

### Fresh validation

Every 10 experiments (or after every `keep`), evaluate on a different random sample from the validation pool. Large divergence between fresh validation and test results = overfitting to the test set.

---

## Experiment Phase Discipline

The single most important pattern across all sessions: **follow the phase order.**

### Phase 1 — Data Quality (highest leverage)

- Volume: How much data? Try 2×, try 0.5×.
- Curation: Filter bad examples, deduplicate.
- Balance: Check class distributions.
- For RL: environment design, reward shaping, curriculum.
- For distillation: teacher selection, synthetic data quality.

In DOOM, scaling from 4096 → 8192 windows improved from 18.75% → 21.875%. In NER, cutting from 12k → 8k examples cost 3.4 F1 points.

### Phase 2 — Input/Output Format (second highest)

- **Loss masking** was the single biggest win in NER: masking prompt tokens so the model only learns from the JSON output jumped F1 from 81.69% → 89.51% (+7.8 points).
- In DOOM, 4-frame temporal stacking broke through the single-frame ceiling: 21.875% → 26.5625%.
- Label format matters: 9-bit binary action strings outperformed English action names for DOOM.

### Phase 3 — Architecture

- LoRA rank/alpha changes, target module selection, layer unfreezing.
- NER benefited from r=32 (Phase 3) but only *after* loss masking (Phase 2) was established.

### Phase 4 — Hyperparameters

- Learning rate (sweep 1e-6 to 1e-3 log scale), batch size, scheduler, warmup.
- **Do not start here.** The sessions prove that data and format changes dominate.

### Phase 5 — Regularization

- Weight decay, dropout, early stopping.
- Only if overfitting is visible (train loss dropping, eval metric dropping).
- Rarely reached in practice — step count limits usually handle overfitting.

**Hard rule:** Do NOT jump to Phase 4 before exhausting Phases 1–2.

---

## Anti-Thrash Rules

1. **5+ consecutive discards** → Stop. Write detailed notes. Pivot to a different phase entirely.
2. **Same metric ±noise for 8+ experiments** → The current approach is exhausted. Change something structural.
3. **All ideas are Phase 4 but Phases 1–3 not exhausted** → Go back up. You're micro-optimizing when macro changes are still available.
4. **20+ minutes without improvement** → Run fresh validation to check if recent "improvements" were noise.
5. **Eval metrics diverging from train metrics** → You're overfitting. Stop and investigate.

---

## Common Failure Modes

### Crashes and platform issues

| Failure | Frequency | Root cause | Prevention |
|---------|-----------|------------|------------|
| Missing dependencies | First run | Remote container doesn't have `torchvision`, etc. | Declare all deps in PEP 723 header. Smoke test first. |
| Job cancelled mid-training | ~10% of runs | HF platform instability or timeout | Set `--timeout` with 50% buffer. |
| 402 insufficient credits | Once per session | Accidentally switched to expensive flavor | Check balance before submitting. |
| Connection drop (attached mode) | 100% on long jobs | Default mode drops stdout on long jobs, orphans the job | **Always use `-d` (detached mode).** |
| `datasets` library failures | ~20% of datasets | Incompatible versions, broken configs | Load via raw JSON/parquet shards. |

### Subtle bugs

| Bug | Impact | Detection |
|-----|--------|-----------|
| Shared train/eval RNG | Metrics unreliable — comparing apples to oranges | Suspicious jumps. Fixed by separate RNGs. |
| `fp16=True` on Ampere + QLoRA | AMP unscale errors, crashes | Use `bf16=True` on A10G/A100/L40S. |
| Logging too infrequent | Silent progress, can't detect stuck runs | `logging_steps=20` at 45s/step = 15 min silence. Use `logging_steps=5` for VLM. |
| ANSI codes in `hf auth whoami` | Username parsing breaks | Strip with `sed 's/\x1b\[[0-9;]*m//g'`. |

---

## Smoke Test Protocol

Before every full training run, do a 10-step sanity check:

```bash
if [ "$SMOKE_TEST" = "1" ]; then
  STEPS=10
  LOGGING_STEPS=1
  EVAL_STEPS=10
  echo "SMOKE TEST: 10 steps only"
fi
```

A smoke test catches:
- Missing dependencies (saved 2.5 hours in DOOM experiment 1)
- Data loading errors
- Shape mismatches, dtype errors
- OOM on the selected hardware

Cost: ~$0.05 and 2 minutes. The agent never did this and paid the price repeatedly.

---

## Task-Specific Guidance

### VLM fine-tuning (images → text)

- RAM is the bottleneck, not GPU compute. Size up the instance.
- Frame stacking (multiple images as temporal context) can break through single-frame ceilings — DOOM went from 21.875% → 26.5625%.
- Keep eval prompts short and output format strict (e.g., `{"action":"A_101000000"}`).
- `logging_steps=5` minimum — VLM steps are slow (45s+).
- Check `pipeline_tag` on the model card — don't attempt text-only fine-tuning on a VLM and vice versa.
- JSON output validity is a useful secondary metric — the zero-shot baseline produces 0% valid JSON.

### NLP structured extraction (text → JSON)

- **Loss masking is mandatory.** Only train on the output tokens, not the prompt. +7.8 F1 points in NER.
- Higher LoRA rank helps (r=32 beat r=16). JSON has structure that benefits from more capacity.
- More steps help (450 > 300 for NER) — unlike VLM where overfitting kicks in fast.
- Include negative examples (sentences with no entities) at 10–25% ratio to reduce false positives.
- Data volume matters: don't cut data to speed up iteration.

### General SFT

- Start with the model's native chat template. Don't invent formats.
- Check the tokenizer's `chat_template` and `config.json` (max context length, hidden size) before writing the data pipeline.
- Inspect model architecture class to determine correct LoRA target modules.

---

## Local Training Gotchas

### mlx-lm (Apple Silicon)

1. **Abort trap: 6** — Combined `--train --test` in one call causes SIGABRT due to memory accumulation. Always run train and eval as separate invocations.
2. **Eval baseline crash** — `mlx_lm.lora --test` without an existing adapter crashes. Pass `--adapter-path ""` explicitly for baseline eval.
3. **Data format** — Expects `train.jsonl`, `valid.jsonl`, `test.jsonl` with `{"messages": [...]}` matching the model's chat template.
4. **Sampler API change** — `temp=` kwarg removed from `generate()`. Use `sampler=make_sampler(temp=0.0)` from `mlx_lm.sample_utils`.
5. **Module invocation** — Use `mlx_lm.lora` (dot notation) or `python -m mlx_lm lora` (space). `python -m mlx_lm.lora` is deprecated.
6. **LoRA rank** — Not a CLI flag. Configure via YAML passed with `-c config.yaml`.
7. **Batch size ≤ 4** — Apple Silicon shares the GPU with the display. Larger batches freeze macOS. Default to batch-size 2 with gradient accumulation.

### unsloth (NVIDIA)

- `lora_dropout=0` and `bias="none"` are **required** for fast kernels. Any other value silently falls back to the slow path — you lose the 2–5× speedup and 50–70% VRAM savings.

### TRL + PEFT (NVIDIA fallback)

- Use when unsloth doesn't support the model architecture. Standard `AutoModelForCausalLM` + `LoraConfig` + `SFTTrainer` pattern.

---

## HF Jobs Patterns

### Detached mode (required)

ALWAYS use `-d`/`--detach`. Attached mode drops the connection on long-running jobs, orphaning the job (which keeps running and billing). Parse the job ID:
```bash
JOB_ID=$(hf jobs uv run -d ... 2>&1 | grep -Eo '[0-9a-f]{24}' | head -n 1)
```

### Training script requirements

1. **PEP 723 header** — declare all dependencies at the top:
   ```python
   # /// script
   # dependencies = ["torch", "transformers", "peft", "bitsandbytes", "trl"]
   # ///
   ```
2. **METRIC lines** — print `METRIC name=value` to stdout for extraction.
3. **Push before exit** — container is ephemeral; call `upload_folder()` before the script ends.
4. **Config via env vars** — pass per-experiment config with `-e` flags in `autotrain.sh`.

### Timeout rules

- `--timeout` in `autotrain.sh`: `training_time × 1.5`
- `timeout_seconds` in `run_experiment`: same value + 120s for startup/polling overhead

---

## Agent Orchestration Lessons

### What works

1. **Phase discipline** — follows the priority order rather than randomly tweaking hyperparameters
2. **Dead-end tracking** — logs failed approaches in `autotrain.md` so resumed sessions don't repeat mistakes
3. **Bug detection** — found the shared-RNG eval bug that most humans would miss
4. **Data profiling** — runs inline Python analysis of datasets before training to inform decisions
5. **Appropriate discarding** — correctly identifies overfitting and doesn't chase noise

### What fails

1. **No smoke testing** — launches 2.5-hour runs without a 5-minute sanity check. Enforce a 10-step dry run.
2. **Blocking on long jobs** — `run_experiment` blocks the agent for the entire duration. ~40 hours of frozen agent time in the DOOM session alone. (`monitor_job` tool is in development on `feat/monitor-job-two-step` branch.)
3. **Small eval sets** — treats 1–2% swings on 64 examples as signal. Set minimum eval set size in constraints.
4. **No cost awareness** — doesn't estimate cost before submitting. Led to 402 credit exhaustion.
5. **Weak model delegation** — using a weak gateway (Gemini Flash Lite, FACTS 40.6%) to orchestrate training always fails. Must delegate via `exec` to a strong coding agent.

### The "17-second fine-tuning" anti-pattern

In the failed Chess session, OpenClaw spawned a weak subagent instead of delegating to Pi via `exec`. The subagent returned in 17 seconds claiming success — no script written, no job submitted, no METRIC lines.

**How to detect it:**
- Wall-clock time is implausibly short (seconds, not minutes)
- No HF Job ID in the output
- No training logs, loss curves, or metric values reported
- No file artifacts created (`*.py`, `autotrain.md`, `autotrain.jsonl`)
- Output is vague ("I set up the pipeline") instead of concrete ("job abc123, step 200/300, eval F1: 89.5%")

---

## Session Resume Protocol

When resuming (new agent, context window reset, multi-day training):

1. **Read `autotrain.md`** — objective, current strategy, all results, dead ends, what phase you're in
2. **Read `git log`** — experiment sequence, what was kept/discarded
3. **Read `autotrain.ideas.md`** — backlog of untried ideas tagged by phase; prune stale entries
4. **Read `autotrain.jsonl`** — append-only log of every experiment with metrics and commit hashes

Then continue looping without asking the user. Pick up from the current phase, apply anti-thrash rules, never stop autonomously.

---

## Experiment Checklist

**Before submitting:**

- [ ] Smoke test passed (10 steps, `logging_steps=1`)
- [ ] Eval set is fixed (separate RNG from training)
- [ ] Eval set has 200+ examples
- [ ] Using `bf16=True` on Ampere GPU (not `fp16`)
- [ ] Detached mode enabled (`-d` flag)
- [ ] Dependencies declared in PEP 723 header
- [ ] `METRIC name=value` lines printed to stdout
- [ ] Results pushed to Hub before script exits
- [ ] `--timeout` set with 50% buffer
- [ ] Cost estimated and within budget

**After each experiment:**

- [ ] Compare metric to current best
- [ ] Log as `keep` or `discard` with clear rationale
- [ ] If `keep`: update `autotrain.md`, commit, upload to Hub
- [ ] If 5+ consecutive discards: pivot to next phase
- [ ] If same metric for 8+ experiments: structural change needed

---

## Unmerged Features Worth Knowing About

Two branches contain features that address documented pain points:

- **`feat/monitor-job-two-step`** — adds `monitor_job` and `stop_monitor` tools for non-blocking job monitoring. Solves the biggest infrastructure gap: the agent being frozen for hours during `run_experiment`.
- **`upstream/feat/confidence-layer`** — statistical significance testing for metric improvements, structured METRIC line parsing, median-of-N guidance for fast benchmarks, and security fixes (prototype pollution via METRIC names, abort signal race conditions).
