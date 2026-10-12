#!/usr/bin/env bash
#
# Build the two images docker-compose.yml's `app` and `migrate` services run,
# and print the tag they were given (ugcportal-fb32).
#
#   npm run docker:qa:build
#
# THE TAG is `<package.json version>-dev.g<short sha>`, e.g.
# `0.6.0-dev.gb592ba0`, with `-dirty` appended when the working tree has
# uncommitted changes.
#
#   - `-dev.` says what it is. package.json's version names the LAST
#     RELEASE, not this build: at the time of writing it reads 0.6.0, v0.6.0
#     is the newest tag, and `main` is 34 commits past it. It stays that way
#     until the cut-release skill bumps it, which is deliberate — CI checks
#     package.json's version against two separate fields in
#     package-lock.json, so a hand bump reddens the build. A tag of plain
#     `0.6.0` would therefore name an image that is not the released 0.6.0.
#   - `g<short sha>` identifies the commit, the way `git describe` spells it.
#     A tag has to start with [a-zA-Z0-9_], and a bare short sha can begin
#     with anything; the `g` also stops a hex-looking sha reading as a
#     number.
#   - `-dirty` because an image built from uncommitted work is not the commit
#     it names, and a QA session that cannot tell those apart is the thing
#     this bead exists to fix. `+` would be the semver spelling and Docker
#     tags do not allow it.
#
# WHAT `-dirty` CANNOT SEE. It is computed from git, and git says nothing
# about a gitignored file. So any gitignored file that reaches the BUILD
# CONTEXT makes this tag name two different images on two machines -- exactly
# what the pinned tag exists to prevent. That was not hypothetical:
# `certs/capgemini.pem`, the corporate-proxy CA bundle
# docker-compose.proxy-ca.yml tells a proxied developer to create, reached
# the context and both images, because `.dockerignore` does not use gitignore
# semantics and its `*.pem` did not match a nested path (PR #222 round 1).
# Fixed there; the reasoning is at the top of .dockerignore.
#
# Measured after that fix, against this repo rather than in the abstract: the
# context is 551 files, and `git check-ignore` claims exactly one of them --
# `next-env.d.ts`, a generated stub of `/// <reference ... />` lines that
# `next build` writes for itself -- checked by deleting it and running
# `npm run build`, which put it back byte-identical, and the builder stage
# runs that same `next build`. Re-run the context check after adding
# anything to .gitignore, or after adding a directory of machine-local files:
#
#   printf 'FROM scratch\nCOPY . /ctx\n' > Dockerfile.ctxprobe
#   docker build -q -f Dockerfile.ctxprobe --output type=local,dest=/tmp/ctx .
#   rm Dockerfile.ctxprobe
#   (cd /tmp/ctx/ctx && find . -type f | sed 's|^\./||') | git check-ignore --stdin
#
# Nothing listed means the tag sees every input. Something listed means it
# does not, and the fix is a .dockerignore entry rather than a longer tag:
# hashing the context into the tag would change it on a regenerated stub and
# would still not be an attestation, for the reason below.
#
# WHAT THE TAG DOES NOT PROMISE is byte-identical images. This build is not
# reproducible, but the image ID is the wrong evidence for that: it is not a
# content digest, so three different IDs from three identical-context builds
# proves nothing -- that is also what three byte-identical rebuilds produce.
# (All three carried the same 11-layer rootfs digest list and the same
# `Created` timestamp when checked.) The real evidence is the layer digests
# themselves: a `--no-cache` rebuild from the same commit changes 6 of the
# runner's 11 layers -- the five `node:20-alpine` base layers are identical
# both times; `apk add`, `adduser`, `mkdir /data` and all three `COPY`s
# differ. Reproduce with
# `docker inspect <image> --format '{{json .RootFS.Layers}}'` against a
# normal build and a `--no-cache` one. The tag identifies the INPUTS -- one
# commit, plus nothing gitignored beyond a regenerated stub -- so two QA
# sessions a week apart are exercising the same source. That is what this
# bead needs. It is not a claim that they hold the same bytes.
#
# Two images, one tag. The app image is the Dockerfile's default (runner)
# target; the migrate image is its `builder` target, which still has the
# `prisma` CLI that the runner deliberately drops — the runner has no
# node_modules/.bin directory at all. The second build is a cache hit on
# every layer the first already made, so it adds no build time. It does cost
# disk: the builder stage carries the full dependency tree and the source,
# measured at 1.82 GB against the runner image's 343 MB. That is the price of
# migrating with the real CLI rather than reimplementing `migrate deploy`
# against @libsql/client inside the app.
set -euo pipefail

cd "$(dirname "$0")/.."

version="$(node -p "require('./package.json').version")"
sha="$(git rev-parse --short=7 HEAD)"
dirty=""
if ! git diff --quiet HEAD -- . || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  dirty="-dirty"
fi
tag="${version}-dev.g${sha}${dirty}"

docker build -t "ugcportal:${tag}" .
docker build --target builder -t "ugcportal-migrate:${tag}" .

echo "UGCPORTAL_IMAGE_TAG=${tag}"
