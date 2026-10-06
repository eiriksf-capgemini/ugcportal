/**
 * Who is behind the site, for the privacy statement and the licence page
 * (ugcportal-qnq9.4) — read from the environment, like every other piece of
 * required configuration in this repo (requireEnv in src/lib/s3.ts, the
 * boot warnings in src/instrumentation.ts).
 *
 * Environment rather than source (PR #90 review round 2): the controller is
 * a private person (docs/ugc-research.md, decisions table, "Owner"), and her
 * name does not belong in a public source tree; the hosting and storage
 * providers are deployment facts src/lib/s3.ts is deliberately agnostic
 * about. "Unset" is also binary, where a bracketed placeholder in prose was
 * a heuristic.
 *
 * Why each exists — GDPR Art. 13(1):
 *  - LEGAL_CONTROLLER_NAME   (a) the identity of the controller;
 *  - LEGAL_CONTACT_EMAIL     (a) the controller's contact details, and
 *                            Art. 12: where data-subject requests go;
 *  - LEGAL_HOSTING_PROVIDER  (e) the recipient that operates the server
 *                            (sees IP addresses, holds the database), and
 *                            (f) whether that is outside the EEA;
 *  - LEGAL_STORAGE_PROVIDER  (e)/(f) the same for the object store that
 *                            holds uploads and rights evidence.
 *
 * While a variable is unset the pages render its name in square brackets
 * (`unsetMarker`), production refuses to serve them, and boot says so — see
 * src/lib/legal/publishable.ts. Documented in env.example.
 */

export const LEGAL_CONTACT_VARS = {
  controllerName: "LEGAL_CONTROLLER_NAME",
  contactEmail: "LEGAL_CONTACT_EMAIL",
  hostingProvider: "LEGAL_HOSTING_PROVIDER",
  storageProvider: "LEGAL_STORAGE_PROVIDER",
} as const;

export type LegalContactField = keyof typeof LEGAL_CONTACT_VARS;
export type LegalContactVar = (typeof LEGAL_CONTACT_VARS)[LegalContactField];
export type LegalContact = Record<LegalContactField, string>;

export type LegalContactReading = {
  /** Every field filled — from the environment, or with `unsetMarker`. */
  contact: LegalContact;
  /** The variables that were unset or blank, in LEGAL_CONTACT_VARS order. */
  missing: LegalContactVar[];
};

/**
 * What an unset variable renders as: `[LEGAL_CONTROLLER_NAME]`. Bracketed
 * so it is unmistakable on a dev screen, and so the prose scan in
 * publishable.ts (the second line of defence) would also catch it.
 */
export function unsetMarker(name: LegalContactVar): string {
  return `[${name}]`;
}

/** Reads the four variables; never throws, so a dev page can show what is missing. */
export function readLegalContact(
  env: NodeJS.ProcessEnv = process.env,
): LegalContactReading {
  const missing: LegalContactVar[] = [];
  const contact = {} as LegalContact;
  for (const field of Object.keys(LEGAL_CONTACT_VARS) as LegalContactField[]) {
    const name = LEGAL_CONTACT_VARS[field];
    const value = env[name]?.trim();
    if (value) {
      contact[field] = value;
    } else {
      contact[field] = unsetMarker(name);
      missing.push(name);
    }
  }
  return { contact, missing };
}

/**
 * A contact whose values can never read as a placeholder — plain lower-case
 * hyphenated words, no brackets, not TODO or TBD — used to build the AUTHORED
 * text of a page for the stray-placeholder scan (PR #90 round 3). The scan
 * must see the prose the repository wrote, not what an operator typed into
 * an environment variable: "Acme Hosting [Oslo], Norway" is a set variable,
 * not a reminder to fill one in, and must not block the page. A test holds
 * these values to PLACEHOLDER_PATTERN.
 */
export const SENTINEL_CONTACT: LegalContact = {
  controllerName: "controller-name-sentinel",
  contactEmail: "contact-email-sentinel",
  hostingProvider: "hosting-provider-sentinel",
  storageProvider: "storage-provider-sentinel",
};

/**
 * The human sign-off ugcportal-alg requires before the draft marker comes
 * off (bead K4: "review by whoever plays the DPO/legal role for this project
 * before the draft marker is removed"). A source constant, not an
 * environment variable, because it is a fact about THIS text: `null` until
 * the review happens.
 *
 * It is bound to the words it certifies (PR #90 round 4): `authoredSha256`
 * holds, per route, the digest of that page's authored prose
 * (`LegalPage.authoredSha256`, computed in publishable.ts). `legalReadiness`
 * treats a page whose digest no longer matches as NOT signed off, so editing
 * a paragraph clears the sign-off by itself and nobody has to remember to.
 * To record a sign-off: take the digests from `legalReadiness(...).digests`
 * (or from the failing test's message), and set them here in the same PR
 * as the reviewed text.
 *
 * Sign-off is one of the three things that keep a page in draft (see
 * `legalReadiness`); unlike the other two it is not a configuration problem,
 * so it does not stop production from serving the page — it keeps the draft
 * notice, the `ugcportal:draft` meta tag that ugcportal-akv6's footer guard
 * will read, and `noindex` in place.
 */
export type LegalSignOff = {
  by: string;
  date: string;
  bead: string;
  /** Route path -> sha256 hex of that page's authored prose at sign-off. */
  authoredSha256: Readonly<Record<string, string>>;
};
export const LEGAL_SIGN_OFF: LegalSignOff | null = {
  // Eirik reviewed the privacy statement and the licence text as published
  // on main at 69f2209 (after PR #92 brought the cookie-consent section into
  // the present tense) and approved them on 2026-10-05. The digests are the
  // ones legalReadiness(LEGAL_PAGES).digests reported for that text; any
  // later edit to either page's authored prose changes its digest and puts
  // that page back in draft until it is approved again.
  //
  // Eirik approved the uploads category's new fourth `what` paragraph (the
  // advertising-disclosure record: benefit received, its source, the label)
  // and the matching `legalBasis`/`recipients` wording on 2026-10-06
  // (ugcportal-mj50); only /privacy's digest below changed — the /licence
  // value is byte-identical to the one it replaces, since this PR touched
  // no licence text.
  by: "Eirik Sander-Fjeld",
  date: "2026-10-06",
  bead: "ugcportal-mj50",
  authoredSha256: {
    "/privacy": "28aec31b8f15d05f9cd69c6687b47fa6c37adf8f63081ae9397068dd266d55fd",
    "/licence": "ae6a4a484a0bc2c571121a5f2e02c2bc9db46dd5d14eb6915abafe1b5fd8f901",
  },
};

/** The ISO date the text was last checked against the code. */
export const LEGAL_LAST_REVIEWED = "2026-10-05";

/**
 * A SET LEGAL_* value that still reads like env.example's own illustrative
 * text (ugcportal-qnq9.15 item 2, PR #90 round 6 cap) — the whole word
 * "example" (env.example's samples all contain it: "Example Hosting AS,
 * Norway", an "...@example.com" address) or a bare TODO, in any case.
 *
 * WARN-ONLY, by design, and never fed into `legalReadiness` (src/lib/legal/
 * publishable.ts): round 3 deliberately stopped scanning an operator's own
 * value for stray brackets/TBD, because a real value like "Acme Hosting
 * [Oslo], Norway" must never be BLOCKED for merely containing them. This is
 * a narrower, separate signal that keeps that promise — it flags a likely
 * copy-paste of the sample text without ever making `blocked` or `draft`
 * true, so it cannot reintroduce a false block.
 */
export const SUSPICIOUS_VALUE_PATTERN = /\bexample\b|\btodo\b/i;

export type SuspiciousLegalValue = { name: LegalContactVar; value: string };

/**
 * Every LEGAL_* variable that is SET (an unset one is `readLegalContact`'s
 * `missing`, not this) but whose value still matches
 * `SUSPICIOUS_VALUE_PATTERN` — first-seen (LEGAL_CONTACT_VARS) order.
 */
export function suspiciousLegalValues(
  env: NodeJS.ProcessEnv = process.env,
): SuspiciousLegalValue[] {
  const { contact, missing } = readLegalContact(env);
  const missingVars = new Set(missing);
  return (Object.keys(LEGAL_CONTACT_VARS) as LegalContactField[])
    .map((field) => ({ name: LEGAL_CONTACT_VARS[field], value: contact[field] }))
    .filter(({ name, value }) => !missingVars.has(name) && SUSPICIOUS_VALUE_PATTERN.test(value));
}

/**
 * The boot-time message for `suspiciousLegalValues`, or null when nothing
 * was flagged — same one-formatter idiom as `blockerWarning`
 * (src/lib/legal/publishable.ts), kept in this module because it is about
 * the VALUES an operator set, not about whether a page may render.
 */
export function suspiciousLegalValueWarning(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const found = suspiciousLegalValues(env);
  if (found.length === 0) {
    return null;
  }
  return found
    .map(
      ({ name, value }) =>
        `[legal] ${name} is set to "${value}", which still reads like env.example's own ` +
        "sample text or a stray TODO. If that really is the deployment's value this is a " +
        "coincidence and safe to ignore; otherwise replace it.",
    )
    .join("\n");
}
