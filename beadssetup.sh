#!/usr/bin/env bash
# Beads task graph for the UGC portfolio site.
# Run `bd init` in your project root first, then run this script
# (needs `jq` installed). Adjust the jq path (.id vs .issue.id) if your
# bd version's --json output shape differs.
#
# Phasing: everything at P0-P2 runs against local dev (localhost OAuth
# redirects, local storage emulation). P3 beads are the production /
# hosting cutover, done as a phase near the end.
set -euo pipefail

id() { bd create "$1" -p "$2" -t "$3" --json | jq -r '.id // .issue.id'; }

# ============ PHASE 1: local development ============

# --- Foundation ---
SCAFFOLD=$(id "Scaffold Next.js app (TS, Tailwind, shadcn/ui)" 0 task)
LOCALSTORAGE=$(id "Local S3-compatible storage emulation (MinIO) for dev" 0 task)
bd dep add "$LOCALSTORAGE" "$SCAFFOLD"

DB=$(id "Set up user/session data model" 0 task)
bd dep add "$DB" "$SCAFFOLD"

THEME=$(id "Build petrol blue design system (color tokens, Tailwind theme)" 1 task)
bd dep add "$THEME" "$SCAFFOLD"

# --- Auth (localhost redirect URIs for now) ---
GOOGLE=$(id "Google OAuth via Auth.js (localhost redirect for dev)" 0 feature)
bd dep add "$GOOGLE" "$DB"

FACEBOOK=$(id "Facebook OAuth via Auth.js (localhost redirect for dev)" 0 feature)
bd dep add "$FACEBOOK" "$DB"

# --- Media pipeline ---
UPLOAD=$(id "Media upload API (image + video, auth-gated)" 1 feature)
bd dep add "$UPLOAD" "$LOCALSTORAGE"
bd dep add "$UPLOAD" "$GOOGLE"
bd dep add "$UPLOAD" "$FACEBOOK"

WATERMARK=$(id "Watermark preview service (sharp or imgproxy)" 1 feature)
bd dep add "$WATERMARK" "$UPLOAD"

GALLERY=$(id "Gallery/portfolio UI with lightbox (PhotoSwipe), styled with petrol theme" 1 feature)
bd dep add "$GALLERY" "$WATERMARK"
bd dep add "$GALLERY" "$THEME"

VIDEO=$(id "Video playback support in gallery" 2 feature)
bd dep add "$VIDEO" "$GALLERY"

OWNERSHIP=$(id "Access control: users can only edit/delete their own UGC" 1 task)
bd dep add "$OWNERSHIP" "$UPLOAD"

# --- Promotion features ---
LIKES=$(id "Likes/reactions on UGC" 1 feature)
bd dep add "$LIKES" "$GALLERY"

TAGS=$(id "Tag/category data model + browsing UI" 1 feature)
bd dep add "$TAGS" "$GALLERY"

TRENDING=$(id "Trending sort (views + likes) on gallery" 2 feature)
bd dep add "$TRENDING" "$LIKES"

FEATURED=$(id "Featured/editor's-picks carousel on homepage" 1 feature)
bd dep add "$FEATURED" "$GALLERY"

PROFILES=$(id "Creator profile pages" 1 feature)
bd dep add "$PROFILES" "$GOOGLE"
bd dep add "$PROFILES" "$FACEBOOK"
bd dep add "$PROFILES" "$GALLERY"

SHARE=$(id "Share buttons + Open Graph preview tags" 1 feature)
bd dep add "$SHARE" "$GALLERY"

EMBED=$(id "Embeddable widget/iframe for creators" 2 feature)
bd dep add "$EMBED" "$GALLERY"

CONTEST=$(id "Piece-of-the-month contest feature" 2 feature)
bd dep add "$CONTEST" "$FEATURED"
bd dep add "$CONTEST" "$LIKES"

CROSSPOST=$(id "Cross-post to Facebook/Instagram (extra consented OAuth scopes)" 2 feature)
bd dep add "$CROSSPOST" "$FACEBOOK"

GDPR=$(id "GDPR consent flow + data retention policy (review with DPO)" 2 task)
bd dep add "$GDPR" "$GOOGLE"
bd dep add "$GDPR" "$FACEBOOK"

# --- Instagram integration (admin-owned accounts, resale) ---
LEGAL_REVIEW=$(id "Legal/Compliance review: resale rights per connected Instagram account" 1 task)

IG_CONNECT=$(id "Admin settings: connect multiple Instagram accounts (OAuth, token storage)" 1 feature)
bd dep add "$IG_CONNECT" "$DB"
bd dep add "$IG_CONNECT" "$FACEBOOK"

IG_TOKEN_REFRESH=$(id "Instagram long-lived token refresh job" 2 task)
bd dep add "$IG_TOKEN_REFRESH" "$IG_CONNECT"

IG_SYNC=$(id "Instagram media sync job (pull posts via Graph API)" 1 feature)
bd dep add "$IG_SYNC" "$IG_CONNECT"

IG_CURATION=$(id "Curation UI: select synced posts for sale, set price/license" 1 feature)
bd dep add "$IG_CURATION" "$IG_SYNC"
bd dep add "$IG_CURATION" "$WATERMARK"
bd dep add "$IG_CURATION" "$LEGAL_REVIEW"

STRIPE_CHECKOUT=$(id "Single-seller Stripe checkout for purchasing images" 1 feature)
bd dep add "$STRIPE_CHECKOUT" "$IG_CURATION"

FULFILLMENT=$(id "Fulfillment: signed time-limited download URL for purchased originals" 1 feature)
bd dep add "$FULFILLMENT" "$STRIPE_CHECKOUT"
bd dep add "$FULFILLMENT" "$LOCALSTORAGE"

# --- Analytics, discoverability, revenue reporting ---
ANALYTICS_INSTANCE=$(id "Deploy Umami analytics instance" 2 task)

ANALYTICS_INTEGRATION=$(id "Integrate Umami tracking script (page views) into app" 1 feature)
bd dep add "$ANALYTICS_INTEGRATION" "$SCAFFOLD"
bd dep add "$ANALYTICS_INTEGRATION" "$ANALYTICS_INSTANCE"
bd dep add "$GDPR" "$ANALYTICS_INTEGRATION"

LLMSTXT=$(id "Add /llms.txt file describing site content (llmstxt.org spec)" 2 task)
bd dep add "$LLMSTXT" "$GALLERY"

ORDERS=$(id "Order/transaction data model linking sales to specific media items" 1 task)
bd dep add "$ORDERS" "$STRIPE_CHECKOUT"
bd dep add "$ORDERS" "$DB"

REVENUE_DASHBOARD=$(id "Revenue dashboard: income by image/account" 1 feature)
bd dep add "$REVENUE_DASHBOARD" "$ORDERS"

# --- Reviews (gate before moving to the hosting phase) ---
ARCH_REVIEW=$(id "Architecture review of the application" 2 task)
bd dep add "$ARCH_REVIEW" "$SCAFFOLD"
bd dep add "$ARCH_REVIEW" "$LOCALSTORAGE"
bd dep add "$ARCH_REVIEW" "$UPLOAD"
bd dep add "$ARCH_REVIEW" "$WATERMARK"
bd dep add "$ARCH_REVIEW" "$GALLERY"
bd dep add "$ARCH_REVIEW" "$IG_SYNC"
bd dep add "$ARCH_REVIEW" "$IG_CURATION"
bd dep add "$ARCH_REVIEW" "$ANALYTICS_INTEGRATION"
bd dep add "$ARCH_REVIEW" "$REVENUE_DASHBOARD"

SECURITY_REVIEW=$(id "Security review of the application" 2 task)
bd dep add "$SECURITY_REVIEW" "$UPLOAD"
bd dep add "$SECURITY_REVIEW" "$GOOGLE"
bd dep add "$SECURITY_REVIEW" "$FACEBOOK"
bd dep add "$SECURITY_REVIEW" "$OWNERSHIP"
bd dep add "$SECURITY_REVIEW" "$GDPR"
bd dep add "$SECURITY_REVIEW" "$IG_CONNECT"
bd dep add "$SECURITY_REVIEW" "$STRIPE_CHECKOUT"
bd dep add "$SECURITY_REVIEW" "$FULFILLMENT"
bd dep add "$SECURITY_REVIEW" "$REVENUE_DASHBOARD"

# ============ PHASE 2: hosting / production cutover (end phase) ============

HOSTING=$(id "Provision DreamHost VPS (Managed/Self-Managed) with Node.js via Passenger or PM2" 3 task)

PRODSTORAGE=$(id "Migrate storage from local MinIO to DreamObjects (production)" 3 task)
bd dep add "$PRODSTORAGE" "$LOCALSTORAGE"
bd dep add "$PRODSTORAGE" "$HOSTING"

PRODOAUTH=$(id "Update OAuth redirect URIs for production domain" 3 task)
bd dep add "$PRODOAUTH" "$GOOGLE"
bd dep add "$PRODOAUTH" "$FACEBOOK"
bd dep add "$PRODOAUTH" "$HOSTING"

DEPLOY=$(id "CI/CD + deployment pipeline to DreamHost VPS" 3 task)
bd dep add "$DEPLOY" "$HOSTING"
bd dep add "$DEPLOY" "$PRODSTORAGE"
bd dep add "$DEPLOY" "$PRODOAUTH"
bd dep add "$DEPLOY" "$ARCH_REVIEW"
bd dep add "$DEPLOY" "$SECURITY_REVIEW"

# ============ PHASE 3: containerization & Kubernetes CI/CD (Tekton) ============

DOCKERFILE=$(id "Write production Dockerfile for Next.js app (multi-stage build)" 3 task)
bd dep add "$DOCKERFILE" "$SCAFFOLD"

REGISTRY=$(id "Provision container image registry" 3 task)

K8S_MANIFESTS=$(id "Write Kubernetes manifests (Deployment, Service, Ingress)" 3 task)
bd dep add "$K8S_MANIFESTS" "$DOCKERFILE"

TEKTON_TASKS=$(id "Define Tekton Tasks (lint, test, build image)" 3 task)
bd dep add "$TEKTON_TASKS" "$DOCKERFILE"

TEKTON_PIPELINE=$(id "Assemble Tekton Pipeline (build, push, deploy)" 3 feature)
bd dep add "$TEKTON_PIPELINE" "$TEKTON_TASKS"
bd dep add "$TEKTON_PIPELINE" "$REGISTRY"

TEKTON_TRIGGER=$(id "Set up Tekton Triggers (webhook on push)" 3 task)
bd dep add "$TEKTON_TRIGGER" "$TEKTON_PIPELINE"

K8S_DEPLOY=$(id "Deploy via Tekton pipeline to Kubernetes cluster" 3 task)
bd dep add "$K8S_DEPLOY" "$TEKTON_PIPELINE"
bd dep add "$K8S_DEPLOY" "$K8S_MANIFESTS"
bd dep add "$K8S_DEPLOY" "$ARCH_REVIEW"
bd dep add "$K8S_DEPLOY" "$SECURITY_REVIEW"

echo "Task graph created. Run 'bd ready' to see what's unblocked."