#!/usr/bin/env bash
# scripts/run-backfill-roles.sh
# ────────────────────────────────────────────────────────────────────────
# Wrapper for backfill-roles.js so you don't fight shell line-continuation
# rules every time you run it. Fill in the two values marked TODO,
# save the file, then in the VS Code terminal:
#
#   bash scripts/run-backfill-roles.sh
#
# Default mode is DRY-RUN (no DB writes). Once the dry-run distribution
# looks right, set DRY_RUN below to 0 and re-run for real.
#
# IMPORTANT: this file contains live credentials when filled in.
# Never commit it. Add `scripts/run-backfill-roles.sh` to .gitignore
# (or rename to *.local.sh which is already typically ignored).
set -euo pipefail

# ── Credentials (already known) ─────────────────────────────────────────
export APPWRITE_ENDPOINT="https://fra.cloud.appwrite.io/v1"
export APPWRITE_PROJECT_ID="66b8be7400121b5d4697"
export APPWRITE_DATABASE_ID="66b32b3600246bc34956"
export APPWRITE_USER_COLLECTION_ID="66b32b4a0022880bc87e"

# ── TODO: fill these in ─────────────────────────────────────────────────
# Appwrite Console → Project Settings → API Keys → create one with
# `databases.read` scope (or paste an existing server key here).
export APPWRITE_API_KEY="standard_f4b52XXXX"

# Your actual Supabase project URL — usually https://<ref>.supabase.co.
# Confirm in Supabase Dashboard → Project Settings → API → Project URL.
# `https://auth.selebox.com` only works if you've set up custom domains
# for the FULL REST API surface (not just auth).
export SUPABASE_URL="https://auth.selebox.com"

# Supabase Dashboard → Project Settings → API → service_role key.
# Treat as root credential.
export SUPABASE_SERVICE_ROLE_KEY="eyJhbXXXX"

# ── Run flags ───────────────────────────────────────────────────────────
# DRY_RUN=1 → no UPDATEs; just preview the role distribution.
# DRY_RUN=0 (or unset) → live writes against profiles.
export DRY_RUN="${DRY_RUN:-1}"

# Limit how many Appwrite users to walk this run. Useful for smoke
# testing before a full sweep. Comment out (or set blank) for the full
# run.
export LIMIT="${LIMIT:-200}"

# Print every classified user. Comment out for quieter output on large
# runs.
export VERBOSE="${VERBOSE:-1}"

# ── Run ────────────────────────────────────────────────────────────────
cd "$(dirname "$0")/.."
node scripts/backfill-roles.js
