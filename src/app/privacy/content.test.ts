import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isTestFile, stripComments, walkSourceFiles } from "@/lib/design/scan-source";

import {
  MODEL_COVERAGE,
  PRIVACY_CATEGORIES,
  PRIVACY_COOKIES,
  PRIVACY_RIGHTS,
  UNDETERMINED_RETENTION_TEXT,
  retentionText,
  type Retention,
} from "./content";

/**
 * ugcportal-qnq9.4: the privacy statement is held to the code.
 *
 *  - K2: every Prisma model is mapped to a category (or explicitly to
 *    "not personal data"), so a new table forces a decision about the page.
 *  - K3: an undetermined retention renders the fixed sentence and never a
 *    number of days/months/years.
 *  - K5: every file a category claims as its backing exists, and the two
 *    negative claims the page makes about the application ("does not record
 *    your IP address or browser", "sets no cookies of its own when browsing")
 *    are checked against the source tree, not asserted from memory.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

function schemaModels(): string[] {
  const schema = readFileSync(path.join(REPO_ROOT, "prisma", "schema.prisma"), "utf8");
  return Array.from(schema.matchAll(/^model\s+(\w+)\s*\{/gm), (m) => m[1]);
}

const categoryIds = new Set(PRIVACY_CATEGORIES.map((category) => category.id));

/** A number followed by a unit of time — the thing K3 forbids inventing. */
const NUMERIC_PERIOD = /\b\d+\s*(?:day|week|month|year)s?\b/i;

describe("K2: every model in prisma/schema.prisma is covered", () => {
  const models = schemaModels();

  it("reads the schema", () => {
    expect(models.length).toBeGreaterThan(5);
    expect(models).toContain("User");
  });

  it.each(models)("%s has an entry in MODEL_COVERAGE", (model) => {
    expect(MODEL_COVERAGE, `add ${model} to MODEL_COVERAGE in content.ts`).toHaveProperty(
      model,
    );
  });

  it("maps each covered model to a category that exists", () => {
    for (const [model, coverage] of Object.entries(MODEL_COVERAGE)) {
      if ("category" in coverage) {
        expect(categoryIds, `${model} -> ${coverage.category}`).toContain(coverage.category);
      } else {
        expect(coverage.notPersonalData.length).toBeGreaterThan(10);
      }
    }
  });

  it("has no entry for a model the schema no longer has", () => {
    // The map can go stale in the other direction too: a renamed model
    // would otherwise keep its old, now-meaningless entry forever.
    const live = new Set(models);
    for (const model of Object.keys(MODEL_COVERAGE)) {
      expect(live, `${model} is not in prisma/schema.prisma`).toContain(model);
    }
  });

  it("would fail on a model missing from the map", () => {
    // The needle-can-be-absent control for the it.each above.
    expect(MODEL_COVERAGE).not.toHaveProperty("NotARealModel");
  });
});

describe("K1: every category states the Art. 13 items", () => {
  it.each(PRIVACY_CATEGORIES.map((category) => [category.id, category] as const))(
    "%s",
    (_id, category) => {
      expect(category.what.length).toBeGreaterThan(0);
      expect(category.purpose.length).toBeGreaterThan(10);
      expect(category.legalBasis).toMatch(/Art\. 6\(1\)\([a-f]\)/);
      expect(category.recipients.length).toBeGreaterThan(5);
      expect(category.access.length).toBeGreaterThan(5);
      expect(retentionText(category.retention).length).toBeGreaterThan(10);
    },
  );

  it("uses each category id once", () => {
    expect(categoryIds.size).toBe(PRIVACY_CATEGORIES.length);
  });
});

describe("K3: an undetermined retention is never a number", () => {
  const undetermined = PRIVACY_CATEGORIES.filter(
    (category) => category.retention.kind === "undetermined",
  );

  it("has at least one undetermined period while ugcportal-yck is open", () => {
    expect(undetermined.length).toBeGreaterThan(0);
  });

  it.each(undetermined.map((category) => [category.id, category.retention] as const))(
    "%s renders the fixed sentence and no period",
    (_id, retention) => {
      const text = retentionText(retention);
      expect(text.startsWith(UNDETERMINED_RETENTION_TEXT)).toBe(true);
      expect(text).not.toMatch(NUMERIC_PERIOD);
    },
  );

  it("the fixed sentence itself names no period", () => {
    expect(UNDETERMINED_RETENTION_TEXT).not.toMatch(NUMERIC_PERIOD);
  });

  it("would catch a number smuggled into an undetermined entry", () => {
    // Mutate the fixture: the matcher above must have a failing case.
    const smuggled: Retention = { kind: "undetermined", today: "Kept for 90 days." };
    expect(retentionText(smuggled)).toMatch(NUMERIC_PERIOD);
    const stated: Retention = { kind: "stated", text: "Deleted on request." };
    expect(retentionText(stated).startsWith(UNDETERMINED_RETENTION_TEXT)).toBe(false);
  });

  it("a stated period is one the code enforces: sessions, uploads", () => {
    // The only two retention facts the code makes true today. Anything
    // else claiming a period has to come with the file that enforces it.
    const stated = PRIVACY_CATEGORIES.filter(
      (category) => category.retention.kind === "stated",
    ).map((category) => category.id);
    expect(stated.sort()).toEqual(["sessions", "uploads"]);
  });
});

describe("K5: every claim points at a file that exists", () => {
  const sources = [
    ...PRIVACY_CATEGORIES.map((category) => [category.id, category.backedBy] as const),
    [PRIVACY_COOKIES.id, PRIVACY_COOKIES.backedBy] as const,
    [PRIVACY_RIGHTS.id, PRIVACY_RIGHTS.backedBy] as const,
  ];

  it.each(sources)("%s", (_id, backedBy) => {
    expect(backedBy.length).toBeGreaterThan(0);
    for (const file of backedBy) {
      expect(existsSync(path.join(REPO_ROOT, file)), file).toBe(true);
    }
  });

  it("would notice a renamed file", () => {
    expect(existsSync(path.join(REPO_ROOT, "src/lib/does-not-exist.ts"))).toBe(false);
  });
});

/**
 * The two negative claims, checked mechanically. Application source only:
 * tests and the generated Prisma client are excluded, and so is this file.
 */
function applicationSources(): { file: string; code: string }[] {
  return walkSourceFiles(SRC_ROOT, (file) => isTestFile(file) || file.includes("/generated/"))
    .map((file) => ({
      file: path.relative(REPO_ROOT, file),
      code: stripComments(readFileSync(file, "utf8")),
    }));
}

describe("the negative claims hold against the source tree", () => {
  const sources = applicationSources();

  it("scans the application", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it("nothing reads a visitor's IP address or user agent", () => {
    // "the application code does not record your IP address, your browser
    // or what you looked at" (category `visitors`, `logs`).
    const pattern = /x-forwarded-for|x-real-ip|remoteAddress|user-agent|userAgent/i;
    const offenders = sources.filter(({ code }) => pattern.test(code)).map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it("only the Instagram connect flow sets a cookie by hand", () => {
    // "If you only browse, this site sets no cookies of its own": Auth.js
    // sets its own cookies inside the library, and the one first-party
    // cookie this code writes is the admin-only OAuth state cookie.
    const pattern = /cookies\(\)|\.cookies\.set\(|set-cookie/i;
    const offenders = sources.filter(({ code }) => pattern.test(code)).map((s) => s.file);
    const instagramConnectFlow = new Set([
      "src/app/api/admin/instagram/callback/route.ts",
      "src/app/api/admin/instagram/connect/route.ts",
      "src/lib/instagram-oauth-state.ts",
    ]);
    expect(offenders.filter((file) => !instagramConnectFlow.has(file))).toEqual([]);
    // The control: the pattern does find the route that sets the cookie
    // (instagram-oauth-state.ts only defines its options).
    expect(offenders).toContain("src/app/api/admin/instagram/connect/route.ts");
  });

  it("no third-party script is loaded from the layout", () => {
    // "loads no analytics, advertising or social-media scripts"
    const layout = readFileSync(path.join(SRC_ROOT, "app", "layout.tsx"), "utf8");
    expect(stripComments(layout)).not.toMatch(/next\/script|<script|umami|gtag|analytics/i);
  });
});
