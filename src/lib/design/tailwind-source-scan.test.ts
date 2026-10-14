/**
 * ugcportal-rj7y: no file Tailwind's source detection can read carries an
 * unprefixed motion-shaped utility outside the named allowlist below.
 * The scanner and the reasoning live in tailwind-source-scan.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
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

describe("every file Tailwind can read is free of unprefixed motion utilities (ugcportal-rj7y K1)", () => {
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
        "is enough in prose), gate it with motion-safe:/motion-reduce:, or add a named " +
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
      "animate-spin",
      "transition-transform",
      "transition-[opacity,transform]",
      "hover:[scale:1.1]",
      "not-motion-safe:animate-pulse",
    ];
    expect(hits(planted.join(" "))).toEqual(planted);
  });

  it("does not flag a motion-safe: or motion-reduce: gated token at any position in the chain", () => {
    expect(
      hits(
        "motion-safe:group-hover:scale-[1.04] hover:motion-safe:animate-spin motion-reduce:scale-none " +
          "sm:motion-safe:hover:translate-y-px motion-reduce:translate-y-0",
      ),
    ).toEqual([]);
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

describe("scanTree over a planted tree (ugcportal-rj7y K1 fixture)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function plant(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "tw-scan-"));
    roots.push(root);
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), body);
    }
    return root;
  }

  const excluded = sourceNotMatchers(GLOBALS_CSS, REPO_ROOT);
  const PLANTED = "group-hover:scale-[1.1]";

  it.each(["src/a.ts", "docs/a.md", "scripts/a.mjs", "e2e/helpers.ts", "other/a.json", ".claude/a.md"])(
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
    expect(scanTree(root, excluded)).toEqual({ findings: [], filesScanned: 0 });
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

  it("reads tracked dot-directories, which Tailwind compiled from in a real build", () => {
    const root = plant({ ".claude/skills/a.md": PLANTED, ".github/a.yml": PLANTED });
    expect(offending(scanTree(root, excluded).findings)).toEqual([
      `.claude/skills/a.md:1 ${PLANTED}`,
      `.github/a.yml:1 ${PLANTED}`,
    ]);
  });
});
