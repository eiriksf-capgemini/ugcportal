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
 * Allowed: `--append-notes`, `--body-file`, single-quoted strings, QUOTED
 * heredoc bodies (`<<'EOF'`, `<<"EOF"`, `<<-'EOF'`, `<<-"EOF"`; the shell does
 * not expand those), and the repo's blessed form `"$(cat <<'EOF' ... EOF)"`
 * (cut-release/SKILL.md, pr-review-merge/SKILL.md, review-standards/SKILL.md).
 * Non-bd commands pass through untouched. Only statements whose command word
 * is `bd` are inspected; statements are split on unquoted newline ; & | (a
 * `&` that is part of `2>&1`, `>&` or `&>` does not split). Prefixes stripped
 * before the command-word test: do then else elif if while until { ( ! time
 * command exec sudo, `env` (and its flags and VAR=val), `xargs` (and its
 * flags), VAR=val, a path ending in `/bd`; bd's own global value flags
 * (--actor -C/--directory --db --database --dolt-auto-commit --mem-profile)
 * are skipped when finding the subcommand.
 *
 * An UNQUOTED heredoc (`<<EOF`) body is expanded by the shell, so a backtick
 * or `$(` in it is refused like one in double quotes.
 *
 * FAIL-OPEN, DELIBERATELY: malformed, empty or unreadable stdin, and parseable
 * JSON whose `tool_input.command` is missing or not a string, exit 0 with a
 * stderr note. A broken guard must not block every Bash call in the session.
 * Nothing is ever written to stdout. (scripts/bd-guard.sh, the hook entry
 * point, is the opposite on purpose: no node found exits 2, so a missing
 * runtime blocks loudly instead of the hook silently never running.)
 *
 * Also allowed inside double quotes: `$(cat <path>)` where the only argument
 * is one path token (double-quoted, single-quoted or bare, `$VAR` fine) with
 * no nested `$(`, backtick, extra word or pipe (cut-release/SKILL.md:235-236).
 * File content is not re-scanned by bash, so reading it is safe. Every other
 * `$(` is refused.
 *
 * Known limit: it is a scanner, not a shell parser. Quoting built by variable
 * expansion or `eval` is not seen.
 */
import fs from "node:fs";

import { isMainModule } from "./lib/is-main.mjs";

export const MSG_NOTES =
  "bd-guard: refused `bd update --notes`, which replaces the whole notes field and its history; use --append-notes.";
export const MSG_BACKTICK =
  "bd-guard: refused a backtick inside a double-quoted bd argument (the shell executes it); use a quoted heredoc \"$(cat <<'EOF' ... EOF)\" or --body-file.";
export const MSG_HEREDOC =
  "bd-guard: refused a backtick or `$(` in an unquoted heredoc body (the shell expands it); quote the delimiter (<<'EOF') or use --body-file.";
export const MSG_SUBST =
  "bd-guard: refused `$(` inside a double-quoted bd argument that is not the quoted-heredoc form; use \"$(cat <<'EOF' ... EOF)\" or --body-file.";

const HEREDOC_OPEN = /^\$\(cat <<(-?)(['"])(\w+)\2\n/;

// $(cat <path>): one path token (double-quoted, single-quoted or bare; $VAR or
// ${VAR} allowed), no nested $(, backtick, extra word, pipe or redirect. The
// file's content is not re-scanned by bash, so reading it is safe.
const VAR = String.raw`\$\{?\w+\}?`;
const CAT_PATH = new RegExp(
  String.raw`^\$\(cat[ \t]+(?:"(?:[^"\x60\\()|;&<>$]|${VAR})*"|'[^']*'|(?:[^\s"'\x60$()|;&<>\\]|${VAR})+)[ \t]*\)`,
);

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
        const close = new RegExp(`\\n${m[1] ? "\\t*" : ""}${m[3]}\\n\\)`, "g");
        close.lastIndex = j + m[0].length - 1;
        const hit = close.exec(cmd);
        if (hit) {
          j = hit.index + hit[0].length;
          continue;
        }
      }
      const p = CAT_PATH.exec(cmd.slice(j));
      if (p) {
        j += p[0].length;
        continue;
      }
      problem ??= MSG_SUBST;
      j += 2;
      continue;
    }
    j += 1;
  }
  return { end: cmd.length, problem };
}

/** True when text holds an unescaped backtick or `$(` (what an unquoted heredoc expands). */
function expandsCommand(text) {
  for (let k = 0; k < text.length; k += 1) {
    if (text[k] === "\\") k += 1;
    else if (text[k] === "`" || (text[k] === "$" && text[k + 1] === "(")) return true;
  }
  return false;
}

/** Skip heredoc bodies from i; an unquoted one that expands marks its statement. */
function skipHeredocBodies(cmd, i, pending) {
  let j = i;
  for (const { tag, dash, quoted, stmt } of pending) {
    const start = j;
    let end = j;
    while (j < cmd.length) {
      let nl = cmd.indexOf("\n", j);
      if (nl === -1) nl = cmd.length;
      let line = cmd.slice(j, nl);
      const lineStart = j;
      j = Math.min(nl + 1, cmd.length);
      if (dash) line = line.replace(/^\t+/, "");
      if (line === tag) {
        end = lineStart;
        break;
      }
      end = j;
    }
    if (!quoted && expandsCommand(cmd.slice(start, end))) stmt.problem ??= MSG_HEREDOC;
  }
  return j;
}

/** Split into statements: { words, problem }. */
function scanStatements(cmd) {
  const stmts = [];
  let stmt = { words: [], problem: null };
  let cur = null;
  let pending = [];
  const pushWord = () => {
    if (cur !== null) stmt.words.push(cur);
    cur = null;
  };
  const endStmt = () => {
    pushWord();
    if (stmt.words.length) stmts.push(stmt);
    stmt = { words: [], problem: null };
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
      stmt.problem ??= r.problem;
      cur = cur ?? "";
      i = r.end;
    } else if (c === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      const m = /^<<(-?)\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))/.exec(cmd.slice(i));
      if (m) {
        pending.push({ tag: m[2] ?? m[3] ?? m[4], dash: m[1] === "-", quoted: m[4] === undefined, stmt });
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
    } else if (c === "&" && (cmd[i - 1] === ">" || cmd[i - 1] === "<" || cmd[i + 1] === ">")) {
      cur = (cur ?? "") + c;
      i += 1;
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

const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "time", "command", "exec", "sudo"]);
const XARGS_VALUE_FLAGS = new Set(["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a"]);
const BD_VALUE_FLAGS = new Set(["--actor", "-C", "--directory", "--db", "--database", "--dolt-auto-commit", "--mem-profile"]);

/** Drop prefixes that sit before the command word; returns the words from it on. */
function fromCommandWord(words) {
  const w = words.map((x) => x.replace(/^[({]+/, ""));
  let k = 0;
  while (k < w.length) {
    const x = w[k];
    if (x === "" || KEYWORDS.has(x) || /^[A-Za-z_]\w*=/.test(x)) {
      k += 1;
    } else if (x === "env") {
      k += 1;
      while (k < w.length && (w[k].startsWith("-") || /^[A-Za-z_]\w*=/.test(w[k]))) k += 1;
    } else if (x === "xargs") {
      k += 1;
      while (k < w.length && w[k].startsWith("-")) k += XARGS_VALUE_FLAGS.has(w[k]) ? 2 : 1;
    } else {
      break;
    }
  }
  return w.slice(k);
}

/** The subcommand of `bd <rest>`, skipping global flags and their values. */
function subcommand(rest) {
  for (let k = 0; k < rest.length; k += 1) {
    if (BD_VALUE_FLAGS.has(rest[k])) k += 1;
    else if (!rest[k].startsWith("-")) return { sub: rest[k], args: rest.slice(k + 1) };
  }
  return { sub: undefined, args: [] };
}

/**
 * @param {string} cmd a Bash command line
 * @returns {string | null} the refusal reason, or null to allow
 */
export function analyzeCommand(cmd) {
  for (const { words, problem } of scanStatements(cmd)) {
    const [word, ...rest] = fromCommandWord(words);
    if (word !== "bd" && !word?.endsWith("/bd")) continue;
    const { sub, args } = subcommand(rest);
    if (sub === "update" && args.some((x) => x === "--notes" || x.startsWith("--notes="))) {
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
