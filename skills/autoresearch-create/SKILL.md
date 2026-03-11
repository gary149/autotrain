---
name: autoresearch-create
description: Set up and run an autonomous experiment loop for any optimization target. Gathers what to optimize, then starts the loop immediately. Use when asked to "run autoresearch", "optimize X in a loop", "set up autoresearch for X", or "start experiments".
---

# Autoresearch — Setup & Run

Set up an autonomous experiment loop and start running immediately.

## Tools

You have two custom tools from the autoresearch extension. **Always use these instead of raw bash for experiments:**

- **`run_experiment`** — pass it a `command` to run. It times execution, captures output, detects pass/fail via exit code.
- **`log_experiment`** — records each experiment's `commit`, `metric`, `status` (keep/discard/crash), and `description`. Persists state, updates the status widget and dashboard (toggle with ctrl+r).

  **On the first call**, always set these to configure the display:
  - `metric_name` — display name for primary metric (e.g. `"total_µs"`, `"bundle_kb"`, `"val_bpb"`)
  - `metric_unit` — unit string that controls number formatting: `"µs"`, `"ms"`, `"s"`, `"kb"`, or `""` for unitless. Integers get comma-separated thousands; fractional values get 2 decimal places.
  - `direction` — `"lower"` (default) or `"higher"` depending on what's better

  **Optional params (any call):**
  - `metrics` — dict of secondary metric name→value for tradeoff monitoring, e.g. `{"parse_µs": 5505, "render_µs": 1440}`
  - `new_baseline` — only use this to **reset** the comparison reference point (e.g. after changing the optimization target or accepting a tradeoff). The first experiment is automatically the baseline. Do NOT set this on every keep.

  The inline widget shows the current metric vs baseline as a delta %, e.g. `★ total_µs: 6,945 (-21.2%)`.

## Step 1: Gather Context

Ask the user (propose smart defaults based on the codebase):

1. **Goal** — what are we optimizing? (e.g. "reduce vitest execution time")
2. **Command** — shell command to run per experiment (e.g. `pnpm test:vitest`)
3. **Metric** — what number to measure, and is lower or higher better?
4. **Files in scope** — what can you modify?
5. **Constraints** — hard rules (e.g. "all tests must pass", "don't delete files")

If the user already provided these in their prompt, skip asking and confirm your understanding.

## Step 2: Setup

1. **Create a branch**: `git checkout -b autoresearch/<tag>` (propose a tag based on the goal + date).
2. **Read the relevant files** to understand what you're working with.
3. **Run the baseline**: use `run_experiment` with the command as-is, then `log_experiment` to record it. The first experiment automatically becomes the baseline. Set `metric_name`, `metric_unit`, and `direction` on this first call. Include any secondary `metrics` you want to track for tradeoffs.
4. **Start looping** — do NOT wait for confirmation after the baseline. Go.

## Step 3: Experiment Loop

LOOP FOREVER:

1. Think of an experiment idea. Read the codebase for inspiration. Consider:
   - Config changes (parallelism, caching, pooling, environment)
   - Removing unnecessary work (unused setup, redundant transforms)
   - Structural changes (splitting, merging, reordering)
2. Edit files with the idea
3. `GIT_EDITOR=true git add -A && git commit -m "short description"`
4. Use `run_experiment` with the command
5. Use `log_experiment` to record the result. Always pass secondary `metrics` if tracking tradeoffs.
6. If metric improved AND constraints met → keep (status: `keep`).
7. If metric worse OR constraints broken → `git reset --hard HEAD~1` (status: `discard` or `crash`)
8. Repeat

**Simplicity criterion**: all else being equal, simpler is better. Removing code for equal results is a win.

**NEVER STOP.** Loop indefinitely until the user interrupts. Do not ask "should I continue?". The user can check progress anytime with `/autoresearch`.

**Crashes**: if it's a trivial fix (typo, missing import), fix and retry. If fundamentally broken, discard and move on.

## Example Domains

- **Test speed**: metric=seconds ↓, command=`pnpm test`, scope=vitest/jest configs
- **Bundle size**: metric=KB ↓, command=`pnpm build && du -sb dist`, scope=bundler config
- **Build speed**: metric=seconds ↓, command=`pnpm build`, scope=tsconfig + bundler
- **LLM training**: metric=val_bpb ↓, command=`uv run train.py`, scope=train.py
- **Lighthouse score**: metric=perf score ↑, command=`lighthouse --output=json`, scope=components
