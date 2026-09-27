import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACCEPTED_CHECKLIST_VERSIONS,
  CURRENT_CHECKLIST_VERSION,
} from "@/lib/resale-rights";

/**
 * The constant and the document have to agree, and nothing enforced that
 * until now.
 *
 * `CURRENT_CHECKLIST_VERSION` is what gets stamped on every new clearance,
 * and `ACCEPTED_CHECKLIST_VERSIONS` is what the gate will still honour. Both
 * are claims *about a document* — "the reviewer worked through this form" —
 * so a constant that has drifted from the form it names is a clearance
 * recorded against a checklist nobody filled in.
 *
 * ugcportal-vsm is the case in point. It moved the checklist's subject from
 * a connected Instagram account to an uploader, which widens what a single
 * CLEARED decision authorises to a person's entire past and future upload
 * history, and an earlier revision of this bead left the version string
 * alone on the reasoning that only the storage location had changed. That
 * was wrong, and nothing would have caught it: the doc says "bump this
 * string whenever the form changes", which is a rule no code enforced.
 */

const CHECKLIST = readFileSync(
  resolve(process.cwd(), "docs/legal/instagram-resale-rights-checklist.md"),
  "utf8",
);

/** Every version string the document quotes in a fenced `backtick` form. */
function quoted(pattern: RegExp): string[] {
  return [...CHECKLIST.matchAll(pattern)].map((match) => match[1]);
}

describe("the code and the checklist agree on which version is in force", () => {
  it("found the checklist to read", () => {
    // Guards the scan: a moved or renamed document would otherwise make
    // every assertion below vacuously true.
    expect(CHECKLIST).toContain("**Checklist version:**");
    expect(CHECKLIST.length).toBeGreaterThan(1000);
  });

  it("stamps new clearances with the version the document declares", () => {
    const [declared] = quoted(/\*\*Checklist version:\*\* `([^`]+)`/g);

    expect(declared).toBe(CURRENT_CHECKLIST_VERSION);
  });

  it("offers the same version on the decision form in Part D", () => {
    // Part D is what a human physically fills in. If it names a different
    // version from the one the system stamps, the paper record and the
    // database disagree about which questions were answered.
    const [partD] = quoted(/\| Checklist version applied \| `([^`]+)` \|/g);

    expect(partD).toBe(CURRENT_CHECKLIST_VERSION);
  });

  it("accepts the current version", () => {
    expect(ACCEPTED_CHECKLIST_VERSIONS.has(CURRENT_CHECKLIST_VERSION)).toBe(
      true,
    );
  });

  it("does not accept a version the document records as retired", () => {
    // The point of retiring one: a clearance granted under questions that
    // have since changed stops counting until someone re-reviews.
    const retired = quoted(/\*\*Previous version:\*\* `([^`]+)`/g);

    expect(retired.length).toBeGreaterThan(0);
    for (const version of retired) {
      expect({ version, accepted: ACCEPTED_CHECKLIST_VERSIONS.has(version) })
        .toEqual({ version, accepted: false });
    }
  });

  it("names the per-account checklist as retired, not as current", () => {
    // ugcportal-vsm specifically: 2026-09-24.1 asked about the content of
    // one connected Instagram account. A clearance carrying it must not be
    // honoured now that a clearance covers a whole person's uploads.
    expect(ACCEPTED_CHECKLIST_VERSIONS.has("2026-09-24.1")).toBe(false);
    expect(CURRENT_CHECKLIST_VERSION).not.toBe("2026-09-24.1");
  });
});
