import { createHash } from "node:crypto";

import {
  LEGAL_SIGN_OFF,
  SENTINEL_CONTACT,
  type LegalContact,
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
 *  1. an unset LEGAL_* variable (src/lib/legal/contact.ts) — the primary,
 *     binary signal. A privacy statement whose controller reads
 *     "[LEGAL_CONTROLLER_NAME]" does not satisfy GDPR Art. 13(1)(a) and is
 *     worse than no page, because it looks like compliance;
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
};

/** The digest a sign-off records for a page's authored prose. */
export function authoredDigest(authored: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(authored)).digest("hex");
}

/**
 * The one way to build a LegalPage: evaluate the content module's text
 * function against the sentinel, once, at module load. Both pages go
 * through here, so both scan the same kind of thing.
 */
export function legalPage(
  path: string,
  textsFor: (contact: LegalContact) => readonly string[],
): LegalPage {
  const authored = textsFor(SENTINEL_CONTACT);
  return { path, authored, authoredSha256: authoredDigest(authored) };
}

export type LegalReadiness = {
  /** The routes this readiness describes, in the order given. */
  paths: string[];
  /** LEGAL_* variables that are unset. */
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
  const { missing } = readLegalContact(env);
  const strayPlaceholders = pages
    .map((page) => ({ path: page.path, tokens: findPlaceholders(page.authored) }))
    .filter(({ tokens }) => tokens.length > 0);
  const digests = Object.fromEntries(pages.map((page) => [page.path, page.authoredSha256]));
  const blocked = missing.length > 0 || strayPlaceholders.length > 0;
  // A sign-off certifies specific words: a page whose prose has changed
  // since is unsigned, however the constant reads.
  const signedOff =
    signOff !== null &&
    pages.every((page) => signOff.authoredSha256[page.path] === page.authoredSha256);
  return {
    paths: pages.map((page) => page.path),
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
  const paths = readiness.paths.join(", ");
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
