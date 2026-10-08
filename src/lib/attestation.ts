import { MediaAuthorship } from "@/generated/prisma/enums";

/**
 * The uploader's own rights attestation (ugcportal-15r), as one list that the
 * form, the multipart parser, the sellability gate and the document test all
 * iterate.
 *
 * WHY IT EXISTS AT ALL. docs/legal/manual-upload-rights-review.md §3.1: every
 * per-upload rights fact `src/lib/resale-rights.ts` reads today is an ADMIN's
 * assertion about a file the admin did not make — an admin looking at a
 * landscape cannot know whether the uploader took it — and the uploader, the
 * only person who can know, is never asked. §3.1 is also explicit about what
 * this is NOT: "An attestation is not proof. A dishonest uploader will tick
 * the box." Its value is that it converts silence into a warranty the operator
 * can rely on and act on, that it makes a careless uploader stop and think,
 * and that it gives the admin's triage something to confirm against.
 *
 * ONE REGISTRY, FOUR CONSUMERS, and that is the whole shape of this module.
 * The failure this closes is the one `TRIAGE_FACTS` closes next door: a tenth
 * question added to the form but not to the parser is a question that renders,
 * reads as asked, and is stored as nothing. Here the form maps this array, the
 * parser requires an answer for every member of it, the gate's completeness
 * check iterates it, and src/lib/attestation-text.test.ts asserts the legal
 * document asks exactly these questions and no others.
 *
 * DEPENDENCY-FREE, so the browser can share the server's rules rather than
 * carry a second copy of them — the same reason `src/lib/media-rules.ts`
 * exists (ugcportal-n3c). The one import is `@/generated/prisma/enums`, which
 * is a standalone file of plain string constants with no imports of its own,
 * and which Prisma documents as directly importable. Nothing here touches the
 * Prisma client, `node:*`, or React.
 */

/**
 * The version of docs/legal/upload-rights-attestation.md currently in force.
 * Stamped on new attestations — by the BROWSER, not by this server; see
 * `parseAttestation` for why that direction is load-bearing.
 */
export const CURRENT_ATTESTATION_VERSION = "2026-10-08.1";

/**
 * Versions a *past* attestation may still rely on.
 *
 * Revising the questions in a way that changes what the uploader was actually
 * asked means dropping the old version from this set, which immediately makes
 * every upload attested under it unsellable until someone re-attests. That is
 * the intended blast radius, and it is the same one
 * `ACCEPTED_CHECKLIST_VERSIONS` carries for the admin-side review: the
 * alternative is selling under a declaration that never asked the question the
 * revision added.
 *
 * A pure wording fix that leaves every question meaning the same thing does
 * not need a bump. Anything that adds, removes or narrows a question does.
 */
export const ACCEPTED_ATTESTATION_VERSIONS: ReadonlySet<string> = new Set([
  CURRENT_ATTESTATION_VERSION,
]);

/**
 * Every authorship option, derived from the generated enum rather than
 * hand-listed, so adding a fourth basis to the schema cannot leave the form
 * silently offering three of four.
 */
export const MEDIA_AUTHORSHIP_VALUES = Object.values(
  MediaAuthorship,
) as readonly MediaAuthorship[];

export function isMediaAuthorship(value: unknown): value is MediaAuthorship {
  return (
    typeof value === "string" &&
    (MEDIA_AUTHORSHIP_VALUES as readonly string[]).includes(value)
  );
}

/**
 * The nine answers, in the order §3.1 lists them.
 *
 * `authorship` is the three-way; the other eight are yes/no. Both halves are
 * required — there is no partially attested state, which is what keeps
 * ugcportal-15r K4's "not asked" distinguishable from "answered no": the
 * absence of an answer is the absence of the whole row.
 */
export type AttestationAnswers = {
  authorship: MediaAuthorship;
  ownOriginalNotFromWeb: boolean;
  showsIdentifiablePeople: boolean;
  showsMinors: boolean;
  containsMusicNotOwned: boolean;
  otherCreativeContributor: boolean;
  brandOrSponsorship: boolean;
  aiGenerated: boolean;
  uploaderIsAdult: boolean;
};

/** The yes/no columns on MediaAttestation — everything but `authorship`. */
export type AttestationBooleanField = Extract<
  {
    [K in keyof AttestationAnswers]: AttestationAnswers[K] extends boolean
      ? K
      : never;
  }[keyof AttestationAnswers],
  string
>;

export type AttestationQuestion = {
  /** The NOT NULL Boolean column on MediaAttestation holding the answer. */
  readonly field: AttestationBooleanField;
  /** The question, in the first person, exactly as the form asks it. */
  readonly question: string;
  /**
   * Why it is asked, shown under the question. Not decoration: §3.1's second
   * stated value is making "the honest-but-careless uploader stop and think",
   * and a bare yes/no with no context does not do that.
   */
  readonly why: string;
};

/**
 * §3.1's eight yes/no questions, verbatim in substance and in this order.
 *
 * EVERY ONE OF THEM IS ASKED EVEN THOUGH THE GATE ACTS ON ONLY SOME. That is
 * deliberate and it is the point of the bead: an answer the gate does not act
 * on is still the record the admin triage confirms against (ugcportal-vq3z)
 * and still what ugcportal-vlnn renders beside the admin's own flag so a
 * disagreement is visible. Which answers block, and which are recorded only,
 * is decided in one place — the blocker list in src/lib/resale-rights.ts — and
 * is written down there rather than implied by what is in this array.
 */
export const ATTESTATION_QUESTIONS: readonly AttestationQuestion[] = [
  {
    field: "ownOriginalNotFromWeb",
    question: "This file is my own original — I did not save it from a website.",
    why: "Re-uploading someone else's picture is the single most common way a stock library ends up selling a licence it never had.",
  },
  {
    field: "showsIdentifiablePeople",
    question: "It shows one or more identifiable people.",
    why: "Åndsverkloven § 104 means a photograph of a person may not be displayed publicly without their consent, and GDPR treats their image as personal data.",
  },
  {
    field: "showsMinors",
    question: "Someone shown in it is under 18.",
    why: "Consent has to come from a guardian, be specific and written, and name online publication. Answer yes if you are not sure of someone's age.",
  },
  {
    field: "containsMusicNotOwned",
    question: "It contains music I did not create.",
    why: "A recording carries at least two separate rights, and neither of them travels with the file.",
  },
  {
    field: "otherCreativeContributor",
    question:
      "Someone other than me contributed creatively — a co-photographer, a stylist, an artwork or mural as the main subject.",
    why: "A co-creator is a co-owner. An artwork that is the main subject of a photograph is its own author's work, even where it stands in a public place.",
  },
  {
    field: "brandOrSponsorship",
    question: "It was made for a brand, or under a sponsorship.",
    why: "A brand agreement usually says who may sell the result, and Forbrukertilsynet requires any item a benefit was received for to be labelled.",
  },
  {
    field: "aiGenerated",
    question: "It is wholly or partly AI-generated.",
    why: "A wholly generated image very likely has no copyright holder at all, so there may be nothing to license — and a buyer paying for a photograph is being sold something different.",
  },
  {
    field: "uploaderIsAdult",
    question: "I am 18 or older.",
    why: "Under vergemålsloven a licence granted by someone under 18 is at best voidable. Nothing here verifies your age; this is your own declaration.",
  },
];

/** What the authorship control asks, and what each option says. */
export const ATTESTATION_AUTHORSHIP_QUESTION = {
  field: "authorship",
  question: "On what basis can you grant a licence to this file?",
  why: "Everything else follows from this one. If neither answer above the last is true, there is nothing for you to grant and the file cannot be offered for sale.",
  options: [
    { value: MediaAuthorship.AUTHOR, label: "I am the author — I made it." },
    {
      value: MediaAuthorship.LICENSED_FROM_AUTHOR,
      label: "I hold a written licence from the author.",
    },
    { value: MediaAuthorship.NEITHER, label: "Neither." },
  ],
} as const;

/**
 * The multipart field a question's answer arrives in.
 *
 * Namespaced with a prefix rather than using the bare column name, so an
 * attestation field can never collide with `altText`, `caption`, `tags` or a
 * future one — and so the route can tell "the client sent no attestation at
 * all" (an old tab, a script) apart from "the client sent a field whose name
 * happens to match a column".
 */
export const MEDIA_ATTESTATION_FIELD_PREFIX = "attestation.";

export function attestationFieldName(field: string): string {
  return `${MEDIA_ATTESTATION_FIELD_PREFIX}${field}`;
}

/** The part carrying which version of the document the uploader was shown. */
export const MEDIA_ATTESTATION_VERSION_FIELD = attestationFieldName("version");

/**
 * The only two strings a yes/no answer may arrive as.
 *
 * NOT "true"/"false", and not a checkbox's presence-or-absence, which is the
 * shape a form would reach for first and the one this must not use: an
 * unchecked box and a box that was never rendered send exactly the same thing
 * — nothing — so a client that dropped a question would be read as the
 * uploader answering "no" to it. That is ugcportal-15r K4's failure mode
 * arriving over the wire instead of out of the database. Requiring an explicit
 * token means "not asked" is a 400, not a `false`.
 */
export const ATTESTATION_YES = "yes";
export const ATTESTATION_NO = "no";

export type AttestationParseResult =
  | { ok: true; version: string; answers: AttestationAnswers }
  | { ok: false; message: string; field: string };

/**
 * Reads one complete attestation out of a multipart body, or refuses.
 *
 * `read` is a `(name) => unknown` rather than a `FormData`, so this is
 * testable without constructing one and so a non-string value — a part sent as
 * a file, which `FormData.get` returns as a `File` — reaches the checks below
 * as the non-string it is rather than being coerced to "[object File]". Same
 * reasoning as `validateAltText` and `parseTagNames` next door.
 *
 * FAILS ON THE FIRST MISSING ANSWER, with the field named, and refuses the
 * whole upload rather than storing a partial row. There is deliberately no
 * default and no "unanswered" value to fall back to: a stored attestation is a
 * warranty, and a warranty assembled out of blanks is the exact fail-open this
 * bead exists to close.
 *
 * THE VERSION COMES FROM THE CLIENT AND IS CHECKED, NOT STAMPED HERE. Stamping
 * `CURRENT_ATTESTATION_VERSION` server-side would be simpler and would be a
 * lie: a tab opened before a revision shows the OLD questions, and stamping
 * the new version on its answers records that the uploader was asked something
 * they never saw. So the browser sends the version of the text it actually
 * rendered, and anything not in `ACCEPTED_ATTESTATION_VERSIONS` is refused —
 * which is the correct answer for a stale tab: reload and read the new text.
 */
export function parseAttestation(
  read: (name: string) => unknown,
): AttestationParseResult {
  const version = read(MEDIA_ATTESTATION_VERSION_FIELD);
  if (typeof version !== "string" || version.trim() === "") {
    return {
      ok: false,
      field: MEDIA_ATTESTATION_VERSION_FIELD,
      message:
        "This upload carries no rights attestation. Reload the page and answer the rights questions.",
    };
  }
  if (!ACCEPTED_ATTESTATION_VERSIONS.has(version)) {
    return {
      ok: false,
      field: MEDIA_ATTESTATION_VERSION_FIELD,
      message:
        "The rights questions have changed since this page was opened. Reload and answer them again.",
    };
  }

  const authorshipField = attestationFieldName(
    ATTESTATION_AUTHORSHIP_QUESTION.field,
  );
  const authorship = read(authorshipField);
  if (!isMediaAuthorship(authorship)) {
    return {
      ok: false,
      field: authorshipField,
      message: "Say on what basis you can license this file.",
    };
  }

  // Built up rather than written as a literal, because the literal would be
  // the second list of nine questions in this module and the one that could
  // fall behind. A field in `ATTESTATION_QUESTIONS` with no answer in the body
  // refuses here by construction.
  const answers: Record<string, boolean> = {};
  for (const { field, question } of ATTESTATION_QUESTIONS) {
    const name = attestationFieldName(field);
    const raw = read(name);
    if (raw !== ATTESTATION_YES && raw !== ATTESTATION_NO) {
      return {
        ok: false,
        field: name,
        message: `Answer yes or no: ${question}`,
      };
    }
    answers[field] = raw === ATTESTATION_YES;
  }

  return {
    ok: true,
    version,
    // The cast is the one place this module asserts that the loop above filled
    // every key of `AttestationAnswers`. It is not taken on trust:
    // `attestation.test.ts` asserts the parsed object's keys are exactly
    // `ATTESTATION_QUESTIONS`' fields plus `authorship`, and the gate's own
    // completeness check (`attestation_incomplete`) refuses a row missing any
    // of them however it was built.
    answers: { authorship, ...answers } as AttestationAnswers,
  };
}

/**
 * One complete attestation as the browser holds it and the wire carries it.
 *
 * The version travels WITH the answers rather than being added at send time,
 * so a queued file keeps the version of the text its uploader actually read
 * even if the page is revised and the tab is still open — the same "a retry
 * re-sends what the first attempt sent" rule `QueueEntry.tags` follows.
 */
export type AttestationSubmission = {
  version: string;
  answers: AttestationAnswers;
};

/**
 * The multipart parts one attestation becomes, as `[name, value]` pairs.
 *
 * The inverse of `parseAttestation`, in the same module and derived from the
 * same `ATTESTATION_QUESTIONS`, so the two cannot come to disagree about a
 * field name or about how a `no` is spelled. `attestation.test.ts` asserts
 * the round trip for every combination of answers rather than for one.
 */
export function attestationFormParts(
  submission: AttestationSubmission,
): [string, string][] {
  const { answers } = submission;
  return [
    [MEDIA_ATTESTATION_VERSION_FIELD, submission.version],
    [
      attestationFieldName(ATTESTATION_AUTHORSHIP_QUESTION.field),
      answers.authorship,
    ],
    ...ATTESTATION_QUESTIONS.map(
      ({ field }): [string, string] => [
        attestationFieldName(field),
        answers[field] ? ATTESTATION_YES : ATTESTATION_NO,
      ],
    ),
  ];
}
