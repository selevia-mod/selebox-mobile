#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/backfill-roles.js
  ─────────────────────────────────────────────────────────────────────────
  One-shot backfill: read every Appwrite user document and write the
  matching role string into `profiles.role` so the verified-seal badge
  appears next to creator / writer / pioneer / moderator / auditor users
  on every post, comment, book, video, and profile across mobile + web.

  Why this exists:
    The Selebox role badges are stored as boolean fields on the Appwrite
    users collection (`creator`, `userPlus`, `moderator`, `auditor`,
    `isWriter`). They were never propagated to Supabase — the
    `profiles.role` column was sized for auth-level user/admin only.
    The migration:
      1. Expanded the `profiles_role_check` constraint to accept the
         full set of badge values (manual SQL — already run).
      2. This script: pages through Appwrite users and, for each one
         with at least one role flag set, runs an UPDATE on
         `profiles.role` keyed by `legacy_appwrite_id`.

  Role priority when a user has multiple flags:
    pioneer > moderator > creator > writer > auditor

    Pioneer wins because the recap calls it the "highest tier" badge.
    Moderator over creator/writer because moderator is a staff role.
    The rest is alphabetical-ish — pick one when in doubt and surface
    via UserRoleBadgeIcons (which can render multiple anyway, but
    profiles.role is single-string today).

  Idempotency:
    Pure UPDATE-by-key. Re-running the script with no Appwrite changes
    is a no-op (every row is already at its computed role). Safe to
    interrupt and resume — Appwrite cursor pagination is stable on
    `$id`.

  Usage:
    APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
    APPWRITE_PROJECT_ID=66b8be7400121b5d4697 \
    APPWRITE_API_KEY=server-key-with-databases-read \
    APPWRITE_DATABASE_ID=66b32b3600246bc34956 \
    APPWRITE_USER_COLLECTION_ID=66b32b4a0022880bc87e \
    SUPABASE_URL=https://your-project.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
    node scripts/backfill-roles.js

    Optional:
      DRY_RUN=1   Walk + classify, no UPDATEs. Prints the role distribution
                  it would write so you can sanity-check before committing.
      LIMIT=500   Stop after N Appwrite users (smoke test).
      VERBOSE=1   Log every user with their resolved role.

  Security:
    Requires SUPABASE_SERVICE_ROLE_KEY because the `profiles` RLS policy
    keys off auth.uid() and our anon writes would be blocked. Treat the
    key like a root credential — never commit it.
*/

const { Client, Databases, Query } = require("node-appwrite");
const { createClient } = require("@supabase/supabase-js");

const env = (k, fallback) => {
  const v = process.env[k];
  if (v) return v;
  if (fallback !== undefined) return fallback;
  console.error(`Missing required env var: ${k}`);
  process.exit(1);
};

const APPWRITE_ENDPOINT = env("APPWRITE_ENDPOINT");
const APPWRITE_PROJECT_ID = env("APPWRITE_PROJECT_ID");
const APPWRITE_API_KEY = env("APPWRITE_API_KEY");
const APPWRITE_DATABASE_ID = env("APPWRITE_DATABASE_ID");
const APPWRITE_USER_COLLECTION_ID = env("APPWRITE_USER_COLLECTION_ID");
const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

// "0" / "false" / "" all read as falsy. Anything else (including "1",
// "true", "yes") reads as truthy. Without this, DRY_RUN=0 was sticking
// at true because "0" is a non-empty string and `!!"0"` is true.
const truthyEnv = (k) => {
  const v = (process.env[k] || "").trim().toLowerCase();
  return v && v !== "0" && v !== "false";
};
const DRY_RUN = truthyEnv("DRY_RUN");
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const VERBOSE = truthyEnv("VERBOSE");
const PAGE_SIZE = 100; // Appwrite list query cap

const appwrite = new Databases(
  new Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID)
    .setKey(APPWRITE_API_KEY)
);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Map an Appwrite user document to its Supabase role string.
//
// Source of truth: the `roles` text[] array on the Appwrite user doc.
// We deliberately ignore the legacy boolean fields (`creator`,
// `moderator`, `auditor`) because they're known to drift from the
// roles[] array — e.g., a user whose `moderator: true` flag was set
// historically but never cleared, even though they're no longer a
// moderator. Trusting roles[] only gives a clean, semantically-correct
// classification that reflects the user's CURRENT badge set.
//
// Priority (high → low): moderator > pioneer > creator > writer >
// auditor > user. A user with multiple roles is reduced to the single
// highest-priority badge — only one seal shown next to their name in
// every surface (matching the product spec: one badge per user).
//
// Creator and Writer are mutually exclusive in the product spec but
// data-wise a user could in theory have both — we resolve to whichever
// appears higher in the cascade (creator > writer).
//
// Returns "user" when no badge applies. Re-running self-heals stale
// rows: a profile previously written as 'moderator' whose Appwrite
// roles[] no longer contains "moderator" gets reset to 'user'.
const resolveRole = (doc) => {
  const rolesArray = Array.isArray(doc.roles) ? doc.roles : [];
  const rolesLower = rolesArray.map((r) => String(r || "").trim().toLowerCase());
  const inRoles = (key) => rolesLower.includes(key);

  if (inRoles("moderator")) return "moderator";
  if (inRoles("pioneer")) return "pioneer";
  if (inRoles("creator")) return "creator";
  if (inRoles("writer")) return "writer";
  if (inRoles("auditor")) return "auditor";
  return "user";
};

const main = async () => {
  console.log(`[backfill-roles] starting (dry-run=${DRY_RUN}, limit=${LIMIT === Infinity ? "∞" : LIMIT})`);

  let cursor = null;
  let scanned = 0;
  const distribution = { pioneer: 0, moderator: 0, creator: 0, writer: 0, auditor: 0, user: 0 };
  const failures = [];
  let updated = 0;
  let skippedNoLegacy = 0;
  let skippedNotFound = 0;

  while (scanned < LIMIT) {
    const queries = [Query.limit(PAGE_SIZE), Query.orderAsc("$id")];
    if (cursor) queries.push(Query.cursorAfter(cursor));

    const page = await appwrite.listDocuments(
      APPWRITE_DATABASE_ID,
      APPWRITE_USER_COLLECTION_ID,
      queries
    );
    if (!page.documents.length) break;

    for (const doc of page.documents) {
      if (scanned >= LIMIT) break;
      scanned += 1;

      const role = resolveRole(doc);
      const isBadge = role !== "user";
      const appwriteId = doc.$id;
      const username = doc.username || doc.name || "(anonymous)";

      // Skip plain users entirely — writing 'user' to 79k rows just to
      // self-heal a few hundred stale ones isn't worth ~80k network
      // round-trips (≈3 hours). Stale rows get cleaned by the separate
      // post-backfill SQL the operator runs after this completes (see
      // the README/usage block at the top of this file).
      if (!isBadge) continue;

      distribution[role] += 1;

      if (DRY_RUN) {
        if (VERBOSE) console.log(`  [dry] ${appwriteId} → ${role} (${username})`);
        continue;
      }

      // Write to Supabase via legacy_appwrite_id key. Service-role key
      // bypasses RLS so the UPDATE lands regardless of policy.
      // Bump updated_at on every write so a follow-up "stale entries"
      // SQL can find rows the backfill DIDN'T touch (those whose
      // updated_at predates the run) — that's how we identify role
      // assignments that no longer have an Appwrite badge to back them.
      const { data, error } = await supabase
        .from("profiles")
        .update({ role, updated_at: new Date().toISOString() })
        .eq("legacy_appwrite_id", appwriteId)
        .select("id");

      if (error) {
        failures.push({ appwriteId, username, role, error: error.message });
        console.error(`  [fail] ${appwriteId} (${username}) → ${role}: ${error.message}`);
        continue;
      }
      if (!data || !data.length) {
        skippedNotFound += 1;
        if (VERBOSE) console.log(`  [miss] ${appwriteId} (${username}) — no profile row`);
        continue;
      }

      updated += 1;
      if (VERBOSE) console.log(`  [ok] ${appwriteId} → ${role} (${username})`);
    }

    cursor = page.documents[page.documents.length - 1]?.$id;
    if (!cursor || page.documents.length < PAGE_SIZE) break;
    process.stdout.write(`  scanned ${scanned} users…\r`);
  }

  console.log("\n[backfill-roles] done");
  console.log(`  scanned:           ${scanned}`);
  console.log(`  pioneer:           ${distribution.pioneer}`);
  console.log(`  moderator:         ${distribution.moderator}`);
  console.log(`  creator:           ${distribution.creator}`);
  console.log(`  writer:            ${distribution.writer}`);
  console.log(`  auditor:           ${distribution.auditor}`);
  console.log(`  total badge users: ${Object.values(distribution).reduce((a, b) => a + b, 0)}`);
  if (DRY_RUN) {
    console.log("  (dry-run — no UPDATEs executed)");
  } else {
    console.log(`  updated:           ${updated}`);
    console.log(`  no-profile-row:    ${skippedNotFound}`);
    console.log(`  no-legacy-id:      ${skippedNoLegacy}`);
    if (failures.length) {
      console.log(`  failures:          ${failures.length} — see stderr above`);
      process.exit(1);
    }
  }
};

main().catch((err) => {
  console.error("[backfill-roles] fatal:", err);
  process.exit(1);
});
