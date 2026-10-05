"use client";

import Link from "next/link";

import { HEADER_NAV_LINK_CLASS, useAriaCurrentPage } from "@/components/header-nav-link";
import { UPLOAD_PATH } from "@/lib/routes";

/**
 * The upload nav link's actual `<a>` (ugcportal-t0y round 4).
 *
 * A Client Component, not the Server Component that decides whether to show
 * it at all (src/components/upload-nav-link.tsx) — round 3 tried to answer
 * "is this the current page" server-side, by having a new src/proxy.ts stamp
 * the request's own path onto a header for a Server Component to read back.
 * Round 4 found that wrong on two counts, not one:
 *
 * 1. A proxy matching every request also matches every `/api/*` upload
 *    endpoint. Next clones a matched request's body via
 *    `getCloneableBody()`, which truncates the clone at
 *    `experimental.proxyClientMaxBodySize ?? 10 MB` with only a
 *    `console.warn` — silently corrupting any upload over 10 MB (this app
 *    accepts 200 MB video and 20 MB rights-evidence files) on exactly the
 *    upload path this bead exists to link to. A HIGH-severity regression
 *    from a one-line accessibility attribute.
 * 2. Even ignoring that, the header was read once, during the ROOT
 *    layout's render — and the App Router does not re-render a persistent
 *    root layout on client-side navigation. So `aria-current` would freeze
 *    at whatever it was on the last full page load: still "page" after
 *    navigating away from /upload with no reload, and never set at all
 *    after navigating to /upload without one. Actively wrong information
 *    for assistive tech, worse than the omission the header existed to fix.
 *
 * `usePathname()` fixes both by construction: it needs no request-level
 * infrastructure at all (no proxy, no header, no truncation surface), and
 * because it lives in a Client Component that participates in the App
 * Router's client-side navigation bookkeeping — unlike the root layout — it
 * re-renders, and this re-evaluates, on every soft navigation.
 *
 * The `aria-current` derivation and the base link class are shared with
 * src/components/primary-nav-link.tsx via src/components/header-nav-link.ts
 * (ugcportal-14k9 PR #94 review round 1, low finding 4) rather than each
 * hand-spelling its own copy — see that file's own comment.
 */
export function UploadLink() {
  const ariaCurrent = useAriaCurrentPage(UPLOAD_PATH);

  return (
    <Link href={UPLOAD_PATH} aria-current={ariaCurrent} className={HEADER_NAV_LINK_CLASS}>
      Upload
    </Link>
  );
}
