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
#                it as a non-root user. `.git` and `.env*` files do not
#                reach this stage, and node_modules here is the traced
#                subset -- no devDependencies, no `.bin` directory at all
#                (checked). But "the standalone output" is not small:
#                Next's whole-project file tracing sweeps the entire repo
#                into `.next/standalone` (`.dockerignore`'s header
#                documents the mechanism), and this stage copies that
#                directory wholesale -- so source and test files DO reach
#                this stage. Read out of a build of this commit: /app holds
#                2422 files, including the 438-file src/ tree and 258
#                files matching *.test.*/*.spec.*, plus docs/, scripts/,
#                prisma/, e2e/ and the repo-root config files (tsconfig,
#                eslint, vitest, playwright, etc). Re-run
#                `find /app -type f | wc -l` (and the same scoped to src/
#                or to *.test.*/*.spec.*) against a fresh build to check
#                today's figures -- the repo keeps growing, so these will
#                drift. Shipping that smaller is ugcportal-6jcq, filed and
#                deliberately out of scope here: this comment only
#                describes what the image actually contains.
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
# dependency — @img/sharp-linuxmusl-<arch> (+
# @img/sharp-libvips-linuxmusl-<arch>) on this alpine base. Two things have
# to hold:
#   1. the lockfile resolves the musl variant — confirmed by running
#      `npm ci --omit=dev --os=linux --libc=musl --cpu=x64` against this
#      exact package-lock.json, which installs both @img musl packages; and
#   2. Next's file tracing carries them into `.next/standalone/node_modules`
#      — @vercel/nft has an explicit `sharp` rule that enumerates *every*
#      entry in sharp's own optionalDependencies (and each of those packages'
#      optionalDependencies) and emits whichever ones exist on disk, so it
#      does not branch on the host platform.
#
# BUILT AND RUN FOR THE FIRST TIME on 2026-10-12 (ugcportal-fb32), on
# linux/arm64 (Docker Desktop on Apple Silicon, so that is the native
# platform here). What the image actually contains, read out of it rather
# than inferred: node_modules/@img holds four entries — `colour`,
# `sharp-linuxmusl-arm64`, `sharp-libvips-linuxmusl-arm64` and
# `sharp-wasm32` — i.e. (2) above behaves as described, emitting the musl
# bindings that exist on disk for the build platform (plus `colour`, a
# pure-JS dependency of sharp that every platform gets). An image uploaded
# through the running container
# produced a watermarked preview, so the binding loads and fontconfig
# resolves the font. The x64 half of (1) is still a lockfile check rather
# than a build: building for x64 needs `docker build --platform linux/amd64`
# and has not been done.
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
# `npm ci` runs package.json's `postinstall` (`prisma generate`), which loads
# prisma7.config.ts, which imports scripts/lib/env-files.mjs. Without this the
# install fails with "Cannot find module './scripts/lib/env-files.mjs'" —
# observed on the first build of this file (ugcportal-fb32). Only lib/ is
# copied, not the whole scripts/ directory, so a change to an unrelated
# maintenance script does not invalidate this (slow) layer.
COPY scripts/lib ./scripts/lib
RUN npm ci


FROM node:${NODE_VERSION} AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The same /data the runner stage creates below, with the same ownership, and
# here for a reason that is not obvious: docker-compose.yml runs the database
# migration from THIS stage (the runner has no `prisma` CLI), and both
# containers mount one named volume at /data.
#
# Docker seeds an empty named volume from the image of the container mounting
# it, directory ownership included — but only if that image HAS the path. With
# /data in the runner alone, whether the migration can write depends on which
# container Docker happened to create first: `docker compose up -d` worked
# because the app's container was created before the migration's started, and
# `docker compose up migrate` on a fresh volume failed with "unable to open
# database file: /data/ugcportal.db" (observed, ugcportal-fb32). Declaring it
# in both stages removes the ordering from the picture.
#
# Numeric, because neither `nextjs` nor `nodejs` exists in this stage. 1001
# is the runner's `nextjs` uid and 1001 is its `nodejs` gid, which is exactly
# what `chown nextjs:nodejs /data` resolves to down there. Note the app
# PROCESS runs as uid=1001 gid=65533(nogroup) — `adduser --system` was not
# given `-G nodejs`, so its primary group is nogroup — which does not matter
# here because /data and the database file are owned by uid 1001 and it is
# the owner bits that grant the write.
RUN mkdir -p /data && chown 1001:1001 /data

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
# rather than at /etc/fonts. Checked by reading the artifact out of the
# image this Dockerfile actually built, which on this machine is
# linux/arm64: @img/sharp-libvips-linuxmusl-arm64/lib/libvips-cpp.so.8.18.7
# (the header above lists the full @img set the runner carries). The x64
# artifact was NOT inspected — no x64 build has been made, the same
# limitation as the header's point (1) — so this is an arm64 reading and
# not a general one. What `strings` on it showed:
#   - the only config-directory path in the binary is "/etc/fonts", sitting
#     immediately beside the "FONTCONFIG_FILE"/"FONTCONFIG_PATH"/"fonts.conf"
#     strings, i.e. fontconfig's standard default-path lookup with /etc/fonts
#     as the compiled-in fallback. There is no build-prefix path to compete
#     with it; and
#   - the built-in fallback config it embeds already lists
#     <dir>/usr/share/fonts</dir>, which is where apk puts font-dejavu.
# So FONTCONFIG_PATH=/etc/fonts would be a provable no-op, and setting it
# would imply a problem that the binary says does not exist. x64 is not
# covered by that reading, but it cannot degrade silently there either: the
# font probe above fails the upload rather than shipping an under-marked
# image, so an x64 build with a fontconfig problem says so on the first
# upload instead of after it.
RUN apk add --no-cache fontconfig font-dejavu

# Non-root runtime user (K1: "run as a non-root user in the final stage").
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# A writable home for the SQLite database when this image is run from
# docker-compose.yml for manual QA (ugcportal-fb32), where `app-data` is
# mounted here and DATABASE_URL points inside it.
#
# Created in the image, and owned by the runtime user, because that is what
# decides the ownership of a FRESH named volume: Docker seeds a new volume
# from the image's content at the mount point, ownership included. Mount a
# volume at a path the image does not contain and it is created root-owned,
# which this non-root process cannot write — the database file then fails to
# open instead of being created. The builder stage declares the same path for
# the same reason; see the comment there.
RUN mkdir -p /data && chown nextjs:nodejs /data

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
# docker-compose.yml's `app` service sets `mem_limit: 1g` for exactly this
# reason, and the line the app logs on its first upload there reads
# `memoryBudget=1024 MB (cgroup-v2)` rather than `(host)`.
#
# Not a nice-to-have, and not something this file can set for you — a memory
# limit is a runtime property of the container, so there is no Dockerfile
# directive for it. It matters here because watermark preview generation
# allocates in native libvips memory, outside the V8 heap and outside
# anything --max-old-space-size can bound. src/lib/watermark.ts caps how many
# previews run at once, and it sizes that cap by reading the cgroup's memory
# limit (src/lib/container-limits.ts).
#
# With no limit set, that read falls back to host RAM, and on a shared host
# the cap is then derived from memory this container does not actually have —
# the process is free to allocate its way to an OOM kill, which is the exact
# failure the cap exists to prevent. The fallback is not silent: the app
# warns, naming the budget, the chosen configuration and where each number
# came from. That happens on the first image upload rather than at process
# start, because that is when preview generation is first configured, so a
# deployment missing this flag looks clean until something is uploaded.
# WATERMARK_MAX_CONCURRENCY overrides the derived value outright if the
# environment cannot supply a cgroup limit.
#
# Reference points from the two derivations — the preview gate in
# src/lib/watermark.ts and the upload-body budget in src/lib/upload-memory.ts
# (ugcportal-05b). "Burst" is how many simultaneous maximum-size (10 MB)
# image uploads are absorbed before any are refused; "largest upload" is the
# biggest single file the container can buffer at all:
#
#                 previews     burst    upload-body    largest
#                 at once /    (max-    budget         upload
#                 queued       size)
#     512 MB  ->  1 /  0          1       21 MB         10 MB   DOES NOT FIT
#     768 MB  ->  2 /  1          3       77 MB        102 MB
#       1 GB  ->  3 /  5          8      166 MB        211 MB   <- recommended
#       2 GB  ->  3 / 12         15    1_037 MB        646 MB
#
# Up to and including 1 GB the two bounds coincide: the upload budget affords
# about the burst the gate can hold (8 x 20.5 MB = 166 MB at 1 GB), so a
# burst is refused at the door, before any of it is buffered. At 2 GB the
# budget affords 50 concurrent bodies while the gate's libuv-bound ceiling
# still only holds 15, so uploads 16-50 are buffered and then shed by the
# gate — which is fine, and is the difference this change makes: that memory
# is now inside a bound instead of outside every one.
#
# "About", not "exactly": what the route reserves carries an allowance for
# the rest of the form that the gate's own per-body figure does not, so at
# some container sizes the budget affords one fewer maximum-size image than
# limit+queue and the gate's last queue slot goes unused. Swept at every whole
# MB from 512 to 4096, the shortfall is never more than one slot. It is the
# safe direction — the tighter bound wins — and the exact statement lives on
# resolveUploadMemorySettings in src/lib/upload-memory.ts.
#
# Give it 1 GB. An in-flight preview costs ~128 MB of decode on top of the
# ~320 MB process baseline, each buffered upload body costs twice the file
# (the parsed File plus the Buffer over it), and 15% of the limit is held
# back as headroom because the per-preview figure was measured on macOS and
# never validated on this alpine image (ugcportal-68r). Spending the budget
# to the last byte would turn any under-estimate into the OOM kill the gate
# exists to replace with shedding.
#
# 1 GB is also the smallest size at which *every* upload the app accepts
# fits: a maximum-size (200 MB) video needs 211 MB of largest-upload room,
# which 1 GB affords with about 11 MB to spare and 768 MB (102 MB) does not,
# so such a video is refused there with a 413 saying so. Below 1 GB, expect
# bursts to shed (a retryable 503 with Retry-After).
#
# "Largest upload" is smaller than it looks because a single upload alone in
# the budget may also be an image, which then runs a preview: its body and
# that decode are resident at the same moment, so the room for the body is a
# decode short of everything spendable, not all of it.
#
# The budget is not committed up front from what a request *claims* it will
# send. Every upload is granted one image's worth (21 MB) on arrival — enough
# to refuse a burst before any of it is read — and grows only as bytes
# actually arrive. A request that declares a 200 MB video and then sends
# nothing holds 21 MB, not 420 MB. That matters more than it sounds: sizing
# the commitment from the declaration meant two connections asserting a large
# Content-Length could hold the whole budget of a 1 GB container for the
# lifetime of the request, for a few hundred bytes of real traffic.
#
# A request that sends a Content-Length is reserved from that instead, so the
# "burst absorbed" column above is what a chunked client gets and an ordinary
# browser form goes considerably further. An upload that grows past the whole
# shared budget shuts everybody else out for as long as it runs, and so has to
# keep earning it: 512 KiB/s sustained, or the exclusivity is taken back and
# the request ends. A container big enough to hold your largest upload inside
# the shared budget — about 1.5 GB for a 200 MB video — never reaches that
# path at all.
#
# WHAT THE NUMBERS COVER, AND WHAT THEY DO NOT.
#
# The figure to size a container from is `projectedUploadPathPeakBytes`
# (src/lib/upload-memory.ts), which prices the whole of POST /api/media: the
# process baseline, the previews in flight, and every upload body the route
# is holding — buffered, queued for a preview, being previewed, or on its way
# to S3. On a fitting configuration it comes to the container limit less the
# 15% headroom, by construction.
#
# It is deliberately NOT the same thing as the gate's own
# `projectedGatedPeakBytes`, which prices only the uploads the gate is
# holding, and the two must never be added together — the gate's per-caller
# body charge is for bodies the upload budget is already holding. Three
# classes of upload used to sit outside every bound and are now inside this
# one:
#
#   - video, accepted at up to 200 MB and excluded from preview generation
#     until ugcportal-pmb, so it reaches no gate at all. Now reserved for and
#     held to one at a time on 1 GB;
#   - uploads read to MAX_UPLOAD_BYTES (205 MB) and only then rejected for
#     exceeding their kind's cap. The request stream is now capped at the cap
#     that kind will be held to, so an oversized image stops at ~10 MB;
#   - image uploads the gate sheds, which the gate itself creates: 60
#     concurrent 10 MB POSTs on 1 GB are 8 admitted and 52 refused, and all
#     60 bodies used to be resident when that was decided. They are now
#     refused before their bodies are read.
#
# Reservations are bounded in time as well as in bytes: a body that goes
# 30 seconds without delivering a chunk is cut off with a 408 and its
# reservation released (BODY_STALL_TIMEOUT_MS). Without that, one client that
# sends its part headers and then stops holds its whole reservation until
# Node's 300-second requestTimeout, which on a 1 GB container is enough for a
# handful of them to 503 every other upload for five minutes. An idle
# timeout, not a deadline, so a genuinely slow upload is unaffected. A client
# that drips one byte inside every window still holds its reservation for the
# whole request lifetime — bounded, but not cheap; that residual is
# ugcportal-9qk, and belongs at the ingress proxy rather than here.
#
# Still outside it, knowingly: the admin evidence upload at
# POST /api/admin/instagram/rights-decision (ugcportal-wa4), undici's
# transient parsing buffers, memory not yet reclaimed after a request ends
# (both headroom's job), and anything on another replica — this is one
# process's bound, and N replicas are N times it, which is correct because
# each has its own container.
#
# Every number above is arithmetic over a per-preview constant measured on
# darwin, not a measurement of this image. Measuring it here is ugcportal-68r;
# setting the limit in a real deployment and load-checking against it is
# ugcportal-jp4. ugcportal-fb32 set the limit and confirmed the app derives
# its budget from the cgroup rather than from host RAM; it did not load-check
# the numbers in the table above, which remain arithmetic.
#
# MIGRATIONS ARE NOT THIS STAGE'S JOB, and cannot be: Next's standalone
# tracing deliberately leaves devDependencies behind, the `prisma` CLI
# included, and this stage ends up with no node_modules/.bin directory at
# all. So there is no `prisma migrate deploy` to run in here.
#
# A container started against an unmigrated database does not announce it:
# it stays up, and `GET /` answers 200 because the home page catches the
# failed read and falls back to placeholder tiles, while every query that is
# not caught fails — `GET /api/public/media` answers 500 with
# `SQLITE_ERROR: no such table: main.Media` (observed, ugcportal-fb32).
# docker-compose.yml runs the migration from a one-shot service built from
# the `builder` stage above, which does have the CLI, against the same
# `app-data` volume.

CMD ["node", "server.js"]
