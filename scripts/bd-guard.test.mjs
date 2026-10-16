/**
 * Tests for scripts/bd-guard.mjs (ugcportal-vu49). Every case runs the real CLI
 * with hook JSON on stdin. The blessed-form fixtures are sliced from the three
 * skill files at test time, with a drift check on the line they start at.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "bd-guard.mjs");

function run(stdin) {
  const r = spawnSync(process.execPath, [script], { input: stdin, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const hook = (command) => run(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));

function lines(file, from, to) {
  const all = fs.readFileSync(path.join(root, file), "utf8").split("\n");
  return { first: all[from - 1], text: all.slice(from - 1, to).join("\n") };
}

describe("refuses (K1, K2)", () => {
  it("K1: bd update --notes names --append-notes", () => {
    const r = hook('bd update ugcportal-x --notes "text"');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--append-notes");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stdout).toBe("");
  });
  it("--notes=value form and a chained command", () => {
    expect(hook("bd update x --notes=foo").code).toBe(2);
    expect(hook("cd /tmp && bd update x --notes 'a'").code).toBe(2);
  });
  it("K2: backtick in a double-quoted arg names heredoc / --body-file", () => {
    const r = hook('bd create --description "uses `code` here"');
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/heredoc/);
    expect(r.stderr).toContain("--body-file");
  });
  it("K2: $( not followed by cat <<' in a double-quoted arg", () => {
    const r = hook('bd create --title "see $(whoami)"');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--body-file");
  });
  it("backtick after a blessed heredoc in the same quote is still refused", () => {
    const c = "bd create --title \"$(cat <<'EOF'\nx\nEOF\n) `id`\"";
    expect(hook(c).code).toBe(2);
  });
  it("$(cat <<'EOF' with no terminator is refused", () => {
    expect(hook("bd create --title \"$(cat <<'EOF'\nx\"").code).toBe(2);
  });
});

describe("allows (K2 must-pass, K4)", () => {
  it("K4: --append-notes", () => {
    expect(hook('bd update x --append-notes "text"').code).toBe(0);
  });
  it("K4: --body-file", () => {
    expect(hook("bd create --title t --body-file /tmp/x.md").code).toBe(0);
    expect(hook("bd create --title t --body-file - <<'EOF'\nhas `ticks` and $(x)\nEOF").code).toBe(0);
  });
  it("single-quoted strings with backticks and $(", () => {
    expect(hook("bd create --description 'uses `code` and $(x)'").code).toBe(0);
  });
  it("escaped backtick inside double quotes is literal", () => {
    expect(hook('bd create --description "a \\`b\\` c"').code).toBe(0);
  });
  const blessed = [
    ["cut-release/SKILL.md:230", ".claude/skills/cut-release/SKILL.md", 230, 234],
    ["pr-review-merge/SKILL.md:932", ".claude/skills/pr-review-merge/SKILL.md", 932, 938],
    ["review-standards/SKILL.md:38", ".claude/skills/review-standards/SKILL.md", 38, 44],
  ];
  for (const [label, file, from, to] of blessed) {
    it(`K4: blessed heredoc as used at ${label}`, () => {
      const { first, text } = lines(file, from, to);
      expect(first).toContain("$(cat <<'");
      const r = hook(text);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
    });
  }
});

describe("passes through / fail-open", () => {
  it("non-bd commands are untouched, even with backticks and --notes", () => {
    expect(hook('git commit -m "fix `x` $(y) --notes"').code).toBe(0);
    expect(hook('echo "bd update x --notes"').code).toBe(0);
    expect(hook("ls -la").stdout).toBe("");
  });
  it("a non-bd statement chained to a clean bd one does not refuse", () => {
    expect(hook('git commit -m "`x`" && bd show x').code).toBe(0);
  });
  it("malformed JSON exits 0 with a stderr note", () => {
    const r = run("{not json");
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/fail-open/);
    expect(r.stdout).toBe("");
  });
  it("empty stdin and missing command exit 0", () => {
    expect(run("").code).toBe(0);
    expect(run("{}").code).toBe(0);
  });
});
