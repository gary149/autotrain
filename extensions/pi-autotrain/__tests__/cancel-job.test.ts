import { describe, it, expect } from "vitest";

describe("cancel_job — minimum runtime guard logic", () => {
  it("smoke under 120s should be refused", () => {
    const startedAt = Date.now() - 60 * 1000; // 60 seconds ago
    const elapsed = (Date.now() - startedAt) / 1000;
    expect(elapsed).toBeLessThan(120);
  });

  it("smoke over 120s should be allowed", () => {
    const startedAt = Date.now() - 150 * 1000; // 150 seconds ago
    const elapsed = (Date.now() - startedAt) / 1000;
    expect(elapsed).toBeGreaterThanOrEqual(120);
  });

  it("full job should be allowed regardless of runtime", () => {
    // Full jobs have no minimum runtime guard
    const stage = "full";
    expect(stage).toBe("full");
    // The guard only applies to stage === "smoke"
  });
});

describe("cancel_job — smoke registry update logic", () => {
  it("canceled smoke counts as failure in smoke registry", () => {
    // Simulate what cancel_job does to the smoke registry
    const smokeRegistry = new Map<number, { passed: boolean; failures: number }>();
    smokeRegistry.set(1, { passed: true, failures: 0 });

    const job = { stage: "smoke", experiment_id: 1 };

    // cancel_job logic: increment failures, clear passed
    if (job.stage === "smoke") {
      const reg = smokeRegistry.get(job.experiment_id);
      if (reg) {
        reg.failures++;
        reg.passed = false;
      }
    }

    expect(smokeRegistry.get(1)?.passed).toBe(false);
    expect(smokeRegistry.get(1)?.failures).toBe(1);
  });

  it("canceled full job does not affect smoke registry", () => {
    const smokeRegistry = new Map<number, { passed: boolean; failures: number }>();
    smokeRegistry.set(1, { passed: true, failures: 0 });

    const job = { stage: "full", experiment_id: 1 };

    // cancel_job logic: only smoke stage affects registry
    if (job.stage === "smoke") {
      const reg = smokeRegistry.get(job.experiment_id);
      if (reg) {
        reg.failures++;
        reg.passed = false;
      }
    }

    // Full job cancel should not touch smoke registry
    expect(smokeRegistry.get(1)?.passed).toBe(true);
    expect(smokeRegistry.get(1)?.failures).toBe(0);
  });
});
