import { describe, expect, it } from "vitest";

import { MediaAuthorship } from "@/generated/prisma/enums";
import {
  ACCEPTED_ATTESTATION_VERSIONS,
  ATTESTATION_AUTHORSHIP_QUESTION,
  ATTESTATION_NO,
  ATTESTATION_QUESTIONS,
  ATTESTATION_YES,
  CURRENT_ATTESTATION_VERSION,
  MEDIA_ATTESTATION_VERSION_FIELD,
  MEDIA_AUTHORSHIP_VALUES,
  type AttestationAnswers,
  attestationFieldName,
  attestationFormParts,
  isMediaAuthorship,
  parseAttestation,
} from "@/lib/attestation";
import {
  MEDIA_ALT_TEXT_FIELD,
  MEDIA_CAPTION_FIELD,
  MEDIA_TAGS_FIELD,
} from "@/lib/routes";

/**
 * ugcportal-15r K1, at the level the wire format is decided: the questions
 * the registry declares, how an answer arrives, and what happens when one
 * does not.
 */

/** A complete set of parts, as `attestationFormParts` would produce them. */
function completeParts(
  overrides: Partial<AttestationAnswers> = {},
): Map<string, string> {
  const answers = Object.fromEntries(
    ATTESTATION_QUESTIONS.map(({ field }) => [
      field,
      field === "uploaderIsAdult",
    ]),
  );
  return new Map(
    attestationFormParts({
      version: CURRENT_ATTESTATION_VERSION,
      answers: {
        ...answers,
        authorship: MediaAuthorship.AUTHOR,
        ...overrides,
      } as AttestationAnswers,
    }),
  );
}

/** A `read` function over a map, the shape `parseAttestation` takes. */
function reader(parts: Map<string, unknown>) {
  return (name: string) => parts.get(name);
}

describe("the registry is the one list of questions", () => {
  it("asks every question docs/legal/manual-upload-rights-review.md §3.1 names", () => {
    // Named explicitly rather than derived, because this is the one
    // assertion in the file that must not be satisfiable by whatever the
    // registry happens to contain. §3.1's list, in its own order.
    expect([
      ATTESTATION_AUTHORSHIP_QUESTION.field,
      ...ATTESTATION_QUESTIONS.map(({ field }) => field),
    ]).toEqual([
      "authorship",
      "ownOriginalNotFromWeb",
      "showsIdentifiablePeople",
      "showsMinors",
      "containsMusicNotOwned",
      "otherCreativeContributor",
      "brandOrSponsorship",
      "aiGenerated",
      "uploaderIsAdult",
    ]);
  });

  it("asks each question exactly once", () => {
    const fields = ATTESTATION_QUESTIONS.map(({ field }) => field);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("gives every question wording and a reason", () => {
    // The `why` is not decoration: §3.1's second stated value is making a
    // careless uploader stop and think, which a bare yes/no does not do.
    for (const question of ATTESTATION_QUESTIONS) {
      expect(question.question.trim().length, question.field).toBeGreaterThan(
        10,
      );
      expect(question.why.trim().length, question.field).toBeGreaterThan(10);
    }
  });

  it("offers every authorship value the schema defines, no more and no fewer", () => {
    // Derived from the generated enum on both sides, so a fourth basis added
    // to prisma/schema.prisma fails here rather than being silently
    // unofferable on the form.
    expect(
      ATTESTATION_AUTHORSHIP_QUESTION.options.map((option) => option.value),
    ).toEqual([...MEDIA_AUTHORSHIP_VALUES]);
    expect([...MEDIA_AUTHORSHIP_VALUES].sort()).toEqual(
      Object.values(MediaAuthorship).sort(),
    );
  });

  it("recognises exactly those values as authorship answers", () => {
    for (const value of MEDIA_AUTHORSHIP_VALUES) {
      expect(isMediaAuthorship(value)).toBe(true);
    }
    for (const value of ["", "author", "Author", null, undefined, 1, {}]) {
      expect(isMediaAuthorship(value), String(value)).toBe(false);
    }
  });

  it("namespaces every field so none can collide with altText, caption or tags", () => {
    const names = [
      MEDIA_ATTESTATION_VERSION_FIELD,
      attestationFieldName(ATTESTATION_AUTHORSHIP_QUESTION.field),
      ...ATTESTATION_QUESTIONS.map(({ field }) => attestationFieldName(field)),
    ];
    /*
     * Literal "attestation.", not MEDIA_ATTESTATION_FIELD_PREFIX — every name
     * above is itself built from that constant via attestationFieldName, so
     * comparing against the constant just restates whatever value it holds.
     * Comparing against the literal is what checks that value directly.
     */
    for (const name of names) {
      expect(name.startsWith("attestation."), name).toBe(true);
    }
    /*
     * Disjoint from the OTHER parts POST /api/media reads, computed from the
     * real constants rather than from four string literals — `expect(names)
     * .not.toContain("altText")` is an assertion that cannot fail, because
     * no attestation field is ever spelled "altText" with or without the
     * prefix. Reading the constants means a renamed `MEDIA_CAPTION_FIELD`
     * is what this compares against.
     */
    const otherParts = new Set([
      MEDIA_ALT_TEXT_FIELD,
      MEDIA_CAPTION_FIELD,
      MEDIA_TAGS_FIELD,
    ]);
    expect(names.filter((name) => otherParts.has(name))).toEqual([]);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the wire format round-trips", () => {
  it("parses back exactly what it serialised, for every combination of answers", () => {
    /*
     * EVERY COMBINATION, not one. 2^8 = 256 sets of yes/no answers times
     * three authorship values, which is 768 round trips and runs in
     * milliseconds. A single "all no" fixture would pass against a
     * serialiser that wrote the same constant for every field, or a parser
     * that read one field into all of them — both of which are the mistakes
     * a shared eight-field loop can actually make.
     */
    for (const authorship of MEDIA_AUTHORSHIP_VALUES) {
      for (let mask = 0; mask < 1 << ATTESTATION_QUESTIONS.length; mask += 1) {
        const answers = {
          authorship,
          ...Object.fromEntries(
            ATTESTATION_QUESTIONS.map(({ field }, index) => [
              field,
              (mask & (1 << index)) !== 0,
            ]),
          ),
        } as AttestationAnswers;

        const parts = new Map(
          attestationFormParts({
            version: CURRENT_ATTESTATION_VERSION,
            answers,
          }),
        );
        const parsed = parseAttestation(reader(parts));

        expect(parsed.ok, `${authorship}/${mask}`).toBe(true);
        if (!parsed.ok) continue;
        expect(parsed.answers, `${authorship}/${mask}`).toEqual(answers);
        expect(parsed.version).toBe(CURRENT_ATTESTATION_VERSION);
      }
    }
  });

  it("spells a yes and a no out rather than relying on a part being present", () => {
    // The reason this matters is ugcportal-15r K4 arriving over the wire: an
    // unchecked box and a box that was never rendered send the same thing —
    // nothing — so a presence-based encoding would read a dropped question
    // as a `no`.
    const parts = completeParts();
    const values = new Set(
      ATTESTATION_QUESTIONS.map(({ field }) =>
        parts.get(attestationFieldName(field)),
      ),
    );
    expect([...values].sort()).toEqual([ATTESTATION_NO, ATTESTATION_YES]);
    expect(ATTESTATION_YES).not.toBe(ATTESTATION_NO);
  });

  it("produces one part per question plus the version, and nothing else", () => {
    expect(completeParts().size).toBe(ATTESTATION_QUESTIONS.length + 2);
  });
});

describe("parseAttestation refuses anything short of a complete answer", () => {
  it("accepts the complete fixture, so the refusals below are meaningful", () => {
    expect(parseAttestation(reader(completeParts())).ok).toBe(true);
  });

  /*
   * ONE CASE PER QUESTION, generated from the registry. A tenth question
   * added to the registry gets its own missing-answer case for free, which
   * is the half a single hand-written "omit one field" case cannot give.
   */
  for (const { field } of ATTESTATION_QUESTIONS) {
    it(`refuses an upload with no answer to ${field}, rather than defaulting it`, () => {
      const parts = completeParts();
      parts.delete(attestationFieldName(field));

      const result = parseAttestation(reader(parts));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      // The field is NAMED, so the form can mark the right question rather
      // than saying "something is wrong" under a block of nine.
      expect(result.field).toBe(attestationFieldName(field));
    });
  }

  it("refuses a missing authorship answer", () => {
    const parts = completeParts();
    parts.delete(attestationFieldName("authorship"));

    const result = parseAttestation(reader(parts));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe(attestationFieldName("authorship"));
  });

  it("refuses an authorship value outside the closed set", () => {
    const parts = completeParts();
    parts.set(attestationFieldName("authorship"), "SOMETHING_ELSE");

    expect(parseAttestation(reader(parts)).ok).toBe(false);
  });

  it("refuses anything but the exact yes/no tokens", () => {
    const field = attestationFieldName("showsMinors");
    // "" and "false" are the two an HTML form could plausibly send for an
    // unanswered question, and both must be a refusal rather than a `no`.
    // `true`/`false` as booleans cover a JSON client that skipped the
    // multipart encoding.
    for (const value of ["", " ", "false", "true", "YES", "No", "0", "1", true, false, null]) {
      const parts = completeParts() as Map<string, unknown>;
      parts.set(field, value);
      expect(parseAttestation(reader(parts)).ok, String(value)).toBe(false);
    }
  });

  it("refuses a part sent as a File rather than coercing it", () => {
    const parts = completeParts() as Map<string, unknown>;
    parts.set(
      attestationFieldName("showsMinors"),
      new File(["yes"], "answer.txt"),
    );

    expect(parseAttestation(reader(parts)).ok).toBe(false);
  });

  it("refuses an upload that carries no attestation at all", () => {
    const result = parseAttestation(() => undefined);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe(MEDIA_ATTESTATION_VERSION_FIELD);
  });

  it("refuses a version nobody accepts any more, with its own message", () => {
    const parts = completeParts();
    parts.set(MEDIA_ATTESTATION_VERSION_FIELD, "2019-01-01.0");

    const result = parseAttestation(reader(parts));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Distinct from "no attestation at all": a stale tab is told to reload,
    // not that something is broken.
    expect(result.message).toMatch(/changed since this page was opened/i);
  });

  it("keeps the version the client sent rather than stamping the current one", () => {
    /*
     * The direction is load-bearing (see parseAttestation's own docstring):
     * a server that stamped `CURRENT_ATTESTATION_VERSION` would record that
     * the uploader was asked whatever the text says NOW, which for a tab
     * opened before a revision is false. Asserted by adding a second
     * accepted version and checking it survives — a stamping implementation
     * returns the current one and fails here.
     */
    const second = [...ACCEPTED_ATTESTATION_VERSIONS][0];
    const parts = completeParts();
    parts.set(MEDIA_ATTESTATION_VERSION_FIELD, second);

    const result = parseAttestation(reader(parts));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBe(second);
  });

  it("returns an answer for every column and no others", () => {
    const result = parseAttestation(reader(completeParts()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.answers).sort()).toEqual(
      [
        "authorship",
        ...ATTESTATION_QUESTIONS.map(({ field }) => field),
      ].sort(),
    );
    for (const { field } of ATTESTATION_QUESTIONS) {
      expect(typeof result.answers[field], field).toBe("boolean");
    }
  });
});

describe("the accepted-version set", () => {
  it("accepts the current version", () => {
    expect(ACCEPTED_ATTESTATION_VERSIONS.has(CURRENT_ATTESTATION_VERSION)).toBe(
      true,
    );
  });

  it("accepts nothing else today", () => {
    // Not a rule forever — a revision adds the new one and keeps the old
    // until it is retired. Pinned so that widening the set is a visible act
    // with a reason beside it, rather than a line somebody added.
    expect([...ACCEPTED_ATTESTATION_VERSIONS]).toEqual([
      CURRENT_ATTESTATION_VERSION,
    ]);
  });
});
