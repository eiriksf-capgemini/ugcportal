import {
  LEGAL_SIGN_OFF,
  type LegalContactVar,
  type LegalSignOff,
  readLegalContact,
  unsetMarker,
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
 *  2. a stray placeholder in the prose — "[fill in later]", "TBD" — the
 *     second line, for text that slipped past review;
 *  3. no human sign-off yet (LEGAL_SIGN_OFF, ugcportal-alg) — draft only;
 *     this is not a configuration problem an operator can fix at deploy
 *     time, so it keeps the notice and the marker rather than the page.
 *
 * Fail-closed at two edges: at render (`assertPublishable`, called by each
 * page, so the guarantee holds however the app was started) and at boot
 * (`checkLegalPagesPublishable` from src/instrumentation.ts, so the operator
 * reads it in the first log lines rather than when the first visitor opens
 * the footer link). Both read the same `legalReadiness`, so they cannot
 * disagree. `env` is a parameter throughout so tests exercise the
 * production branch without mutating process.env.
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

export type LegalPage = {
  /** The route, for messages. */
  path: string;
  /** Every string the page can render, flattened. */
  texts: readonly string[];
};

export type LegalReadiness = {
  /** LEGAL_* variables that are unset. */
  missing: LegalContactVar[];
  /** Placeholders in the prose other than the markers for unset variables. */
  strayPlaceholders: { path: string; tokens: string[] }[];
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
  // The unset markers are reported once, as `missing`, not again as prose.
  const unsetMarkers = new Set(missing.map(unsetMarker));
  const strayPlaceholders = pages
    .map((page) => ({
      path: page.path,
      tokens: findPlaceholders(page.texts).filter((token) => !unsetMarkers.has(token)),
    }))
    .filter(({ tokens }) => tokens.length > 0);
  const blocked = missing.length > 0 || strayPlaceholders.length > 0;
  const signedOff = signOff !== null;
  return { missing, strayPlaceholders, signedOff, draft: blocked || !signedOff, blocked };
}

/**
 * The boot-time check. A warning in EVERY environment while a page is
 * blocked — a fresh checkout from env.example is exactly where this is hit
 * first, the same reasoning as the sign-in check in src/instrumentation.ts
 * — with the consequence spelled out per environment. Null once nothing is
 * blocking. Sign-off alone produces no warning: it is not an operator's
 * problem to fix.
 */
export function checkLegalPagesPublishable(
  pages: readonly LegalPage[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const readiness = legalReadiness(pages, env);
  if (!readiness.blocked) {
    return null;
  }
  const paths = pages.map((page) => page.path).join(", ");
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
 * Called by each legal page at render. Throws in production while the page
 * is blocked, so Next serves its error page instead of a statement with no
 * controller; a no-op otherwise. Delegates to the boot check so there is
 * one definition of "blocked" and one message.
 */
export function assertPublishable(
  page: LegalPage,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== "production") {
    return;
  }
  const warning = checkLegalPagesPublishable([page], env);
  if (warning !== null) {
    throw new Error(warning);
  }
}
