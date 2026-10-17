import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  identifiersIn,
  isTestFile,
  stripComments,
  walkSourceFiles,
} from "@/lib/design/scan-source";
import { prismaModelWritesIn } from "@/lib/test-support/prisma-write-scan";

/**
 * ugcportal-74w.1 K3 and K4, as claims about the WHOLE TREE: the licence
 * grant column is written in exactly one place, read only beside the sale
 * gate, and never rendered as markup.
 *
 * MODELLED ON src/lib/sellability-signal.test.ts, which makes the same two
 * claims about `priceCents`, and for the same reasons — read its header for
 * why this is an AST walk rather than a grep and why a `select` counts as a
 * read. The one difference worth stating: a stored grant is a promise about
 * what a buyer receives, and like a stored price it stays exactly as written
 * while the clearance behind it lapses, the review expires or the triage
 * signer is demoted. So a file that names the column without asking the gate
 * is one line away from showing a grant for an item this site may no longer
 * sell.
 *
 * WHAT COUNTS AS ASKING THE GATE is the same two tiers as the price scan:
 * the gate itself (`evaluateSellability`, `isSellable`), or a named
 * indirection whose own defining file is asserted below to call it
 * (`recordPrice`, `publicOffer`, `getPublicOffer`).
 *
 * THE KNOWN BLIND SPOTS are the price scan's, unchanged: a column name built
 * in a string (`row.listing["licenceTerms"]`, ugcportal-1xhs) and a raw SQL
 * statement are not identifiers, so neither is seen. Both have to be written
 * on purpose.
 */

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The column this file governs. */
const TERMS = "licenceTerms";

/** The gate, by name. */
const GATE_NAMES = ["evaluateSellability", "isSellable"] as const;

/** Stand-ins for the gate, each mapped to the file that defines it. */
const GATED_INDIRECTIONS: Readonly<Record<string, string>> = {
  recordPrice: "lib/curation-price-write.ts",
  publicOffer: "lib/sellable-media.ts",
  getPublicOffer: "lib/sellable-media.ts",
};

/**
 * Files that name the column and do not ask the gate, each with its reason.
 * Every one of them handles a value somebody else already gated; none reads
 * a row.
 */
const ALLOWED_WITHOUT_GATE: Readonly<Record<string, string>> = {
  "app/admin/curation/price-form.tsx":
    "the admin form field; it round-trips the stored grant into a textarea, the screen that mounts it runs evaluateSellability over the same row, and recordPrice re-runs the gate on submit",
  "lib/pricing.ts":
    "declares the PublicOffer type the field travels in; a pure module with no row, no query and no gate by construction",
  "components/media/purchase-offer.tsx":
    "renders the PublicOffer it is handed and decides nothing; its one producer is publicOffer, which asks isSellable first and is itself required to below",
};

/** The render path for a buyer: every file between the row and the markup. */
const RENDER_PATH = [
  "lib/sellable-media.ts",
  "components/media/purchase-offer.tsx",
  "app/media/[previewId]/page.tsx",
] as const;

const UNSAFE_HTML = "dangerouslySetInnerHTML";

function relativeTo(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Every non-test file under `root` naming the column as an identifier. */
export function termsReaders(root: string): string[] {
  return walkSourceFiles(root, (file) => isTestFile(file))
    .filter((file) => identifiersIn(file).has(TERMS))
    .map((file) => relativeTo(root, file))
    .sort();
}

/** Those readers that name neither the gate nor a gated indirection. */
export function ungatedTermsReaders(root: string): string[] {
  return termsReaders(root).filter((relative) => {
    const names = identifiersIn(path.join(root, relative));
    if (GATE_NAMES.some((gate) => names.has(gate))) return false;
    return !Object.keys(GATED_INDIRECTIONS).some((name) => names.has(name));
  });
}

/**
 * Every non-test file with a Prisma write of `mediaListing` — direct, or
 * nested through the `listing` relation — whose payload names the column
 * as code. Comments are stripped first, for the reason the price scan's
 * `namesPriceColumn` gives.
 */
export function termsWriters(root: string): string[] {
  const namesColumn = (argument: string): boolean =>
    new RegExp(`\\b${TERMS}\\b`).test(stripComments(`(${argument})`, "terms-write.ts"));
  return walkSourceFiles(root, (file) => isTestFile(file))
    .filter((file) =>
      prismaModelWritesIn(file, { model: "mediaListing", relationField: "listing" }).some(
        (write) => namesColumn(write.argument),
      ),
    )
    .map((file) => relativeTo(root, file))
    .sort();
}

/** Of the given files, those naming `dangerouslySetInnerHTML` as code. */
export function unsafeHtmlIn(root: string, relatives: readonly string[]): string[] {
  return relatives
    .filter((relative) => identifiersIn(path.join(root, relative)).has(UNSAFE_HTML))
    .sort();
}

/** ONE WALK of `src/` per question, shared by every case (ugcportal-9faa). */
let cachedReaders: string[] | undefined;
let cachedUngated: string[] | undefined;
let cachedWriters: string[] | undefined;
const readers = () => (cachedReaders ??= termsReaders(SRC_ROOT));
const ungated = () => (cachedUngated ??= ungatedTermsReaders(SRC_ROOT));
const writers = () => (cachedWriters ??= termsWriters(SRC_ROOT));

describe("the licence grant is written by recordPrice alone (ugcportal-74w.1 K3)", () => {
  it("finds the one writer, and it is the gated chokepoint", () => {
    // `toEqual` on a one-element list: an empty result (a broken walker) and
    // a second writer both fail it.
    expect(writers()).toEqual(["lib/curation-price-write.ts"]);
  });
});

describe("the licence grant is read only beside the gate (ugcportal-74w.1 K3)", () => {
  it("finds readers at all, including the render path's own", () => {
    // Guards every negative below against a walker that found nothing.
    expect(readers()).toContain("lib/sellable-media.ts");
    expect(readers()).toContain("lib/curation-price-write.ts");
  });

  it("reports nothing outside the written-down allowlist", () => {
    expect(ungated()).toEqual(Object.keys(ALLOWED_WITHOUT_GATE).sort());
  });

  it("keeps no stale allowlist entry, and every entry carries a reason", () => {
    for (const [relative, reason] of Object.entries(ALLOWED_WITHOUT_GATE)) {
      expect(ungated(), `${relative} no longer needs its allowlist entry`).toContain(relative);
      expect(reason.trim().length, relative).toBeGreaterThan(10);
    }
  });

  it("every gated indirection is itself gated, so tier B is not a hole", () => {
    for (const [name, relative] of Object.entries(GATED_INDIRECTIONS)) {
      const names = identifiersIn(path.join(SRC_ROOT, relative));
      expect(names.has(name), `${relative} does not define ${name}`).toBe(true);
      expect(
        GATE_NAMES.some((gate) => names.has(gate)),
        `${relative} stands in for the gate but never calls it`,
      ).toBe(true);
    }
  });
});

describe("the licence grant is never rendered as markup (ugcportal-74w.1 K4)", () => {
  it("no file that names the column, and no file on the buyer's render path, uses dangerouslySetInnerHTML", () => {
    const files = [...new Set([...readers(), ...RENDER_PATH])];
    // The render path really is there: a renamed file would otherwise drop
    // out of this check silently.
    expect(files).toEqual(expect.arrayContaining([...RENDER_PATH]));
    expect(unsafeHtmlIn(SRC_ROOT, files)).toEqual([]);
  });
});

describe("the scanners themselves, against a fixture tree (ugcportal-74w.1 K3/K4)", () => {
  const roots: string[] = [];

  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "licence-terms-signal-"));
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

  it("FAILS on a second file writing the column, direct or nested", () => {
    const root = tree({
      "lib/curation-price-write.ts":
        "export const w = (tx) => tx.mediaListing.update({ where: { id: 'x' }, data: { licenceTerms: 'ok' } });",
      "lib/scratch-direct.ts":
        "export const s = (p) => p.mediaListing.upsert({ where: { id: 'x' }, create: {}, update: { licenceTerms: 'x' } });",
      "lib/scratch-nested.ts":
        "export const n = (p) => p.media.update({ where: { id: 'x' }, data: { listing: { update: { licenceTerms: 'x' } } } });",
      // A write that only MENTIONS the column in a comment is not a writer.
      "lib/prose-write.ts":
        "export const q = (p) => p.mediaListing.update({ where: { id: 'x' }, data: { /* never licenceTerms here */ priceCents: 1 } });",
    });
    expect(termsWriters(root)).toEqual([
      "lib/curation-price-write.ts",
      "lib/scratch-direct.ts",
      "lib/scratch-nested.ts",
    ]);
  });

  it("FAILS on a reader with no gate call, and PASSES one that asks the gate or a gated indirection", () => {
    const root = tree({
      "app/shop/page.tsx":
        "export default function Shop({ row }) { return <p>{row.listing.licenceTerms}</p>; }",
      "lib/gated.ts": [
        'import { isSellable } from "@/lib/resale-rights";',
        "export const g = (r) => (isSellable(r) ? r.listing.licenceTerms : null);",
      ].join("\n"),
      "lib/indirect.ts": [
        'import { recordPrice } from "@/lib/curation-price-write";',
        "export const i = (licenceTerms) => recordPrice({ licenceTerms });",
      ].join("\n"),
      "lib/prose.ts": '// licenceTerms is read behind the gate.\nexport const NOTE = "licenceTerms";',
    });
    expect(ungatedTermsReaders(root)).toEqual(["app/shop/page.tsx"]);
  });

  it("FAILS on a render path that uses dangerouslySetInnerHTML, and not on one that mentions it in prose", () => {
    const root = tree({
      "components/bad.tsx":
        "export const B = ({ t }) => <p dangerouslySetInnerHTML={{ __html: t }} />;",
      "components/good.tsx":
        "// never dangerouslySetInnerHTML here\nexport const G = ({ t }) => <p>{t}</p>;",
    });
    expect(unsafeHtmlIn(root, ["components/bad.tsx", "components/good.tsx"])).toEqual([
      "components/bad.tsx",
    ]);
  });
});
