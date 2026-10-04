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
 * The human sign-off ugcportal-alg requires before the draft marker comes
 * off (bead K4: "review by whoever plays the DPO/legal role for this project
 * before the draft marker is removed"). A source constant, not an
 * environment variable, because it is a fact about THIS text at THIS
 * revision: set it in the same PR that makes the reviewed change, so the
 * sign-off and the words it covers move together. `null` until then.
 *
 * Sign-off is one of the three things that keep a page in draft (see
 * `legalReadiness` in publishable.ts); unlike the other two it is not a
 * configuration problem, so it does not stop production from serving the
 * page — it keeps the draft notice, the `ugcportal:draft` meta tag that
 * ugcportal-akv6's footer guard reads, and `noindex` in place.
 */
export type LegalSignOff = { by: string; date: string; bead: string };
export const LEGAL_SIGN_OFF: LegalSignOff | null = null;

/** The ISO date the text was last checked against the code. */
export const LEGAL_LAST_REVIEWED = "2026-10-04";
