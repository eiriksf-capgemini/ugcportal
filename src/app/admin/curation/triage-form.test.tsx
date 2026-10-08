import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CurationTriageForm,
  type TriageFormAnswers,
} from "@/app/admin/curation/triage-form";
import {
  TRIAGE_ANSWER_NO,
  TRIAGE_ANSWER_UNANSWERED,
  TRIAGE_ANSWER_YES,
} from "@/lib/curation-triage";
import { TRIAGE_FACTS } from "@/lib/resale-rights";

/**
 * The triage form is an EDIT form over security-relevant columns: submitting
 * it writes every registered fact, so a question rendered without its current
 * answer clears that answer on the next submit. The dangerous direction is a
 * stored `true` rendering as "Not answered" — an upload blocked because it
 * shows a minor gets quietly un-answered, and the next admin "fixes" the
 * block by answering `no`.
 *
 * So this renders the real component and reads the real markup, rather than
 * asserting that some helper was called. Same reason, and same shape, as
 * decision-form.test.tsx one screen over.
 */

const FIELDS = TRIAGE_FACTS.map((fact) => fact.field);

function answers(value: boolean | null): TriageFormAnswers {
  return Object.fromEntries(
    FIELDS.map((field) => [field, value]),
  ) as TriageFormAnswers;
}

function render(stored: TriageFormAnswers | null): string {
  return renderToStaticMarkup(
    <CurationTriageForm
      mediaId="media-1"
      answers={stored}
      action={() => undefined}
    />,
  );
}

/** The `<select name="...">…</select>` block for one question. */
function selectBlock(markup: string, name: string): string {
  const match = new RegExp(
    `<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`,
  ).exec(markup);
  if (!match) {
    throw new Error(`no select named ${name} in the rendered form`);
  }
  return match[1];
}

/**
 * The value of the pre-selected option in one question, or null when none is.
 *
 * React renders a `<select defaultValue>` as `selected` on the matching
 * `<option>`. MEASURED on this repo's react-dom (19.2.8):
 * `renderToStaticMarkup(<select defaultValue="b">…)` emits
 * `<option value="b" selected="">` — value first — so it is the second
 * alternative below that matches today. Both orders are accepted anyway, the
 * same two-sided match decision-form.test.tsx makes, because a React version
 * that swapped them would otherwise make every assertion here fail for a
 * reason that has nothing to do with the form.
 *
 * A matcher that stopped matching altogether does NOT make these tests pass
 * vacuously: this returns `null`, and every caller compares it against one of
 * the three answer tokens — including `""` for unanswered, which `null` is
 * not equal to — so all of them fail loudly instead.
 */
function selectedValue(markup: string, name: string): string | null {
  const block = selectBlock(markup, name);
  const match =
    /<option selected(?:=""|)\s+value="([^"]*)"/.exec(block) ??
    /<option value="([^"]*)"\s+selected/.exec(block);
  return match?.[1] ?? null;
}

describe("the form asks the registry's questions", () => {
  it("renders one question per registered triage fact, named after its column", () => {
    const markup = render(null);
    for (const fact of TRIAGE_FACTS) {
      expect(markup, fact.field).toContain(`name="${fact.field}"`);
    }
    // Exactly one per fact and no others: a select the registry does not know
    // about is a column nothing reads being offered as if it mattered.
    expect([...markup.matchAll(/<select[^>]*name="([^"]*)"/g)].map((m) => m[1])
      .sort()).toEqual([...FIELDS].sort());
  });

  it("carries the upload's id, so the action knows what is being triaged", () => {
    expect(render(null)).toContain('name="mediaId" value="media-1"');
  });

  it("offers exactly the three answers, with the two tokens the parser reads", () => {
    const block = selectBlock(render(null), FIELDS[0]);
    const values = [...block.matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
    expect(values).toEqual([
      TRIAGE_ANSWER_UNANSWERED,
      TRIAGE_ANSWER_YES,
      TRIAGE_ANSWER_NO,
    ]);
  });
});

describe("the form round-trips the stored answers", () => {
  // The regression this file exists for, in both directions, on every field.
  it("pre-selects a stored yes on every question", () => {
    const markup = render(answers(true));
    for (const field of FIELDS) {
      expect(selectedValue(markup, field), field).toBe(TRIAGE_ANSWER_YES);
    }
  });

  it("pre-selects a stored no on every question", () => {
    const markup = render(answers(false));
    for (const field of FIELDS) {
      expect(selectedValue(markup, field), field).toBe(TRIAGE_ANSWER_NO);
    }
  });

  it("defaults an unanswered question to unanswered, not to no", () => {
    // "Not asked" and "asked, answer no" are different states and only one of
    // them sells. A form opening on `no` would turn the act of looking at an
    // upload into an assertion that nobody identifiable is in it.
    for (const stored of [answers(null), null]) {
      const markup = render(stored);
      for (const field of FIELDS) {
        expect(selectedValue(markup, field), field).toBe(
          TRIAGE_ANSWER_UNANSWERED,
        );
      }
    }
  });

  it("keeps the questions independent of each other", () => {
    // One stored `true` among stored `false`s. A form that rendered the first
    // answer against every question — or read the wrong key — passes the two
    // uniform cases above and fails here.
    for (const subject of FIELDS) {
      const stored = {
        ...answers(false),
        [subject]: true,
      } as TriageFormAnswers;
      const markup = render(stored);
      for (const field of FIELDS) {
        expect(selectedValue(markup, field), `${subject} / ${field}`).toBe(
          field === subject ? TRIAGE_ANSWER_YES : TRIAGE_ANSWER_NO,
        );
      }
    }
  });
});
