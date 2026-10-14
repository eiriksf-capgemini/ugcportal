/**
 * ugcportal-rj7y: no file the scanner reads carries an ungated
 * motion-shaped utility outside the named allowlist below. Which files it
 * reads (every non-binary file `git ls-files -co --exclude-standard` lists,
 * so git's own evaluation of .gitignore, less Tailwind's own ignore lists
 * and the `@source not` globs), what counts as a gate, and why, are in
 * tailwind-source-scan.ts's header.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { NEUTRALISING_UTILITY } from "../../../scripts/check-reduced-motion-css-exclusions.mjs";
import {
  NEUTRALISING_SEGMENT,
  findBareDangerousUtilities,
  globToRegExp,
  parseSourceNotGlobs,
  scanTree,
  sourceNotMatchers,
  type Finding,
} from "./tailwind-source-scan";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GLOBALS_CSS = path.join(REPO_ROOT, "src", "app", "globals.css");

/**
 * Deliberate bare mentions. Each entry is exact: the file, the token and how
 * many times it appears, so a new copy fails and a removed one makes the
 * entry stale (and fails too). `reason` is why that use does not leak a rule
 * that matters.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; token: string; count: number; reason: string }> = [
  {
    file: "src/components/gallery/containment.ts",
    token: "transition-transform",
    count: 3,
    reason:
      "a real class on the tile image (one use) plus two comments naming it; the same class string " +
      "carries motion-reduce:transition-none and its scale is motion-safe: gated, so a bare " +
      "transition rule with no transform to animate adds no motion",
  },
  {
    file: "src/components/gallery/containment.ts",
    token: "translate-x-0.5",
    count: 1,
    reason: "a static half-pixel optical nudge of the video badge icon, applied unconditionally, not an animation",
  },
  {
    file: "src/components/ui/button.tsx",
    token: "transition-all",
    count: 1,
    reason: "the shadcn button base; its only transform utility is the motion-safe: gated active nudge",
  },
];

function offending(findings: readonly Finding[]): string[] {
  return findings.map((f) => `${f.file}:${f.line} ${f.token}`);
}

function unallowed(findings: readonly Finding[]): Finding[] {
  return findings.filter(
    (f) => !ALLOWLIST.some((entry) => entry.file === f.file && entry.token === f.token),
  );
}

describe("every file the scanner reads is free of ungated motion utilities (ugcportal-rj7y K1)", () => {
  const excluded = sourceNotMatchers(GLOBALS_CSS, REPO_ROOT);
  const { findings, filesScanned } = scanTree(REPO_ROOT, excluded);

  it("scans a real tree, and reads the exclusions from globals.css rather than a copy", () => {
    expect(filesScanned).toBeGreaterThan(100);
    expect(parseSourceNotGlobs(readGlobals())).toHaveLength(4);
    expect(excluded).toHaveLength(4);
  });

  it("finds nothing outside the named allowlist", () => {
    expect(
      offending(unallowed(findings)),
      "an unprefixed motion-shaped utility in a file Tailwind scans compiles into the " +
        "production stylesheet, comment or not. Break the string (a space after the hyphen " +
        "is enough in prose), gate it with motion-safe: (motion-reduce: gates only a " +
        "utility that removes motion), or add a named " +
        "ALLOWLIST entry with a reason.",
    ).toEqual([]);
  });

  it("every allowlist entry still matches exactly its stated count (no stale or widened entries)", () => {
    for (const entry of ALLOWLIST) {
      const actual = findings.filter((f) => f.file === entry.file && f.token === entry.token).length;
      expect(actual, `${entry.file} ${entry.token}`).toBe(entry.count);
    }
  });
});

function readGlobals(): string {
  return readFileSync(GLOBALS_CSS, "utf8");
}

describe("findBareDangerousUtilities", () => {
  const hits = (source: string) => findBareDangerousUtilities(source, "f.ts").map((f) => f.token);

  it("flags bare and interaction-prefixed scale, translate, rotate, skew, animate and transform transitions", () => {
    const planted = [
      "group-hover:scale-[1.1]",
      "scale-110",
      "-translate-y-0.5",
      "hover:rotate-6",
      "skew-x-3",
      "skew-y-6",
      "rotate-x-12",
      "rotate-y-12",
      "-skew-x-2",
      "animate-spin",
      "transition-transform",
      "transition-[opacity,transform]",
      "hover:[scale:1.1]",
      "transform-gpu",
      "transform-[scale(1.1)]",
      "not-motion-safe:animate-pulse",
    ];
    expect(hits(planted.join(" "))).toEqual(planted);
  });

  it("does not flag a motion-safe: gated token at any position in the chain", () => {
    expect(
      hits(
        "motion-safe:group-hover:scale-[1.04] hover:motion-safe:animate-spin " +
          "sm:motion-safe:hover:translate-y-px motion-safe:skew-x-3",
      ),
    ).toEqual([]);
  });

  // Orchestrator decision on round-1 F6: motion-reduce: fires only for users
  // who asked for less motion, so it gates a utility that removes motion and
  // never one that adds it.
  it("flags motion-reduce: on a utility that ADDS motion", () => {
    const adding = [
      "motion-reduce:animate-spin",
      "motion-reduce:scale-110",
      "hover:motion-reduce:-translate-y-1",
      "motion-reduce:rotate-6",
      "motion-reduce:skew-x-3",
      "motion-reduce:transition-transform",
      "motion-reduce:transition-all",
      "motion-reduce:transform-gpu",
    ];
    expect(hits(adding.join(" "))).toEqual(adding);
  });

  it("accepts motion-reduce: on a utility that removes or neutralises motion, which bare would be flagged", () => {
    const neutral = ["scale-100", "translate-0", "translate-x-0", "translate-y-0", "rotate-0", "skew-0"];
    // Bare, the zero/identity forms still match the dangerous shape, so the
    // prefix is what makes them pass below.
    expect(hits(neutral.join(" "))).toEqual(neutral);
    expect(
      hits(
        [...neutral, "animate-none", "scale-none", "transition-none", "transform-none"]
          .map((utility) => `motion-reduce:${utility}`)
          .join(" "),
      ),
    ).toEqual([]);
  });

  it("the compiled check's copy of the neutralising shape is the same regex", () => {
    expect(NEUTRALISING_UTILITY.source).toBe(NEUTRALISING_SEGMENT.source);
  });

  it("does not flag -none forms, unrelated utilities, or the word transition in prose", () => {
    expect(
      hits(
        "animate-none scale-none translate-none transition-colors transition-[width] object-scale-down " +
          "a state transition occurs; scale-free, translate- and animate- alone",
      ),
    ).toEqual([]);
  });

  it("finds a token inside quotes, a comment, markdown backticks and a template literal", () => {
    expect(hits('className="animate-spin"')).toEqual(["animate-spin"]);
    expect(hits("// e.g. animate-spin here")).toEqual(["animate-spin"]);
    expect(hits("use `animate-spin` for loading.")).toEqual(["animate-spin"]);
    expect(hits("`x ${y} animate-spin`")).toEqual(["animate-spin"]);
  });

  it("names the line", () => {
    expect(findBareDangerousUtilities("a\nb animate-spin", "f.md")).toEqual([
      { file: "f.md", line: 2, token: "animate-spin" },
    ]);
  });
});

describe("globToRegExp", () => {
  it("mirrors the shapes globals.css uses", () => {
    expect(globToRegExp("src/**/*.test.ts").test("src/a/b/c.test.ts")).toBe(true);
    expect(globToRegExp("src/**/*.test.ts").test("src/c.test.ts")).toBe(true);
    expect(globToRegExp("src/**/*.test.ts").test("src/c.test.tsx")).toBe(false);
    expect(globToRegExp("e2e/**/*.spec.ts").test("src/e2e/a.spec.ts")).toBe(false);
    expect(globToRegExp("a/*.ts").test("a/b/c.ts")).toBe(false);
  });

  it("refuses syntax it does not support rather than matching nothing", () => {
    expect(() => globToRegExp("src/{a,b}/*.ts")).toThrow(/unsupported/);
  });
});

// Every case spawns real `git init` / `git ls-files` subprocesses (the scan
// asks git what it does not ignore), which a loaded machine can make slower
// than vitest's 5s default (ugcportal-9faa).
describe("scanTree over a planted tree (ugcportal-rj7y K1 fixture)", { timeout: 30_000 }, () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /**
   * A fresh git repository whose ignore rules are the real repo's .gitignore,
   * copied into .git/info/exclude (same pattern semantics, anchored at the
   * same root) so the copy is not itself a listed file. Plants are untracked.
   */
  function plant(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "tw-scan-"));
    roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    writeFileSync(path.join(root, ".git", "info", "exclude"), readFileSync(path.join(REPO_ROOT, ".gitignore")));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), body);
    }
    return root;
  }

  const excluded = sourceNotMatchers(GLOBALS_CSS, REPO_ROOT);
  const PLANTED = "group-hover:scale-[1.1]";

  it.each([
    "src/a.ts",
    "docs/a.md",
    "scripts/a.mjs",
    "e2e/helpers.ts",
    "other/a.json",
    ".claude/a.md",
    // Round-1 F2: Tailwind reads these too; a .sh plant compiled.
    "scripts/x.sh",
    "scripts/hook",
    ".beads/hooks/pre-push",
    "Dockerfile",
    "prisma/schema.prisma",
    "prisma/migrations/1/migration.sql",
    "public/a.svg",
    "a.py",
    "a.toml",
    // Round-2 L1: .gitignore anchors these names to the root, so at any other
    // depth git does not ignore them and they must be read. The first two are
    // the review's plants, both of which compiled into a real build.
    "src/lib/generated/zz-plant.md",
    "docs/coverage/zz-plant.md",
    "e2e/test-results/a.md",
    "docs/playwright-report/a.md",
    "src/blob-report/a.md",
    "src/build/a.ts",
    "docs/out/a.md",
    // `.yarn/*` is ignored but `!.yarn/patches` re-includes it.
    ".yarn/patches/zz.md",
    ".yarn/releases/a.md",
  ])(
    "fails naming file and string for a bare mention in %s, passes once removed",
    (rel) => {
      const root = plant({ [rel]: `// ${PLANTED}\n` });
      const { findings } = scanTree(root, excluded);
      expect(offending(findings)).toEqual([`${rel}:1 ${PLANTED}`]);

      writeFileSync(path.join(root, rel), `// ${PLANTED.replace("scale-", "scale- ")}\n`);
      expect(scanTree(root, excluded).findings).toEqual([]);
    },
  );

  it("does not read a *.test.ts under src or a *.spec.ts under e2e, exactly as globals.css excludes them", () => {
    const root = plant({
      "src/a.test.ts": PLANTED,
      "src/deep/a.test.tsx": PLANTED,
      "e2e/a.spec.ts": PLANTED,
      "e2e/production/a.spec.tsx": PLANTED,
    });
    expect(scanTree(root, excluded)).toEqual({ findings: [], filesScanned: 0, binarySkipped: 0 });
  });

  it("still reads a *.spec.ts outside e2e and a *.test.ts outside src", () => {
    const root = plant({ "src/a.spec.ts": PLANTED, "scripts/a.test.mjs": PLANTED });
    expect(offending(scanTree(root, excluded).findings)).toEqual([
      `scripts/a.test.mjs:1 ${PLANTED}`,
      `src/a.spec.ts:1 ${PLANTED}`,
    ]);
  });

  it("skips node_modules, gitignored directories and .css files", () => {
    const root = plant({
      "node_modules/x/a.js": PLANTED,
      ".next/a.js": PLANTED,
      ".claude/worktrees/w/a.md": PLANTED,
      "src/a.css": PLANTED,
    });
    expect(scanTree(root, excluded).filesScanned).toBe(0);
  });

  it("does not read a plant under a root-anchored ignored path, or under .yarn outside its re-includes", () => {
    const root = plant({
      "coverage/zz.md": PLANTED,
      "src/generated/prisma/zz.ts": PLANTED,
      "test-results/a.md": PLANTED,
      "playwright-report/a.md": PLANTED,
      "blob-report/a.md": PLANTED,
      "build/a.ts": PLANTED,
      "out/a.md": PLANTED,
      ".yarn/cache/a.md": PLANTED,
      "src/.runtime/a.md": PLANTED,
      "docs/.dolt/a.md": PLANTED,
    });
    expect(scanTree(root, excluded)).toEqual({ findings: [], filesScanned: 0, binarySkipped: 0 });
  });

  it("reads a tracked file but not a tracked file deleted from the working tree", () => {
    const root = plant({ "docs/kept.md": PLANTED, "docs/gone.md": PLANTED });
    execFileSync("git", ["add", "docs"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    rmSync(path.join(root, "docs", "gone.md"));
    expect(offending(scanTree(root, excluded).findings)).toEqual([`docs/kept.md:1 ${PLANTED}`]);
  });

  it("does not honour the user's global excludes file, which Tailwind's scanner ignores", () => {
    const root = plant({ "docs/zz-global.md": PLANTED });
    const globalIgnore = path.join(root, ".git", "scratch-global-ignore");
    writeFileSync(globalIgnore, "zz-global.md\n");
    execFileSync("git", ["config", "core.excludesFile", globalIgnore], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    expect(offending(scanTree(root, excluded).findings)).toEqual([`docs/zz-global.md:1 ${PLANTED}`]);
  });

  it("throws, rather than scanning nothing, when the root is not inside a git work tree", () => {
    const root = mkdtempSync(path.join(tmpdir(), "tw-scan-nogit-"));
    roots.push(root);
    writeFileSync(path.join(root, "a.md"), PLANTED);
    expect(() => scanTree(root, excluded)).toThrow();
  });

  it("skips a binary file by its NUL byte, and the extensions and lockfiles Tailwind ignores", () => {
    const root = plant({
      "public/a.png": `\u0000PNG ${PLANTED}`,
      "a.log": PLANTED,
      "yarn.lock": PLANTED,
      "package-lock.json": PLANTED,
      ".env.local": PLANTED,
      "tsconfig.tsbuildinfo": PLANTED,
    });
    expect(scanTree(root, excluded)).toEqual({ findings: [], filesScanned: 0, binarySkipped: 1 });
  });

  it("reads tracked dot-directories, which Tailwind compiled from in a real build", () => {
    const root = plant({ ".claude/skills/a.md": PLANTED, ".github/a.yml": PLANTED });
    execFileSync("git", ["add", "."], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    expect(offending(scanTree(root, excluded).findings)).toEqual([
      `.claude/skills/a.md:1 ${PLANTED}`,
      `.github/a.yml:1 ${PLANTED}`,
    ]);
  });
});
