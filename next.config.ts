import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits a self-contained `.next/standalone` build (server + only the
  // production node_modules actually reachable at runtime) so the
  // production Docker image doesn't need the full node_modules tree or
  // the Next.js CLI. See Dockerfile.
  output: "standalone",

  experimental: {
    serverActions: {
      // Next's default server-action body limit is 1 MB, which the framework
      // enforces before the action runs — so an action's own size check can
      // never be reached above it, and an ordinary 4 MB signed PDF would die
      // with a generic framework error instead of a usable message.
      //
      // Raised to sit just above MAX_EVIDENCE_BYTES in
      // src/app/admin/settings/instagram/actions.ts (20 MB), so that the
      // action's own check is the one that fires and the two numbers agree.
      // Keep them in step: this is the outer bound, that one is the message.
      //
      // Applies to every server action, not just this one. That is
      // acceptable while the only other action carries a single account id,
      // and it is a ceiling, not an allocation — nothing buffers 21 MB
      // unless a client actually sends it.
      bodySizeLimit: "21mb",
    },
  },
};

export default nextConfig;
