import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isTestFile, stripComments, walkSourceFiles } from "@/lib/design/scan-source";
import {
  FILLED_CONTACT,
  REPO_ROOT,
  itReviewPointersExist,
} from "@/lib/legal/legal-page.test-support";

import { type LegalProseSection, sectionTexts } from "@/lib/legal/section";

import {
  MODEL_COVERAGE,
  UNDETERMINED_RETENTION_TEXT,
  privacyContent,
  privacyProseSections,
  privacyTexts,
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
 *  - K5: every review pointer names a file that exists (a re-prompt, not a
 *    proof — see src/lib/legal/section.ts), and the negative claims the page
 *    makes about the application ("does not record your IP address or
 *    browser", "sets no cookies of its own when browsing") are checked
 *    against the source tree, not asserted from memory.
 */

const SRC_ROOT = path.join(REPO_ROOT, "src");
const content = privacyContent(FILLED_CONTACT);
const categoryIds = new Set(content.categories.map((category) => category.id));

function schemaModels(): string[] {
  const schema = readFileSync(path.join(REPO_ROOT, "prisma", "schema.prisma"), "utf8");
  return Array.from(schema.matchAll(/^model\s+(\w+)\s*\{/gm), (m) => m[1]);
}

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
  it.each(content.categories.map((category) => [category.id, category] as const))(
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

  it("uses each category id once, and no prose section reuses one", () => {
    expect(categoryIds.size).toBe(content.categories.length);
    for (const section of privacyProseSections(content)) {
      expect(categoryIds).not.toContain(section.id);
    }
  });

  it("scans every prose section the content declares (one enumeration, round 4)", () => {
    // privacyTexts derives its section list from privacyProseSections, and
    // privacyProseSections must name every LegalProseSection on the content
    // object — so a sixth section cannot be added without being scanned.
    const declared = Object.values(content).filter(
      (value): value is LegalProseSection =>
        typeof value === "object" && value !== null && "paragraphs" in value,
    );
    expect(privacyProseSections(content)).toEqual(declared);
    const texts = privacyTexts(content);
    for (const section of declared) {
      for (const text of sectionTexts(section)) {
        expect(texts).toContain(text);
      }
    }
  });

  it("puts the configured contact where Art. 13 wants it", () => {
    expect(content.controller.paragraphs.join(" ")).toContain(FILLED_CONTACT.controllerName);
    expect(content.controller.paragraphs.join(" ")).toContain(FILLED_CONTACT.contactEmail);
    expect(content.rights.paragraphs.join(" ")).toContain(FILLED_CONTACT.contactEmail);
    expect(content.transfers.paragraphs.join(" ")).toContain(FILLED_CONTACT.hostingProvider);
    expect(content.transfers.paragraphs.join(" ")).toContain(FILLED_CONTACT.storageProvider);
  });
});

describe("K3: an undetermined retention is never a number", () => {
  const undetermined = content.categories.filter(
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
    const stated = content.categories
      .filter((category) => category.retention.kind === "stated")
      .map((category) => category.id);
    expect(stated.sort()).toEqual(["sessions", "uploads"]);
  });
});

describe("K5: every review pointer names a file that exists", () => {
  itReviewPointersExist([...content.categories, ...privacyProseSections(content)]);

  it("every category has at least one pointer", () => {
    // Prose sections may be pure policy; a data category never is.
    for (const category of content.categories) {
      expect(category.reviewAgainst.length, category.id).toBeGreaterThan(0);
    }
  });
});

/**
 * The negative claims, checked mechanically. Application source only:
 * tests, test support and the generated Prisma client are excluded.
 */
function applicationSources(): { file: string; code: string }[] {
  return walkSourceFiles(
    SRC_ROOT,
    (file) =>
      isTestFile(file) || file.includes("/generated/") || file.endsWith(".test-support.ts"),
  ).map((file) => ({
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
    // or what you looked at" (categories `visitors`, `logs`).
    const pattern = /x-forwarded-for|x-real-ip|remoteAddress|user-agent|userAgent/i;
    const offenders = sources.filter(({ code }) => pattern.test(code)).map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it("only the Instagram connect flow and the consent choice write a cookie by hand", () => {
    // "sets no cookies of its own" until the banner is answered: Auth.js
    // sets its cookies inside the library; this code writes exactly two of
    // its own — the admin-only OAuth state cookie, and the consent cookie
    // described in the statement (ugcportal-3wgp). `document.cookie =` is in
    // the pattern because that is how the consent cookie is written
    // (src/lib/cookies.ts); without it the pattern saw only server-side
    // writes and the claim was checked against half the code.
    const pattern = /cookies\(\)|\.cookies\.set\(|set-cookie|document\.cookie\s*=/i;
    const offenders = sources.filter(({ code }) => pattern.test(code)).map((s) => s.file);
    const described = new Set([
      "src/app/api/admin/instagram/callback/route.ts",
      "src/app/api/admin/instagram/connect/route.ts",
      "src/lib/instagram-oauth-state.ts",
      // The consent cookie: written and deleted through src/lib/cookies.ts,
      // read on the server by consent.server.ts (`cookies()`, read only),
      // and the gated loader clears a withdrawn script's cookies
      // (`clearAnalyticsCookies`). All three are what the statement's
      // "Cookies and consent" section says happens.
      "src/lib/cookies.ts",
      "src/lib/consent.server.ts",
      "src/components/consent/analytics-loader.tsx",
    ]);
    expect(offenders.filter((file) => !described.has(file))).toEqual([]);
    // The controls: the pattern does find the route that sets the Instagram
    // cookie (instagram-oauth-state.ts only defines its options) and the
    // one module that writes the consent cookie.
    expect(offenders).toContain("src/app/api/admin/instagram/connect/route.ts");
    expect(offenders).toContain("src/lib/cookies.ts");
  });

  it("the layout mounts no script of its own, only the consent-gated loader", () => {
    // "loads no analytics, advertising or social-media scripts" before the
    // banner is answered. The layout may not reach for next/script, a raw
    // <script> or a vendor directly; the one analytics-related thing it may
    // render is AnalyticsLoader, which is the single place a tracking script
    // may mount and is itself gated on consent (ugcportal-3wgp K2/K6, guarded
    // by eslint.config.mjs and analytics-host.grep.test.ts).
    const layout = stripComments(
      readFileSync(path.join(SRC_ROOT, "app", "layout.tsx"), "utf8"),
    );
    expect(layout).not.toMatch(/next\/script|<script|umami|gtag/i);
    expect(layout).toMatch(/@\/components\/consent\/analytics-loader/);
    // Any other "analytics" in the layout is a second mount point.
    expect(layout.replace(/analytics-loader|AnalyticsLoader/g, "")).not.toMatch(/analytics/i);
  });
});
