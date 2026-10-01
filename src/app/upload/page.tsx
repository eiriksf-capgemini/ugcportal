import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth";
import { UPLOAD_PATH, signInPath } from "@/lib/routes";
import { listPickerTags } from "@/lib/tags";

import { UploadForm } from "./upload-form";

export const metadata = {
  title: "Upload",
};

/**
 * Manual upload (ugcportal-n3c).
 *
 * The only door media comes in through: ugcportal-8wa shipped POST /api/media
 * with no front end at all, and the Instagram sync was deferred, so before
 * this page the only way to add anything to the product was an HTTP client.
 *
 * The page is the auth gate, and the form is a client component underneath
 * it. Everything static — the heading, the explanation — is rendered on the
 * server so it is on screen before any JavaScript arrives.
 */
export default async function UploadPage() {
  const session = await getSession();

  /*
    Gated on `user.id`, not on `session` or `user`, because `user.id` is
    exactly what POST /api/media requires (`session?.user?.id`, else 401).
    Gating on anything weaker would let through a visitor who is shown a form
    that 401s on submit — the failure K5 exists to prevent — and gating on
    anything stronger would lock out someone the API would have served.

    A redirect rather than an inline "please sign in": there is no first-party
    sign-in page to render, and Auth.js's own provider picker is a real
    destination with a working callback (see signInPath).
  */
  if (!session?.user?.id) {
    redirect(signInPath(UPLOAD_PATH));
  }

  /*
    The subject vocabulary (ugcportal-jsc), read here rather than fetched by
    the form: this page is already a server component and already awaiting a
    session, so the picker arrives populated in the first HTML instead of
    appearing a round trip later.

    AFTER the auth gate, deliberately. It is not secret — every tag on a
    published item is on the public gallery — but there is no reason for an
    unauthenticated request that is about to be redirected to run a query.

    BOUNDED AND FILTERED BY `listPickerTags`, not by a `findMany` spelled
    here. The bound is a security property rather than a tidiness one — the
    tag table has no ceiling and any authenticated account can add to it, so
    an unbounded SELECT rendered one-checkbox-per-row made this page a denial
    of service on itself. The rule lives next to the rest of the tag rules so
    a second reader cannot be added without it; see the note there for the
    ordering, which is the half that makes the cap useful.

    Sorted for DISPLAY here, by name. `listPickerTags` returns oldest-first
    because that is what makes the cap unspoofable, and that is not an order
    anybody wants to read a list of subjects in.
  */
  const availableTags = [...(await listPickerTags())].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  return (
    /*
      max-w-3xl, narrower than the shell's max-w-6xl: this is a single column
      of rows, and a 1152px-wide file list puts the filename and its status at
      opposite ends of the screen. The gallery (ugcportal-71y) is what wants
      the full width.

      No <main> here — src/components/app-shell.tsx owns the page's single
      main landmark, and a second one would break the skip link.
    */
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      {/*
        text-foreground/text-muted-foreground, not text-ink/text-ink-muted
        (ugcportal-rw9j review round 4): this heading and intro sit directly
        on --background (this div has no bg-surface-* class), not inside any
        near-black well. --color-ink/--color-ink-muted are tuned for that
        near-black scale and measured ~1.1-1.9:1 against the new --paper
        canvas in light mode; the semantic foreground/muted-foreground tokens
        are the ones actually mode-aware for the page canvas.
      */}
      <h1 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
        Upload
      </h1>
      <p className="mt-3 max-w-prose text-sm text-muted-foreground">
        Add images and video to your library. Each image is watermarked as it
        arrives, and only that watermarked copy is ever displayed.
      </p>

      <div className="mt-8">
        <UploadForm availableTags={availableTags} />
      </div>
    </div>
  );
}
