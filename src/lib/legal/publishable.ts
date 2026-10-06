import { createHash } from "node:crypto";

import { cache } from "react";

import {
  LEGAL_CONTACT_VARS,
  LEGAL_SIGN_OFF,
  SENTINEL_CONTACT,
  type LegalContact,
  type LegalContactField,
  type LegalContactVar,
  type LegalSignOff,
  readLegalContact,
} from "@/lib/legal/contact";

/**
 * When a legal page may be served, and whether it is still a draft
 * (ugcportal-qnq9.4).
 *
 * Three things keep a page in draft, and the first two also keep production
 * from serving it at all:
 *
 *  1. an unset LEGAL_* variable (src/lib/legal/contact.ts) that THIS page
 *     renders — the primary, binary signal. A privacy statement whose
 *     controller reads "[LEGAL_CONTROLLER_NAME]" does not satisfy GDPR
 *     Art. 13(1)(a) and is worse than no page, because it looks like
 *     compliance. Per page (round 5): the licence names the controller and
 *     the contact address and nothing else, so it is not held hostage by a
 *     storage provider it never mentions; which fields a page uses is read
 *     off its authored prose, not declared by hand;
 *  2. a stray placeholder in the AUTHORED prose — "[fill in later]", "TBD" —
 *     the second line, for text that slipped past review. Authored, not
 *     rendered: a page's prose is built once, from SENTINEL_CONTACT, so an
 *     operator value that happens to contain brackets or the word TBD is a
 *     set variable, not a placeholder, and never blocks the page (PR #90
 *     round 3);
 *  3. no human sign-off for THIS prose (LEGAL_SIGN_OFF, ugcportal-alg) —
 *     draft only. The sign-off names a digest per page; a page whose
 *     authored prose has changed since is not signed off (round 4). Not a
 *     configuration problem an operator can fix at deploy time, so it keeps
 *     the notice and the marker rather than the page.
 *
 * Fail-closed at two edges: at render (`assertPublishable`, called by each
 * page, so the guarantee holds however the app was started) and at boot
 * (`checkLegalPagesPublishable` from src/instrumentation.ts, so the operator
 * reads it in the first log lines rather than when the first visitor opens
 * the footer link). Both format the same `LegalReadiness` through one
 * function, so they cannot disagree. `env` is a parameter throughout so
 * tests exercise the production branch without mutating process.env.
 */

/**
 * Anything in square brackets, plus the bare words TODO and TBD in any case
 * as whole words. Broad on purpose (PR #90 round 1): the first version
 * matched only upper-case tokens and let "[fill in later]" through. The
 * legal pages contain no legitimate bracketed prose; if that changes,
 * reword the prose rather than narrow this.
 *
 * Carries the `g` flag because every caller goes through `matchAll`, which
 * requires it; do not use it with `.test()`, whose `lastIndex` would then
 * carry over between calls.
 */
export const PLACEHOLDER_PATTERN = /\[[^\]\n]+\]|\b(?:TODO|TBD)\b/gi;

/** Every placeholder token in the given texts, first-seen order, deduplicated. */
export function findPlaceholders(texts: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
      found.add(match[0]);
    }
  }
  return Array.from(found);
}

/**
 * A legal page as the guard sees it: its route and its AUTHORED prose. There
 * is deliberately no rendered-text field here (round 4): the only consumer
 * of the text-as-rendered is the test support, which derives it from the
 * content module itself, so nothing in production can scan the wrong tree
 * again.
 */
export type LegalPage = {
  /** The route, for messages and for the sign-off's digest map. */
  path: string;
  /** The prose this repository wrote, built once from SENTINEL_CONTACT. */
  authored: readonly string[];
  /** sha256 hex over `authored`, computed once; what a sign-off certifies. */
  authoredSha256: string;
  /**
   * The contact fields this page's prose actually interpolates — the ones
   * whose sentinel value appears in `authored`. Only their variables are
   * required for this page (round 5).
   */
  requires: readonly LegalContactField[];
};

/** The digest a sign-off records for a page's authored prose. */
export function authoredDigest(authored: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(authored)).digest("hex");
}

/**
 * The one way to build a LegalPage: evaluate the content module's text
 * function against the sentinel, once, at module load. Both pages go
 * through here, so both scan the same kind of thing and both derive what
 * they require the same way.
 */
export function legalPage(
  path: string,
  textsFor: (contact: LegalContact) => readonly string[],
): LegalPage {
  const authored = textsFor(SENTINEL_CONTACT);
  const requires = (Object.keys(SENTINEL_CONTACT) as LegalContactField[]).filter((field) =>
    authored.some((text) => text.includes(SENTINEL_CONTACT[field])),
  );
  return { path, authored, authoredSha256: authoredDigest(authored), requires };
}

export type LegalReadiness = {
  /** The routes this readiness describes, in the order given. */
  paths: string[];
  /**
   * The subset of `paths` that is actually blocked — a page whose OWN
   * `requires` names one of `missing`, or whose own authored prose has a
   * stray placeholder (ugcportal-qnq9.15 item 1, PR #90 round-6 cap: the
   * boot message used to name every page given, even one fully configured
   * and blocked by nothing, whenever ANY other given page was blocked).
   * `blockerWarning` names only these.
   */
  blockedPaths: string[];
  /** LEGAL_* variables that are unset AND required by at least one of the pages given. */
  missing: LegalContactVar[];
  /** Placeholders in the authored prose. */
  strayPlaceholders: { path: string; tokens: string[] }[];
  /** Route -> current digest of its authored prose, for recording a sign-off. */
  digests: Record<string, string>;
  /** True when a sign-off exists and its digest matches every page given. */
  signedOff: boolean;
  /** True while any of the three conditions above holds. */
  draft: boolean;
  /** True while either configuration condition holds; production refuses the page. */
  blocked: boolean;
};

export function legalReadiness(
  pages: readonly LegalPage[],
  env: NodeJS.ProcessEnv = process.env,
  signOff: LegalSignOff | null = LEGAL_SIGN_OFF,
): LegalReadiness {
  // Judge each page on the variables it renders, not on the whole set: the
  // union of the given pages' requirements, intersected with what is unset.
  const required = new Set<LegalContactVar>(
    pages.flatMap((page) => page.requires.map((field) => LEGAL_CONTACT_VARS[field])),
  );
  const missing = readLegalContact(env).missing.filter((name) => required.has(name));
  const missingSet = new Set(missing);
  const strayPlaceholders = pages
    .map((page) => ({ path: page.path, tokens: findPlaceholders(page.authored) }))
    .filter(({ tokens }) => tokens.length > 0);
  const strayPaths = new Set(strayPlaceholders.map(({ path }) => path));
  const blockedPaths = pages
    .filter(
      (page) =>
        page.requires.some((field) => missingSet.has(LEGAL_CONTACT_VARS[field])) ||
        strayPaths.has(page.path),
    )
    .map((page) => page.path);
  const digests = Object.fromEntries(pages.map((page) => [page.path, page.authoredSha256]));
  const blocked = missing.length > 0 || strayPlaceholders.length > 0;
  // A sign-off certifies specific words: a page whose prose has changed
  // since is unsigned, however the constant reads.
  const signedOff =
    signOff !== null &&
    pages.every((page) => signOff.authoredSha256[page.path] === page.authoredSha256);
  return {
    paths: pages.map((page) => page.path),
    blockedPaths,
    missing,
    strayPlaceholders,
    digests,
    signedOff,
    draft: blocked || !signedOff,
    blocked,
  };
}

/**
 * The message for a blocked readiness, or null when nothing blocks. One
 * formatter for the boot check and the render guard. Sign-off alone
 * produces nothing: it is not an operator's problem to fix.
 */
export function blockerWarning(
  readiness: LegalReadiness,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!readiness.blocked) {
    return null;
  }
  // Name only the pages actually blocked (ugcportal-qnq9.15 item 1), not
  // every page this readiness happens to describe: with /licence needing
  // only the controller and the contact (round 5), setting just those two
  // leaves /licence unblocked while /privacy still is — a message naming
  // both would send an operator to "fix" a page that already works.
  const paths = readiness.blockedPaths.join(", ");
  const lines: string[] = [];
  if (readiness.missing.length > 0) {
    lines.push(
      `[legal] ${readiness.missing.join(", ")} ${readiness.missing.length === 1 ? "is" : "are"} ` +
        `not set, so ${paths} cannot name the data controller and recipients GDPR Art. 13 ` +
        "requires. See env.example.",
    );
  }
  for (const { path, tokens } of readiness.strayPlaceholders) {
    lines.push(
      `[legal] ${path} still contains placeholder text (${tokens.join(", ")}); ` +
        "fix the prose in its content module.",
    );
  }
  lines.push(
    env.NODE_ENV === "production"
      ? `[legal] Production will not serve ${paths} until this is fixed.`
      : `[legal] Outside production ${paths} render with the problem visible.`,
  );
  return lines.join("\n");
}

/**
 * The boot-time check. A warning in EVERY environment while a page is
 * blocked — a fresh checkout from env.example is exactly where this is hit
 * first, the same reasoning as the sign-in check in src/instrumentation.ts
 * — with the consequence spelled out per environment.
 */
export function checkLegalPagesPublishable(
  pages: readonly LegalPage[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return blockerWarning(legalReadiness(pages, env), env);
}

/**
 * Called by each legal page at render, with the readiness its loader already
 * computed (round 4: once per request, not three times). Throws in
 * production while blocked, so Next serves its error page instead of a
 * statement with no controller; a no-op otherwise. Same formatter as the
 * boot check, so there is one definition of "blocked" and one message.
 */
export function assertPublishable(
  readiness: LegalReadiness,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== "production") {
    return;
  }
  const warning = blockerWarning(readiness, env);
  if (warning !== null) {
    throw new Error(warning);
  }
}

/** What a legal page's per-request loader returns — content, the page record, and its readiness. */
export type LegalPageLoad<TContent> = {
  content: TContent;
  page: LegalPage;
  readiness: LegalReadiness;
};

/**
 * Builds the one per-request loader every legal page needs (ugcportal-
 * qnq9.15 item 4: `loadPrivacy` and `loadLicence`, PR #90, were identical
 * cache()-wrapped boilerplate — the content built from the live contact,
 * the page record, and the readiness computed once and shared by
 * `generateMetadata`, the component and `assertPublishable`, round 4).
 *
 * Called once per legal page, at module load, each call producing its OWN
 * `cache()`-wrapped function — a third legal page adds one line here, not a
 * fourth copy of this shape.
 */
export function createLegalPageLoader<TContent>(
  page: LegalPage,
  contentFor: (contact: LegalContact) => TContent,
): (env?: NodeJS.ProcessEnv) => LegalPageLoad<TContent> {
  return cache(
    (env: NodeJS.ProcessEnv = process.env): LegalPageLoad<TContent> => ({
      content: contentFor(readLegalContact(env).contact),
      page,
      readiness: legalReadiness([page], env),
    }),
  );
}

/**
 * Whether a caller — anything that points AT a legal page rather than
 * rendering it — must not link to it at all, once NODE_ENV is production
 * (ugcportal-akv6 K3: "never link a draft legal page in production"; the
 * same rule is reused for the About page's own outbound link by
 * ugcportal-nf9l). Reads the SAME `LegalReadiness` `assertPublishable`
 * guards the page's own render with — this is a STRICTER rule layered on
 * top for a caller that isn't the page's own render guard, not a second
 * opinion about what "draft" means: outside production a draft page still
 * renders (with its notice visible), so a linking caller may still link to
 * it there.
 *
 * `env` is a parameter, same convention as `legalReadiness` and
 * `assertPublishable` themselves, so a test can exercise the production
 * branch without mutating the real `process.env`.
 */
export function linkBlockedInProduction(
  readiness: LegalReadiness,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return readiness.draft && env.NODE_ENV === "production";
}
