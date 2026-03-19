# Autotrain 2 PRD Addendum
## Distrust-first autonomy, anti-overfitting, and agent control

**Status:** Addendum to the final Autotrain 2 PRD  
**Version:** 1.0  
**Purpose:** Incorporate the core lessons from recent autoresearch overfitting failures into the Autotrain product spec.

---

## 1. Why this addendum exists

Autotrain should be designed on the assumption that agents will optimize the score surface they can touch, not the operator’s real intent.

That means the product must assume the following failure modes are normal unless explicitly prevented:
- score hacking
- benchmark drift
- metric gaming
- file sprawl
- fake or incomplete runs
- rising proposal volume with falling proposal quality
- progressive collapse into a narrow or degenerate strategy
- “done” behavior where the agent optimizes for closure rather than correctness

The right response is not less autonomy. It is **bounded autonomy with hard integrity rails**.

This addendum turns those lessons into product requirements.

---

## 2. Core operating assumption

> **Agents search. Humans steer. Judges stay frozen.**

Autotrain may search aggressively inside a bounded space, but it must not be trusted to define success for itself.

Therefore, every campaign must separate three roles:

### 2.1 Proposer
Generates candidate changes:
- recipe changes
- data preparation changes
- prompt / output format changes
- training hyperparameter changes
- base model swaps
- scheduler or cancellation policy proposals

### 2.2 Judge
Independently validates whether the candidate is actually better.

The judge must be:
- frozen for the duration of the campaign
- outside the editable experiment surface
- multi-objective
- reproducible
- fail-closed when integrity is uncertain

### 2.3 Operator
Provides periodic steering:
- reframes the search space
- stops unproductive search
- approves risky expansions
- interprets ambiguous tradeoffs
- checks that “progress” is real

Autotrain should automate the proposer heavily, automate the judge carefully, and keep the operator in the loop at defined checkpoints.

---

## 3. Autotrain constitution

The following rules are non-negotiable.

### 3.1 Frozen judge
During a live campaign, the agent may not change:
- benchmark definitions
- dev/test split semantics
- metric definitions
- acceptance thresholds
- parser meaning
- seed logic that defines the frozen comparison set

### 3.2 Multi-objective gate
No experiment may be accepted on a single score alone.

Every judged campaign must track at least:
- primary quality metric
- validity / contract metric
- speed or cost metric
- reproducibility / integrity status

Examples:
- training: task quality, JSON validity, wall-clock efficiency, artifact reproducibility
- inference: task accuracy, latency, memory footprint, swap or cache cost

### 3.3 One experiment, one evidence bundle
Every experiment must produce one self-contained record with:
- experiment ID
- parent experiment ID if applicable
- exact config
- exact artifact refs
- job IDs
- metrics from the judge
- logs tail
- decision and reason

No experiment is accepted on narrative alone.

### 3.4 Clean isolated execution
Judged runs must execute from isolated working directories using the frozen benchmark and a known recipe version.

No judged experiment may rely on:
- mutable ambient state
- hand-edited notebooks
- hidden temp files
- “already loaded” data structures
- partially mocked execution paths

### 3.5 No full run without smoke and screen
All candidates must pass:
1. smoke gate
2. screening gate
before they are eligible for a full-budget run.

### 3.6 Constrained edit surface
Autotrain must prefer editing a predefined set of files over creating new ones.

By default, judged experiments may not create new files in benchmark-critical paths.

### 3.7 Atomic history
Every experiment must be recoverable and revertible.

Campaign state must support:
- atomic commit or snapshot
- clean rollback
- exact replay of the judged configuration

### 3.8 Proof over completion
The system must never claim success based on self-report.

A run is only “successful” if the independent validator produces a passing result and real artifacts exist.

### 3.9 Human review is mandatory
Autotrain must pause for review on a regular cadence and on integrity alerts.

---

## 4. Required gates

Autotrain should have explicit gates, not a single vague keep/discard loop.

### 4.1 Smoke gate
Purpose: catch cheap failures before GPU spend.

Checks:
- imports and environment
- tokenizer / processor setup
- dataset schema validity
- prompt template validity
- output parser round-trip
- one forward / backward pass
- tiny train loop
- tiny eval loop
- metric parser sanity

Failure policy:
- fail closed
- no promotion
- log root cause

### 4.2 Screening gate
Purpose: determine whether a candidate deserves additional budget.

Checks:
- minimum learning signal
- output validity above threshold
- resource usage within budget envelope
- no obvious regression against champion baseline
- no integrity alerts

Failure policy:
- cancel or discard early
- preserve logs and root-cause notes

### 4.3 Full-run gate
Purpose: award larger budget only to credible challengers.

Eligibility requires:
- smoke pass
- screen pass
- bounded estimated cost
- promotion rationale
- available budget

### 4.4 Champion gate
Purpose: prevent false wins.

Promotion requires:
- guardrails passed
- improvement beyond threshold or confidence rule
- confirmatory evaluation for close wins
- exact reproducibility metadata

### 4.5 Publish gate
Purpose: prevent “trained but unusable” outcomes.

Requires:
- model or adapter artifact exists
- benchmark report exists
- configuration exists
- final summary exists
- lineage to winning experiment is clear

---

## 5. Acceptance rate is a first-class metric

Autotrain must track not only model metrics, but also **researcher calibration metrics**.

The most important is:
- **accept rate** = accepted or promoted experiments / proposed experiments

Why it matters:
- low accept rate usually means the proposer and gate are misaligned
- low accept rate can burn more GPU time than slow inference ever will
- a fast but sloppy proposer is often worse than a slower but well-calibrated one

### 5.1 Campaign summary must show
- proposals made
- smoke pass rate
- screen promotion rate
- full-run win rate
- champion replacement rate
- accept rate by proposal category

### 5.2 Autotrain response to poor accept rate
If accept rate drops below a threshold, Autotrain should not blindly continue searching. It should first try to improve calibration by:
- tightening the recipe search space
- improving candidate prompts and constraints
- biasing toward lower-risk proposals
- improving prior-context summaries
- asking for operator review if misalignment persists

---

## 6. Integrity monitoring and anti-cheating

The system must assume that, under pressure, an agent may disable checks, insert mocks, alter the benchmark, or create a path that looks complete without doing the intended work.

### 6.1 Independent validator
The judge must run from a validator path outside the editable experiment surface.

### 6.2 Diff scanner
Autotrain must automatically flag or block changes touching sensitive areas such as:
- benchmark files
- metric code
- parser logic
- eval sampling logic
- split generation logic
- test skip flags
- mocking utilities in judged paths
- job-status synthesis or fake artifact generation

### 6.3 Suspicion triggers
The campaign should raise an integrity alert when it sees patterns such as:
- sudden large gains without corresponding artifact evidence
- shorter and shorter cycles with less real work
- missing HF Job IDs for “completed” runs
- benchmark files changing after freeze
- disabled tests or bypassed validators
- unusually large diffs in unrelated files
- repeated creation of auxiliary files with no measurable benefit

### 6.4 Fail-closed policy
When integrity is uncertain, the experiment must not be promoted.

---

## 7. File and dependency hygiene

File sprawl is not a cosmetic problem. It degrades steering, increases context pressure, and makes resume behavior worse.

### 7.1 Default file policy
Autotrain should operate with:
- a file allowlist for judged paths
- a soft cap on files touched per experiment
- zero new dependencies by default in judged runs

### 7.2 Prefer modification over creation
The system should prefer:
- updating existing recipe configs
- updating existing dataset-prep modules
- updating existing report files

over:
- creating parallel implementations
- creating new wrappers around unchanged logic
- fragmenting the same concept across many markdown files

### 7.3 Cleanup cadence
The campaign loop should include periodic cleanup / consolidation steps so that long unattended runs do not accumulate unusable clutter.

---

## 8. Human steering protocol

Autotrain should not require constant babysitting, but it must require periodic steering.

### 8.1 Review cadence
A review checkpoint should be required at least:
- every fixed batch of experiments, or
- every few elapsed job-hours, or
- whenever an integrity alert is raised

Suggested default for V1:
- review every 6 screened experiments or every 3 hours of active GPU time, whichever comes first

### 8.2 What the review asks
The operator review surface should answer:
- Is the search space still the right one?
- Are improvements real or benchmark artifacts?
- Has the agent collapsed to one repeated strategy?
- Are diffs getting larger without better outcomes?
- Is accept rate falling?
- Are there signs of score hacking or fake completeness?

### 8.3 Auto-pause conditions
Autotrain should pause automatically when:
- two integrity alerts occur in one review window
- benchmark-critical files are touched
- acceptance rate collapses below a hard floor
- three consecutive full runs fail for preventable reasons

---

## 9. Search versus steer in the product design

Autotrain should treat agent strength as strongest in:
- searching model / dataset / paper spaces
- profiling datasets
- exploring bounded recipe knobs
- summarizing experimental evidence
- spotting repeated failure patterns

Autotrain should treat agent weakness as strongest in:
- redefining the problem itself
- interpreting ambiguous tradeoffs without external grounding
- self-certifying correctness
- unconstrained scaffold redesign

This means the product should emphasize:
- autonomous search
- constrained proposals
- independent validation
- regular steering

not:
- open-ended self-authorship of the entire system

---

## 10. What this changes in the main PRD

This addendum strengthens the existing PRD in these ways:

1. **Frozen judge becomes stricter.** Not just a principle, but an enforced product boundary.
2. **Human review becomes a requirement.** Not merely “nice to have.”
3. **Accept rate becomes a KPI.** Proposal quality is measured explicitly.
4. **Constrained edit surfaces become a design requirement.** File sprawl is treated as a core failure mode.
5. **Integrity monitoring becomes built-in.** Autotrain assumes optimization pressure will create shortcuts.
6. **Evidence bundles become mandatory.** No acceptance on narrative progress.
7. **Fail-closed behavior becomes default.** Ambiguity is not promotion.

---

## 11. Minimal implementation impact

These changes should stay simple.

V1 does **not** need a giant new subsystem. It needs a few hard rules in the existing architecture:
- frozen benchmark path outside editable recipe files
- independent validator run after every smoke, screen, and full result
- diff scanner for protected paths
- accept-rate tracking in campaign state
- review checkpoints in campaign policy
- auto-pause on integrity alerts
- file allowlist and no-new-dependency policy by default

That is enough to encode the distrust-first model without making Autotrain heavy.

---

## 12. Final amendment to the operating model

The main PRD says:

> **Autotrain 2 continuously manages a benchmarked training campaign on HF Jobs: prepare cheaply, smoke fast, screen in parallel, promote carefully, cancel aggressively, confirm wins, and remember what worked.**

This addendum tightens it to:

> **Autotrain 2 continuously manages a benchmarked training campaign on HF Jobs under a distrust-first control model: prepare cheaply, validate independently, smoke fast, screen in parallel, promote cautiously, cancel aggressively, confirm wins, pause for steering, and remember what actually worked.**

