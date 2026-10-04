import type { Metadata } from "next";
import type { ReactNode } from "react";

import { PageTitle } from "@/components/page-title";
import { LEGAL_LAST_REVIEWED } from "@/lib/legal/contact";
import type { LegalListSection, LegalProseSection } from "@/lib/legal/section";

/**
 * The frame shared by /privacy and /licence (ugcportal-qnq9.4): one draft
 * notice, one "last checked" line, one way to render a section, so the two
 * pages cannot drift apart on anything but their text.
 *
 * Renders into the app shell's single <main> (src/components/app-shell.tsx)
 * and adds no landmark of its own. max-w-3xl, like /upload: wide enough for
 * a definition list. Colour tokens are the page-canvas pair, because this
 * renders straight on --background — see the pin in
 * src/lib/design/dual-meaning-usage.test.ts.
 *
 * Whether the page is a draft is decided by `legalReadiness` in
 * src/lib/legal/publishable.ts and passed in; nothing here decides it.
 */

/**
 * The meta tag ugcportal-akv6's footer guard will read. Present only while the
 * text is a draft, so its absence IS the signal; a `content="false"` variant
 * would make the guard compare strings instead of checking presence.
 */
export const DRAFT_META_NAME = "ugcportal:draft";

export const DRAFT_NOTICE =
  "Draft. This text is written from the code and checked against it, but it is not yet complete or signed off.";

/** Page metadata for a legal page: titled, and marked as a draft while it is one. */
export function legalMetadata(title: string, draft: boolean): Metadata {
  if (!draft) {
    return { title };
  }
  return {
    title,
    // Not indexed while draft: a search engine quoting "[LEGAL_CONTACT_EMAIL]"
    // back at a visitor is a worse outcome than a page that is hard to find.
    robots: { index: false, follow: false },
    other: { [DRAFT_META_NAME]: "true" },
  };
}

const PARAGRAPH_CLASS = "mt-3 max-w-prose text-sm text-muted-foreground";

export function LegalPageFrame({
  title,
  intro,
  draft,
  children,
}: {
  title: string;
  intro: readonly string[];
  draft: boolean;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <PageTitle>{title}</PageTitle>
      {draft ? (
        <p
          role="status"
          data-testid="legal-draft-notice"
          className="mt-4 max-w-prose rounded-md border border-border px-3 py-2 text-sm text-muted-foreground"
        >
          {DRAFT_NOTICE}
        </p>
      ) : null}
      <LegalParagraphs paragraphs={intro} />
      {children}
      <p className="mt-12 max-w-prose text-xs text-muted-foreground">
        Last checked against the code: {LEGAL_LAST_REVIEWED}.
      </p>
    </div>
  );
}

/** One titled section with an anchor and a stable test id. */
export function LegalSection({
  id,
  testId,
  title,
  children,
}: {
  id: string;
  testId: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} data-testid={testId} className="mt-10">
      <h2 className="text-lg font-medium tracking-tight text-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * A prose or list section from a content module, under a test id built from
 * the given prefix and the section's id. Lists render their items before
 * their paragraphs, matching `sectionTexts` in src/lib/legal/section.ts.
 */
export function LegalProse({
  section,
  testIdPrefix,
}: {
  section: LegalProseSection | LegalListSection;
  testIdPrefix: string;
}) {
  return (
    <LegalSection
      id={section.id}
      testId={`${testIdPrefix}-${section.id}`}
      title={section.title}
    >
      {"items" in section ? <LegalList items={section.items} /> : null}
      <LegalParagraphs paragraphs={section.paragraphs} />
    </LegalSection>
  );
}

/**
 * Keyed by position, not by text (PR #90 round 1): two identical paragraphs
 * would collide on a text key. The content is static data from a content
 * module and is never reordered at runtime, so an index is a stable
 * identity here. The same holds for LegalList and LegalFacts below.
 */
export function LegalParagraphs({ paragraphs }: { paragraphs: readonly string[] }) {
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p key={index} className={PARAGRAPH_CLASS}>
          {paragraph}
        </p>
      ))}
    </>
  );
}

export function LegalList({ items }: { items: readonly string[] }) {
  return (
    <ul className="mt-3 max-w-prose list-disc space-y-1 pl-5 text-sm text-muted-foreground">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

/** Label/value rows — purpose, legal basis, and so on — as a definition list. */
export function LegalFacts({
  facts,
}: {
  facts: readonly { label: string; value: string; testId?: string }[];
}) {
  return (
    <dl className="mt-4 grid max-w-prose grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
      {facts.map((fact, index) => (
        // A fragment per row, so dt and dd stay siblings inside the dl (a
        // wrapper div between them is invalid in a grid dl for assistive
        // tech in some browsers).
        <LegalFact key={index} {...fact} />
      ))}
    </dl>
  );
}

function LegalFact({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <>
      <dt className="font-medium text-foreground">{label}</dt>
      <dd data-testid={testId} className="text-muted-foreground">
        {value}
      </dd>
    </>
  );
}
