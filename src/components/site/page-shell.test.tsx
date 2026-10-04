import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PageShell } from "@/components/site/page-shell";

/**
 * Round-2 review: /about and /portfolio's shared page container and `<h1>`.
 */
describe("PageShell", () => {
  it("renders the title as an <h1> and the children below it", () => {
    const markup = renderToStaticMarkup(
      <PageShell title="About us">
        <p>hello</p>
      </PageShell>,
    );
    expect(markup).toMatch(/<h1[^>]*>About us<\/h1>/);
    expect(markup).toContain("<p>hello</p>");
  });

  it("defaults to the narrower max-width", () => {
    const markup = renderToStaticMarkup(
      <PageShell title="About us">
        <p>hello</p>
      </PageShell>,
    );
    expect(markup).toContain("max-w-3xl");
    expect(markup).not.toContain("max-w-6xl");
  });

  it("uses the wider max-width when wide is set", () => {
    const markup = renderToStaticMarkup(
      <PageShell title="Portfolio" wide>
        <p>hello</p>
      </PageShell>,
    );
    expect(markup).toContain("max-w-6xl");
    expect(markup).not.toContain("max-w-3xl");
  });

  it("carries flex-1, like every other top-level page container in this app", () => {
    const markup = renderToStaticMarkup(
      <PageShell title="About us">
        <p>hello</p>
      </PageShell>,
    );
    expect(markup).toContain("flex-1");
  });
});
