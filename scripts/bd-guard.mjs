#!/usr/bin/env node
/**
 * bd-guard: a Claude Code PreToolUse hook for the Bash tool (ugcportal-vu49).
 *
 * Reads the hook JSON on stdin, inspects `tool_input.command`, and refuses
 * (exit 2, one-line reason on stderr) a `bd` command that makes one of the two
 * mistakes this repo keeps repeating:
 *
 *   (a) `bd update ... --notes`  -- replaces the whole notes field and
 *       destroys its history. Use `--append-notes`.
 *   (b) a double-quoted bd argument containing a backtick, or `$(` that is not
 *       the quoted-heredoc form -- the shell EXECUTES it. Use
 *       `"$(cat <<'EOF' ... EOF)"` or `--body-file`.
 *
 * Allowed: `--append-notes`, `--body-file`, single-quoted strings, heredoc
 * bodies fed on stdin, and the repo's blessed form `"$(cat <<'EOF' ... EOF)"`
 * (cut-release/SKILL.md, pr-review-merge/SKILL.md, review-standards/SKILL.md).
 * Non-bd commands pass through untouched. Only statements whose command word
 * is `bd` are inspected; statements are split on unquoted newline ; & |.
 *
 * FAIL-OPEN, DELIBERATELY: malformed, empty or unreadable stdin exits 0 with a
 * stderr note. A broken guard must not block every Bash call in the session.
 * Nothing is ever written to stdout.
 *
 * Known limit: it is a scanner, not a shell parser. Quoting built by variable
 * expansion or `eval` is not seen. `$(cat "$file")` inside double quotes is
 * refused too (it is not the `cat <<'` form the bead specifies).
 */
import fs from "node:fs";

import { isMainModule } from "./lib/is-main.mjs";

export const MSG_NOTES =
  "bd-guard: refused `bd update --notes`, which replaces the whole notes field and its history; use --append-notes.";
export const MSG_BACKTICK =
  "bd-guard: refused a backtick inside a double-quoted bd argument (the shell executes it); use a quoted heredoc \"$(cat <<'EOF' ... EOF)\" or --body-file.";
export const MSG_SUBST =
  "bd-guard: refused `$(` inside a double-quoted bd argument that is not the quoted-heredoc form; use \"$(cat <<'EOF' ... EOF)\" or --body-file.";

const HEREDOC_OPEN = /^\$\(cat <<'(\w+)'\n/;

/** Scan a double-quoted string starting at cmd[i] === '"'. */
function scanDoubleQuoted(cmd, i) {
  let j = i + 1;
  let problem = null;
  while (j < cmd.length) {
    const c = cmd[j];
    if (c === '"') return { end: j + 1, problem };
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") {
      problem ??= MSG_BACKTICK;
      j += 1;
      continue;
    }
    if (c === "$" && cmd[j + 1] === "(") {
      const m = HEREDOC_OPEN.exec(cmd.slice(j));
      if (m) {
        const close = `\n${m[1]}\n)`;
        const at = cmd.indexOf(close, j + m[0].length - 1);
        if (at !== -1) {
          j = at + close.length;
          continue;
        }
      }
      problem ??= MSG_SUBST;
      j += 2;
      continue;
    }
    j += 1;
  }
  return { end: cmd.length, problem };
}

function skipHeredocBodies(cmd, i, pending) {
  let j = i;
  for (const { tag, dash } of pending) {
    while (j < cmd.length) {
      let nl = cmd.indexOf("\n", j);
      if (nl === -1) nl = cmd.length;
      let line = cmd.slice(j, nl);
      j = Math.min(nl + 1, cmd.length);
      if (dash) line = line.replace(/^\t+/, "");
      if (line === tag) break;
    }
  }
  return j;
}

/** Split into statements: { words, problem }. */
function scanStatements(cmd) {
  const stmts = [];
  let words = [];
  let cur = null;
  let problem = null;
  let pending = [];
  const pushWord = () => {
    if (cur !== null) words.push(cur);
    cur = null;
  };
  const endStmt = () => {
    pushWord();
    if (words.length) stmts.push({ words, problem });
    words = [];
    problem = null;
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "\\") {
      if (cmd[i + 1] === "\n") {
        i += 2;
        continue;
      }
      cur = (cur ?? "") + (cmd[i + 1] ?? "");
      i += 2;
    } else if (c === "'") {
      const e = cmd.indexOf("'", i + 1);
      const stop = e === -1 ? cmd.length : e;
      cur = (cur ?? "") + cmd.slice(i + 1, stop);
      i = stop + 1;
    } else if (c === '"') {
      const r = scanDoubleQuoted(cmd, i);
      problem ??= r.problem;
      cur = cur ?? "";
      i = r.end;
    } else if (c === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/.exec(cmd.slice(i));
      if (m) {
        pending.push({ tag: m[3], dash: m[1] === "-" });
        i += m[0].length;
      } else {
        cur = (cur ?? "") + c;
        i += 1;
      }
    } else if (c === "\n") {
      endStmt();
      i += 1;
      if (pending.length) {
        i = skipHeredocBodies(cmd, i, pending);
        pending = [];
      }
    } else if (c === ";" || c === "&" || c === "|") {
      endStmt();
      i += 1;
    } else if (c === " " || c === "\t") {
      pushWord();
      i += 1;
    } else if (c === "#" && cur === null) {
      const e = cmd.indexOf("\n", i);
      i = e === -1 ? cmd.length : e;
    } else {
      cur = (cur ?? "") + c;
      i += 1;
    }
  }
  endStmt();
  return stmts;
}

/**
 * @param {string} cmd a Bash command line
 * @returns {string | null} the refusal reason, or null to allow
 */
export function analyzeCommand(cmd) {
  for (const { words, problem } of scanStatements(cmd)) {
    const w = words.map((x) => x.replace(/^[({]+/, ""));
    let k = 0;
    while (k < w.length && /^[A-Za-z_]\w*=/.test(w[k])) k += 1;
    if (w[k] !== "bd") continue;
    const rest = w.slice(k + 1);
    const sub = rest.find((x) => !x.startsWith("-"));
    if (sub === "update" && rest.some((x) => x === "--notes" || x.startsWith("--notes="))) {
      return MSG_NOTES;
    }
    if (problem) return problem;
  }
  return null;
}

/**
 * @param {string} raw stdin text
 * @returns {{ code: number, message: string | null }}
 */
export function decide(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return { code: 0, message: "bd-guard: stdin was not valid JSON; allowing (fail-open)." };
  }
  const command = input?.tool_input?.command;
  if (typeof command !== "string") {
    return { code: 0, message: "bd-guard: no tool_input.command in hook JSON; allowing (fail-open)." };
  }
  const reason = analyzeCommand(command);
  return reason ? { code: 2, message: reason } : { code: 0, message: null };
}

if (isMainModule(import.meta.url)) {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  const { code, message } = decide(raw);
  if (message) process.stderr.write(`${message}\n`);
  process.exit(code);
}
