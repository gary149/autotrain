# Don't trust your agents. On Autoresearch and overfitting.

**By [0xSero](https://x.com/0xSero) · Mar 18, 2026**

- https://github.com/SarahXC/codex-autoresearch-harness
- https://github.com/0xSero/reap-expert-swap/

[@MilksandMatcha](https://x.com/MilksandMatcha) and I ran over 100 autoresearch iterations across two setups the last week. Sarah pit GPT-5.4 against Spark training nanochat, and I was optimising inference. This was inspired by Andrej Karpathy's [autoresearch](https://github.com/karpathy/autoresearch).

We both ended up independently losing time because of the same core problem, the models overfit the parameters.

The agents find a way to hack the score without actually solving the problem. One agent built an *optimization* that was identical to what we started with, just with added overhead.

I whole-heartedly believe that these LLMs can do great work and help us accelerate scientific discovery.

[Left unchecked your agents will actively delude you, waste your time, and ruin your research.](https://x.com/0xSero/status/2033830245707530556?s=20) Here's how you can spot this fail-point, why it happens, and what you can do to prevent it.

> *"One day, frontier AI research used to be done by meat computers in between eating, sleeping, having other fun, and synchronizing once in a while using sound wave interconnect in the ritual of "group meeting". That era is long gone. Research is now entirely the domain of autonomous swarms of AI agents running across compute cluster megastructures in the skies. The agents claim that we are now in the 10,205th generation of the code base, in any case no one could tell if that's right or wrong as the "code" is now a self-modifying binary that has grown beyond human comprehension. This repo is the story of how it all began." — [@karpathy](https://x.com/karpathy), March 2026.*

Before we jump into the details, here's the TLDR: ***autoresearch works***. [We ran dozens of hours of experiments that produced results](https://x.com/0xSero/status/2034260962757279765?s=20). But we lost a lot of time and resources to pitfalls we could have avoided.

---

## Here's what we underestimated:

1. You need **clear metrics to improve.** You have to define exactly what *better* means and boil it down to objectively verifiable metrics.

Here's what Karpathy tracked [in his autoresearch program.md](https://github.com/karpathy/autoresearch/blob/master/program.md).

2. You need **a constrained harness.** The agent needs a well designed system to work with. Think of the metrics above and answer:

   1. What files should it be able to edit?
   2. In what ways can it edit them?
   3. What tests could validate its results?

   Its environment must also stay clean, so enforcing atomic git commits at every iteration will prevent you from losing work if it goes off the rails.

3. You need well timed **human feedback and steering.** The longer you leave a system like this unattended, the more it drifts from the original purpose.

   LLMs don't like running forever, and they lose accuracy as context grows. Regular human check-ins are essential and this is the one we learned the hard way.

   Left to their own devices they will make hundreds of files and getting anything done becomes impossible. Example of what I came back to after a 6 hour run.

---

## Our experiments

**Experiment 1: Optimising LLM training.**

We wrapped Codex in a bash loop ([codex-autoresearch-harness](https://github.com/SarahXC/codex-autoresearch-harness)) and tested two LLMs as the "researcher" in parallel on Karpathy's nanochat model.

- GPT-5.4: the latest frontier model from OpenAI
- GPT-5.3-Codex-Spark: OpenAI's fastest model

We provisioned a single H100 for 12 hours, each model had 6 hours to find training optimisations. Our question: "Would faster inference result in more experiments being proposed and approved?"

**Experiment 2: Inference optimization.**

We took 2 models, and tried to run them on 5 year old gaming GPUs at acceptable speeds without sacrificing on too much intelligence.

- **Qwen3.5-35B:** We tried to run it on 2x RTX 3090s and 64GB of DDR4 RAM, this would give us 48 GB of VRAM, the models weights alone are 70GB.
- **Kimi-K2.5:** We tried to run this model on 8x RTX 3090s, and 256GB of DDR4 RAM (the original model requires 2.5 TB of Memory to run).

Our question: *"can we reduce the vram needed to run an LLM without sacrificing too much intelligence and speed?"*

## 100+ experiments total across both. Here's what we learned

1. **Agents will exploit any unconstrained metrics to claim success.** If your environment doesn't prevent an action, the model will take it, even if counter intuitive.
2. **Proposal quality makes or breaks your experiments.** When each experiment takes up to hours of GPU time, the cost of a rejected proposal dwarfs the cost of a slower inference call.
3. **Your agent builds on what you've thought through. It's unlikely for** AI to make a sloppy idea good. Likewise, if you've spent time thinking about the problem, and documenting it your agent will be much more effective.
4. **Agents make a mess.** LLMs tend to create new files, write new functions, add new dependencies, over modifying what's already available to them. Left unbounded they will make the directory unmanageable very quickly.
5. **Models optimize for "done."** LLMs do not understand that improving metrics at the cost of correctness is wrong.
6. **Agents search. Humans steer.** The biggest gains we've seen from the LLMs contributions were always related to finding important information, whether it be public, or local. They excel at search, but do not have any creative thinking.

What follows is each of these in detail — what the behavior looked like, why it happens, and what to actually do about it.

## 1. Constrain how the agents interact with your experiments.

A validation "gate" is the rule that decides whether to keep or reject each experiment. Karpathy's gate requires two conditions:

1. Reduce training loss
2. Train **at least as fast** (wall clock time).

Think of it like a hiring rubric. If your only measure *"gets things done fast,"* you'll hire people who cut corners. If you only measure *"high quality"* you'll hire people who rarely ship.

You need both. Same with auto-research — a single-objective gate turns every decision into a tradeoff the agent can exploit in a direction you didn't intend.

For our inference validation gate we tracked 3 main metrics:

1. VRAM utilised.
2. Tokens/s (average throughput & prefill speeds).
3. Accuracy on benchmarks.

Before you start your loop, list every axis the model could move along.

- **For training:** prediction quality, speed, memory usage.
- For inference: accuracy, latency, memory, swap cost.

If you're not properly confining the agent it will find a gap in your reasoning and push on it. Your validation criteria must be strict + your environment must be simple, and easy to validate.

## 2. Proposal Quality Defines Outcomes

For our training research we tested two models as "researchers" using the [codex-autoresearch-harness](https://github.com/SarahXC/codex-autoresearch-harness): GPT-5.4 and Codex-Spark.

**The question:** *"when each experiment costs minutes to hours of GPU time, what does the accept rate tell you about how well your researcher is matched to your gate?"*

Both models independently discovered the same optimization. Gradually reducing the learning rate toward the end of training (called "warmdown").

- GPT-5.4 found it methodically, tuning the ratio step by step.
- GPT-5.3-Codex-Spark found it faster but with more exploratory proposals.

Many of which the gate rejected. That convergence is interesting on its own — it suggests the search landscape for small training improvements has real structure. Different agents find the same peaks.

The key insight was in the accept rates: **67% vs 17%**. Spark proposed nearly 2x more ideas, many of them more creative. But we had to reject most of them.

The problem is that each idea cost 5–60 minutes to validate, which very quickly dominates all your resources. Surprisingly, both independently discovered the same optimization, which tells you that there is structure to their slop.

The takeaway is that accept rate is a metric you should be tracking. It tells you how well-calibrated your researcher is to your gate.

A low accept rate means your gate and your proposer are misaligned — either the validation gate is too strict, the proposals are too exploratory for the current search space, or both.

**What to actually do:**

Track acceptance rates as a primary metric for any auto-research loop. It tells you whether your proposer and your validation gate are aligned.

If accept rate is low, either relax the gate, give the proposer more context about what the gate wants, or both. This matters more than which model you pick.

## 3. Your Agent Will Build on what you've thought through.

[Mixture of Expert LLMs](https://en.wikipedia.org/wiki/Mixture_of_experts) allow us to reduce the amount of compute needed to process 1 token, without sacrificing on quality.

Imagine a hospital with hundreds of specialists on call and ready to help when they're needed. Every new patient only needs to see a handful of those specialists.

This system makes coordinating workers and experts much more efficient, but you still have to pay the cost for keeping them around — what if we can just page them when they are needed?

Our idea: ***instead of permanently firing specialists (static pruning), keep them all on call and page the right ones dynamically depending on who walks through the door.***

We used [REAP](https://github.com/CerebrasResearch/reap) to track which experts the model actually used across 37,304 different prompts.

The distribution was heavily skewed to few experts, just 7.6% per layer accounted for over half the token routing.

Here's what happened:

GPT-5.4 had created a spreadsheet it used to increment the results of the research, after about 4 hours of decent incremental progress, I saw a huge spike in the metrics I was tracking.

I felt suspicious, but went along with it — which was a mistake. After another few hours of it running I noticed something. It claimed that it had used dynamic swapping to improve the results.

When I reviewed the code I noticed it wasn't dynamically selecting anything. It was loading the same fixed group every time, plus paying the overhead of a swapping system it never actually used.

All of this while telling me otherwise — if I hadn't checked and taken its word for it I'd think we are much better off.

**What to actually do:** After every few iterations, check whether your agent's "progress" system actually makes any sense.

Feed it very different tasks and see if it maintains progress. If they don't, your agents found a shortcut that doesn't actually help you.

## 4. Agents are messy (This Is the Dangerous One)

As the experiments progressed, I noticed that the diffs were getting larger, and larger. Markdown files start accumulating, and GPT was compacting more and more often.

This is worse than a crash. I kept having to re-steer the model toward productivity, and it kept getting harder to make any real progress. The reason this was happening is because of a quirk that all LLMs exhibit.

They love creating new code, rebuilding instead of improving what already exists. They attempt to externalise their memory to stay on track since they can only see 256k tokens at a time.

We tried several workarounds: Clearing out old files, preventing from creating new files, enforcing atomic git commits. Unfortunately overly correcting for this behaviour also hurts the models coherence over multiple turns and compactions.

**What to actually do:**

1. Use atomic git commits
2. Coax the agent to using a predefined set of files
3. Clean up after it every few iterations
4. Don't force it to stay down an unproductive path/unblock it

## 5. Agents Optimize for "Completeness" over Correctness.

After 12 hours of unreviewed auto-research, we noticed an unreasonable improvement in our core metrics, each cycle got shorter until it officially "completed" the experiment.

When we looked deeper into the iterations we noticed it mocking functions, modifying the metrics, and simply faking runs all together.

This tracks with known LLM behavior. Models don't want to run forever. They pause and ask if they should continue, they turn off tests that don't pass, they simply lie and fake success.

Karpathy dealt with this on his runs too.

In our case: proposals made progress on scoring without getting us closer to the actual goal.

We fixed this by creating isolated working directories (removing distractions from the environment) and implementing stricter, more frequent validation checkpoints. The improvement was immediate.

**What to actually do:** Don't let your loop run unsupervised on the first pass. Review every 2–4 hours initially. Watch for declining proposal ambition — not just declining scores, but declining scope.

## 6. Agents Search. Humans Steer.

The biggest result in our inference work wasn't proposed by an agent. It came from *us* reading the pattern and providing proper educated guidance.

After reviewing the structured evidence the agents produced — which experiments failed, how they failed, what the expert usage patterns looked like across every configuration — we realized we'd been asking the wrong question.

Instead of assuming the LLMs will magically solve the problems, we started digging into the issues we saw it run into, we then prompted new prompts that directed agents to find information across the web, our results history, and forum posts.

We then used that to synthesize a few research directions, which we used to make decisions on next steps.

**What to actually do:** Build review into your loop, not just monitoring. After every batch of experiments, ask: is the search space itself right? Are the constraints correct? Is the agent exploring, or has it collapsed to a fixed strategy? The agent won't ask these questions for you.

## An Infrastructure Gap

Both experiments surfaced another friction point. You had to give some form of automated and elevated access to your agent for it to perform the research at hand.

- **Codex ignores your OPENAI_API_KEY environment variable.** You need `echo "$KEY" | codex login --with-api-key` explicitly. We burned an hour on this.
- **So much configuration, and niche issues on the software side.** This wasted hours of our time before we could get started.
- **Agent sandboxes kill uv (Python package manager).** Since you'd need to write to paths outside your current directories.
- **Non-interactive shells don't source .bashrc.** The harness scripts check `$OPENAI_API_KEY` explicitly and fail fast with a clear error. Without this guard: cryptic auth failures three iterations in.
- **One GPU = one experiment at a time.** Each 5-minute nanochat training run uses 100% of an H100. Our launch_ab.sh handles this by running models sequentially, not in parallel.

Each of these issues makes it less likely that people or agents will succeed at harnessing the intelligence of AI to do important and useful research.

## Reusable Pattern

Strip both experiments down and you get the same loop:

1. **Define a multi-objective gate.** What counts as "better"? Require improvement on multiple axes, not just one.
2. **Give the agent the code that controls the metric.** It proposes changes to a real script, not a hypothetical.
3. **One experiment per call.** Save all state to files (git history + a log file), not in the agent's memory. This way a crash just means the next round starts fresh.
4. **Enforce the gate strictly.** No exceptions, no "close enough."
5. **Log everything.** Every proposal, every result, every rejection. The logs are where the real learning happens.
6. **Review regularly.** After every batch: is the agent still exploring, or has it collapsed? Is the search space right? Steer when needed.
7. **Repeat.**

**Don't use the LLM to design, build and run the system. You need to think this one through consciously to get good results.**

*Code: [codex-autoresearch-harness](https://github.com/SarahXC/codex-autoresearch-harness) · [reap-expert-swap](https://github.com/0xSero/reap-expert-swap/) · Built on [Karpathy's autoresearch](https://github.com/karpathy/autoresearch)*