import { Button } from "@/components/ui/button";
import { contactMailtoHref, resolveContactEmail } from "@/lib/contact";
import { CONTACT_INTRO, CONTACT_NOTICE, PRIVACY_PATH } from "@/lib/site-copy";

/**
 * The contact affordance for /about and /portfolio (ugcportal-qnq9.7, K5).
 *
 * A `mailto:` form, not a backend one — a deliberate scope decision for this
 * release. The bead's own text describes "a contact form whose submission is
 * lawful"; the orchestrating instruction for this pass narrowed that to "a
 * contact route (e-mail placeholder Eirik fills)". Building a real POST
 * endpoint would mean a new Prisma model for submissions, a data category to
 * add to ugcportal-qnq9.4's privacy page (which lists "contact-form
 * submissions" as a category THIS bead would introduce), rate limiting and
 * spam handling — a materially bigger surface than "two static routes, a
 * curated list and a form" this bead's own model_why estimates. A GET-method
 * form targeting `mailto:` keeps the literal shape the bead asks for (a real
 * `<form>`, a real submission) while keeping NO data at all server-side,
 * which trivially satisfies "keeps no more than is needed" — the strongest
 * form of that requirement is needing nothing.
 *
 * KNOWN LIMITATION, worth naming rather than discovering later: a
 * GET-method form whose `action` is a `mailto:` URI is a long-standing
 * browser trick, not a web standard with guaranteed behaviour — some
 * browsers prompt for a handler, some silently do nothing if no mail client
 * is configured (common on a phone with only a webmail tab), and only the
 * `subject`/`body` field NAMES are honoured by RFC 6068; anything else
 * appended to the query string is ignored by the mail client. The plain
 * `mailto:` link beneath the form is there for exactly that failure mode —
 * copy the address and write an email the ordinary way.
 *
 * K5: the notice above the form states what happens and why BEFORE
 * submission (nothing is collected server-side at all; the visitor's own
 * mail client is the entire path), and links to the privacy statement
 * (ugcportal-qnq9.4's /personvern, not yet merged — see site-copy.ts for
 * that gap).
 *
 * Calls `resolveContactEmail()` ITSELF, inside this component's render,
 * rather than receiving the email as a prop computed by its caller at module
 * scope — see src/lib/contact.ts for why that matters: the guard that stops
 * an unconfigured placeholder reaching production only works if it runs at
 * request time, and both callers of this component (src/app/about/page.tsx,
 * src/app/portfolio/page.tsx) mark their route `force-dynamic` for the same
 * reason.
 */
const DEFAULT_SUBJECT = "Hello from your portfolio page";

export function ContactSection() {
  const email = resolveContactEmail();
  const directHref = contactMailtoHref(email, DEFAULT_SUBJECT);

  return (
    <section className="mt-10" data-page-section="contact">
      <h2 className="text-lg font-semibold tracking-tight text-foreground">
        Get in touch
      </h2>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        {CONTACT_INTRO}
      </p>

      <p className="mt-4 max-w-prose text-xs text-muted-foreground" data-contact-notice="">
        {CONTACT_NOTICE}{" "}
        <a
          className="rounded-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          href={PRIVACY_PATH}
        >
          Read our privacy statement
        </a>
        .
      </p>

      <form
        action={`mailto:${email}`}
        method="get"
        className="mt-4 max-w-prose"
        data-contact-form=""
      >
        <label
          htmlFor="contact-subject"
          className="block text-sm font-medium text-ink"
        >
          Subject
        </label>
        <input
          id="contact-subject"
          name="subject"
          type="text"
          defaultValue={DEFAULT_SUBJECT}
          className="mt-2 block w-full rounded-md border border-line-strong bg-surface-1 px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />

        <label
          htmlFor="contact-message"
          className="mt-4 block text-sm font-medium text-ink"
        >
          Message
        </label>
        <textarea
          id="contact-message"
          name="body"
          rows={5}
          required
          className="mt-2 block w-full rounded-md border border-line-strong bg-surface-1 px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />

        <Button type="submit" className="mt-4">
          Open your email client
        </Button>
      </form>

      <p className="mt-4 text-sm text-muted-foreground">
        Prefer to email us directly?{" "}
        <a
          className="rounded-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          href={directHref}
          data-contact-direct-link=""
        >
          {email}
        </a>
      </p>
    </section>
  );
}
