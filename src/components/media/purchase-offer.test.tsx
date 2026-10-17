import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  LICENCE_GRANT_ATTRIBUTE,
  PURCHASE_OFFER_ID,
  PurchaseOffer,
} from "@/components/media/purchase-offer";
import { LICENCE_PATH } from "@/lib/routes";
import type { PublicOffer } from "@/lib/pricing";

/**
 * ugcportal-74w.1 K1/K2/K4 at the component: what the offer panel draws for
 * a grant, for no grant, and for a grant somebody tried to put markup in.
 * The item page against a real database is src/app/media/[previewId]/
 * page.test.tsx; this file owns the rendering rules themselves.
 */

function offer(licenceTerms: string | null): PublicOffer {
  return { priceCents: 125_000, currency: "NOK", licenceTerms };
}

const render = (value: PublicOffer | null) => renderToStaticMarkup(<PurchaseOffer offer={value} />);

describe("the grant beside the price (K1)", () => {
  it("shows the stored text inside the grant container, after the price", () => {
    const html = render(offer("Web and social use for 12 months.\nCredit the photographer."));
    expect(html).toContain(LICENCE_GRANT_ATTRIBUTE);
    expect(html).toContain("Web and social use for 12 months.\nCredit the photographer.");
    expect(html.indexOf("1,250.00")).toBeLessThan(html.indexOf(LICENCE_GRANT_ATTRIBUTE));
    // The site-wide licence stays linked for what the grant does not say.
    expect(html).toContain(`href="${LICENCE_PATH}"`);
  });

  it("spells the exported marker the way the JSX does", () => {
    // The constant is the tests' needle; the JSX spells the attribute
    // literally. If the two drift, every absence assertion would pass.
    expect(render(offer("x"))).toMatch(new RegExp(`<section[^>]*${LICENCE_GRANT_ATTRIBUTE}=`));
  });
});

describe("no grant falls back to /licence (K2)", () => {
  it("renders the /licence link and no grant container or heading for null, and both flip once a grant is set", () => {
    const none = render(offer(null));
    expect(none).toContain(`id="${PURCHASE_OFFER_ID}"`);
    expect(none).toContain(`href="${LICENCE_PATH}"`);
    expect(none).not.toContain(LICENCE_GRANT_ATTRIBUTE);
    expect(none).not.toContain("What this licence grants");

    // THE FIXTURE MUTATION: the same offer with a grant, and the container
    // and its heading appear — so their absence above was about the value.
    const some = render(offer("Print use only."));
    expect(some).toContain(LICENCE_GRANT_ATTRIBUTE);
    expect(some).toContain("What this licence grants");
  });

  it("renders nothing at all for no offer, grant or not", () => {
    expect(render(null)).toBe("");
  });
});

describe("the grant is text, never markup (K4)", () => {
  it("escapes a script tag and an anchor tag, and no such element exists in the output", () => {
    const hostile =
      '<script>alert("x")</script> and <a href="https://evil.example/">a link</a>';
    const html = render(offer(hostile));

    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;a href=&quot;https://evil.example/&quot;&gt;a link&lt;/a&gt;");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('href="https://evil.example/"');
    // The one anchor in the panel is the /licence link.
    expect([...html.matchAll(/<a\s/g)]).toHaveLength(1);
  });
});
