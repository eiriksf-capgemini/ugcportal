import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ugcportal-6uxr K3: playwright.config.ts's `webServer.reuseExistingServer`
 * used to be `true` unconditionally, which lets this suite silently attach
 * to a FOREIGN dev server already listening on port 3000 (a different
 * worktree, a different branch) when several agents run e2e concurrently on
 * one machine — producing spurious mass failures with nothing pointing at
 * the real cause. Gated behind `UGCPORTAL_E2E_REUSE_SERVER` instead, default
 * closed (always start this config's own server) so that failure mode needs
 * an explicit opt-in to happen at all.
 *
 * The config module reads `process.env` once, at import time (that's how
 * Playwright's own `defineConfig` works - a plain object, not a function of
 * the environment at run time), so each case here sets the variable, calls
 * `vi.resetModules()` to drop vitest's cached copy of the config module, and
 * only then re-`import()`s it - confirmed empirically: without the reset,
 * the second `import()` of the same specifier resolves to the first case's
 * already-evaluated module and every case after the first would silently
 * see the FIRST case's result instead of re-reading the environment.
 */
const ENV_VAR = "UGCPORTAL_E2E_REUSE_SERVER";
const originalValue = process.env[ENV_VAR];

afterEach(() => {
  if (originalValue === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = originalValue;
});

async function loadReuseExistingServer(): Promise<unknown> {
  vi.resetModules();
  const mod = (await import("./playwright.config")) as {
    default: { webServer?: { reuseExistingServer?: unknown } | Array<{ reuseExistingServer?: unknown }> };
  };
  const { webServer } = mod.default;
  const server = Array.isArray(webServer) ? webServer[0] : webServer;
  return server?.reuseExistingServer;
}

describe("playwright.config.ts: reuseExistingServer gate (ugcportal-6uxr K3)", () => {
  it("defaults to false (always starts its own server) when the flag is unset", async () => {
    delete process.env[ENV_VAR];
    expect(await loadReuseExistingServer()).toBe(false);
  });

  it('MUTATION CHECK: reuses an existing server when the flag is exactly "1"', async () => {
    process.env[ENV_VAR] = "1";
    expect(await loadReuseExistingServer()).toBe(true);
  });

  it("stays false for any other value, not just when unset (fail-closed, not merely default-closed)", async () => {
    process.env[ENV_VAR] = "true";
    expect(await loadReuseExistingServer()).toBe(false);
  });
});
