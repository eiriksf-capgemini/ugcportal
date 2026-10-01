import { GALLERY_STATE_CONTAINER_CLASS } from "@/components/gallery/containment";

/**
 * What the home page renders when `listPublicMedia` answers `ok: false`
 * (ugcportal-0dh).
 *
 * A SEPARATE MODULE FROM `gallery.tsx`, and deliberately not just a second
 * export living next to `GalleryEmpty` there. `gallery.tsx` opens with
 * `"use client"`, which is right for `Gallery` itself (state, refs, the
 * lightbox) and unavoidable for `GalleryEmpty` (it is one branch of that same
 * client component's own render, reachable on hydration whenever the initial
 * page has nothing in it). `GalleryUnavailable` is neither: it is rendered
 * only from `src/app/page.tsx`, a Server Component, as an ALTERNATIVE to
 * `<Gallery>` entirely — the two are never both on screen, and `Gallery`
 * itself never renders this component. Defining it inside `gallery.tsx` would
 * cost every visitor a few bytes of client JS for a branch the client bundle
 * has no reason to carry. Living in its own plain module (no `"use client"`)
 * makes it a genuine Server Component: zero bytes shipped to the browser.
 *
 * NOT `GalleryEmpty`. That component's whole second sentence — "Nothing is
 * hidden from you — the gallery is genuinely empty" — is a claim about the
 * listing having been read successfully and come back with nothing in it.
 * This branch is the other case: the listing was NOT read successfully, so
 * the honest claim is the opposite of that one, and the two must not share
 * copy or a visitor reading a failed fetch is told a specific, false thing
 * about the state of the gallery.
 *
 * `data-gallery-state="error"` (against `GalleryEmpty`'s `"empty"`) is what
 * makes the two distinguishable in the rendered markup itself, per K3 — not
 * only by which sentence happens to be present, which a future copy edit
 * could make the two read alike.
 */
export function GalleryUnavailable() {
  return (
    <div className={GALLERY_STATE_CONTAINER_CLASS} data-gallery-state="error">
      <h1 className="max-w-2xl text-2xl leading-tight font-medium tracking-tight text-balance text-foreground sm:text-3xl">
        The gallery could not be loaded.
      </h1>
      <p className="mt-4 max-w-prose text-sm text-muted-foreground">
        {/*
          No `role="alert"`. It would do two different things depending on
          HOW a visitor arrives here, and only one of them is useful: a
          client-side navigation to "/" (an ordinary Next.js <Link>, e.g. from
          /upload) inserts this whole subtree fresh, which is exactly the
          shape assistive tech reliably announces an alert on. A direct
          browser load of "/" is the opposite case — this paragraph is part
          of the FIRST render the page ever had, not a later change, and the
          established reasoning in gallery.tsx's own GalleryPaging ("a live
          region inserted at the same moment as its text is frequently not
          announced at all") applies just as much to a whole page as to one
          region of it. Rather than ship an attribute that is load-bearing on
          one path and a no-op on the other, the heading above carries the
          failure in plain text either way: a real `<h1>`, read in document
          order or by heading navigation, regardless of which path got here.
        */}
        Something went wrong while fetching photographs. This is not the same
        as an empty gallery — please try refreshing in a moment.
      </p>
    </div>
  );
}
