import { describe, it, expect } from "vitest";
import { hashCommand, hashWorkspace } from "../index.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("hashCommand", () => {
  it("returns 64-char hex string", () => {
    const hash = hashCommand("./autotrain.sh");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const a = hashCommand("./autotrain.sh");
    const b = hashCommand("./autotrain.sh");
    expect(a).toBe(b);
  });

  it("different inputs produce different hashes", () => {
    const a = hashCommand("./autotrain.sh");
    const b = hashCommand("./other.sh");
    expect(a).not.toBe(b);
  });
});

describe("hashWorkspace", () => {
  it("includes file contents in hash", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-test-"));
    fs.writeFileSync(path.join(dir, "autotrain.sh"), "echo hello");
    const h1 = hashWorkspace(dir, "./autotrain.sh");
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    // Hash should differ from command-only hash
    const cmdOnly = hashCommand("./autotrain.sh");
    expect(h1).not.toBe(cmdOnly);
    fs.rmSync(dir, { recursive: true });
  });

  it("different file contents produce different hashes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-test-"));
    fs.writeFileSync(path.join(dir, "train.py"), "v1");
    const h1 = hashWorkspace(dir, "./autotrain.sh");
    fs.writeFileSync(path.join(dir, "train.py"), "v2");
    const h2 = hashWorkspace(dir, "./autotrain.sh");
    expect(h1).not.toBe(h2);
    fs.rmSync(dir, { recursive: true });
  });

  it("missing files don't break hashing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-test-"));
    // No training files at all — should still return a valid hash
    const h = hashWorkspace(dir, "./autotrain.sh");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Should equal hashCommand since no files exist
    expect(h).toBe(hashCommand("./autotrain.sh"));
    fs.rmSync(dir, { recursive: true });
  });
});
