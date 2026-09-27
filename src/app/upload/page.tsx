import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { UPLOAD_PATH, signInPath } from "@/lib/routes";

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
  const session = await auth();

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
      <h1 className="text-2xl font-medium tracking-tight text-ink sm:text-3xl">
        Upload
      </h1>
      <p className="mt-3 max-w-prose text-sm text-ink-muted">
        Add images and video to your library. Each image is watermarked as it
        arrives, and only that watermarked copy is ever displayed.
      </p>

      <div className="mt-8">
        <UploadForm />
      </div>
    </div>
  );
}
