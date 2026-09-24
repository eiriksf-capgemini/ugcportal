import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits a self-contained `.next/standalone` build (server + only the
  // production node_modules actually reachable at runtime) so the
  // production Docker image doesn't need the full node_modules tree or
  // the Next.js CLI. See Dockerfile.
  output: "standalone",
};

export default nextConfig;
