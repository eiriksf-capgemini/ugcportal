# syntax=docker/dockerfile:1
#
# Production image for the ugcportal Next.js app.
#
# Multi-stage build:
#   1. deps    - installs the full dependency tree (incl. devDependencies),
#                needed to compile TypeScript/Tailwind/etc.
#   2. builder - regenerates the Prisma client (`prisma generate`) from
#                schema.prisma, then runs `next build`. With
#                `output: "standalone"` set in next.config.ts, this
#                produces `.next/standalone`: a
#                self-contained server bundle plus only the production
#                node_modules actually reachable from that bundle (Next's
#                file-tracing excludes devDependencies such as typescript,
#                tailwindcss, eslint, vitest, and the `prisma` CLI itself).
#   3. runner  - copies just the standalone output, `public/`, and
#                `.next/static` into a fresh, minimal base image and runs
#                it as a non-root user. No source, no full node_modules,
#                no dev tooling, no .git, no .env files ever reach this
#                stage.
#
# Prisma note: this app uses Prisma's driver-adapter mode
# (@prisma/adapter-libsql against a libsql-backed SQLite datasource), so
# there is no Rust query-engine binary to ship — only the pure-JS
# @prisma/client runtime plus the platform-specific @libsql/* native
# binding, both of which Next's tracing already pulls into
# `.next/standalone/node_modules`. `prisma generate` still has to run at
# build time (in the builder stage, before `next build`) so
# `src/generated/prisma` exists for the app to import and for the build
# to bundle.
#
# sharp note (ugcportal-44q): watermark generation needs sharp's native
# libvips binding, which npm installs as a platform-specific optional
# dependency — @img/sharp-linuxmusl-x64 (+ @img/sharp-libvips-linuxmusl-x64)
# on this alpine base. Two things have to hold, and both were checked
# without running this build:
#   1. the lockfile resolves the musl variant — confirmed by running
#      `npm ci --omit=dev --os=linux --libc=musl --cpu=x64` against this
#      exact package-lock.json, which installs both @img musl packages; and
#   2. Next's file tracing carries them into `.next/standalone/node_modules`
#      — @vercel/nft has an explicit `sharp` rule that enumerates *every*
#      entry in sharp's own optionalDependencies (and each of those packages'
#      optionalDependencies) and emits whichever ones exist on disk, so it
#      does not branch on the host platform. Observed doing exactly that for
#      the darwin binding on a workstation build.
# Residual risk: this image has never actually been built or run, so a
# failure at load time would only show up on first deploy.
#
# What tracing cannot supply is font *files*; see the apk install in the
# runner stage.

ARG NODE_VERSION=20-alpine

FROM node:${NODE_VERSION} AS deps
WORKDIR /app

# Install dependencies first, isolated from application source, so this
# (slow) layer is cached across source-only changes.
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma7.config.ts ./
RUN npm ci


FROM node:${NODE_VERSION} AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Regenerate the Prisma client from schema.prisma inside the image rather
# than trusting anything that might exist on the host (src/generated is
# gitignored and dockerignored - see .dockerignore - precisely so this
# stage is the only source of truth for it).
RUN npx prisma generate

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

# next build type-checks the app and evaluates route/config modules (e.g.
# the NextAuth setup in src/lib/auth.ts) at build time, so it needs these
# vars *defined*, even though no real provider is ever contacted during
# the build. These are placeholders only, discarded with this stage - the
# runner stage below must be given real values at deploy/run time instead.
ENV AUTH_SECRET=build-time-placeholder-not-a-real-secret \
    AUTH_GOOGLE_ID=build-time-placeholder \
    AUTH_GOOGLE_SECRET=build-time-placeholder \
    AUTH_FACEBOOK_ID=build-time-placeholder \
    AUTH_FACEBOOK_SECRET=build-time-placeholder

RUN npm run build

# Next/Turbopack emits placeholder .js.map files alongside the server
# route bundles even with client source maps disabled. They're empty
# stubs (no embedded source), but K2 says never ship source maps in the
# production image, so strip anything matching before the runner stage
# copies from here.
RUN find .next/standalone .next/static -name '*.map' -delete


FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Fonts for the watermark overlay (ugcportal-44q). sharp draws the preview's
# watermark text through libvips -> pango -> fontconfig, and libvips ships no
# font files of its own; a bare node:*-alpine image has none either. Without
# this the text renders as nothing. `fontconfig` supplies /etc/fonts so the
# font is actually discoverable; `font-dejavu` is the family named first in
# the font stack in src/lib/watermark.ts.
#
# Removing this does not silently degrade previews: the watermark service
# probes for a usable font on first use and refuses to run without one, so
# uploads fail with a 5xx instead of shipping under-marked images.
#
# No FONTCONFIG_PATH is set, and that is deliberate rather than an oversight.
# The concern is real — sharp bundles its own fontconfig inside
# libvips-cpp.so, so its compiled-in default could point at the build prefix
# rather than at /etc/fonts. Checked against the actual artifact this image
# installs (@img/sharp-libvips-linuxmusl-x64, libvips-cpp.so.8.18.6):
#   - the only config-directory path in the binary is "/etc/fonts", sitting
#     immediately beside the "FONTCONFIG_FILE"/"FONTCONFIG_PATH"/"fonts.conf"
#     strings, i.e. fontconfig's standard default-path lookup with /etc/fonts
#     as the compiled-in fallback. There is no build-prefix path to compete
#     with it; and
#   - the built-in fallback config it embeds already lists
#     <dir>/usr/share/fonts</dir>, which is where apk puts font-dejavu.
# So FONTCONFIG_PATH=/etc/fonts would be a provable no-op, and setting it
# would imply a problem that the binary says does not exist.
RUN apk add --no-cache fontconfig font-dejavu

# Non-root runtime user (K1: "run as a non-root user in the final stage").
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Static assets Next's standalone tracing deliberately excludes and that
# must be copied in by hand: the public/ dir and the pre-built client
# bundles under .next/static.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

# Run this image with an explicit memory limit (ugcportal-e86).
#
#     docker run --memory=1g ...
#     # or, in a compose file / k8s manifest:
#     #   mem_limit: 1g  /  resources.limits.memory: 1Gi
#
# Not a nice-to-have, and not something this file can set for you — a memory
# limit is a runtime property of the container, so there is no Dockerfile
# directive for it. It matters here because watermark preview generation
# allocates in native libvips memory, outside the V8 heap and outside
# anything --max-old-space-size can bound. src/lib/watermark.ts caps how many
# previews run at once, and it sizes that cap by reading the cgroup's memory
# limit (src/lib/memory-budget.ts).
#
# With no limit set, that read falls back to host RAM, and on a shared host
# the cap is then derived from memory this container does not actually have —
# the process is free to allocate its way to an OOM kill, which is the exact
# failure the cap exists to prevent. The fallback is not silent: the app logs
# a warning at startup naming the budget, the chosen configuration and where
# each number came from. WATERMARK_MAX_CONCURRENCY overrides the derived
# value outright if the environment cannot supply a cgroup limit.
#
# Reference points from the derivation in src/lib/watermark.ts, where "burst"
# is how many simultaneous uploads are absorbed before any are rejected:
#
#     512 MB -> 1 at once,  3 queued, burst 4
#     768 MB -> 3 at once,  3 queued, burst 6
#       1 GB -> 3 at once, 12 queued, burst 15   <- recommended
#       2 GB -> 3 at once, 12 queued, burst 15
#
# Give it 1 GB. 512 MB does not fit an ordinary five-image multi-select and
# will reject the fifth upload; that is arithmetic, not tuning. Past ~1 GB
# the limit is bounded by libuv's worker pool rather than by memory, so a
# larger container needs UV_THREADPOOL_SIZE raised to make use of it.
#
# Setting the limit in a real deployment and load-checking against it is
# ugcportal-jp4.

CMD ["node", "server.js"]
