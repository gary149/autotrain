# Autotrain 2 PRD
## Simple, powerful, HF-only autonomous fine-tuning

**Status:** Final spec  
**Version:** 1.0  
**Audience:** Pi/Autotrain maintainers, OpenClaw integrators, experiment platform engineers  
**Authoring basis:** current `pi-autotrain` behavior, March 2026 session report, and the decision to move to a Hugging Face Jobs-only architecture.

---

## 1. Executive summary

Autotrain should stop behaving like a generic research loop and become a **campaign manager for high-quality fine-tunes**.

The current system has the right ambition but the wrong center of gravity:
- it is too close to `autoresearch`
- it blocks on one long experiment at a time
- it treats synchronous keep/discard loops as the main abstraction
- it relies too much on ad hoc script mutation
- it does not separate benchmark integrity from training iteration
- it wastes GPU time on runs that should have been screened or canceled early

Autotrain 2 is a deep simplification:
- **HF Jobs only** for compute
- **one orchestrator** with an async campaign loop
- **recipe-first training** instead of freeform codegen-first training
- **benchmark contract first** before expensive runs
- **mandatory smoke tests** before full jobs
- **parallel screening + promotion** instead of one blocking loop
- **cancellation and cost awareness** as first-class features
- **frozen judge, evolving harness** so the system improves without gaming itself

The system remains autonomous, but it becomes autonomous in the right way: it continuously manages a training campaign rather than getting trapped inside a single experiment.

### Definition of “10x better”

Autotrain 2 should aim to deliver:
- **10x more useful experiments per day** than the current blocking design
- **10x less wasted GPU spend** on broken or obviously losing runs
- **far lower false-win rate** by enforcing a stable benchmark contract
- **much faster time to first valid signal** through smoke tests and screening

This PRD does **not** promise 10x model quality on every task. It promises a much better system for discovering strong fine-tunes efficiently and reliably.

---

## 2. Product thesis

Autotrain is not “autoresearch for training.”

Autoresearch is optimized for open-ended code iteration with a compact local loop. Autotrain needs a different shape because training campaigns are dominated by:
- data preparation
- benchmark integrity
- remote job orchestration
- cost control
- asynchronous monitoring
- experiment promotion and cancellation
- artifact management

The correct metaphor is:

> **Autotrain is an autonomous ML engineer that runs and manages a training campaign.**

Its job is to decide:
- what to train
- how to prepare data
- which recipe to use
- how much budget each candidate deserves
- when to stop, cancel, promote, or declare a winner
- what to scout next while jobs are running

---

## 3. Goals

### Primary goals

1. Produce stronger fine-tunes with less human supervision.
2. Maximize useful signal per dollar.
3. Avoid wasted full-budget runs through mandatory screening.
4. Keep every campaign resumable and inspectable.
5. Preserve benchmark integrity across long autonomous sessions.
6. Allow the system to keep working while remote jobs run.
7. Stay simple enough to implement and maintain.

### Secondary goals

1. Support lightweight self-improvement of the harness.
2. Make it easy for frontends such as OpenClaw to launch and monitor campaigns.
3. Build a durable memory of dead ends, winners, and transferable heuristics.

---

## 4. Non-goals

Autotrain 2 V1 will not try to do everything.

### Out of scope for V1

- local compute backends
- Kubernetes or multi-cloud orchestration
- full pretraining from scratch
- arbitrary RL environments
- robotics, browser agents, or embodied training loops
- automatic mutation of benchmark judges during a live campaign
- unrestricted code generation for every experiment
- large multi-agent systems as the core execution model

### Deliberately dropped

- non-HF Jobs compute
- “train everything everywhere” abstractions
- synchronous long-running `run_experiment` as the main primitive

---

## 5. Product principles

### 5.1 Benchmark first
No serious training campaign starts until the benchmark contract is frozen.

### 5.2 HF-only
Every compute action goes through Hugging Face Jobs. This reduces complexity, removes backend branching, and makes async orchestration easier.

### 5.3 Recipe-first, codegen-last
Autotrain should search over stable recipe families and bounded knobs before it writes custom code.

### 5.4 Async by default
The orchestrator never blocks on a single training run. It should always be able to inspect jobs, schedule new ones, scout assets, and update state.

### 5.5 Small budget before big budget
Every candidate must earn its right to consume more GPU time.

### 5.6 Frozen judge, evolving harness
The system may improve its scaffolding, but it may not rewrite the judge during a live campaign.

### 5.7 Human-readable state
A person should be able to understand a campaign from the saved files without replaying the whole session.

### 5.8 Proof over claims
No component may report “training complete” without concrete evidence: job IDs, metrics, artifacts, and a recorded winner.

---

## 6. User and use cases

### Primary user
An AI engineer or operator who wants the best possible fine-tune for a task under a budget and time limit.

### Core jobs-to-be-done

1. Start a campaign from a task description.
2. Evaluate candidate datasets, base models, and recipes.
3. Run small experiments first, then promote winners.
4. Monitor runs and cancel bad ones early.
5. Resume campaigns after interruptions.
6. Produce a final model, reproducible artifacts, and a report.

### Example campaign types in V1

- text SFT for structured extraction, classification, or generation
- VLM SFT for multimodal instruction following or action prediction
- DPO / preference tuning on a fixed prompt-response dataset

---

## 7. Product scope

### Supported in V1

- text SFT
- VLM SFT
- DPO / preference tuning
- LoRA and QLoRA first
- remote CPU and GPU jobs on HF Jobs
- detached jobs with polling and cancellation
- dataset prep as explicit job stage
- benchmarked screening and promotion
- campaign resume
- final artifact packaging and report generation

### Deferred to later phases

- full-model fine-tuning when budget allows
- automated ensembling
- cross-campaign meta-learning beyond simple heuristics
- generalized harness self-editing with code patch proposals

---

## 8. Core concept: two loops

Autotrain 2 has two loops.

### 8.1 Campaign loop (mandatory)
This loop optimizes the user’s target fine-tune.

Steps:
1. define benchmark
2. scout assets
3. prepare data
4. smoke test candidates
5. launch screening runs
6. compare results
7. cancel losers
8. promote winners
9. run full train
10. confirm and package winner
11. continue scouting until budget or stopping criteria are reached

### 8.2 Harness loop (bounded, optional in V1)
This loop improves Autotrain’s own scaffolding.

Allowed to evolve:
- recipe defaults
- smoke-test design
- scheduler heuristics
- cancellation policies
- dataset prep heuristics
- logging and monitoring policies
- output parsing robustness

Not allowed to evolve during a live user campaign:
- benchmark contract
- frozen eval/test split
- acceptance rule
- metric parser semantics
- champion promotion threshold

The harness loop is important, but it must be sandboxed so the system cannot game its own judge.

---

## 9. End-to-end workflow

### 9.1 Intake
User provides:
- objective
- task type or target behavior
- budget cap
- time cap
- optional base model constraints
- optional dataset constraints
- optional output format requirements

Autotrain responds by creating a new campaign directory and initial campaign spec.

### 9.2 Benchmark contract
Before training begins, Autotrain creates a frozen `benchmark.json` containing:
- task name
- task type
- primary metric and direction
- parser / output contract
- guardrail metrics
- `sanity_set`
- `dev_small`
- `dev_full`
- `test_frozen`
- significance / confidence rule
- acceptance rule
- stop rule

No expensive run may start before this file exists.

### 9.3 Asset scouting
Autotrain inspects candidate:
- datasets
- prepared dataset variants
- base models
- related papers / repos
- prior campaign heuristics

Output:
- shortlist of viable datasets
- shortlist of viable base models
- shortlist of recipe families
- initial experiment queue

### 9.4 Data preparation
Autotrain launches **CPU prep jobs** to:
- validate schema
- normalize records
- dedupe
- build stable train/dev/test splits
- create prompt/response renderings
- build windows or multimodal packs
- compute dataset statistics
- push prepared artifacts to a stable HF dataset repo or campaign artifact location

Prepared data is versioned and immutable within the campaign.

### 9.5 Smoke tests
Every candidate recipe must pass a small GPU smoke test before screening.

Smoke test requirements:
- imports succeed
- model/tokenizer load succeeds
- prompt template renders correctly
- parser round-trip works
- at least one train/eval step succeeds
- metrics are emitted in expected format
- output-validity checks pass on a tiny set

A candidate that fails smoke never receives full budget.

### 9.6 Screening runs
Autotrain launches short detached screening runs in parallel.

Purpose:
- test viability
- measure learning direction
- estimate throughput and cost
- verify output validity
- identify clearly losing candidates fast

Screen runs are intentionally cheap and numerous.

### 9.7 Promotion
Autotrain promotes only the best candidates to a larger budget.

Promotion is based on:
- benchmark score
- guardrail score
- output validity
- cost efficiency
- stability across repeated quick checks when margin is small

### 9.8 Full training
Only promoted candidates receive full training budget.

Full training runs should:
- inherit from the best screened config
- use the stable prepared dataset artifact
- report metrics at predictable cadence
- emit artifacts and metrics in a machine-readable form

### 9.9 Confirmation and packaging
If a challenger beats the current champion by more than the acceptance threshold, it becomes the new champion.

Before finalizing, Autotrain must:
- rerun confirmatory eval when the margin is close
- verify guardrails
- record artifact locations
- generate deployment summary
- update campaign memory and final report

### 9.10 Continuous scouting while jobs run
While remote jobs are active, the orchestrator continues to:
- inspect logs and stats
- cancel obvious losers
- analyze dataset patterns
- scout new assets
- queue the next wave

This is the key change from the current blocking design.

---

## 10. Supported recipe families

Autotrain 2 V1 ships with a small set of stable recipe families.

### 10.1 `text_sft`
For text-only supervised fine-tuning.

Typical knobs:
- base model
- LoRA / QLoRA mode
- target modules
- rank / alpha / dropout
- max sequence length
- loss masking mode
- packing mode
- template format
- train step budget
- learning rate / scheduler

### 10.2 `vlm_sft`
For multimodal supervised fine-tuning.

Typical knobs:
- base VLM
- image/video frame packing strategy
- frame count / stride
- resize policy
- LoRA target modules
- JSON or structured output format
- prompt style
- step budget
- logging cadence

### 10.3 `dpo`
For preference tuning.

Typical knobs:
- base model
- judge-free pairwise loss config
- prompt format
- truncation behavior
- dataset balance
- LoRA target config
- step budget

### Recipe contract
Each recipe must declare:
- supported task types
- required dataset schema
- searchable knobs
- default values
- smoke command
- train command
- metric extraction rule
- output parsing rule
- artifact outputs

This makes Autotrain search configuration space instead of rewriting entire harnesses from scratch.

---

## 11. Benchmark design

Benchmark integrity is a first-class feature.

### 11.1 Benchmark partitions
Every campaign benchmark must define:
- `sanity_set`: tiny examples for parser/template checks
- `dev_small`: fast screening set
- `dev_full`: main comparison set
- `test_frozen`: final confirmation set

### 11.2 Guardrail metrics
In addition to the primary metric, Autotrain tracks:
- output validity rate
- formatting compliance
- latency / tokens per second where relevant
- refusal or null-output rates where relevant
- task-specific guardrails

### 11.3 Noise-aware comparison
Autotrain must not treat every 1–2% change as signal.

Minimum rules:
- define an acceptance threshold for champion replacement
- use confirmatory evaluation when the challenger margin is within a gray zone
- record confidence level or judgment strength in the experiment log

### 11.4 Stable slices
Train, dev, and test slices must be deterministically frozen and versioned. No experiment may implicitly alter the eval slice.

---

## 12. Scheduler and budget policy

The scheduler is intentionally simple.

### 12.1 Default resource policy
- 1 CPU prep slot
- 2 GPU screen slots
- 1 GPU full-train slot
- max 4 active jobs by default

### 12.2 Budget stages
Each candidate moves through these stages:
1. prep
2. smoke
3. screen
4. extended screen (optional)
5. full

### 12.3 Promotion strategy
Use a simple successive-halving style policy:
- many smoke candidates
- fewer screen candidates
- very few full runs

### 12.4 Early cancel policy
Cancel a run when:
- smoke fails
- parser/output validity is below threshold
- benchmark score is clearly below the champion or below a kill threshold
- throughput or resource usage indicates a broken pipeline
- projected cost exceeds budget cap with low upside
- the run stalls or is platform-canceled

### 12.5 Cost awareness
Before every GPU submission, Autotrain must estimate:
- expected wall-clock duration
- estimated cost
- remaining campaign budget
- whether this run is allowed under policy

A campaign should never burn credits blindly.

---

## 13. HF-only architecture

Autotrain 2 is built around a small set of components.

### 13.1 Orchestrator
The central agent loop. Responsible for:
- reading campaign state
- deciding next actions
- dispatching jobs
- comparing candidates
- updating memory and logs

### 13.2 Benchmark manager
Creates and validates `benchmark.json`. Ensures the benchmark stays frozen.

### 13.3 Scout
Finds candidate datasets, models, and related artifacts. Adds ideas to the queue.

### 13.4 Data prep runner
Launches CPU prep jobs and versioned prepared datasets.

### 13.5 Recipe library
Contains stable recipe templates and their searchable knobs.

### 13.6 HF job controller
Submits, checks, tails, and cancels HF Jobs. This is the only compute interface.

### 13.7 Evaluator
Parses metrics, validates outputs, and applies benchmark rules.

### 13.8 Scheduler
Allocates concurrency and budget across candidates.

### 13.9 Artifact manager
Stores configs, metrics, summaries, and winner artifacts.

### 13.10 Harness policy layer
Stores reusable heuristics and optional harness-evolution patches.

---

## 14. Campaign state model

All campaign state must be persisted to disk in both human-readable and machine-readable form.

### 14.1 Human-readable files
- `autotrain.md` — living session memory
- `autotrain.ideas.md` — backlog of ideas and hypotheses
- `summary.md` — current champion and campaign status

### 14.2 Machine-readable files
- `campaign.json` — objective, budget, constraints, status
- `benchmark.json` — frozen benchmark contract
- `leaderboard.json` — ordered candidate results
- `jobs.jsonl` — append-only job status history
- `experiments.jsonl` — append-only experiment log
- `artifacts.json` — model, dataset, and report locations

### 14.3 Per-run directory
Each experiment gets:
- `runs/EXP-###/config.json`
- `runs/EXP-###/metrics.json`
- `runs/EXP-###/summary.md`
- `runs/EXP-###/logs/`
- `runs/EXP-###/artifacts.json`

This state model is designed for resumption and auditability.

---

## 15. Tool/API surface

The old model of `init_experiment`, `run_experiment`, `log_experiment` is too narrow because the blocking run primitive is the main architectural flaw.

Autotrain 2 should expose a minimal but better tool surface.

### 15.1 Required tools

#### `init_campaign`
Creates campaign directory, campaign spec, and initial benchmark draft.

Input:
- objective
- task type
- budget cap
- time cap
- constraints

Output:
- campaign ID
- campaign path
- initial status

#### `prepare_data`
Creates or updates prepared dataset artifacts.

Input:
- campaign ID
- source dataset refs
- transform spec
- split spec
- recipe family

Output:
- prep job ID
- prepared dataset artifact ref

#### `submit_job`
Submits a detached HF Job for a specific stage.

Input:
- campaign ID
- stage (`prep`, `smoke`, `screen`, `full`)
- recipe family
- config ref or inline config
- hardware flavor
- timeout
- labels / parent experiment ID

Output:
- job ID
- experiment ID
- stage
- estimated cost

#### `check_jobs`
Returns status, logs tail, parsed metrics, and resource signals for active jobs.

Input:
- campaign ID or job IDs

Output:
- job statuses
- metric updates
- log tails
- health signals
- cancel recommendations

#### `cancel_job`
Cancels a detached HF Job.

Input:
- job ID
- reason

Output:
- final status

#### `log_decision`
Appends an experiment decision to persistent history.

Input:
- campaign ID
- experiment ID
- status (`keep`, `discard`, `promote`, `cancel`, `champion`)
- reason
- evidence
- confidence
- cost

Output:
- log record ID

### 15.2 Optional tools
- `scout_assets`
- `package_winner`
- `resume_campaign`
- `run_harness_eval`

The core should remain small.

---

## 16. Decision policy

### 16.1 Search order
Autotrain should explore in this order unless the benchmark strongly suggests otherwise:
1. benchmark integrity and task framing
2. data quality and split quality
3. prompt / output format
4. base model family
5. recipe family and masking strategy
6. architecture-level knobs available inside the recipe
7. hyperparameters

This preserves the good discipline seen in the current system while preventing random thrashing.

### 16.2 Champion policy
A model becomes champion only if it:
- passes required guardrails
- beats the current champion by the benchmark acceptance rule
- uses a valid and reproducible artifact path
- has complete run metadata

### 16.3 Tie-break policy
When metrics are too close:
- prefer the cheaper run if quality is statistically indistinguishable
- otherwise schedule confirmatory evaluation
- only then promote or reject

### 16.4 Dead-end tracking
Every failed idea must be written down with:
- what was tried
- why it failed
- whether the failure is likely general or task-specific

This memory should shape future search.

---

## 17. Harness evolution policy

This is how Autotrain becomes self-improving without becoming dangerous.

### 17.1 Purpose
Use the same analyze → patch → eval → keep/rollback pattern on the harness itself.

### 17.2 Allowed patch targets
- recipe defaults
- smoke tests
- scheduler constants
- logging cadence defaults
- cancellation thresholds
- scouting heuristics
- parser robustness and reporting

### 17.3 Disallowed patch targets during live campaigns
- benchmark.json semantics
- frozen split generation after campaign freeze
- acceptance threshold semantics
- primary metric definition
- evaluation parser meaning

### 17.4 Execution model
Harness evolution should run on a separate meta-eval suite, not directly on a live user campaign.

### 17.5 Acceptance rule
A harness patch is kept only if it improves meta-metrics such as:
- time to first valid result
- smoke-test pass rate
- wasted GPU spend
- false-win rate
- useful experiments per day
- campaign recovery reliability

This feature can ship after the HF-only async core, but the PRD reserves the architecture for it.

---

## 18. Frontend / gateway contract

The OpenClaw failure demonstrated that a frontend cannot be trusted to “kind of do the right thing.”

### 18.1 Frontend role
The frontend is a transport and status surface, not the trainer.

### 18.2 Start-of-campaign proof
A campaign is only considered started when all of these exist:
- campaign directory
- `campaign.json`
- `benchmark.json`
- at least one real HF Job ID or explicit `no-job-yet` planning state

### 18.3 Completion proof
A campaign is only considered completed when all of these exist:
- winning experiment ID
- artifact ref for the winning model
- final metrics file
- summary report

No frontend may claim success without proof.

---

## 19. UX and reporting

Autotrain’s outputs should be easy to inspect by humans.

### 19.1 Campaign summary should always answer
- what is the current champion?
- what metric is it winning on?
- how much budget has been spent?
- what jobs are running right now?
- what ideas were rejected and why?
- what is the next planned action?

### 19.2 Status updates
Status messages should be event-based, not spammy. Examples:
- benchmark frozen
- dataset prep finished
- smoke candidate failed parser validity
- screen candidate promoted
- full run canceled due to low projected upside
- new champion selected

### 19.3 Final report
Every campaign should produce a concise final report containing:
- objective
- benchmark definition
- best config
- best metrics
- budget used
- key failed hypotheses
- deployment / artifact refs
- recommended next experiments

---

## 20. Success metrics

### 20.1 Product KPIs
- useful experiments per day
- useful experiments per dollar
- time to first valid signal
- percentage of GPU spend wasted on crashes or dead-on-arrival runs
- false-win rate
- campaign resume success rate
- percentage of full runs that came from promoted screens

### 20.2 Target improvements versus current system
- 5–10x more screening runs per day
- >80% reduction in wasted full-budget runs
- <10 minutes to first smoke signal on healthy campaigns
- <10% false-win rate on close comparisons
- >90% of full runs sourced from promoted candidates instead of raw ideas

These are strong but plausible system-level goals.

---

## 21. Acceptance criteria for V1

Autotrain 2 V1 is done when all of the following are true:

1. A campaign can be created from a task description.
2. The system creates a frozen benchmark contract before full training.
3. The system can launch detached HF Jobs for prep, smoke, screen, and full stages.
4. The orchestrator can continue planning and monitoring while jobs run.
5. The system can cancel low-value jobs automatically.
6. The system uses recipe-first training for at least `text_sft` and `vlm_sft`.
7. All experiments are logged with metrics, cost, and decisions.
8. A campaign can be resumed after interruption from saved state.
9. A final winner can be packaged with artifact refs and a report.
10. The system never reports completion without proof artifacts.

---

## 22. Implementation plan

### Milestone 1 — HF-only async core
Deliver:
- HF job controller
- `init_campaign`, `submit_job`, `check_jobs`, `cancel_job`, `log_decision`
- campaign state files
- detached monitoring loop

Success condition:
- no more blocking `run_experiment` architecture

### Milestone 2 — Benchmark and promotion layer
Deliver:
- benchmark contract
- smoke tests
- screening vs full budget stages
- champion/challenger policy
- cost estimation and cancellation rules

Success condition:
- campaign decisions are benchmarked, not ad hoc

### Milestone 3 — Recipe library
Deliver:
- `text_sft`
- `vlm_sft`
- stable config schemas
- artifact packaging

Success condition:
- most campaigns run without bespoke training-script invention

### Milestone 4 — Scout and memory
Deliver:
- asset scouting
- dead-end memory
- reusable heuristics across campaigns

Success condition:
- the system improves search quality over time

### Milestone 5 — Harness evolution (bounded)
Deliver:
- meta-eval suite
- harness patch proposal flow
- keep/rollback for harness changes

Success condition:
- the trainer can improve itself without touching the live judge

---

## 23. Key design choices and rationale

### Why HF-only?
Because simplicity is a feature. Removing other compute backends removes branching complexity, reduces debugging surface area, and aligns the whole system around one async control plane.

### Why recipe-first?
Because the biggest current problems are not lack of creativity; they are lack of reliability, benchmark integrity, and throughput. Stable recipes solve more real problems than freeform codegen.

### Why mandatory smoke tests?
Because expensive runs should be earned. The current system wastes hours discovering problems that should take minutes to reveal.

### Why frozen benchmark contracts?
Because a self-modifying trainer without a frozen judge will optimize for self-deception.

### Why two loops?
Because the target model is not the only thing worth optimizing. The trainer itself should improve too, but on a separate rail.

---

## 24. Final product definition

Autotrain 2 is:
- an autonomous fine-tuning campaign manager
- specialized for HF-native training workflows
- benchmark-first, recipe-first, async-first
- capable of screening, promoting, monitoring, and canceling runs
- able to keep working while jobs are active
- designed to improve its harness without corrupting its judge

It is **not**:
- a generic research loop
- a blocking shell wrapper around one training job
- a hallucinated “subagent did the training” frontend trick
- a platform abstraction layer for every compute backend on earth

---

## 25. One-sentence operating model

> **Autotrain 2 continuously manages a benchmarked training campaign on HF Jobs: prepare cheaply, smoke fast, screen in parallel, promote carefully, cancel aggressively, confirm wins, and remember what worked.**

