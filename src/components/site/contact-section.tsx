import { ContactMailtoForm } from "@/components/site/contact-mailto-form";
import { contactMailtoHref, resolveContactEmail } from "@/lib/contact";
import { PRIVACY_PATH } from "@/lib/routes";
import { CONTACT_INTRO, CONTACT_NOTICE } from "@/lib/site";

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
 * curated list and a form" this bead's own model_why estimates. The actual
 * field-encoding and submission mechanics live in `ContactMailtoForm`
 * (src/components/site/contact-mailto-form.tsx, a Client Component) — see
 * that module's own comment for the round-1 review fix (the `+`-vs-`%20`
 * encoding bug) and why it has to run client-side.
 *
 * `defaultSubject` IS A PROP, not a shared constant (round-1 review): each
 * page names itself in its own default subject line rather than every
 * contact form on the site saying "portfolio page", even on /about.
 *
 * K5: the notice above the form states what happens and why BEFORE
 * submission (nothing is collected server-side at all; the visitor's own
 * mail client is the entire path), and links to the privacy statement
 * (`PRIVACY_PATH`, src/lib/routes.ts — ugcportal-qnq9.4's /privacy, not yet
 * merged — see that bead's PR for the gap).
 *
 * Calls `resolveContactEmail()` ITSELF, inside this component's render,
 * rather than receiving the email as a prop computed by its caller — so
 * both callers (src/app/about/page.tsx, src/app/portfolio/page.tsx) read
 * the same live configuration without either having to remember to pass it
 * through. `resolveContactEmail` no longer throws (round-1 review moved
 * that guard to a boot-time check, src/instrumentation.ts), so this no
 * longer forces its callers to be `force-dynamic` on its account — /about
 * is static again for exactly that reason.
 */
export function ContactSection({ defaultSubject }: { defaultSubject: string }) {
  const email = resolveContactEmail();
  const directHref = contactMailtoHref(email, { subject: defaultSubject });

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

      <ContactMailtoForm email={email} defaultSubject={defaultSubject} />

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
