#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/provision-supabase-auth.js
  ─────────────────────────────────────────────────────────────────────────
  One-shot migration: create a Supabase `auth.users` row for every existing
  Appwrite user, using THE SAME UUID as their existing `profiles.id` so
  every foreign key (books.author_id, posts.user_id, comments.user_id, …)
  keeps working without rewrites.

  PERFORMANCE NOTES — read before running on a large user base
  ─────────────────────────────────────────────────────────────
  Naive per-user implementation issues 2–3 sequential Supabase round trips
  per Appwrite user (look up profile, check if auth row exists, create if
  not). At ~100ms per round trip × 80k users that's 6+ hours.

  This implementation pre-fetches everything in bulk:

    1. ALL profiles (id, legacy_appwrite_id) → in-memory Map. ~80 round
       trips for 80k profiles (1000-row pages), ~30 seconds.
    2. ALL existing auth.users IDs → in-memory Set. Tells us which users
       are already migrated WITHOUT a per-user check.
    3. Iterate Appwrite users from the Auth API (still paginated — that's
       the source data). For each: O(1) Map/Set lookups → either skip
       cleanly or queue for migration.
    4. Run `auth.admin.createUser` in parallel batches (PARALLELISM env
       defaults to 10) so wall-clock = (users / parallelism) × roundtrip
       instead of users × roundtrip.

  Net: ~30 minutes for 80k users instead of 6 hours.

  Why this exists
  ───────────────
  Mobile users authenticate via Appwrite. They have a `profiles` mirror
  row in Supabase (created at signup or self-healed via
  upsert_profile_mirror), but no `auth.users` row — which means
  `auth.uid()` returns NULL inside RPCs and they get `not_authenticated`
  errors. Web users sign in to Supabase natively and don't have this
  problem.

  This script provisions an auth.users row for every Appwrite user. It
  does NOT migrate passwords (Appwrite hashes them with a key we don't
  have). After this runs, users sign in via:

    • Magic link  — email → tap link → signed in (no password)
    • Google OAuth — tap "Continue with Google"
    • Apple OAuth  — tap "Continue with Apple"

  Supabase auto-links new OAuth identities to the existing auth.users
  row when emails match (configurable in Dashboard → Auth → Settings →
  "Auto-link users by email"). Make sure that's enabled before cutover.

  Idempotency + resume
  ────────────────────
  Skips users whose auth.users row already exists (pre-fetched into the
  Set at startup). If the script dies partway, just re-run — the next
  pre-fetch picks up everything created so far and skips them.

  Failure modes
  ─────────────
  • Email collision: Supabase auth requires unique emails across users.
    If two Appwrite accounts share an email, the second one fails. Logged
    to provision-auth-failures.csv for manual review.
  • No profile mirror: User exists on Appwrite but no profiles row.
    Logged + skipped (rare — usually means signup never completed).
  • No email: Anonymous Appwrite users without an email field. Skipped.

  Usage
  ─────
    APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
    APPWRITE_PROJECT_ID=66b8be7400121b5d4697 \
    APPWRITE_API_KEY=server-key-with-users-read \
    SUPABASE_URL=https://your-project.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
    node scripts/provision-supabase-auth.js

    Optional:
      DRY_RUN=1           Walk + classify, no auth.users rows created.
      LIMIT=500           Stop after N Appwrite users (smoke test).
      PARALLELISM=10      Concurrent createUser calls per batch (default 10).
                          Higher = faster but risks Supabase rate limits.
                          5–20 is a safe range.
      VERBOSE=1           Log every user as it's processed.

  Security
  ────────
  Uses SUPABASE_SERVICE_ROLE_KEY (root credential — bypasses RLS, can
  create auth users). Treat this key like a master password; never
  commit it. Run from a trusted machine only.

  Output
  ──────
  Writes provision-auth-failures.csv next to the script with
  appwrite_id, email, error for any failed creations. Stats are
  printed to stdout when the run completes.
*/

const { Client, Users, Query } = require("node-appwrite");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

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
const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

const truthyEnv = (k) => {
  const v = (process.env[k] || "").trim().toLowerCase();
  return v && v !== "0" && v !== "false";
};
const DRY_RUN = truthyEnv("DRY_RUN");
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const VERBOSE = truthyEnv("VERBOSE");
const PARALLELISM = Math.max(1, Math.min(50, Number(process.env.PARALLELISM) || 10));

const APPWRITE_PAGE_SIZE = 100;   // Appwrite hard cap on users.list
const SUPABASE_PAGE_SIZE = 1000;  // postgrest .range() — fast for big tables
const AUTH_LIST_PER_PAGE = 1000;  // supabase.auth.admin.listUsers max per page

const appwriteClient = new Client()
  .setEndpoint(APPWRITE_ENDPOINT)
  .setProject(APPWRITE_PROJECT_ID)
  .setKey(APPWRITE_API_KEY);
const appwriteUsers = new Users(appwriteClient);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─────────────────────────────────────────────────────────────────────
// Pre-fetch helpers
// ─────────────────────────────────────────────────────────────────────

// Pulls every profile row into a Map<legacy_appwrite_id → profile.id>.
// Pages 1000 at a time. We only need two columns so the network cost is
// small — about 80MB total over the wire for 80k rows.
async function preloadProfiles() {
  console.log("[preload] profiles…");
  const t0 = Date.now();
  const map = new Map(); // legacy_appwrite_id → uuid
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, legacy_appwrite_id")
      .not("legacy_appwrite_id", "is", null)
      .order("legacy_appwrite_id", { ascending: true })
      .range(from, from + SUPABASE_PAGE_SIZE - 1);
    if (error) throw new Error(`profiles preload: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (row.legacy_appwrite_id && row.id) map.set(row.legacy_appwrite_id, row.id);
    }
    if (data.length < SUPABASE_PAGE_SIZE) break;
    from += SUPABASE_PAGE_SIZE;
    if (from % 10000 === 0) process.stdout.write(`  loaded ${from} profile rows…\r`);
  }
  console.log(`[preload] profiles: ${map.size} rows (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return map;
}

// Pulls every existing auth.users id into a Set<UUID>. Lets us skip
// already-migrated users with an O(1) lookup instead of a per-user RPC.
async function preloadAuthUserIds() {
  console.log("[preload] auth.users…");
  const t0 = Date.now();
  const set = new Set();
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: AUTH_LIST_PER_PAGE,
    });
    if (error) throw new Error(`auth.users preload: ${error.message}`);
    const users = data?.users || [];
    if (!users.length) break;
    for (const u of users) {
      if (u.id) set.add(u.id);
    }
    if (users.length < AUTH_LIST_PER_PAGE) break;
    page += 1;
    if (page % 10 === 0) process.stdout.write(`  loaded ${set.size} auth users…\r`);
  }
  console.log(`[preload] auth.users: ${set.size} rows (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return set;
}

// ─────────────────────────────────────────────────────────────────────
// Per-user create — runs inside the parallel pool
// ─────────────────────────────────────────────────────────────────────

async function createOne(item) {
  const { profileId, email, appwriteId, providers } = item;
  const { error } = await supabase.auth.admin.createUser({
    id: profileId,
    email,
    email_confirm: true,
    user_metadata: {
      legacy_appwrite_id: appwriteId,
      migrated_at: new Date().toISOString(),
      migration_source: "appwrite",
      appwrite_providers: providers,
    },
  });
  if (error) throw new Error(error.message || String(error));
}

// Run an array of jobs with a max-N-at-a-time concurrency cap. Returns
// after all resolve (success or fail). Each result is { ok, item, error? }.
async function runPool(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const next = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      const item = items[i];
      try {
        await worker(item);
        results.push({ ok: true, item });
      } catch (err) {
        results.push({ ok: false, item, error: err?.message || String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

const main = async () => {
  console.log(`[provision-auth] starting (dry-run=${DRY_RUN}, limit=${LIMIT === Infinity ? "∞" : LIMIT}, parallelism=${PARALLELISM})`);

  // Phase 1: pre-fetch everything in bulk so per-user lookups are O(1).
  const profileByAppwriteId = await preloadProfiles();
  const migratedAuthIds = await preloadAuthUserIds();

  const stats = {
    scanned: 0,
    migrated: 0,
    skipped_existing: 0,
    skipped_no_profile: 0,
    skipped_no_email: 0,
    failed: 0,
  };
  const failedRows = []; // { appwrite_id, email, error }

  // Phase 2: iterate Appwrite users page by page, build a queue of users
  // that need an auth.users row, then process the queue in parallel.
  console.log("[scan] iterating Appwrite users…");
  const tStart = Date.now();
  let cursor = null;
  let pageQueue = [];

  // Process the queued users we've collected so far. Called once per
  // Appwrite page so we keep the queue bounded and surface progress.
  const flushQueue = async () => {
    if (!pageQueue.length) return;
    if (DRY_RUN) {
      stats.migrated += pageQueue.length;
      pageQueue = [];
      return;
    }
    const results = await runPool(pageQueue, PARALLELISM, createOne);
    for (const r of results) {
      if (r.ok) {
        stats.migrated += 1;
        migratedAuthIds.add(r.item.profileId); // keep the Set hot in case Appwrite has dupes
      } else {
        stats.failed += 1;
        failedRows.push({
          appwrite_id: r.item.appwriteId,
          email: r.item.email,
          error: r.error,
        });
        console.error(`  [fail] ${r.item.email} (${r.item.appwriteId}): ${r.error}`);
      }
    }
    pageQueue = [];
  };

  while (stats.scanned < LIMIT) {
    const queries = [Query.limit(APPWRITE_PAGE_SIZE), Query.orderAsc("$id")];
    if (cursor) queries.push(Query.cursorAfter(cursor));

    const page = await appwriteUsers.list(queries);
    if (!page.users || !page.users.length) break;

    for (const aw of page.users) {
      if (stats.scanned >= LIMIT) break;
      stats.scanned += 1;

      const appwriteId = aw.$id;
      const email = (aw.email || "").trim().toLowerCase();

      if (!email) {
        stats.skipped_no_email += 1;
        if (VERBOSE) console.log(`  [no email] ${appwriteId}`);
        continue;
      }

      const profileId = profileByAppwriteId.get(appwriteId);
      if (!profileId) {
        stats.skipped_no_profile += 1;
        if (VERBOSE) console.log(`  [no profile] ${appwriteId} (${email})`);
        continue;
      }

      if (migratedAuthIds.has(profileId)) {
        stats.skipped_existing += 1;
        if (VERBOSE) console.log(`  [exists] ${profileId} (${email})`);
        continue;
      }

      pageQueue.push({
        profileId,
        email,
        appwriteId,
        providers: Array.isArray(aw.providers) ? aw.providers.map((p) => p.provider) : [],
      });
    }

    // Drain the queue at the end of every Appwrite page. Keeps memory
    // bounded and surfaces progress in real time.
    await flushQueue();

    // Progress line — useful for the long runs.
    const elapsed = (Date.now() - tStart) / 1000;
    const rate = stats.scanned / Math.max(elapsed, 1);
    const eta =
      stats.scanned > 0 && LIMIT !== Infinity
        ? (LIMIT - stats.scanned) / rate
        : null;
    process.stdout.write(
      `  scanned=${stats.scanned} migrated=${stats.migrated} skipped=${stats.skipped_existing + stats.skipped_no_profile + stats.skipped_no_email} failed=${stats.failed} | ${rate.toFixed(1)}/s${eta ? ` | ETA ${(eta / 60).toFixed(1)}m` : ""}        \r`
    );

    cursor = page.users[page.users.length - 1]?.$id;
    if (!cursor || page.users.length < APPWRITE_PAGE_SIZE) break;
  }

  // Flush anything that snuck into the queue on the last partial page.
  await flushQueue();

  console.log("\n[provision-auth] done");
  console.log(`  scanned:            ${stats.scanned}`);
  console.log(`  migrated:           ${stats.migrated}${DRY_RUN ? " (dry-run — no rows created)" : ""}`);
  console.log(`  skipped_existing:   ${stats.skipped_existing}`);
  console.log(`  skipped_no_profile: ${stats.skipped_no_profile}`);
  console.log(`  skipped_no_email:   ${stats.skipped_no_email}`);
  console.log(`  failed:             ${stats.failed}`);
  console.log(`  elapsed:            ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

  if (failedRows.length && !DRY_RUN) {
    const csvPath = path.join(__dirname, "provision-auth-failures.csv");
    const csv =
      "appwrite_id,email,error\n" +
      failedRows
        .map((r) => `${r.appwrite_id},"${(r.email || "").replace(/"/g, '""')}","${r.error.replace(/"/g, '""')}"`)
        .join("\n");
    fs.writeFileSync(csvPath, csv);
    console.log(`  failure CSV:        ${csvPath}`);
  }

  if (stats.failed > 0 && !DRY_RUN) {
    process.exit(1);
  }
};

main().catch((err) => {
  console.error("[provision-auth] fatal:", err);
  process.exit(1);
});
