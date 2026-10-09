import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import {
  isTestFile,
  sourceFileOf,
  stripComments,
  walkSourceFiles,
} from "@/lib/design/scan-source";
import { prismaModelWritesIn } from "@/lib/test-support/prisma-write-scan";

/**
 * ugcportal-yzo7 K5, as a claim about the WHOLE TREE: a stored price is
 * never read anywhere without the gate being asked in the same file.
 *
 * THE FAILURE THIS EXISTS TO PREVENT, stated once. `MediaListing.priceCents`
 * is written behind `evaluateSellability` and then sits there. Everything
 * that made it writable can stop holding with no write to that row at all —
 * the uploader's review is revoked or expires, its `validUntil` simply
 * passes, the checklist version it was granted under is retired, the admin
 * who signed the triage is demoted (see src/lib/sellable-media.ts for the
 * full list). A surface that rendered "this item is for sale" because
 * `priceCents !== null` would be wrong in every one of those cases, and
 * wrong in the expensive direction: it would offer a licence this site has
 * no standing to grant.
 *
 * STRUCTURAL, NOT A SUBSTRING SCAN, and deliberately so. A
 * `source.includes("priceCents")` scan reports every file that merely
 * MENTIONS the column in prose — this repo has several — at which point the
 * allowlist below becomes a list of files that talk about prices and stops
 * meaning anything about files that read one. The scan walks the AST and
 * counts only `priceCents` appearing as an IDENTIFIER node: a comment is not
 * a node and a string literal is not an identifier. It is also therefore
 * immune to the shape ugcportal-xqal records, where an AST matcher looking
 * for one specific call expression missed the same call behind a ternary —
 * this matcher asks "does the name occur in the syntax tree at all", so
 * there is no expression shape to hide inside. The fixture cases at the
 * bottom drive exactly that: the same read behind a ternary, inside a
 * template substitution, and through a computed member access.
 *
 * DELIBERATELY OVER-INCLUSIVE. An object literal `{ priceCents: true }` (a
 * Prisma select) and a write payload `{ priceCents: 0 }` are both reported
 * as occurrences, even though neither reads a row's value. That is the safe
 * direction: a file that selects the column is a file one line away from
 * rendering it, and the cost of the false positive is one allowlist entry
 * with a reason. The cost of the other error is a licence sold on a revoked
 * clearance.
 *
 * WHAT COUNTS AS ASKING THE GATE, in two tiers, because a single tier would
 * be either too strict or trivially launderable:
 *
 *   Tier A — the gate itself: `evaluateSellability` or `isSellable`
 *            (src/lib/resale-rights.ts).
 *   Tier B — a named indirection that is ITSELF required by this same scan
 *            to be tier A. `recordPrice`, `publicOffer` and `getPublicOffer`
 *            qualify, and the file each is defined in is asserted below to
 *            satisfy tier A. Without that second assertion, tier B would be
 *            a hole: anybody could add a wrapper, name it here, and the
 *            whole rule would be satisfied by a function that asks nothing.
 */

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The column whose readers this file governs. */
const PRICE = "priceCents";

/** The gate, by name. Nothing else counts as asking it. */
const GATE_NAMES = ["evaluateSellability", "isSellable"] as const;

/**
 * Indirections that stand in for the gate, each mapped to the file it is
 * defined in — which must itself reference a tier-A name, asserted below.
 */
const GATED_INDIRECTIONS: Readonly<Record<string, string>> = {
  recordPrice: "lib/curation-price-write.ts",
  publicOffer: "lib/sellable-media.ts",
  getPublicOffer: "lib/sellable-media.ts",
};

/**
 * Files that read or name `priceCents` and legitimately do not ask the gate,
 * each with the reason. An allowlist of one; adding to it is a decision
 * somebody writes down, not a default.
 */
const ALLOWED_WITHOUT_GATE: Readonly<Record<string, string>> = {
  // The admin price FIELD. It renders the number an admin typed, into the
  // form they typed it in, and decides nothing: the screen that mounts it
  // (app/admin/curation/page.tsx) runs `evaluateSellability` over the same
  // row and renders the verdict beside this form, and the write the form
  // submits to runs it again. A gate call here would be a third evaluation
  // of a question already answered twice on the same request.
  "app/admin/curation/price-form.tsx":
    "an admin form field; the screen renders the gate verdict beside it and recordPrice re-runs the gate on submit",
  // The pure value module: bounds, the currency allowlist, and the display
  // format. It answers "is this amount storable" and "how does this amount
  // read", never "may this be sold" — and it deliberately imports nothing,
  // so it CANNOT ask the gate without pulling `@/lib/prisma` into the two
  // React components that depend on it. See its own header for the measured
  // failure that split it out.
  "lib/pricing.ts":
    "a pure amount module with no row, no query and no gate by construction; its two consumers are the gated writer and the gated render path",
};

/** Every identifier name that occurs anywhere in one file's syntax tree. */
export function identifiersIn(file: string): Set<string> {
  const names = new Set<string>();
  const source = sourceFileOf(file);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/**
 * Files that name `priceCents` and do NOT name the gate, relative to `src/`
 * with POSIX separators. The allowlist is applied by the caller, not here,
 * so the scanner's own fixture cases can see what it really reports.
 */
export function scanUngatedPriceReaders(root: string): string[] {
  return walkSourceFiles(root, (file) => isTestFile(file))
    .filter((file) => {
      const names = identifiersIn(file);
      if (!names.has(PRICE)) return false;
      if (GATE_NAMES.some((gate) => names.has(gate))) return false;
      return !Object.keys(GATED_INDIRECTIONS).some((name) => names.has(name));
    })
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .sort();
}

/**
 * ONE WALK OF `src/`, shared by every case below — required by
 * scripts/tree-walk-timeout-guard.test.mjs and for its reason
 * (ugcportal-9faa).
 */
let cachedUngated: string[] | undefined;
function ungated(): string[] {
  return (cachedUngated ??= scanUngatedPriceReaders(SRC_ROOT));
}

let cachedReaders: string[] | undefined;
function priceReaders(): string[] {
  return (cachedReaders ??= walkSourceFiles(SRC_ROOT, (file) => isTestFile(file))
    .filter((file) => identifiersIn(file).has(PRICE))
    .map((file) => path.relative(SRC_ROOT, file).split(path.sep).join("/"))
    .sort());
}

describe("no path reads a stored price as a sellability signal (ugcportal-yzo7 K5)", () => {
  it("finds price readers at all", () => {
    // Guards every assertion below against passing because the walker or the
    // matcher broke and came back with nothing — the failure mode that makes
    // a whole-tree scan decoration.
    expect(priceReaders().length).toBeGreaterThan(0);
  });

  it("reports nothing outside the written-down allowlist", () => {
    expect(ungated()).toEqual(Object.keys(ALLOWED_WITHOUT_GATE).sort());
  });

  it("keeps no stale allowlist entry", () => {
    /*
     * The other direction, and the one that rots silently: a file allowed
     * here that has since started asking the gate (or stopped naming a price
     * at all) is an exemption nobody needs, and leaving it sitting here makes
     * the next reader believe an exemption was required. Deleting a file
     * named here fails too.
     */
    for (const relative of Object.keys(ALLOWED_WITHOUT_GATE)) {
      expect(ungated(), `${relative} no longer needs its allowlist entry`).toContain(
        relative,
      );
    }
  });

  it("every allowlist entry carries a reason", () => {
    for (const [relative, reason] of Object.entries(ALLOWED_WITHOUT_GATE)) {
      expect(reason.trim().length, relative).toBeGreaterThan(10);
    }
  });

  it("every gated indirection is itself gated — tier B is not a hole", () => {
    /*
     * Without this, `GATED_INDIRECTIONS` would be a way to satisfy the whole
     * rule by naming a function that asks nothing. Each stand-in's own
     * defining file has to reference a tier-A name.
     */
    for (const [name, relative] of Object.entries(GATED_INDIRECTIONS)) {
      const file = path.join(SRC_ROOT, relative);
      const names = identifiersIn(file);
      expect(names.has(name), `${relative} does not define ${name}`).toBe(true);
      expect(
        GATE_NAMES.some((gate) => names.has(gate)),
        `${relative} stands in for the gate but never calls it`,
      ).toBe(true);
    }
  });

  it("the render path for an offer is one of the readers, and is gated", () => {
    // A positive case beside the negative ones: "nothing is ungated" is also
    // true of a tree in which nothing reads a price at all, which is the
    // state this bead found the repository in.
    expect(priceReaders()).toContain("lib/sellable-media.ts");
    expect(ungated()).not.toContain("lib/sellable-media.ts");
  });
});

/**
 * The other half of the same claim: the column is WRITTEN in one place too.
 *
 * `MediaListing` has several writers — `recordTriageFacts` upserts the
 * triage columns onto the same table — so "one writer of this table" is
 * false and is not what is asserted. What is asserted is narrower and is
 * the thing that matters: of every Prisma write of `mediaListing` anywhere
 * under `src/`, exactly one names `priceCents` in its payload, and it is
 * the gated chokepoint. A second one would mean a price set without the
 * uploader's clearance or the preview ever being checked.
 */
describe("exactly one Prisma write names the price column (ugcportal-yzo7 K1)", () => {
  /**
   * Does one write's payload actually name the column — as code, not in a
   * comment inside it?
   *
   * The comment half is not hypothetical and is why this is not a bare
   * regex over `write.argument`: `recordTriageFacts`' upsert carries a
   * comment saying "in particular `priceCents` and `currency` are not
   * settable from this screen", which is a sentence asserting the OPPOSITE
   * of what a text match would read it as. Measured: the first version of
   * this case reported src/lib/curation-triage-write.ts for exactly that.
   *
   * Parenthesised before stripping so the payload parses as an EXPRESSION;
   * an object literal alone at statement position is a block, and
   * `stripComments` fails closed on a file that did not parse cleanly —
   * handing back the source whole, comments and all, which would reinstate
   * the bug it is here to fix.
   */
  function namesPriceColumn(argument: string): boolean {
    return /\bpriceCents\b/.test(
      stripComments(`(${argument})`, "price-write-argument.ts"),
    );
  }

  function priceWriteFiles(): string[] {
    return walkSourceFiles(SRC_ROOT, (file) => isTestFile(file))
      .filter((file) =>
        prismaModelWritesIn(file, {
          model: "mediaListing",
          // `listing` is the relation a nested `data: { listing: { update:
          // … } }` would go through — the shape a screen writing a price
          // alongside something else would reach for first.
          relationField: "listing",
        }).some((write) => namesPriceColumn(write.argument)),
      )
      .map((file) => path.relative(SRC_ROOT, file).split(path.sep).join("/"))
      .sort();
  }

  it("is the gated chokepoint, and only it", () => {
    expect(priceWriteFiles()).toEqual(["lib/curation-price-write.ts"]);
  });
});

describe("the scanner itself, against a fixture tree (ugcportal-yzo7 K5)", () => {
  const roots: string[] = [];

  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "price-signal-"));
    roots.push(root);
    for (const [relative, contents] of Object.entries(files)) {
      const full = path.join(root, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("FAILS on a render path that reads a price with no gate call", () => {
    const root = tree({
      "app/shop/page.tsx": [
        "export default function Shop({ row }) {",
        "  return row.listing.priceCents !== null ? <p>For sale</p> : null;",
        "}",
      ].join("\n"),
    });
    expect(scanUngatedPriceReaders(root)).toEqual(["app/shop/page.tsx"]);
  });

  it("FAILS on the same read hidden behind a ternary, a template and a computed access", () => {
    /*
     * The shape ugcportal-xqal records: an AST matcher hunting one call
     * expression missed the same call behind a ternary. This matcher asks
     * whether the NAME occurs in the tree, so none of these three hides it —
     * run, not described, because "it cannot hide" is exactly the claim a
     * fixture has to prove.
     */
    const root = tree({
      "lib/ternary.ts": "export const a = (r) => (r.ok ? r.listing.priceCents : 0);",
      "lib/template.ts": "export const b = (r) => `${r.listing.priceCents} NOK`;",
      "lib/computed.ts": [
        "const field = 'priceCents';",
        "export const c = (r) => r.listing[field];",
      ].join("\n"),
    });
    /*
     * `computed.ts` is deliberately ABSENT from the expectation, and that is
     * this scan's one real blind spot written down rather than discovered.
     * `r.listing["priceCents"]` through a string constant puts the column
     * name in a STRING, and a string literal is not an identifier — the same
     * property that makes this scan ignore prose makes it ignore this. It is
     * not closed here and no comment in this file should be read as saying
     * it is: closing it would mean constant-folding string values, which is
     * the start of re-implementing the compiler. What bounds it is that the
     * shape has to be written on purpose; filed as ugcportal-1xhs.
     */
    expect(scanUngatedPriceReaders(root)).toEqual([
      "lib/template.ts",
      "lib/ternary.ts",
    ]);
  });

  it("PASSES a reader that asks the gate in the same file", () => {
    const root = tree({
      "lib/offer.ts": [
        'import { isSellable } from "@/lib/resale-rights";',
        "export const offer = (r) =>",
        "  isSellable(r) ? r.listing.priceCents : null;",
      ].join("\n"),
    });
    expect(scanUngatedPriceReaders(root)).toEqual([]);
  });

  it("PASSES a reader that goes through a gated indirection", () => {
    const root = tree({
      "app/admin/act.ts": [
        'import { recordPrice } from "@/lib/curation-price-write";',
        "export const act = (priceCents) => recordPrice({ priceCents });",
      ].join("\n"),
    });
    expect(scanUngatedPriceReaders(root)).toEqual([]);
  });

  it("does NOT report a file that only mentions the column in prose or a string", () => {
    /*
     * The reason this is an AST walk rather than a grep. Several files in
     * this repo discuss `priceCents` in a comment and read nothing; a text
     * scan would have to allowlist each of them, and an allowlist is where a
     * scan like this stops meaning what it says.
     */
    const root = tree({
      "lib/prose.ts": [
        "// A render path must never treat priceCents as permission.",
        "/* priceCents is written behind the gate. */",
        'export const NOTE = "priceCents";',
      ].join("\n"),
    });
    expect(scanUngatedPriceReaders(root)).toEqual([]);
  });

  it("reports a Prisma select naming the column, which is the over-inclusive direction", () => {
    // Stated as a test rather than only in the header: a select is one line
    // from a render, and this scan deliberately treats it as a reader.
    const root = tree({
      "lib/select.ts": "export const S = { listing: { select: { priceCents: true } } };",
    });
    expect(scanUngatedPriceReaders(root)).toEqual(["lib/select.ts"]);
  });
});
