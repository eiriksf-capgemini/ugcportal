/**
 * Tests for scripts/bd-guard.mjs (ugcportal-vu49). Every case runs the real CLI
 * with hook JSON on stdin. The blessed-form fixtures are loaded from the three
 * skill files at test time by content anchor (scripts/bd-guard-fixtures.mjs),
 * never by line number.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { OPENER, loadBlessedBlock, loadBlessedLine } from "./bd-guard-fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "bd-guard.mjs");

function run(stdin) {
  const r = spawnSync(process.execPath, [script], { input: stdin, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const hook = (command) => run(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));

const skill = (name) => path.join(root, ".claude", "skills", name, "SKILL.md");
const ACC_ANCHOR = '--acceptance="$(cat "$scratch/acc.md")"';
const BLESSED = [
  ["cut-release", skill("cut-release"), "bd create \"$(cat <<'BD_EOF'"],
  ["pr-review-merge", skill("pr-review-merge"), "Use quoted heredocs (`<<'EOF'`)"],
  ["review-standards", skill("review-standards"), "so use quoted heredocs, which expand nothing"],
];

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

describe("$(cat <path>) allowance", () => {
  it("must-pass: the cut-release acceptance line, found by anchor at test time", () => {
    const line = loadBlessedLine(skill("cut-release"), ACC_ANCHOR);
    expect(line).toContain('$(cat "$scratch/acc.md")');
    const r = hook(`bd create --title t \\\n${line}`);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });
  it("must-pass: single-quoted and bare path", () => {
    expect(hook("bd create --acceptance=\"$(cat '/tmp/a b.md')\"").code).toBe(0);
    expect(hook('bd create --acceptance="$(cat /tmp/acc.md)"').code).toBe(0);
  });
  for (const bad of ['$(cat a b)', '$(cat "$x" | tr x y)', "$(cat $(echo f))", "$(cat `echo f`)"]) {
    it(`must-fail: ${bad}`, () => {
      expect(hook(`bd create --acceptance="${bad}"`).code).toBe(2);
    });
  }
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
  for (const [label, file, anchor] of BLESSED) {
    it(`K4: blessed heredoc as used in ${label}/SKILL.md`, () => {
      const text = loadBlessedBlock(file, anchor);
      expect(text).toContain("$(cat <<'");
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

describe("command-word prefixes (F1): each shape is refused", () => {
  const shapes = {
    "for/do on one line": 'for id in a b; do bd update $id --notes x; done',
    "then": "if true; then bd update x --notes a; fi",
    "else": "if false; then true; else bd update x --notes a; fi",
    "while do": "while read id; do bd update $id --notes a; done",
    "brace group": "{ bd update x --notes a; }",
    "subshell": "(bd update x --notes a)",
    "bang": "! bd update x --notes a",
    "time": "time bd update x --notes a",
    "command": "command bd update x --notes a",
    "env with assignments": "env FOO=1 BAR=2 bd update x --notes a",
    "env with flag": "env -i bd update x --notes a",
    "xargs": "echo x | xargs bd update --notes a",
    "xargs value flag": "echo x | xargs -I {} bd update {} --notes a",
    "absolute path": "/opt/homebrew/bin/bd update x --notes a",
    "relative path": "./bin/bd update x --notes a",
    "VAR=val prefix": "BEADS_ACTOR=me bd update x --notes a",
    "--actor": "bd --actor me update x --notes a",
    "-C": "bd -C /tmp update x --notes a",
    "--db": "bd --db p update x --notes a",
    "--database": "bd --database n update x --notes a",
    "2>&1 does not split": "bd update x 2>&1 --notes a",
    "&> does not split": "bd update x &>out.log --notes a",
  };
  for (const [name, cmd] of Object.entries(shapes)) {
    it(name, () => {
      const r = hook(cmd);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--append-notes");
    });
  }
  it("backtick refusal also follows a keyword prefix", () => {
    expect(hook('for i in a; do bd create --title "`x`"; done').code).toBe(2);
  });
  it("a keyword prefix on a clean bd command, and a global flag, still pass", () => {
    expect(hook("for i in a; do bd update $i --append-notes x; done").code).toBe(0);
    expect(hook("bd --actor me update x --append-notes a").code).toBe(0);
    expect(hook("bd update x 2>&1 | head").code).toBe(0);
  });
});

describe("heredocs (F2, F3)", () => {
  it("quoted heredoc bodies are skipped, in all four quoted forms", () => {
    for (const open of ["<<'EOF'", '<<"EOF"', "<<-'EOF'", '<<-"EOF"']) {
      const r = hook(`bd create --title t --body-file - ${open}\n\`id\` and $(x)\nEOF`);
      expect(r.code, open).toBe(0);
    }
  });
  it("a quoted heredoc body quoting bd commands is not parsed as commands", () => {
    const body = "bd update x --notes y\nbd create \"a `x` b\"\nbd show $(id)";
    expect(hook(`bd create --title t --body-file - <<'EOF'\n${body}\nEOF`).code).toBe(0);
  });
  it("a tab-indented terminator closes a <<- heredoc", () => {
    expect(hook("bd create --body-file - <<-'EOF'\n\t`x`\n\tEOF\nbd show y").code).toBe(0);
    expect(hook("bd create --body-file - <<-'EOF'\n\t`x`\n\tEOF\nbd update y --notes z").code).toBe(2);
  });
  it("commands after a heredoc body are still inspected", () => {
    expect(hook("bd create --body-file - <<'EOF'\nx\nEOF\nbd update y --notes z").code).toBe(2);
  });
  it("an unquoted heredoc body that expands a backtick or $( is refused", () => {
    for (const body of ["`id`", "see $(id)"]) {
      const r = hook(`bd create --title t --body-file - <<EOF\n${body}\nEOF`);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/unquoted heredoc/);
    }
  });
  it("an unquoted heredoc with a plain or escaped body passes", () => {
    expect(hook("bd create --body-file - <<EOF\nplain text\nEOF").code).toBe(0);
    expect(hook("bd create --body-file - <<EOF\nescaped \\`x\\`\nEOF").code).toBe(0);
  });
  it("an unquoted heredoc on a non-bd command is not inspected", () => {
    expect(hook("cat <<EOF\n`id`\nEOF").code).toBe(0);
  });
  it("blessed forms with <<\"EOF\" and <<-'EOF' are allowed", () => {
    expect(hook('bd create --title "$(cat <<"EOF"\nx\nEOF\n)"').code).toBe(0);
    expect(hook("bd create --title \"$(cat <<-'EOF'\n\tx\n\tEOF\n)\"").code).toBe(0);
  });
  it("blessed block whose terminator is not followed by ) is refused", () => {
    expect(hook("bd create --title \"$(cat <<'EOF'\nx\nEOF\n; id)\"").code).toBe(2);
  });
  it("blessed block followed by a backtick after EOF but before ) is refused", () => {
    expect(hook("bd create --title \"$(cat <<'EOF'\nx\nEOF `id`\n)\"").code).toBe(2);
  });
});

describe("comments (F3)", () => {
  it("a comment's quote characters do not hide the next line", () => {
    expect(hook("# don't do this\nbd update x --notes a").code).toBe(2);
  });
  it("backticks and quotes inside a comment are ignored", () => {
    expect(hook('bd show x # see "`x`" and $(y)').code).toBe(0);
    expect(hook("# bd update x --notes y `z`\nls").code).toBe(0);
  });
});

describe("fail-open on parseable JSON without a command string (F5)", () => {
  for (const raw of ["null", "[]", '"str"', '{"tool_input":{}}', '{"tool_input":{"command":5}}']) {
    it(raw, () => {
      const r = run(raw);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    });
  }
});

describe("scripts/bd-guard.sh wrapper (F4)", () => {
  const wrapper = path.join(root, "scripts", "bd-guard.sh");
  const notes = JSON.stringify({ tool_input: { command: "bd update x --notes a" } });
  const sh = (env) => {
    const r = spawnSync("/bin/sh", [wrapper], { input: notes, encoding: "utf8", env });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bdg-"));

  it("finds node on PATH and runs the guard", () => {
    const r = sh({ PATH: path.dirname(process.execPath), HOME: tmp() });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--append-notes");
  });
  it("finds node through the nvm default alias when PATH has none", () => {
    const home = tmp();
    const bin = path.join(home, ".nvm", "versions", "node", "v9.9.9", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
    // A decoy that the any-nvm-version fallback would pick (it sorts last) and that fails.
    const decoy = path.join(home, ".nvm", "versions", "node", "v99.0.0", "bin");
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(decoy, "node"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    fs.mkdirSync(path.join(home, ".nvm", "alias"), { recursive: true });
    fs.writeFileSync(path.join(home, ".nvm", "alias", "default"), "v9.9.9\n");
    const r = sh({ PATH: tmp(), HOME: home, BD_GUARD_FALLBACK_DIRS: tmp() });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--append-notes");
  });
  it("finds node in a fallback dir", () => {
    const dir = tmp();
    fs.symlinkSync(process.execPath, path.join(dir, "node"));
    const r = sh({ PATH: tmp(), HOME: tmp(), BD_GUARD_FALLBACK_DIRS: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--append-notes");
  });
  it("exits 2 with a message when no node is found anywhere", () => {
    const r = sh({ PATH: tmp(), HOME: tmp(), BD_GUARD_FALLBACK_DIRS: tmp() });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no node found/);
    expect(r.stdout).toBe("");
  });
  it("runs when invoked as a bare relative name", () => {
    const r = spawnSync("/bin/sh", ["bd-guard.sh"], {
      cwd: path.join(root, "scripts"),
      input: notes,
      encoding: "utf8",
      env: { PATH: path.dirname(process.execPath), HOME: tmp() },
    });
    expect(r.status).toBe(2);
  });
});

describe("fixture loader (ugcportal-ucnf)", () => {
  const cutRelease = skill("cut-release");
  const [, , cutAnchor] = BLESSED[0];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bd-guard-fx-"));
  const write = (name, text) => {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, text);
    return f;
  };
  const orig = fs.readFileSync(cutRelease, "utf8");

  it("K1: 20 lines prepended leave every loaded fixture byte-identical", () => {
    const shifted = write("shifted.md", "filler line\n".repeat(20) + orig);
    for (const [, file, anchor] of BLESSED) {
      const moved = write(
        `moved-${path.basename(path.dirname(file))}.md`,
        "filler line\n".repeat(20) + fs.readFileSync(file, "utf8"),
      );
      expect(loadBlessedBlock(moved, anchor)).toBe(loadBlessedBlock(file, anchor));
    }
    expect(loadBlessedLine(shifted, ACC_ANCHOR)).toBe(loadBlessedLine(cutRelease, ACC_ANCHOR));
    expect(loadBlessedLine(shifted, ACC_ANCHOR).length).toBeGreaterThan(0);
  });

  it("K2: an absent anchor throws, naming the file and the anchor", () => {
    const f = write("absent.md", orig.split(cutAnchor).join("bd create REMOVED"));
    expect(() => loadBlessedBlock(f, cutAnchor)).toThrow(f);
    expect(() => loadBlessedBlock(f, cutAnchor)).toThrow(JSON.stringify(cutAnchor).slice(0, 20));
    expect(() => loadBlessedBlock(f, cutAnchor)).toThrow(/matched 0 line/);
    const g = write("absent-line.md", "nothing here\n");
    expect(() => loadBlessedLine(g, ACC_ANCHOR)).toThrow(/matched 0 line/);
  });

  it("K2: a duplicated anchor throws, naming the file and the anchor", () => {
    const f = write("dup.md", orig + "\n" + orig);
    expect(() => loadBlessedBlock(f, cutAnchor)).toThrow(f);
    expect(() => loadBlessedBlock(f, cutAnchor)).toThrow(/matched 2 line/);
    expect(() => loadBlessedLine(f, ACC_ANCHOR)).toThrow(/matched 2 line/);
    expect(() => loadBlessedLine(f, ACC_ANCHOR)).toThrow(f);
  });

  it("K2: an anchor with no opener after it, or no terminator, throws", () => {
    const a = write("noopener.md", "anchor here\njust text\n");
    expect(() => loadBlessedBlock(a, "anchor here")).toThrow(/no blessed opener/);
    const b = write("noterm.md", "anchor here\nx \"$(cat <<'EOF'\nbody\n");
    expect(() => loadBlessedBlock(b, "anchor here")).toThrow(/no EOF terminator/);
    const c = write("noparen.md", "anchor here\nx \"$(cat <<'EOF'\nbody\nEOF\nnot a paren\n");
    expect(() => loadBlessedBlock(c, "anchor here")).toThrow(/not followed by a \) line/);
  });

  it("K3: every loaded block starts at a blessed opener and ends terminator then )", () => {
    for (const [label, file, anchor] of BLESSED) {
      const block = loadBlessedBlock(file, anchor).split("\n");
      const m = OPENER.exec(block[0]);
      expect(m, `${label} first line`).not.toBeNull();
      expect(block.length).toBeGreaterThanOrEqual(4);
      expect(block[block.length - 2]).toBe(m[2]);
      expect(block[block.length - 1].startsWith(")")).toBe(true);
      // the terminator is the first line equal to the delimiter: no earlier one
      expect(block.slice(1, -2)).not.toContain(m[2]);
    }
    expect(OPENER.test("x <<-\"EOF\"")).toBe(false);
    expect(OPENER.test('$(cat <<-"EOF"')).toBe(true);
    expect(OPENER.test('$(cat <<"EOF"')).toBe(true);
    expect(OPENER.test("$(cat <<EOF")).toBe(false);
  });
});
