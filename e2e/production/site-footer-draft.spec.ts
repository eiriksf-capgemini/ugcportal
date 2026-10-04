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
 *     legal-page.tsx's `DRAFT_META_NAME`) — the literal reading of K3, and
 *     an invariant that holds whatever today's real readiness is;
 *  2. the footer's Privacy/Licence links must match whatever that real
 *     readiness ACTUALLY is right now — read live from each page's own
 *     response, not assumed — so this test keeps meaning something however
 *     src/lib/legal/contact.ts's real `LEGAL_SIGN_OFF` changes over time
 *     (round-1 review follow-up: ugcportal-alg signed off the real
 *     /privacy and /licence after this file was first written, which
 *     silently flipped a hard-coded "both are drafts today" assumption
 *     this test used to make — this worktree's env happens to still leave
 *     them in draft today for an unrelated reason, no LEGAL_* variable is
 *     set in e2e/production/playwright.config.ts's webServer, but a future
 *     run with them configured must not need this file edited to stay
 *     correct).
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

test("the footer's Privacy/Licence links match today's REAL readiness, whichever way that reads", async ({
  page,
  request,
}) => {
  // Read whether each page is ACTUALLY a draft right now, live — not
  // assumed — so this test adapts to whatever src/lib/legal/contact.ts's
  // real LEGAL_SIGN_OFF currently says, rather than hard-coding "both are
  // drafts today" as a premise that silently goes stale the moment that
  // changes (see this file's own header comment).
  const draftByPath = new Map<string, boolean>();
  for (const path of ["/privacy", "/licence"] as const) {
    const response = await request.get(path);
    const body = await response.text();
    draftByPath.set(path, /<meta[^>]+name="ugcportal:draft"/.test(body));
  }

  await page.goto("/");
  const hrefs = await footerLinkHrefs(page);
  const footerText = await page.locator("footer[data-site-footer]").innerText();

  for (const [path, label] of [
    ["/privacy", "Privacy"],
    ["/licence", "Licence and rights"],
  ] as const) {
    if (draftByPath.get(path)) {
      expect(hrefs, `${path} is a draft right now, so the footer must not link it`).not.toContain(
        path,
      );
      // Still named for the visitor, as inert text annotated "(coming
      // soon)", not vanished outright and not merely recoloured — see
      // src/components/site-footer.tsx's FooterNavLink.
      expect(footerText, path).toContain(`${label} (coming soon)`);
    } else {
      expect(
        hrefs,
        `${path} is NOT a draft right now, so the footer should link it normally`,
      ).toContain(path);
    }
  }
});
