/**
 * Repo-wide scan for unprefixed motion-shaped Tailwind utilities in the
 * files Tailwind's own source detection reads (ugcportal-rj7y).
 *
 * WHY: Tailwind v4 byte-scans files for class-shaped candidates and has no
 * notion of a comment, a doc or a test fixture. A motion utility spelled out
 * in a doc comment, a markdown file or a script compiles into the shipped
 * stylesheet as a live rule even though nothing renders it. Each earlier
 * instance was patched with another `@source not` glob or a scan scoped to
 * that one string; this module is the one general rule they were instances
 * of: a token whose final segment is a scale, translate, rotate, skew,
 * animate, transform or transform-moving transition utility is a finding,
 * wherever it is, unless its variants gate it (see `isGated`).
 *
 * The gate is asymmetric (orchestrator decision on round-1 F6, recorded in
 * the bead): `motion-safe:` gates any utility. `motion-reduce:` fires only
 * for users who asked for less motion, so it gates only a utility that
 * removes or neutralises motion (NEUTRALISING_SEGMENT: the `-none` forms,
 * the identity scale of 100, a zero translate, rotate or skew,
 * `transition-none`, `transform-none`); a `motion-reduce:` prefix on a
 * utility that adds motion is a finding.
 *
 * What is read, and by what mechanism (`listReachableFiles` + `scanTree`):
 * every file `git ls-files -co --exclude-standard` lists under the root --
 * tracked files plus untracked files git does not ignore, whatever their
 * extension or lack of one (shell hooks, `Dockerfile`, `.sql`, `.prisma`,
 * `.svg` ...). Which paths are ignored is git's own evaluation of
 * .gitignore (root anchors, any-depth names and `!` re-includes alike);
 * nothing here re-implements or copies it. Tailwind's scanner honours
 * .gitignore too: two plants at a root-anchored name below the root
 * (src/lib/generated/, docs/coverage/) compiled into a real build, and this
 * list now names both. Tailwind's scanner also honours .git/info/exclude (measured
 * against @tailwindcss/oxide 4.3.3's own Scanner) but NOT the user's global
 * excludes file (core.excludesFile or ~/.config/git/ignore), so the git
 * call below is told core.excludesFile=/dev/null: that drops the global
 * file and the XDG default alike (measured with scratch files for both).
 * From that list it then drops
 *   - files a `@source not` line in src/app/globals.css excludes, read from
 *     that file at run time (never copied here);
 *   - binary files, detected the way git does: a NUL byte in the first
 *     8000 bytes (Tailwind ships its own binary-extension list instead);
 *   - the extensions and lockfiles Tailwind's scanner itself ignores
 *     (IGNORED_EXTENSION, IGNORED_FILE: the lists compiled into
 *     @tailwindcss/oxide 4.3.3, readable with `strings` on its `.node`
 *     binary), plus `.css`, which a planted utility in a `.css` file under
 *     docs/ did not reach the build when this was checked;
 *   - a listed path that is not a regular file on disk: a tracked file
 *     deleted in the working tree (there is nothing to read), or a symlink
 *     (the repo tracks none today; one would go unread here).
 * Two known differences from Tailwind's scanner remain, each measured
 * against oxide 4.3.3's own Scanner on the same tree (a third, the user's
 * global excludes file, is closed in code, see above):
 *   1. Over-match: a file that is tracked AND matches an ignore rule (today
 *      two empty `.runtime/locks/sling/*.flock` files) is listed by git and
 *      read here, though an ignore-rule walk such as Tailwind's skips it.
 *      Reading more than Tailwind is the safe direction for a guard; a false
 *      positive fails loudly with file:line.
 *   2. Under-match: an untracked nested git repository is listed by git as
 *      `inner/`, which is not a regular file, so it is skipped here, while
 *      oxide reads the files inside it. It concerns untracked files only,
 *      which a CI or clean checkout does not have, so it cannot reach the
 *      shipped stylesheet.
 * Tracked dot-directories (.claude, .github, .beads) ARE read: a planted
 * bare utility in .claude/ compiled into the stylesheet when this was
 * checked.
 * The root must be inside a git work tree; if `git ls-files` fails, this
 * throws (git's stderr is left on the console) rather than scanning nothing.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
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

/** Extensions Tailwind's scanner ignores (oxide 4.3.3), plus `.css` (see the header). */
const IGNORED_EXTENSION = /\.(?:css|less|lock|sass|scss|styl|log)$/;
/** Lockfiles Tailwind's scanner ignores (oxide 4.3.3). */
const IGNORED_FILE = new Set(["package-lock.json", "pnpm-lock.yaml", "bun.lockb"]);
/**
 * Every file `git ls-files -co --exclude-standard` lists under `root` (see
 * the header) that no matcher and no Tailwind ignore list excludes, as
 * forward-slash paths relative to `root`. Binary files are dropped later, by
 * content, in `scanTree`.
 */
export function listReachableFiles(root: string, excluded: readonly RegExp[]): string[] {
  const listed = execFileSync("git", ["-c", "core.excludesFile=/dev/null", "ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  })
    .split("\0")
    .filter(Boolean);
  const out: string[] = [];
  for (const rel of new Set(listed)) {
    const name = path.posix.basename(rel);
    if (IGNORED_EXTENSION.test(name) || IGNORED_FILE.has(name)) continue;
    if (excluded.some((matcher) => matcher.test(rel))) continue;
    let isRegularFile: boolean;
    try {
      isRegularFile = lstatSync(path.join(root, rel)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      isRegularFile = false;
    }
    if (isRegularFile) out.push(rel);
  }
  return out.sort();
}

/** A NUL byte in the first 8000 bytes, git's own binary heuristic. */
export function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
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
    "|transform-(?:gpu|cpu|\\[.*\\]|\\(.*\\))" +
    `|transition-\\[[^\\]]*${MOVING}[^\\]]*\\]` +
    "|\\[(?:scale|translate|rotate|skew|transform|animation|animation-name|animation-duration|transition|--tw-(?:translate|scale|rotate|skew)-[xyz]):[^\\]]*\\]" +
    ")$",
);

/**
 * A final segment that removes or neutralises motion: the only utilities a
 * `motion-reduce:` prefix gates. `-none` forms, the identity scale of 100, a
 * zero translate, rotate or skew, `transition-none` and `transform-none`.
 * Assembled from parts for the same reason as DANGEROUS_SEGMENT. The compiled
 * check (scripts/check-reduced-motion-css-exclusions.mjs) keeps a copy as
 * NEUTRALISING_UTILITY, and tailwind-source-scan.test.ts fails if the two
 * sources differ.
 */
export const NEUTRALISING_SEGMENT = new RegExp(
  "^(?:" +
    "(?:animate|transition|transform|scale|translate|rotate|skew)-none" +
    "|scale-(?:[xyz]-)?1" + "00" +
    "|(?:translate|rotate)-(?:[xyz]-)?0" +
    "|skew-(?:[xy]-)?0" +
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
 * Whether the variants gate `utility`. `motion-safe` gates anything.
 * `motion-reduce` fires exactly when reduced motion IS requested, so it gates
 * only a NEUTRALISING_SEGMENT utility: `motion-reduce:` on a utility that
 * adds motion animates for the users who asked for none. `not-motion-safe`
 * gates nothing (it fires under reduce too, and adds no neutralising
 * guarantee): it is one whole segment, so the anchored matches reject it.
 */
function isGated(variants: readonly string[], utility: string): boolean {
  if (variants.includes("motion-safe")) return true;
  if (variants.includes("motion-reduce")) return NEUTRALISING_SEGMENT.test(utility);
  return false;
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
      if (isGated(variants, utility)) continue;
      findings.push({ file, line: index + 1, token });
    }
  });
  return findings;
}

/**
 * Scans every reachable, non-binary file under `root`. Returns the findings,
 * how many files were read and how many were skipped as binary.
 */
export function scanTree(
  root: string,
  excluded: readonly RegExp[],
): { findings: Finding[]; filesScanned: number; binarySkipped: number } {
  const findings: Finding[] = [];
  let filesScanned = 0;
  let binarySkipped = 0;
  for (const file of listReachableFiles(root, excluded)) {
    const content = readFileSync(path.join(root, file));
    if (isBinary(content)) {
      binarySkipped++;
      continue;
    }
    filesScanned++;
    findings.push(...findBareDangerousUtilities(content.toString("utf8"), file));
  }
  return { findings, filesScanned, binarySkipped };
}
