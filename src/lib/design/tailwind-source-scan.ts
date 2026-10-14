/**
 * Repo-wide scan for unprefixed motion-shaped Tailwind utilities in every
 * file Tailwind's own source detection can read (ugcportal-rj7y).
 *
 * WHY: Tailwind v4 byte-scans files for class-shaped candidates and has no
 * notion of a comment, a doc or a test fixture. A motion utility spelled out
 * in a doc comment, a markdown file or a script compiles into the shipped
 * stylesheet as a live rule even though nothing renders it. Each earlier
 * instance was patched with another `@source not` glob or a scan scoped to
 * that one string; this module is the one general rule they were instances
 * of: outside a `motion-safe:` or `motion-reduce:` variant, a token whose
 * final segment is a scale, translate, rotate, skew, animate or
 * transform-moving transition utility is a finding, wherever it is.
 *
 * What it mirrors: the `@source not` lines in src/app/globals.css, read from
 * that file at run time (never copied here), applied to every text file
 * under the repo root. What it does not reproduce: Tailwind's gitignore
 * handling and binary detection. It skips the directories .gitignore names
 * (node_modules, .next, .claude/worktrees ...), build output and `.css`
 * files, and reads only the text extensions in TEXT_EXTENSION. Dot-directories
 * that are tracked (.claude, .github, .beads) ARE read: a planted bare
 * utility in .claude/ compiled into the stylesheet when this was checked; a file Tailwind skips but this reads is an over-match,
 * which is the safe direction for a guard.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** One `@source not "<glob>"` line, as written. */
export function parseSourceNotGlobs(globalsCss: string): string[] {
  const globs: string[] = [];
  for (const match of globalsCss.matchAll(/^@source\s+not\s+"([^"]+)"\s*;/gm)) {
    globs.push(match[1]);
  }
  return globs;
}

/**
 * Glob to RegExp over a forward-slash relative path: `**` crosses
 * directories, `*` and `?` do not. No brace or character-class support: the
 * four lines this mirrors need none, and an unsupported metacharacter throws
 * rather than silently matching nothing.
 */
export function globToRegExp(glob: string): RegExp {
  if (/[{}[\]!()]/.test(glob)) {
    throw new Error(`globToRegExp: unsupported glob syntax in ${JSON.stringify(glob)}`);
  }
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^$|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * The `@source not` globs of `globalsCssPath`, as regexes over the path
 * RELATIVE TO `root`. Each glob is resolved against the directory holding
 * the css file, which is how Tailwind resolves it.
 */
export function sourceNotMatchers(globalsCssPath: string, root: string): RegExp[] {
  const globs = parseSourceNotGlobs(readFileSync(globalsCssPath, "utf8"));
  return globs.map((glob) => {
    const resolved = path.resolve(path.dirname(globalsCssPath), glob);
    return globToRegExp(path.relative(root, resolved).split(path.sep).join("/"));
  });
}

const TEXT_EXTENSION = /\.(?:tsx?|jsx?|mjs|cjs|mdx?|html|json|jsonl|ya?ml|txt)$/;
const SKIPPED_DIRECTORY = new Set([
  "node_modules",
  ".git",
  ".next",
  ".dolt",
  ".runtime",
  ".vercel",
  "coverage",
  "generated",
  "playwright-report",
  "test-results",
]);
/** Directories .gitignore names by path, which Tailwind's scanner honours. */
const SKIPPED_PATH = new Set([".claude/worktrees", ".beads/proxieddb"]);
const SKIPPED_FILE = new Set(["package-lock.json"]);

/** Every text file under `root` that no matcher excludes, as forward-slash paths relative to `root`. */
export function listReachableFiles(root: string, excluded: readonly RegExp[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED_DIRECTORY.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (!SKIPPED_PATH.has(rel)) walk(full);
        continue;
      }
      if (!TEXT_EXTENSION.test(entry.name) || SKIPPED_FILE.has(entry.name)) continue;
      if (excluded.some((matcher) => matcher.test(rel))) continue;
      out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * The final segment of a token, once variants are stripped, that applies
 * motion. `-none` forms remove motion and are never findings. A bare
 * `transition` is not matched: it is also an ordinary English word (a state
 * transition) and appears in prose across the docs and source comments; only the utilities that
 * name a moving property are.
 *
 * Assembled from parts so this file's own bytes do not spell a whole
 * candidate (Tailwind scans src alike; the real-tree test in
 * tailwind-source-scan.test.ts scans this file and fails if one appears).
 */
const AXIS = "(?:[xyz]-)?";
const NUMERIC = String.raw`(?:\d[\w./%]*|px|full|auto|\[.*\]|\(.*\))`;
const MOVING = "(?:all|transform|translate|scale|rotate)";
const DANGEROUS_SEGMENT = new RegExp(
  "^(?:" +
    `-?(?:scale|translate|rotate|skew)-${AXIS}${NUMERIC}` +
    "|-?animate-(?!none$)(?:[a-z][\\w-]*|\\[.*\\]|\\(.*\\))" +
    `|transition-(?:all|transform)` +
    `|transition-\\[[^\\]]*${MOVING}[^\\]]*\\]` +
    "|\\[(?:scale|translate|rotate|skew|transform|animation|animation-name|animation-duration|transition|--tw-(?:translate|scale|rotate|skew)-[xyz]):[^\\]]*\\]" +
    ")$",
);

/** Splits a token on `:` outside square brackets. */
function variantChain(token: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of token) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === ":" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Whether the variants gate the utility. `motion-safe` and `motion-reduce`
 * count. `not-motion-safe` does not (it compiles to a rule that fires when
 * reduced motion IS requested): it is one whole segment, so the anchored
 * match below rejects it.
 */
function isGated(variants: readonly string[]): boolean {
  return variants.some((variant) => /^motion-(?:safe|reduce)$/.test(variant));
}

export interface Finding {
  file: string;
  line: number;
  token: string;
}

/** Every ungated motion-shaped token in `source`. */
export function findBareDangerousUtilities(source: string, file: string): Finding[] {
  const findings: Finding[] = [];
  source.split("\n").forEach((text, index) => {
    for (const raw of text.split(/[\s"'`<>{}\\;|]+/)) {
      const token = raw.replace(/^[(*.!]+|[).*!,]+$/g, "");
      if (!token) continue;
      const variants = variantChain(token);
      const utility = variants.pop() ?? "";
      if (!DANGEROUS_SEGMENT.test(utility)) continue;
      if (isGated(variants)) continue;
      findings.push({ file, line: index + 1, token });
    }
  });
  return findings;
}

/** Scans every reachable file under `root`. Returns the findings and how many files were read. */
export function scanTree(
  root: string,
  excluded: readonly RegExp[],
): { findings: Finding[]; filesScanned: number } {
  const files = listReachableFiles(root, excluded);
  const findings = files.flatMap((file) =>
    findBareDangerousUtilities(readFileSync(path.join(root, file), "utf8"), file),
  );
  return { findings, filesScanned: files.length };
}
