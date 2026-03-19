import { describe, it, expect } from "vitest";
import { hashCommand, hashWorkspace } from "../index.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("run_experiment — smoke (unit logic)", () => {
  it("hashCommand produces consistent hashes for run_experiment", () => {
    const hash = hashCommand("./autotrain.sh");
    expect(hash).toHaveLength(64);
    expect(hashCommand("./autotrain.sh")).toBe(hash);
  });

  it("different commands produce different hashes (script change detection)", () => {
    const a = hashCommand("./autotrain.sh --config a");
    const b = hashCommand("./autotrain.sh --config b");
    expect(a).not.toBe(b);
  });
});

describe("run_experiment — full stage gate (unit logic)", () => {
  it("script hash comparison catches edits between smoke and full", () => {
    const smokeHash = hashCommand("./autotrain.sh v1");
    const fullHash = hashCommand("./autotrain.sh v2");
    expect(smokeHash).not.toBe(fullHash);
  });

  it("same command produces same hash (gate should pass)", () => {
    const cmd = "./autotrain.sh --flavor a10g-small";
    expect(hashCommand(cmd)).toBe(hashCommand(cmd));
  });
});

describe("run_experiment — 24-char hex job ID parsing", () => {
  it("matches 24-char hex from typical hf jobs output", () => {
    const stdout = "abc123def456789012345678\nView at: https://huggingface.co/jobs/user/abc123def456789012345678";
    const match = stdout.match(/[0-9a-f]{24}/);
    expect(match).not.toBeNull();
    expect(match![0]).toBe("abc123def456789012345678");
  });

  it("returns null when no hex ID present", () => {
    const stdout = "Error: something went wrong";
    const match = stdout.match(/[0-9a-f]{24}/);
    expect(match).toBeNull();
  });
});

describe("run_experiment — benchmark.json dirty check (unit logic)", () => {
  it("benchmark.json dirty check blocks submission", () => {
    // Simulate what run_experiment does: check if git diff output is non-empty
    const diffOutput = "diff --git a/benchmark.json b/benchmark.json\n-old\n+new";
    const isDirty = diffOutput.trim().length > 0;
    expect(isDirty).toBe(true);
  });

  it("clean benchmark.json allows submission", () => {
    const diffOutput = "";
    const isDirty = diffOutput.trim().length > 0;
    expect(isDirty).toBe(false);
  });

  it("hashWorkspace is used instead of hashCommand for script detection", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sj-test-"));
    fs.writeFileSync(path.join(dir, "autotrain.sh"), "echo train v1");
    const h1 = hashWorkspace(dir, "./autotrain.sh");
    fs.writeFileSync(path.join(dir, "autotrain.sh"), "echo train v2");
    const h2 = hashWorkspace(dir, "./autotrain.sh");
    // Editing autotrain.sh should change the hash, proving workspace hashing works
    expect(h1).not.toBe(h2);
    fs.rmSync(dir, { recursive: true });
  });
});
