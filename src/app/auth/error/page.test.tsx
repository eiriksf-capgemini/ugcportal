import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { signInPath } from "@/lib/routes";

import AuthErrorPage from "./page";

/**
 * ugcportal-egp: the page a refused sign-in lands on.
 *
 * Rendered rather than only unit-tested through ./outcomes, because what
 * matters here is the wiring — that the refusal case is the one that drops
 * the retry link, and that the page renders at all without a session.
 */

async function render(error?: string | string[]): Promise<string> {
  return renderToStaticMarkup(
    await AuthErrorPage({
      params: Promise.resolve({}),
      searchParams: Promise.resolve(error === undefined ? {} : { error }),
    } as Parameters<typeof AuthErrorPage>[0]),
  );
}

const RETRY_HREF = `href="${signInPath("/")}"`;

describe("the sign-in error page", () => {
  it("explains a refusal and offers only the way out that works", async () => {
    const markup = await render("AccessDenied");

    expect(markup).toContain("Access denied");
    expect(markup).toContain("private instance");
    expect(markup).toContain('href="/"');
    // The dead end this page exists to remove: a retry link that starts the
    // same refused journey. The default case below proves the needle can be
    // present, so this is falsifiable in both directions.
    expect(markup).not.toContain("Try signing in again");
    expect(markup).not.toContain(RETRY_HREF);
  });

  it("offers a retry for an interrupted sign-in", async () => {
    const markup = await render();

    expect(markup).toContain("Try signing in again");
    expect(markup).toContain(RETRY_HREF);
  });

  it("renders without reaching for a session", async () => {
    /*
      It MUST work unauthenticated — see the note in page.tsx: @auth/core
      does not detect a gated error page, so gating this one loops a refused
      visitor forever and nothing catches it.

      What this test does and does not prove, stated carefully because the
      first version of this comment overclaimed. It mocks no session
      provider, so the page importing `@/lib/auth` and calling `auth()`
      would fail HERE. It does NOT prove the page is safe in production by
      that route — in production the page renders inside AppShell →
      AuthStatus, which calls `auth()` on every page and tolerates a null
      session fine. Calling auth() is not the hazard; redirecting on it is,
      and no unit test of this page can see that. The invariant is held by
      the note in page.tsx and by review.
    */
    await expect(render("AccessDenied")).resolves.toContain("Access denied");
  });

  it("does not render the refusal reason", async () => {
    // Auth.js only ever puts the error TYPE in the query string, and every
    // refusal this app produces is the same type — but a page that echoed
    // the parameter would still hand an attacker a reflected surface.
    const markup = await render("not-permitted");

    expect(markup).not.toContain("not-permitted");
  });

  it("treats a repeated error parameter as the first value", async () => {
    const markup = await render(["AccessDenied", "Verification"]);

    expect(markup).toContain("Access denied");
    expect(markup).not.toContain("Try signing in again");
  });
});
