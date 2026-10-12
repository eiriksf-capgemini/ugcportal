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
