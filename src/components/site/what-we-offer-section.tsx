import { WHAT_WE_OFFER } from "@/lib/site-copy";

/**
 * §5.3: "What you offer: short videos, photo sets, reviews." Shared by
 * /about and /portfolio, same reasoning as IntroSection.
 */
export function WhatWeOfferSection() {
  return (
    <section className="mt-10" data-page-section="offer">
      <h2 className="text-lg font-semibold tracking-tight text-foreground">
        What we offer
      </h2>
      <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {WHAT_WE_OFFER.map((item) => (
          <div key={item.title}>
            <dt className="text-sm font-medium text-foreground">{item.title}</dt>
            <dd className="mt-1 text-sm text-muted-foreground">
              {item.description}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
