import type { CommercialLinkNetwork } from "@/generated/prisma/enums";
import { COMMERCIAL_LINK_NETWORK_OTHER, isCommercialLinkNetwork } from "@/lib/commercial-link";
import { hasUnsafeText } from "@/lib/media-rules";

/**
 * How a `CommercialLink` is rendered, on every public surface (ugcportal-
 * qnq9.2.2). ONE module, imported directly by gallery-item.tsx (the shared
 * component the gallery tile, the portfolio tile and /media/[previewId] all
 * render `GalleryItemCommercialLinks` through) and by lightbox.ts (which
 * builds its own DOM by hand, outside React), so the `rel` tokens and the
 * marker text are the same string wherever a link is drawn rather than
 * separate hand-typed copies that could drift apart — the exact failure
 * `GALLERY_RADIUS_CLASS`'s own history (ugcportal-o312) shows a copy-per-
 * caller eventually produces.
 *
 * NO PRISMA IMPORT, and no import that reaches one — same claim
 * src/lib/commercial-link.ts makes next door, for the same reason: the only
 * type pulled from the generated client is an enum, a plain string union with
 * no runtime client behind it.
 *
 * WHAT THIS IS NOT. It does not decide WHETHER a link may render on an item
 * — that is the render-time gate (ugcportal-jain: a withdrawn disclosure must
 * never leave a link rendering), which lives in TWO places this module is
 * downstream of and does not duplicate: `toGalleryItem`
 * (src/lib/gallery-items.ts) for every React-rendered surface, and
 * `listPublicMedia` (src/lib/public-media.ts) for the raw `GET
 * /api/public/media` JSON. This module only decides what a link that has
 * already passed one of those gates SAYS and LOOKS LIKE.
 */

/**
 * `rel="sponsored nofollow noopener noreferrer"`, exactly, from one function
 * every surface calls rather than four hand-typed copies of the same string.
 *
 *   - `sponsored`: Google's own token for a paid/affiliate link (the HTML
 *     Living Standard's `rel` keyword table credits it to that use), which is
 *     exactly what every `CommercialLink` is by construction — it cannot
 *     exist without a disclosed benefit (`commercialLinkDisclosureRefusal`,
 *     src/lib/commercial-link.ts).
 *   - `nofollow`: belt-and-braces alongside `sponsored` — not every crawler
 *     reads the newer keyword, and `nofollow` is the one nothing has ever
 *     failed to recognise.
 *   - `noopener noreferrer`: this anchor always carries `target="_blank"`
 *     (opening an affiliate destination in the same tab would navigate the
 *     visitor off this site's own gallery); `noopener` stops the opened page
 *     reaching back via `window.opener`, and `noreferrer` stops this site's
 *     own URL leaking into the destination's referrer header before consent
 *     has been given to anything that would make that an acceptable trade
 *     (K3). Both withheld regardless of consent state — this is routing
 *     information, not an analytics script, and there is no "only after
 *     consent" version of an HTTP header the browser sends on navigation.
 *
 * A FUNCTION, not only a constant, because the bead's own text asks for "one
 * function used by every surface" — the lightbox builds its anchor outside
 * React, by hand, and a function call reads the same at that call site as a
 * JSX `rel={...}` does, which a bare exported string would not make as
 * obviously deliberate.
 */
export const COMMERCIAL_LINK_REL = "sponsored nofollow noopener noreferrer";

export function commercialLinkRel(): string {
  return COMMERCIAL_LINK_REL;
}

/**
 * The bilingual marker every commercial link carries as a visible sibling,
 * immediately after the link text — never a `title` attribute (invisible
 * until hover, and absent from touch and screen-reader-by-default use) and
 * never a hashtag-style chip (reads as a subject tag, not a compliance
 * disclosure — the same "must not read as a tag or a caption" rule
 * `GALLERY_ADVERTISING_LABEL_CLASS` states for the top-of-page label).
 *
 * English and Norwegian, in that order — the same pairing
 * `PERMITTED_ADVERTISING_LABELS` uses for the page-level label
 * (src/lib/advertising-disclosure.ts), so a reader who already recognises
 * that label recognises this one as its per-link sibling.
 */
export const COMMERCIAL_LINK_MARKER_TEXT = "Advertisement link / Annonselenke";

/**
 * The human-readable network names the five fixed enum members display as.
 * `OTHER` is deliberately absent: its display text is the brand's own
 * `networkOther` free text, read at the call site rather than hidden behind
 * a lookup table entry that would have to be kept in sync with nothing.
 */
const COMMERCIAL_LINK_NETWORK_DISPLAY_NAMES: Readonly<
  Record<Exclude<CommercialLinkNetwork, "OTHER">, string>
> = {
  ADTRACTION: "Adtraction",
  AWIN: "Awin",
  PARTNER_ADS: "Partner-Ads",
  TRADEDOUBLER: "Tradedoubler",
  ADRECORD: "Adrecord",
};

/**
 * The visible text of the link itself (K1's "link text"): the network's own
 * name, since `CommercialLink` stores no other display string and a bare
 * destination URL is not something a visitor should be asked to read aloud —
 * see `validateCommercialLinkUrl`'s own comment on why the stored `href` is
 * an affiliate deep link with tracking parameters, not a clean domain name.
 *
 * TAKES THE WHOLE ROW, not just `network`, because `OTHER`'s display text —
 * and `OTHER`'s alone — lives in the sibling column. Re-checked defensively
 * the same way `toAdvertisingLabel` (src/lib/gallery-items.ts) re-checks a
 * stored label: `isCommercialLinkNetwork` guards against a row that reached
 * here some way other than through `validateCommercialLinkNetwork`, and a
 * blank or unsafe `networkOther` falls back to the generic noun rather than
 * rendering nothing or rendering unsafe text — this function has no "hide
 * the whole link" failure mode available to it the way a `null` label does,
 * because by the time it runs the link has already passed the render gate.
 */
export function commercialLinkText(link: {
  network: unknown;
  networkOther: string | null;
}): string {
  if (!isCommercialLinkNetwork(link.network)) return "Shop this link";
  if (link.network !== COMMERCIAL_LINK_NETWORK_OTHER) {
    return COMMERCIAL_LINK_NETWORK_DISPLAY_NAMES[link.network];
  }
  const name = link.networkOther?.trim();
  // Re-screened with the same denylist the write path used
  // (`validateCommercialLinkNetwork`, src/lib/commercial-link.ts) — the same
  // "do not trust every row was written through the validator" rule
  // `toAdvertisingLabel`/`toGalleryTags` (src/lib/gallery-items.ts) apply to
  // their own fields. A bidi override in a free-text network name would
  // otherwise reverse the reading order of whatever text sits after it.
  if (!name || name.length === 0 || hasUnsafeText(name)) return "Shop this link";
  return name;
}
