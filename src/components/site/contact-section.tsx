import { ContactMailtoForm } from "@/components/site/contact-mailto-form";
import { SECTION_HEADING_CLASS } from "@/components/site/section-heading";
import { INLINE_LINK_CLASS } from "@/components/ui/inline-link";
import {
  contactMailtoHref,
  isBareEmailAddress,
  resolveContactEmail,
} from "@/lib/contact";
import { PRIVACY_PATH } from "@/lib/routes";
import { CONTACT_INTRO, CONTACT_NOTICE } from "@/lib/site";

/**
 * A neutral fallback for the visible "email us directly" link text, for
 * when `CONTACT_EMAIL` fails the same shape test
 * `checkContactEmailConfiguration` (src/instrumentation.ts) warns about at
 * boot (round-5 review). That boot check is a WARNING, not a block —
 * `resolveContactEmail` still returns whatever is configured — so a
 * misconfigured value (`"Jane Doe <jane@example.com>"`, say) would
 * otherwise be shown to every visitor as the literal link text, not only
 * logged for an operator to notice. `contactMailtoHref` already encodes it
 * defensively for the `href` itself (round-2 review); this is the same
 * defence for what a visitor actually READS.
 */
const CONTACT_EMAIL_FALLBACK_LABEL = "our email address";

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
 * that guard to a boot-time check, src/instrumentation.ts), so this
 * component itself no longer needs either caller to be `force-dynamic` on
 * its account — both still carry that export today, each for its own
 * unrelated reason (see each page file's own comment).
 */

export function ContactSection({ defaultSubject }: { defaultSubject: string }) {
  const email = resolveContactEmail();
  const directHref = contactMailtoHref(email, { subject: defaultSubject });
  const directLinkLabel = isBareEmailAddress(email)
    ? email
    : CONTACT_EMAIL_FALLBACK_LABEL;

  return (
    // id="contact" is the footer's link target (ABOUT_CONTACT_PATH,
    // src/lib/routes.ts, ugcportal-akv6) — data-page-section="contact" above
    // was a test hook only and nothing a fragment link could navigate to.
    // scroll-mt-14 matches the sticky header's 56px height (see
    // src/components/app-shell.tsx's identical class on <main>, for the
    // same reason): without it, landing here from the footer's anchor link
    // scrolls this section's top edge under the header instead of past it.
    <section
      id="contact"
      className="mt-10 scroll-mt-14"
      data-page-section="contact"
    >
      <h2 className={SECTION_HEADING_CLASS}>Get in touch</h2>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        {CONTACT_INTRO}
      </p>

      <p className="mt-4 max-w-prose text-xs text-muted-foreground" data-contact-notice="">
        {CONTACT_NOTICE}{" "}
        <a className={INLINE_LINK_CLASS} href={PRIVACY_PATH}>
          Read our privacy statement
        </a>
        .
      </p>

      <ContactMailtoForm email={email} defaultSubject={defaultSubject} />

      <p className="mt-4 text-sm text-muted-foreground">
        Prefer to email us directly?{" "}
        <a className={INLINE_LINK_CLASS} href={directHref} data-contact-direct-link="">
          {directLinkLabel}
        </a>
      </p>
    </section>
  );
}
