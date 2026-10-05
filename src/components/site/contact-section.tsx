import { ContactMailtoForm } from "@/components/site/contact-mailto-form";
import { SECTION_HEADING_CLASS } from "@/components/site/section-heading";
import { INLINE_LINK_CLASS } from "@/components/ui/inline-link";
import {
  contactMailtoHref,
  isBareEmailAddress,
  resolveContactEmail,
} from "@/lib/contact";
import { ABOUT_CONTACT_PATH, PRIVACY_PATH, pathFragment } from "@/lib/routes";
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
    // id derived from ABOUT_CONTACT_PATH itself (src/lib/routes.ts), not a
    // second hand-typed "contact" literal (round-3 review) — the footer's
    // Contact link and this section's navigation target would otherwise
    // be two independent places that happen to agree today and could
    // silently drift apart. data-page-section="contact" above was a test
    // hook only and nothing a fragment link could navigate to.
    //
    // scroll-mt-[var(--header-height,...)], not scroll-mt-14 (round-1
    // review): PR #94 introduces --header-height on the shell, and once
    // that header becomes a different real height than today's 56px this
    // section would silently go back to scrolling under it. The literal
    // 3.5rem (56px) fallback is only for the window before #94 merges, when
    // the variable is unset and would otherwise resolve to 0 — it must
    // match #94's --header-height exactly once that lands, or this reverts
    // to the bug it fixes.
    <section
      id={pathFragment(ABOUT_CONTACT_PATH)}
      className="mt-10 scroll-mt-[var(--header-height,3.5rem)]"
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
