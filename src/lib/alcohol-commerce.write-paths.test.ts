import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  isTestFile,
  stripComments,
  walkSourceFiles,
} from "@/lib/design/scan-source";

/**
 * ugcportal-qnq9.3 K4, as a claim about the WHOLE TREE rather than about one
 * route: every path that can put a benefit source on an item runs the brand
 * check.
 *
 * WHY THIS EXISTS AS A SEPARATE TEST. The route tests next door prove the
 * gate runs on the one write path there is. They cannot prove it is the only
 * one — and the way a check like this stops holding is not that somebody
 * deletes it, it is that somebody adds a SECOND writer (an importer, an admin
 * screen, a bulk tool, a server action) and the review of that PR has no
 * reason to think about alkoholloven. This is the repo's recurring defect
 * family 4: a rule enforced at one of N call sites.
 *
 * So the assertion is an enumeration. Every file under `src/` that names a
 * benefit-source write is listed, the list is compared against an expected
 * set, and every member of it is required to reach
 * `benefitAttachmentRefusal`. A new writer fails this file by existing, which
 * is the point: the failure arrives in the PR that adds it, naming the
 * function to call.
 *
 * COMMENTS ARE STRIPPED before matching, the same way
 * src/components/consent/analytics-host.grep.test.ts and the
 * dual-meaning-usage scanners do it and for the same reason: a docblock that
 * merely discusses `benefitSourceId` is not a write path, and a false
 * positive here would be paid for by somebody weakening the needles.
 *
 * TEST FILES ARE EXCLUDED, unlike in that file. The needles below are the
 * ordinary vocabulary of a test that seeds a brand — this file's own fixtures
 * use them — and a rule requiring every such test to call the gate would be a
 * rule about tests rather than about write paths. What that costs is covered
 * by `scanWriteSites` being exercised against a real temp-directory fixture
 * at the bottom of this file: the scanner itself is tested, rather than being
 * trusted to be correct on the one tree it ordinarily sees.
 */

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The ways a BenefitSource can be attached to an item, or minted.
 *
 * `benefitSourceId` is the column itself: anything writing the pointer names
 * it. `resolveBenefitSource` is the helper that mints the row. `benefitSource:
 * {` is Prisma's nested-write form (`benefitSource: { connect: … }`), which
 * sets the same pointer without naming the column — the shape a second author
 * is most likely to reach for, and the one a column-name-only grep would miss.
 */
const WRITE_NEEDLES = [
  "benefitSourceId",
  "resolveBenefitSource",
  "benefitSource: {",
] as const;

/** The function every write site has to reach. */
const GATE = "benefitAttachmentRefusal";

/**
 * Files, relative to `src/`, that may name a write needle.
 *
 * Each entry is here for a stated reason, because an unexplained allowlist is
 * how this kind of test stops meaning anything:
 *
 *   - the disclosure route is the write path that ATTACHES A BENEFIT, and it
 *     calls the gate (asserted separately below, which is the half an
 *     allowlist cannot carry);
 *   - the commercial-links route is the write path that ATTACHES A LINK
 *     (ugcportal-qnq9.2.1), and it calls the same gate. It arrived exactly the
 *     way the docstring above predicted a second writer would — a new route,
 *     a new statute to think about — and this file failed on the PR that added
 *     it, naming the function to call;
 *   - `benefit-source.ts` is the module that mints the row, and it is called
 *     BY that route inside the gated branch rather than reaching the gate
 *     itself — a predicate-free data-access helper, deliberately;
 *   - the publish route READS the pointer to refuse on it. It is a read, not
 *     a write, and it is in this list only because `benefitSource: {` matches
 *     its `select`.
 *
 * `lib/alcohol-commerce.ts` is deliberately NOT here: it is the gate, it
 * names the brand only in a type, and it matches no needle — so listing it
 * would be a stale entry of exactly the kind the third case below refuses.
 */
const ALLOWED: Record<string, string> = {
  "app/api/media/[id]/disclosure/route.ts":
    "attaches a benefit; calls the gate",
  "app/api/media/[id]/commercial-links/route.ts":
    "attaches a commercial link; calls the gate",
  "lib/benefit-source.ts": "mints the row, called from inside the gated branch",
  "app/api/media/[id]/publish/route.ts": "reads the pointer to refuse on it",
};

/** Every non-test file under `root` whose comment-stripped source names a
 * benefit-source write, relative to `root` with POSIX separators. */
export function scanWriteSites(root: string): string[] {
  return walkSourceFiles(root, (file) => isTestFile(file))
    .filter((file) => {
      const code = stripComments(readFileSync(file, "utf8"), file);
      return WRITE_NEEDLES.some((needle) => code.includes(needle));
    })
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .sort();
}

/**
 * One walk of `src/`, shared by every case below.
 *
 * Required by scripts/tree-walk-timeout-guard.test.mjs, and for its reason
 * (ugcportal-9faa): a per-test whole-tree walk is what pushes a suite past
 * vitest's default per-test timeout under load, and the failure then looks
 * like a defect in the thing being tested rather than like load. The fixture cases at the bottom pass their own root
 * and deliberately do NOT come through here — each of those walks four files
 * in a temp directory, and caching by root would make a per-case fixture
 * invisible to the next case.
 */
let cachedSrcWriteSites: string[] | undefined;
function srcWriteSites(): string[] {
  return (cachedSrcWriteSites ??= scanWriteSites(SRC_ROOT));
}

describe("ugcportal-qnq9.3 K4: every benefit-source write path is gated", () => {
  it("finds both write paths, so the enumeration is not vacuous", () => {
    // Without this, a scanner that silently matched nothing — a changed
    // needle, a broken strip, the wrong root — would make every assertion
    // below pass. BOTH are named rather than one: the commercial-link route
    // reaches the column only through Prisma's nested-write form
    // (`benefitSource: { connect: … }`), so a needle set narrowed to the
    // column name alone would still find the disclosure route and quietly
    // stop finding this one.
    expect(srcWriteSites()).toContain("app/api/media/[id]/disclosure/route.ts");
    expect(srcWriteSites()).toContain(
      "app/api/media/[id]/commercial-links/route.ts",
    );
  });

  it("lists no file that is not accounted for", () => {
    const found = srcWriteSites();
    const unexpected = found.filter((file) => !(file in ALLOWED));

    expect(
      unexpected,
      `these files write a benefit source and are not accounted for in ALLOWED: ${unexpected.join(", ")}. Call ${GATE} (src/lib/alcohol-commerce.ts) before the write, then add the file here with the reason.`,
    ).toEqual([]);
  });

  it("accounts for nothing that has since stopped writing one", () => {
    // The other direction. A stale allowlist entry is how the list above
    // slowly becomes decoration: the next author reads the list, assumes it
    // is the set of writers, and adds one more. Written without a count,
    // because an ordinal here goes stale exactly when this comment is read.
    const found = new Set(srcWriteSites());
    for (const file of Object.keys(ALLOWED)) {
      expect(found.has(file), `${file} no longer writes a benefit source`).toBe(
        true,
      );
    }
  });

  it("calls the gate from every route that writes the pointer", () => {
    // The claim the allowlist itself cannot make. Asserted per file rather
    // than once, so a second write path added to ALLOWED has to call the gate
    // to get past this — which is what the commercial-links route had to do.
    const writers = [
      "app/api/media/[id]/disclosure/route.ts",
      "app/api/media/[id]/commercial-links/route.ts",
      "app/api/media/[id]/publish/route.ts",
    ];
    for (const file of writers) {
      const code = stripComments(
        readFileSync(path.join(SRC_ROOT, file), "utf8"),
        file,
      );
      expect(
        code.includes(GATE) || code.includes("commercialPublishRefusal"),
        `${file} does not reach the alcohol gate`,
      ).toBe(true);
    }
  });
});

/**
 * The scanner, against a fixture tree it does not otherwise meet.
 *
 * Without this the three cases above are a single sample: they run
 * `scanWriteSites` over one real tree, in which every expectation already
 * holds, so an inverted filter or a needle that matches nothing would be
 * invisible. These cases make it fail and pass on demand.
 */
describe("scanWriteSites", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function fixture(files: Record<string, string>): string {
    dir = mkdtempSync(path.join(tmpdir(), "ugcportal-write-paths-"));
    for (const [name, contents] of Object.entries(files)) {
      const full = path.join(dir, name);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
    return dir;
  }

  it.each(WRITE_NEEDLES)("finds a file that names %j", (needle) => {
    const root = fixture({
      "nested/writer.ts": `export const x = () => ({ ${needle} });\n`,
    });

    expect(scanWriteSites(root)).toEqual(["nested/writer.ts"]);
  });

  it("ignores a needle that appears only in a comment", () => {
    const root = fixture({
      "reader.ts": `// benefitSourceId is written by the disclosure route.\nexport const x = 1;\n`,
    });

    expect(scanWriteSites(root)).toEqual([]);
  });

  it("ignores test files, which is the exclusion this file relies on", () => {
    const root = fixture({
      "writer.test.ts": `export const x = { benefitSourceId: "a" };\n`,
      "writer.ts": `export const y = { benefitSourceId: "a" };\n`,
    });

    expect(scanWriteSites(root)).toEqual(["writer.ts"]);
  });

  it("finds nothing in a tree that writes no benefit source", () => {
    const root = fixture({ "unrelated.ts": `export const x = 1;\n` });

    expect(scanWriteSites(root)).toEqual([]);
  });
});
