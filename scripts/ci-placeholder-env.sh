#!/usr/bin/env sh
# Intended single source of truth for the placeholder auth env values used
# to run a local build without real secrets configured -- NOT YET fully
# wired as one, see below. Not secrets themselves -- safe to commit -- just
# placeholders `next build` needs present to not fail on a missing required
# env var.
#
# Consumed today by .beads/hooks/pre-push (sourced directly, POSIX sh).
# .github/workflows/ci.yml's Build step still hard-codes the same five
# values independently (a YAML `run:` step is a separate shell per step,
# so sourcing this file there requires writing each value to $GITHUB_ENV
# for the next step to inherit it -- not done here, since ci.yml is a
# sensitive path this PR deliberately doesn't touch; tracked as
# ugcportal-qmxl so the two don't drift apart un-noticed in the meantime).
export AUTH_SECRET_PLACEHOLDER=ci-placeholder-secret-not-for-real-use
export AUTH_GOOGLE_ID_PLACEHOLDER=ci-placeholder
export AUTH_GOOGLE_SECRET_PLACEHOLDER=ci-placeholder
export AUTH_FACEBOOK_ID_PLACEHOLDER=ci-placeholder
export AUTH_FACEBOOK_SECRET_PLACEHOLDER=ci-placeholder
