/**
 * ugcportal's wiring of the bead dashboard (github.com/eiriksf-capgemini/bead-dashboard):
 * package.json's dashboard scripts, .bead-dashboard.json's `command`, the
 * committed .cmux/cmux.json, and scripts/dashboard.sh, the npx wrapper they
 * all go through. The dashboard's own tests live in that repo; these pin
 * what this repo commits, without fetching the package (CI has no access to
 * the private repo).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (f) => readFileSync(path.join(ROOT, f), "utf8");
const WRAPPER = path.join(ROOT, "scripts", "dashboard.sh");
const SPEC_RE = /github:eiriksf-capgemini\/bead-dashboard(#[0-9A-Za-z._-]*)?/g;

const pkg = JSON.parse(read("package.json"));
const config = JSON.parse(read(".bead-dashboard.json"));
const cmux = JSON.parse(read(".cmux/cmux.json"));

describe("the pinned bead-dashboard ref", () => {
  it("every place that runs the dashboard names the same 40-hex commit, through scripts/dashboard.sh", () => {
    const places = {
      "package.json dashboard": pkg.scripts.dashboard,
      "package.json dashboard:workspace": pkg.scripts["dashboard:workspace"],
      ".bead-dashboard.json command": config.command,
      ".cmux/cmux.json": JSON.stringify(cmux),
    };
    const specs = Object.entries(places).flatMap(([where, text]) => {
      const found = [...String(text).matchAll(SPEC_RE)].map((m) => m[0]);
      expect(found.length, `${where} names the package`).toBeGreaterThan(0);
      return found;
    });
    const unique = [...new Set(specs)];
    expect(unique).toHaveLength(1);
    expect(unique[0]).toMatch(/^github:eiriksf-capgemini\/bead-dashboard#[0-9a-f]{40}$/);
    const command = `sh scripts/dashboard.sh ${unique[0]}`;
    expect(config.command).toBe(command);
    expect(pkg.scripts.dashboard).toBe(`${command} --watch 30 --open --sidebar`);
    expect(pkg.scripts["dashboard:workspace"]).toBe(`${command} --workspace`);
  });
});

describe(".cmux/cmux.json", () => {
  // The file is `--print-cmux-config` output for .bead-dashboard.json. This
  // checks the parts that output is made of without running the package:
  // names from the config, the placeholder URL, and a Refresh pane that runs
  // the config's command for the render, the URL and the watch loop.
  it("is the dashboard layout for this repo's config", () => {
    const action = cmux.actions?.[config.cmuxAction];
    expect(action).toMatchObject({ type: "workspaceCommand", commandName: config.cmuxWorkspace });
    const cmd = cmux.commands.find((c) => c.name === config.cmuxWorkspace);
    expect(cmd?.workspace?.name).toBe(config.cmuxWorkspace);
    const layout = cmd.workspace.layout;
    expect(layout.children[0].pane.surfaces[0]).toEqual({ type: "browser", name: "Dashboard", url: "file://DASHBOARD_HTML" });
    expect(layout.children[1].children[0].pane.surfaces[0]).toMatchObject({ type: "terminal", name: "Claude", command: "claude" });
    const refresh = layout.children[1].children[1].pane.surfaces[0];
    expect(refresh).toMatchObject({ type: "terminal", name: "Refresh" });
    const c = config.command;
    const parts = [`then ${c};`, `U="$(${c} --print-url)"`, 'navigate "$U"', `${c} --watch 30 --sidebar;`, "exec ${SHELL:-/bin/zsh} -l"];
    let at = 0;
    for (const part of parts) {
      const i = refresh.command.indexOf(part, at);
      expect(i, `Refresh command has ${JSON.stringify(part)} after position ${at}`).toBeGreaterThanOrEqual(0);
      at = i + part.length;
    }
    // The nvm fallback comes first and fails loudly; stderr is never dropped.
    expect(refresh.command.startsWith("if command -v npx >/dev/null || {")).toBe(true);
    expect(refresh.command).toContain('[ -d "$newest" ]');
    expect(refresh.command).not.toMatch(/2>\s*\/dev\/null|2>&1|&>/);
  });
});

describe("scripts/dashboard.sh", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  // A git spec on a host that does not resolve, with ssh replaced by false:
  // the fetch fails with git's 128 without touching the network.
  const SPEC = `git+ssh://git@example.invalid/bead-dashboard.git#${SHA}`;
  const NODE_BIN = path.dirname(process.execPath);
  const run = (args, { cache, home, pathDirs }) =>
    spawnSync("/bin/sh", [WRAPPER, ...args], {
      encoding: "utf8",
      env: { PATH: pathDirs.join(":"), HOME: home, GIT_SSH_COMMAND: "/usr/bin/false", npm_config_cache: cache, npm_config_update_notifier: "false" },
      timeout: 120_000,
    });

  it("a failed fetch with nothing cached prints one named line and exits 128, not silently", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ugc-dash-"));
    const r = run([SPEC, "--print-url"], { cache: path.join(dir, "cache"), home: dir, pathDirs: [NODE_BIN, "/usr/bin", "/bin"] });
    expect(r.status).toBe(128);
    expect(r.stderr).toContain(`bead-dashboard: could not fetch ${SPEC} (exit 128); check ssh/gh access or network`);
    expect(r.stdout).toBe("");
  });

  it("a failed fetch runs the already-fetched copy of the same commit from npm's npx cache", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ugc-dash-"));
    const cache = path.join(dir, "cache");
    const nm = path.join(cache, "_npx", "feedface", "node_modules");
    mkdirSync(path.join(nm, ".bin"), { recursive: true });
    const lock = (sha) => JSON.stringify({ packages: { "node_modules/@eiriksf-capgemini/bead-dashboard": { resolved: `git+ssh://git@github.com/eiriksf-capgemini/bead-dashboard.git#${sha}` } } });
    writeFileSync(path.join(nm, ".package-lock.json"), lock(SHA));
    writeFileSync(path.join(nm, ".bin", "bead-dashboard"), '#!/bin/sh\necho "cached copy: $*"\n', { mode: 0o755 });
    const r = run([SPEC, "--print-url"], { cache, home: dir, pathDirs: [NODE_BIN, "/usr/bin", "/bin"] });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("cached copy: --print-url\n");
    expect(r.stderr).toContain(`running the copy of ${SHA} already in npm's cache`);
    // A cached copy of another commit is not a substitute.
    writeFileSync(path.join(nm, ".package-lock.json"), lock("f".repeat(40)));
    const other = run([SPEC, "--print-url"], { cache, home: dir, pathDirs: [NODE_BIN, "/usr/bin", "/bin"] });
    expect(other.status).toBe(128);
    expect(other.stdout).toBe("");
  });

  it("with no npx and no nvm install it names the problem and exits 127", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ugc-dash-"));
    // `command -v` exits 1 (bash) or 127 (dash) when nothing is found; either way, not 0.
    expect(spawnSync("/bin/sh", ["-c", "command -v npx"], { env: { PATH: "/usr/bin:/bin" } }).status).not.toBe(0);
    const r = run([SPEC], { cache: path.join(dir, "cache"), home: dir, pathDirs: ["/usr/bin", "/bin"] });
    expect(r.status).toBe(127);
    expect(r.stderr).toMatch(/^bead-dashboard: npx is not on PATH and no nvm install was found under /);
    // One line, and nothing ran after it (no "npx: not found" from a PATH holding a literal glob).
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
  });
});
