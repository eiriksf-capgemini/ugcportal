import { SITE_DESCRIPTION } from "@/lib/site";

/**
 * A holding page, on the design-system tokens.
 *
 * ugcportal-71y owns what actually goes here — the public gallery feed and its
 * lightbox — and says so explicitly in its scope ("replacing the create-next-app
 * default content currently sitting in src/app/page.tsx"). This bead only had
 * to stop that default content from being a second visual language: it painted
 * its own zinc/black surfaces and hardcoded greys rather than consuming any
 * token.
 *
 * So this is deliberately almost nothing. Building a gallery here to have
 * something to look at would be taking 71y's work, and the whole point of the
 * surround is that it recedes.
 */
export default function Home() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-4 py-24 sm:px-6">
      <h1 className="max-w-2xl text-3xl leading-tight font-medium tracking-tight text-balance text-foreground sm:text-4xl">
        {SITE_DESCRIPTION}
      </h1>
      <p className="mt-4 max-w-prose text-sm text-muted-foreground">
        The gallery is not here yet. When it lands it renders into this space,
        full width, against the same surround.
      </p>
    </div>
  );
}
