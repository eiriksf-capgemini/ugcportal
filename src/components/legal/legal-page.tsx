import type { Metadata } from "next";
import type { ReactNode } from "react";

import { LEGAL_LAST_REVIEWED, LEGAL_REVIEW_STATUS } from "@/lib/legal/contact";

/**
 * The frame shared by /privacy and /licence (ugcportal-qnq9.4): one heading
 * scale, one draft notice, one "last checked" line, so the two pages cannot
 * drift apart on anything but their text.
 *
 * Renders into the app shell's single <main> (src/components/app-shell.tsx)
 * and adds no landmark of its own. Same width as the sign-in error page
 * (max-w-xl is too narrow for a definition list; max-w-3xl, like /upload,
 * fits one). Colour tokens are the page-canvas pair, text-foreground and
 * text-muted-foreground, because this renders straight on --background —
 * see the note in src/app/upload/page.tsx and the pin in
 * src/lib/design/dual-meaning-usage.test.ts.
 */

/**
 * The meta tag ugcportal-akv6's footer guard reads. Present only while the
 * text is a draft, so its absence IS the signal; a `content="false"` variant
 * would make the guard compare strings instead of checking presence.
 */
export const DRAFT_META_NAME = "ugcportal:draft";

export const DRAFT_NOTICE =
  "Draft. This text is written from the code and checked against it, but it has not yet been signed off, and the contact details are still to be filled in.";

/** Page metadata for a legal page: titled, and marked as a draft while it is one. */
export function legalMetadata(title: string): Metadata {
  if (LEGAL_REVIEW_STATUS !== "draft") {
    return { title };
  }
  return {
    title,
    // Not indexed while draft: a search engine quoting "[CONTROLLER NAME]"
    // back at a visitor is a worse outcome than a page that is hard to find.
    robots: { index: false, follow: false },
    other: { [DRAFT_META_NAME]: "true" },
  };
}

export function LegalPageFrame({
  title,
  intro,
  children,
}: {
  title: string;
  intro: readonly string[];
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
        {title}
      </h1>
      {LEGAL_REVIEW_STATUS === "draft" ? (
        <p
          role="status"
          data-testid="legal-draft-notice"
          className="mt-4 max-w-prose rounded-md border border-border px-3 py-2 text-sm text-muted-foreground"
        >
          {DRAFT_NOTICE}
        </p>
      ) : null}
      {intro.map((paragraph, index) => (
        <p key={index} className="mt-4 max-w-prose text-sm text-muted-foreground">
          {paragraph}
        </p>
      ))}
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
 * Keyed by position, not by text (PR #90 review round 1): two identical
 * paragraphs would collide on a text key. The content is static data from
 * ./content.ts and is never reordered at runtime, so an index is a stable
 * identity here.
 */
export function LegalParagraphs({ paragraphs }: { paragraphs: readonly string[] }) {
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="mt-3 max-w-prose text-sm text-muted-foreground">
          {paragraph}
        </p>
      ))}
    </>
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
        // A fragment keyed per row, so dt and dd stay siblings inside the dl
        // (a wrapper div between them is invalid in a grid dl for assistive
        // tech in some browsers). Keyed by position for the same reason as
        // LegalParagraphs above.
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
