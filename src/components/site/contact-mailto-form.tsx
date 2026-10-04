"use client";

import { useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { contactMailtoHref } from "@/lib/contact";

const FIELD_CLASS =
  "mt-2 block w-full rounded-md border border-line-strong bg-surface-1 px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * The interactive half of the contact form (ugcportal-qnq9.7 round-1 review,
 * the blocking medium finding).
 *
 * THE BUG THIS REPLACES: a GET-method `<form action="mailto:...">` lets the
 * BROWSER build the query string, the same way it would for an ordinary form
 * POST — `application/x-www-form-urlencoded`, which encodes a space as `+`.
 * A `mailto:` URI is not a web form target (RFC 6068), and a mail client
 * reading one does not decode `+` back to a space, so the subject arrived as
 * the literal text "Hello+from+your+portfolio+page" in a real mail client.
 *
 * THE FIX: this component is a Client Component ("use client") specifically
 * so it can hold the subject/message fields as React state and build the
 * `mailto:` href ITSELF, via `contactMailtoHref` (`encodeURIComponent`,
 * which correctly encodes a space as `%20`), recomputed on every keystroke —
 * rather than letting the browser serialise the form at submission time.
 * "Submission" is therefore an ordinary link activation (the `<a>` below),
 * not a native form submit; the `<form>` element is kept purely for the
 * grouping/labelling semantics (`<label htmlFor>` needs a form control to
 * point at), with its own `onSubmit` prevented since there is nothing for a
 * native submission to do.
 *
 * NOT `type="submit"` with `required` validation: with no native submit
 * event to validate, an HTML `required` attribute would be inert, and
 * leaving it on would claim a guarantee this markup does not enforce.
 */
export function ContactMailtoForm({
  email,
  defaultSubject,
}: {
  email: string;
  defaultSubject: string;
}) {
  const [subject, setSubject] = useState(defaultSubject);
  const [message, setMessage] = useState("");
  const href = contactMailtoHref(email, {
    subject,
    body: message === "" ? undefined : message,
  });

  return (
    <form
      className="mt-4 max-w-prose"
      data-contact-form=""
      onSubmit={(event) => event.preventDefault()}
    >
      <label htmlFor="contact-subject" className="block text-sm font-medium text-ink">
        Subject
      </label>
      <input
        id="contact-subject"
        type="text"
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
        className={FIELD_CLASS}
      />

      <label
        htmlFor="contact-message"
        className="mt-4 block text-sm font-medium text-ink"
      >
        Message
      </label>
      <textarea
        id="contact-message"
        rows={5}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        className={FIELD_CLASS}
      />

      <a
        href={href}
        className={buttonVariants({ className: "mt-4" })}
        data-contact-submit=""
      >
        Open your email client
      </a>
    </form>
  );
}
