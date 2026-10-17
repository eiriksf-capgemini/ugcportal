import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the real vitest.config.ts (not just the helper) so deleting the
// maxWorkers line in the config fails here (ugcportal-gdi0, K3).
async function loadMaxWorkers(env: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("VITEST_MAX_FORKS", "");
  vi.stubEnv("VITEST_MAX_THREADS", "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const mod = await import("./vitest.config");
  return (mod.default as { test?: { maxWorkers?: number } }).test?.maxWorkers;
}

describe("vitest.config.ts worker cap", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it("maps VITEST_MAX_FORKS alone", async () => {
    expect(await loadMaxWorkers({ VITEST_MAX_FORKS: "1" })).toBe(1);
  });
  it("maps VITEST_MAX_THREADS alone", async () => {
    expect(await loadMaxWorkers({ VITEST_MAX_THREADS: "2" })).toBe(2);
  });
  it("VITEST_MAX_FORKS wins when both are set", async () => {
    expect(await loadMaxWorkers({ VITEST_MAX_FORKS: "3", VITEST_MAX_THREADS: "1" })).toBe(3);
  });
  it("sets no maxWorkers when neither is set", async () => {
    expect(await loadMaxWorkers({})).toBeUndefined();
  });
  it("treats an empty value as unset, so THREADS still applies", async () => {
    expect(await loadMaxWorkers({ VITEST_MAX_FORKS: "", VITEST_MAX_THREADS: "1" })).toBe(1);
    expect(await loadMaxWorkers({ VITEST_MAX_FORKS: "", VITEST_MAX_THREADS: "" })).toBeUndefined();
  });
  it.each(["abc", "0", "-1", "1.5", "2abc"])("throws naming the variable on %j", async (bad) => {
    await expect(loadMaxWorkers({ VITEST_MAX_FORKS: bad })).rejects.toThrow(/VITEST_MAX_FORKS/);
    await expect(loadMaxWorkers({ VITEST_MAX_THREADS: bad })).rejects.toThrow(/VITEST_MAX_THREADS/);
  });
  it("throws on a bad THREADS even when FORKS is valid", async () => {
    await expect(
      loadMaxWorkers({ VITEST_MAX_FORKS: "1", VITEST_MAX_THREADS: "abc" }),
    ).rejects.toThrow(/VITEST_MAX_THREADS/);
  });
});
