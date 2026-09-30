#!/usr/bin/env sh
# Intended single source of truth for the placeholder auth env values used
# to run a local build without real secrets configured. Not secrets themselves
# -- safe to commit -- just placeholders `next build` needs present to not
# fail on a missing required env var.
#
# Consumed by .beads/hooks/pre-push (sourced directly, POSIX sh) and by
# .github/workflows/ci.yml's Build step (via the Load placeholder auth env
# vars step, which sources this file and writes each value to $GITHUB_ENV).
export AUTH_SECRET_PLACEHOLDER=ci-placeholder-secret-not-for-real-use
export AUTH_GOOGLE_ID_PLACEHOLDER=ci-placeholder
export AUTH_GOOGLE_SECRET_PLACEHOLDER=ci-placeholder
export AUTH_FACEBOOK_ID_PLACEHOLDER=ci-placeholder
export AUTH_FACEBOOK_SECRET_PLACEHOLDER=ci-placeholder
