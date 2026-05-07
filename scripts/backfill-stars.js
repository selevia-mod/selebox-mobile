#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/backfill-stars.js
  ─────────────────────────────────────────────────────────────────────────
  Backfills star balances from Appwrite into Supabase. Pre-cutover stars
  live in Appwrite's stars collection (id from secrets.starsCollectionId
  = "68cef60b00036657931d") as a current-balance snapshot per user.

  Where stars actually live in Supabase:
    wallets
      - user_id (uuid PK → profiles.id)
      - coin_balance (int)
      - star_balance (int)   ← THIS is what the UI reads
      - updated_at (timestamptz)

  The `ad_rewards` table is the per-event log (one row per ad watched);
  it is NOT what the topbar pill, store screen, or wallet hook reads.
  Backfilling there would have done nothing visible to users.

  Conflict semantics:
    For each user, we set wallets.star_balance =
      GREATEST(current_supabase_balance, appwrite_snapshot).
    This avoids overwriting any stars the user earned in Supabase after
    the migration. Idempotent: re-running the script is a no-op once
    everyone is at >= snapshot.

  Prerequisites:
    1. SUPABASE_SERVICE_ROLE_KEY (RLS otherwise blocks wallet upserts).
    2. APPWRITE_STARS_COLLECTION_ID (= "68cef60b00036657931d").
    3. Appwrite API key with `documents.read` scope.

  Usage:
    APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
    APPWRITE_PROJECT_ID=66b8be7400121b5d4697 \
    APPWRITE_API_KEY=server-key-with-databases-read \
    APPWRITE_DATABASE_ID=66b32b3600246bc34956 \
    APPWRITE_STARS_COLLECTION_ID=68cef60b00036657931d \
    SUPABASE_URL=https://zplisqwoejxrdrpbfass.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
    node scripts/backfill-stars.js

    Optional:
      DRY_RUN=1            Walk + resolve, no writes. Recommended FIRST.
      LIMIT=200            First N user docs only (smoke).
      VERBOSE=1            Log every skipped row.
      USER_EMAIL=foo@bar.com  Only backfill stars for one user.
      MIN_STARS=1          Skip users with fewer than this (default 1).
*/

const { Client, Databases, Query } = require("node-appwrite");
const { createClient } = require("@supabase/supabase-js");

const env = (k, fallback) => {
  const v = process.env[k];
  if (v) return v;
  if (fallback !== undefined) return fallback;
  console.error(`Missing env var: ${k}`);
  process.exit(1);
};

const APPWRITE_ENDPOINT = env("APPWRITE_ENDPOINT", "https://fra.cloud.appwrite.io/v1");
const APPWRITE_PROJECT_ID = env("APPWRITE_PROJECT_ID");
const APPWRITE_API_KEY = env("APPWRITE_API_KEY");
const APPWRITE_DATABASE_ID = env("APPWRITE_DATABASE_ID");
const APPWRITE_STARS_COLLECTION_ID = env("APPWRITE_STARS_COLLECTION_ID");
// users collection — needed to resolve stars.userId (= auth account.$id,
// from the JWT) → users-doc.$id (which is what profiles.legacy_appwrite_id
// stores). Defaults to the value in private/secrets.js.
const APPWRITE_USER_COLLECTION_ID = env("APPWRITE_USER_COLLECTION_ID", "66b32b4a0022880bc87e");
const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const VERBOSE = process.env.VERBOSE === "1";
const USER_EMAIL = process.env.USER_EMAIL || null;
const MIN_STARS = Number(process.env.MIN_STARS || 1);

const PAGE_SIZE = 100;
const RESOLVE_BATCH_SIZE = 500;

const aw = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const awDb = new Databases(aw);
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// account.$id → users-doc.$id (cached). The stars Cloud Function writes
// `userId = auth account.$id` (from the JWT subject), but
// profiles.legacy_appwrite_id stores users-doc.$id (see lib/appwrite.js
// line 156: `p_legacy_appwrite_id: newUser.$id`). So we need an
// indirection step: stars.userId → Appwrite users.accountId → users.$id
// → profiles.legacy_appwrite_id. Negative lookups cache as null.
const accountToUserDoc = new Map();
// users-doc.$id → { id (Supabase uuid), email }
const profileCache = new Map();
const walletCache = new Map(); // user_id (uuid) -> current star_balance

async function resolveAccountToUserDoc(accountIds) {
  const unresolved = accountIds.filter((h) => h && !accountToUserDoc.has(h));
  if (unresolved.length === 0) return;
  // Appwrite Query.equal is a single-key equality; for batch resolution
  // we use Query.contains (server treats arrays of strings as IN). Falls
  // back to per-id query if the SDK on this version doesn't support
  // contains-on-string.
  for (let i = 0; i < unresolved.length; i += 100) {
    const slice = unresolved.slice(i, i + 100);
    let docs = [];
    try {
      const res = await awDb.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID, [
        Query.equal("accountId", slice),
        Query.limit(slice.length),
      ]);
      docs = res?.documents || [];
    } catch (err) {
      // Per-id fallback
      console.warn(`  users batch lookup failed (${err.message}); falling back to per-id`);
      for (const acct of slice) {
        try {
          const res = await awDb.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID, [
            Query.equal("accountId", acct),
            Query.limit(1),
          ]);
          if (res?.documents?.[0]) docs.push(res.documents[0]);
        } catch (_) { /* skip */ }
      }
    }
    const seen = new Set();
    docs.forEach((d) => {
      if (d.accountId && d.$id) {
        accountToUserDoc.set(d.accountId, d.$id);
        seen.add(d.accountId);
      }
    });
    slice.forEach((acct) => {
      if (!seen.has(acct)) accountToUserDoc.set(acct, null);
    });
  }
}

async function resolveProfileBatch(userDocIds) {
  const unresolved = userDocIds.filter((h) => h && !profileCache.has(h));
  if (unresolved.length === 0) return;
  for (let i = 0; i < unresolved.length; i += RESOLVE_BATCH_SIZE) {
    const slice = unresolved.slice(i, i + RESOLVE_BATCH_SIZE);
    const { data, error } = await sb
      .from("profiles")
      .select("id, legacy_appwrite_id, email")
      .in("legacy_appwrite_id", slice);
    if (error) throw new Error(`profiles lookup failed: ${error.message}`);
    const found = new Set();
    (data || []).forEach((row) => {
      if (row.legacy_appwrite_id) {
        profileCache.set(row.legacy_appwrite_id, { id: row.id, email: row.email });
        found.add(row.legacy_appwrite_id);
      }
    });
    slice.forEach((id) => {
      if (!found.has(id)) profileCache.set(id, null);
    });
  }
}

async function loadWalletBalances(userIds) {
  const unknown = userIds.filter((id) => id && !walletCache.has(id));
  if (unknown.length === 0) return;
  for (let i = 0; i < unknown.length; i += RESOLVE_BATCH_SIZE) {
    const slice = unknown.slice(i, i + RESOLVE_BATCH_SIZE);
    const { data, error } = await sb
      .from("wallets")
      .select("user_id, star_balance")
      .in("user_id", slice);
    if (error) throw new Error(`wallets lookup failed: ${error.message}`);
    const seen = new Set();
    (data || []).forEach((row) => {
      walletCache.set(row.user_id, Number(row.star_balance || 0));
      seen.add(row.user_id);
    });
    // Users with no wallet row yet => treat as 0
    slice.forEach((id) => {
      if (!seen.has(id)) walletCache.set(id, 0);
    });
  }
}

async function ensureSchemaReady() {
  const { error } = await sb.from("wallets").select("user_id, star_balance").limit(1);
  if (error && /relation .* does not exist/.test(error.message)) {
    console.error("──────────────────────────────────────────────");
    console.error("FATAL: public.wallets table does not exist.");
    console.error("──────────────────────────────────────────────");
    process.exit(1);
  }
  if (error) {
    console.error(`Schema probe failed: ${error.message}`);
    process.exit(1);
  }
}

async function main() {
  console.log(`[backfill-stars] dryRun=${DRY_RUN} limit=${LIMIT ?? "none"} verbose=${VERBOSE} userEmail=${USER_EMAIL ?? "all"} minStars=${MIN_STARS}`);
  console.log(`[backfill-stars] appwrite ${APPWRITE_ENDPOINT}`);
  console.log(`[backfill-stars] supabase ${SUPABASE_URL}`);
  console.log(`[backfill-stars] writing to wallets.star_balance with GREATEST(current, snapshot) semantics`);

  await ensureSchemaReady();

  // For USER_EMAIL filter, we need the account.$id (since stars.userId
  // stores account.$id). We get it by looking up profiles to get the
  // users-doc.$id, then querying Appwrite users collection by $id.
  let filterAccountId = null;
  if (USER_EMAIL) {
    const { data, error } = await sb
      .from("profiles")
      .select("legacy_appwrite_id, email, username")
      .ilike("email", USER_EMAIL)
      .single();
    if (error || !data) {
      console.error(`User not found: ${USER_EMAIL}`);
      process.exit(1);
    }
    const userDocId = data.legacy_appwrite_id;
    try {
      const userDoc = await awDb.getDocument(APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID, userDocId);
      filterAccountId = userDoc?.accountId || null;
    } catch (_) {
      filterAccountId = null;
    }
    console.log(
      `[backfill-stars] filtering for ${data.email} (${data.username}) userDocId=${userDocId} accountId=${filterAccountId}`,
    );
    if (!filterAccountId) {
      console.error("Couldn't resolve account.$id for that user — they may have no Appwrite users-collection doc.");
      process.exit(1);
    }
  }

  let scanned = 0;
  let prepared = 0;
  let updated = 0;
  let alreadyAtOrAbove = 0;
  let totalStarsRestored = 0;
  let skippedNoUser = 0;
  let skippedZeroStars = 0;
  let skippedFiltered = 0;
  let errors = 0;
  let cursor = null;
  let limitReached = false;

  while (true) {
    const queries = [Query.limit(PAGE_SIZE), Query.orderAsc("$id")];
    if (cursor) queries.push(Query.cursorAfter(cursor));

    let res;
    try {
      res = await awDb.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_STARS_COLLECTION_ID, queries);
    } catch (err) {
      console.error(`Appwrite listDocuments failed: ${err.message}`);
      errors++;
      break;
    }
    if (!res.documents || res.documents.length === 0) break;

    scanned += res.documents.length;

    // Two-step resolution per page:
    //   stars.userId (= account.$id) → users-doc.$id → profile uuid
    const accountIds = [...new Set(res.documents.map((d) => d.userId).filter(Boolean))];
    await resolveAccountToUserDoc(accountIds);
    const userDocIds = accountIds
      .map((acct) => accountToUserDoc.get(acct))
      .filter(Boolean);
    await resolveProfileBatch(userDocIds);

    // Then load current wallet balances for those who have profiles
    const profileIds = userDocIds
      .map((d) => profileCache.get(d)?.id)
      .filter(Boolean);
    await loadWalletBalances(profileIds);

    for (const doc of res.documents) {
      if (LIMIT && prepared >= LIMIT) {
        limitReached = true;
        break;
      }
      if (filterAccountId && doc.userId !== filterAccountId) {
        skippedFiltered++;
        continue;
      }
      const userDocId = accountToUserDoc.get(doc.userId);
      const profile = userDocId ? profileCache.get(userDocId) : null;
      if (!profile) {
        skippedNoUser++;
        if (VERBOSE) console.log(`  skip: no profile for stars.userId=${doc.userId} (userDocId=${userDocId ?? "none"}, stars $id ${doc.$id})`);
        continue;
      }
      const snapshot = Number(doc.stars || 0);
      if (snapshot < MIN_STARS) {
        skippedZeroStars++;
        if (VERBOSE) console.log(`  skip: ${snapshot} stars (below MIN_STARS=${MIN_STARS}) for ${profile.email}`);
        continue;
      }

      const current = walletCache.get(profile.id) ?? 0;
      if (current >= snapshot) {
        alreadyAtOrAbove++;
        if (VERBOSE) console.log(`  ok: ${profile.email} current=${current} >= snapshot=${snapshot}, no top-up needed`);
        continue;
      }

      const delta = snapshot - current;
      prepared++;
      totalStarsRestored += delta;

      if (DRY_RUN) {
        if (VERBOSE) console.log(`  WOULD top-up ${profile.email}: ${current} → ${snapshot} (+${delta})`);
        continue;
      }

      const { error: upsertErr } = await sb
        .from("wallets")
        .upsert(
          {
            user_id: profile.id,
            star_balance: snapshot,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        );

      if (upsertErr) {
        console.error(`  wallet upsert failed for ${profile.email}: ${upsertErr.message}`);
        errors++;
      } else {
        updated++;
        walletCache.set(profile.id, snapshot);
        if (VERBOSE) console.log(`  ✓ ${profile.email}: ${current} → ${snapshot} (+${delta})`);
      }
    }

    if (limitReached) break;
    if (res.documents.length < PAGE_SIZE) break;
    cursor = res.documents[res.documents.length - 1].$id;
    console.log(`  scanned=${scanned} prepared=${prepared} updated=${updated} alreadyOk=${alreadyAtOrAbove} starsRestored=${totalStarsRestored}`);
  }

  console.log("──────────────────────────────────────────────");
  console.log(`[backfill-stars] DONE`);
  console.log(`  scanned:              ${scanned}`);
  console.log(`  prepared (need top-up): ${prepared}`);
  console.log(`  updated:              ${updated}${DRY_RUN ? "  (DRY RUN — nothing actually written)" : ""}`);
  console.log(`  already at/above:     ${alreadyAtOrAbove}`);
  console.log(`  total stars restored: ${totalStarsRestored}`);
  console.log(`  skipped no user:      ${skippedNoUser}`);
  console.log(`  skipped < MIN_STARS:  ${skippedZeroStars}`);
  if (filterAccountId) console.log(`  skipped filtered:     ${skippedFiltered}`);
  console.log(`  errors:               ${errors}`);
  console.log("──────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
