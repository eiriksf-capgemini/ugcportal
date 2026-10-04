import { expect, test } from "@playwright/test";

import { footerLinkHrefs, uniqueFetchTargets } from "../footer-test-support";

/**
 * K3 (ugcportal-akv6): "Following should never happen: a footer link
 * pointing at a page carrying a draft marker when NODE_ENV is production."
 *
 * Runs against a REAL `next start` production server (see this directory's
 * own playwright.config.ts) — not `next dev`, which hard-codes
 * NODE_ENV=development and could never exercise this at all. Two halves:
 *
 *  1. every href the production footer actually renders must NOT resolve to
 *     a page carrying the `ugcportal:draft` meta tag (src/components/legal/
 *     legal-page.tsx's `DRAFT_META_NAME`) — the literal reading of K3;
 *  2. because today's real deployment configuration (no LEGAL_SIGN_OFF, no
 *     LEGAL_* env vars set — see playwright.config.ts's own comment) means
 *     BOTH /privacy and /licence are drafts right now, this also directly
 *     asserts the footer has in fact hidden/annotated them rather than
 *     passing (1) vacuously because there happened to be nothing to check.
 *
 * KNOWN GAP: this worktree has no path to flip LEGAL_SIGN_OFF to a non-null
 * value at request time (it's a module-level constant in src/lib/legal/
 * contact.ts, not an env var), so the "pages ARE signed off, in production,
 * and get linked normally" branch is covered at the unit level only
 * (src/components/site-footer.test.tsx's own "MUTATION CHECK: links
 * Privacy and Licence normally outside production" case proves the OTHER
 * half of that same branch — non-production — with the real loaders; this
 * file proves the production branch with whatever readiness is really
 * configured today, which is "still draft").
 */

test("production footer never links a page carrying the draft marker", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const hrefs = await footerLinkHrefs(page);
  const targets = uniqueFetchTargets(hrefs);
  expect(targets.length).toBeGreaterThan(0);

  for (const target of targets) {
    const response = await request.get(target);
    const body = await response.text();
    const isDraft = /<meta[^>]+name="ugcportal:draft"/.test(body);
    expect(isDraft, `${target} must not be linked from a production footer while draft`).toBe(
      false,
    );
  }
});

test("today's real configuration: /privacy and /licence ARE drafts, and the footer does not link either", async ({
  page,
  request,
}) => {
  // Confirms the premise the test above would otherwise pass vacuously
  // without: these two pages really do carry the draft marker right now
  // (no LEGAL_SIGN_OFF, see src/lib/legal/contact.ts), so the footer
  // omitting their <a href> is a real effect of the guard, not an absence
  // of anything to guard against.
  for (const path of ["/privacy", "/licence"]) {
    const response = await request.get(path);
    const body = await response.text();
    expect(body, path).toContain('name="ugcportal:draft"');
  }

  await page.goto("/");
  const hrefs = await footerLinkHrefs(page);
  expect(hrefs).not.toContain("/privacy");
  expect(hrefs).not.toContain("/licence");

  // Still named for the visitor, as inert text, not vanished outright — see
  // src/components/site-footer.tsx's FooterNavLink.
  const footerText = await page.locator("footer[data-site-footer]").innerText();
  expect(footerText).toContain("Privacy");
  expect(footerText).toContain("Licence and rights");
});
