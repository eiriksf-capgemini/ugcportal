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

  it("renders with no session and reads nothing from one", async () => {
    // It MUST work unauthenticated: @auth/core detects a pages.error that
    // requires authentication and abandons it for its own Configuration
    // page. This file mocks no session provider at all, so a call to auth()
    // creeping into the page would fail here rather than in production.
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
