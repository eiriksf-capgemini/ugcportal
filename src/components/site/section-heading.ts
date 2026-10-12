import { cn } from "cn";

import { SECTION_TITLE_CLASS } from "@/components/type-scale";

/**
 * The shared `<h2>` styling for a named section on /about and /portfolio —
 * "What we offer" (src/components/site/what-we-offer-section.tsx), "Get in
 * touch" (src/components/site/contact-section.tsx), and "Samples"
 * (src/app/portfolio/page.tsx). One constant, not the same class string
 * written out three times (round-3 review of ugcportal-qnq9.7).
 *
 * Built on SECTION_TITLE_CLASS plus this surface's own colour
 * (ugcportal-qqnt.1): these three headings used to carry their own smaller
 * size (`text-lg font-semibold`) than the gallery/empty-state/unavailable
 * headings on the home page (`text-2xl font-medium`). The type-scale bead's
 * K2 asks /about and /portfolio to use "the same section utility" as the
 * rest of the site for their first subsection — done here by pointing this
 * constant at the one shared size rather than keeping a second, smaller
 * "section" that would still disagree with it.
 */
export const SECTION_HEADING_CLASS = cn(SECTION_TITLE_CLASS, "text-foreground");

/**
 * The shared wrapper spacing for one of the three sections above — "What we
 * offer", "Get in touch", "Samples" — one constant rather than the same
 * `"mt-10"` literal written out three times (ugcportal-qnq9.16, item 4 of
 * the lows deferred from PR #93's round-6 review). `ContactSection` also
 * needs `scroll-mt-[...]` alongside it; compose at the call site with
 * `cn(SECTION_WRAPPER_CLASS, "scroll-mt-[...]")` rather than baking that
 * into this constant, which the other two sections do not need. `cn()`,
 * NOT a template literal: ugcportal-wz8w's lint guard (eslint.config.mjs,
 * `INTERPOLATED_CLASSNAME_SELECTORS`) bans building a class string by
 * interpolation, because Tailwind v4's scanner reads source TEXT and never
 * evaluates it.
 */
export const SECTION_WRAPPER_CLASS = "mt-10";
