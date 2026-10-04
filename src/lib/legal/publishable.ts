import { findPlaceholders } from "@/lib/legal/contact";

/**
 * Fail closed on a placeholder in production (ugcportal-qnq9.4).
 *
 * A privacy statement that names "[CONTROLLER NAME]" as its controller does
 * not satisfy GDPR Art. 13 — it is worse than no page, because it looks like
 * compliance. So in production a legal page REFUSES to render while any
 * placeholder from src/lib/legal/contact.ts survives in its text: the page
 * throws, Next serves its error page, and nothing with a bracketed
 * placeholder ever reaches a visitor. Outside production the placeholders
 * render as-is, which is what makes the draft reviewable.
 *
 * Two edges, by design:
 *  - at render (`assertPublishable`, called by each page), so the guarantee
 *    holds however the app was built or started; and
 *  - at boot (`checkLegalPagesPublishable`, src/instrumentation.ts), so an
 *    operator sees the problem in the first log lines rather than when the
 *    first visitor opens the footer link.
 *
 * `env` is a parameter so the tests can exercise the production branch
 * without mutating process.env (the same shape src/instrumentation.ts uses).
 */

export type LegalPage = {
  /** The route, for the message. */
  path: string;
  /** Every string the page can render, flattened. */
  texts: readonly string[];
};

/** The placeholders still present on a page, or an empty list. */
export function unresolvedPlaceholders(page: LegalPage): string[] {
  return findPlaceholders(page.texts);
}

function describeProblem(page: LegalPage, placeholders: string[]): string {
  return (
    `[legal] ${page.path} still contains ${placeholders.length} placeholder` +
    `${placeholders.length === 1 ? "" : "s"} (${placeholders.join(", ")}). ` +
    "Fill them in under LEGAL_CONTACT in src/lib/legal/contact.ts. " +
    "Production will not serve the page until they are gone."
  );
}

/**
 * Throws in production while a placeholder remains. A no-op otherwise, and
 * a no-op in production once the operator has filled everything in.
 */
export function assertPublishable(
  page: LegalPage,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== "production") {
    return;
  }
  const placeholders = unresolvedPlaceholders(page);
  if (placeholders.length > 0) {
    throw new Error(describeProblem(page, placeholders));
  }
}

/**
 * The boot-time check: a warning string in production while any legal page
 * carries a placeholder, null otherwise. Same contract as the other checks
 * in src/instrumentation.ts.
 */
export function checkLegalPagesPublishable(
  pages: readonly LegalPage[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.NODE_ENV !== "production") {
    return null;
  }
  const problems = pages
    .map((page) => ({ page, placeholders: unresolvedPlaceholders(page) }))
    .filter(({ placeholders }) => placeholders.length > 0)
    .map(({ page, placeholders }) => describeProblem(page, placeholders));
  return problems.length > 0 ? problems.join("\n") : null;
}
