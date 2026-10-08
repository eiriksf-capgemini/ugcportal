import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACCEPTED_ATTESTATION_VERSIONS,
  ATTESTATION_AUTHORSHIP_QUESTION,
  ATTESTATION_QUESTIONS,
  CURRENT_ATTESTATION_VERSION,
} from "@/lib/attestation";
import { SellabilityBlocker } from "@/lib/resale-rights";

/**
 * ugcportal-15r: the attestation text is versioned in docs/legal/ alongside
 * the checklist, and the code and the document have to agree.
 *
 * The same claim src/lib/checklist-version.test.ts makes for the admin-side
 * checklist, and it exists for the same reason: `CURRENT_ATTESTATION_VERSION`
 * is a claim ABOUT A DOCUMENT — "the uploader was shown this text" — so a
 * constant that has drifted from the text it names records a warranty against
 * questions nobody asked. The document says "bump this string whenever a
 * question is added, removed or narrowed", which is a rule no code enforces
 * unless something like this does.
 *
 * It goes further than the checklist test does, and deliberately: it checks
 * the QUESTIONS, not only the version string. A revision that reworded a
 * question in the document and not in `ATTESTATION_QUESTIONS` (or the other
 * way round) would leave the form asking one thing and the legal record
 * claiming another, with the version string identical on both sides and
 * nothing to notice.
 */

const DOCUMENT = readFileSync(
  resolve(process.cwd(), "docs/legal/upload-rights-attestation.md"),
  "utf8",
);

describe("the code and the attestation document agree", () => {
  it("found the document to read", () => {
    // Guards every assertion below against passing vacuously on a moved or
    // renamed file — the same guard checklist-version.test.ts opens with,
    // and for the same reason.
    expect(DOCUMENT).toContain("**Attestation version:**");
    expect(DOCUMENT.length).toBeGreaterThan(2000);
  });

  it("stamps new attestations with the version the document declares", () => {
    const [, declared] =
      /\*\*Attestation version:\*\* `([^`]+)`/.exec(DOCUMENT) ?? [];

    expect(declared).toBe(CURRENT_ATTESTATION_VERSION);
  });

  it("asks, word for word, every question the document sets out", () => {
    /*
     * The document is the authored text; the registry is what renders. A
     * question present in one and not the other is the drift this case
     * exists for, and it is checked in BOTH directions below — a question
     * dropped from the document would otherwise pass here while the form
     * kept asking it.
     */
    for (const { question } of ATTESTATION_QUESTIONS) {
      expect(DOCUMENT, question).toContain(question);
    }
    expect(DOCUMENT).toContain(ATTESTATION_AUTHORSHIP_QUESTION.question);
    for (const option of ATTESTATION_AUTHORSHIP_QUESTION.options) {
      expect(DOCUMENT, option.label).toContain(option.label);
    }
  });

  it("sets out no question the form does not ask", () => {
    /*
     * The other direction. Every `### 2.n` heading in the document's
     * question section is either the authorship question or one of the
     * eight, matched by its own text — so a question written into the
     * document and never built fails here rather than reading, to anyone who
     * opens the file, as something the product collects.
     */
    const headings = [...DOCUMENT.matchAll(/^### 2\.\d+ (.+)$/gm)].map(
      ([, text]) => text.trim(),
    );
    // The guard: a changed heading convention would otherwise make the loop
    // below iterate nothing and pass.
    expect(headings.length).toBe(ATTESTATION_QUESTIONS.length + 1);

    const asked = new Set<string>([
      ATTESTATION_AUTHORSHIP_QUESTION.question,
      ...ATTESTATION_QUESTIONS.map(({ question }) => question),
    ]);
    for (const heading of headings) {
      expect(asked, `document asks "${heading}", the form does not`).toContain(
        heading,
      );
    }
  });

  it("lists every accepted version, so a retired one cannot vanish quietly", () => {
    for (const version of ACCEPTED_ATTESTATION_VERSIONS) {
      expect(DOCUMENT).toContain(version);
    }
  });

  it("names every blocker the gate can return for an attestation", () => {
    /*
     * §3's table is what a reader goes to in order to find out why an upload
     * will not sell. Derived from the blocker union rather than listed, via
     * a `satisfies` on the array below: a seventh attestation blocker added
     * to src/lib/resale-rights.ts fails `tsc` here until it is named in the
     * table too.
     */
    const attestationBlockers = [
      "attestation_missing",
      "attestation_incomplete",
      "attestation_not_by_uploader",
      "attestation_version_retired",
      "attestation_rights_disclaimed",
      "attestation_uploader_not_adult",
    ] as const satisfies readonly SellabilityBlocker[];

    for (const blocker of attestationBlockers) {
      expect(DOCUMENT, blocker).toContain(blocker);
    }
  });

  it("says in terms that nothing verifies the age declaration", () => {
    // §3.2 of the review leaves "is self-declaration a sufficient floor" to
    // counsel, and ugcportal-5pik owns whether the declarer has the capacity
    // to grant anything. A document that implied this question was an age
    // CHECK would be the single most misleading sentence in it.
    expect(DOCUMENT).toContain("NOTHING VERIFIES THIS ANSWER");
    expect(DOCUMENT).toContain("ugcportal-5pik");
  });

  it("says the gate acts on none of the content answers, and who owns that", () => {
    // The boundary of this bead, written down where a reader will find it
    // rather than only in a code comment.
    expect(DOCUMENT).toContain("ugcportal-9pic");
  });
});
