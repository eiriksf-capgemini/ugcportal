/**
 * Who is behind the site, for the privacy statement and the licence page
 * (ugcportal-qnq9.4).
 *
 * The data controller is the person in whose name the site and its accounts
 * are registered (docs/ugc-research.md, decisions table, "Owner"). Her name
 * and the contact address are not in any source file this code can read, so
 * they are PLACEHOLDERS here, in the one format `findPlaceholders` looks for
 * — `[UPPER-CASE WORDS IN SQUARE BRACKETS]` — and the operator fills them in
 * before the pages go live.
 *
 * The two hosting entries are placeholders for the same reason: src/lib/s3.ts
 * is provider-agnostic by design, nothing in this repository names the VPS,
 * and GDPR Art. 13(1)(e)-(f) wants the recipient and any transfer outside
 * the EEA named. Guessing (DreamObjects, say — ugcportal-odx is still open)
 * would be exactly the "claim the code does not back" this bead exists to
 * avoid.
 *
 * Production refuses to render either page while a placeholder remains —
 * see src/lib/legal/publishable.ts.
 */

/**
 * Anything in square brackets — `[CONTROLLER NAME]`, `[fill in later]`,
 * `[Todo: confirm]` — plus the bare words TODO and TBD in any case, as whole
 * words. Deliberately broad (PR #90 review round 1): the first version
 * matched only upper-case tokens, which left a lower-case reminder free to
 * ship to production unredacted. The legal pages contain no legitimate
 * bracketed prose, so there is nothing for a broad match to trip over, and
 * if that ever changes the right move is to reword the prose, not to narrow
 * the guard. Not configurable, so there is exactly one notion of
 * "placeholder" for the pages, the guard and the tests.
 */
export const PLACEHOLDER_PATTERN = /\[[^\]\n]+\]|\b(?:TODO|TBD)\b/gi;

/** Every placeholder token found in the given texts, in order, deduplicated. */
export function findPlaceholders(texts: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
      found.add(match[0]);
    }
  }
  return Array.from(found);
}

export type LegalContact = {
  /** The data controller: the person the site is registered to. */
  controllerName: string;
  /** Where data-subject requests, licence requests and objections go. */
  contactEmail: string;
  /** The company that runs the server the site is served from, and its country. */
  hostingProvider: string;
  /** The S3-compatible object-storage provider (src/lib/s3.ts), and its country. */
  storageProvider: string;
};

export const LEGAL_CONTACT: LegalContact = {
  controllerName: "[CONTROLLER NAME]",
  contactEmail: "[CONTACT EMAIL]",
  hostingProvider: "[HOSTING PROVIDER, COUNTRY]",
  storageProvider: "[OBJECT-STORAGE PROVIDER, COUNTRY]",
};

/**
 * Review state of the legal pages. `draft` until whoever plays the DPO role
 * has signed the text off (ugcportal-alg gates ugcportal-yck; the bead's own
 * notes say the pages "cannot be published without ugcportal-alg's
 * sign-off"). While draft, each page shows a visible notice and carries a
 * `ugcportal:draft` meta tag — the marker ugcportal-akv6's footer guard
 * reads. Flip to `published` in the same change that removes the last
 * placeholder.
 */
export const LEGAL_REVIEW_STATUS: "draft" | "published" = "draft";

/** The ISO date the text was last checked against the code. */
export const LEGAL_LAST_REVIEWED = "2026-10-04";
