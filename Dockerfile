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

CMD ["node", "server.js"]
