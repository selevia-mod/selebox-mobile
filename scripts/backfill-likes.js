#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/backfill-likes.js
  ─────────────────────────────────────────────────────────────────────────
  One-shot reconciliation: copy historical Appwrite POST likes
  (postsLikeCollectionId) into Supabase's `reactions` table so the mobile
  PostLikesModal (which now reads from `reactions`) shows old likes too.
  Posts that pre-date the dual-write rollout otherwise look like ghost
  towns even when they had real engagement on the legacy backend.

  How it maps:
    Appwrite postsLike row             → Supabase reactions row
    {                                    {
      postId:    <hex>      ─resolve→     target_id:   <uuid>,
      userId:    <hex>      ─resolve→     user_id:     <uuid>,
      $createdAt:<iso>      ────────→     created_at:  <iso>,
                                          target_type: 'post',
                                          emoji:       'heart',
    }                                    }

    Resolution uses legacy_appwrite_id mirror columns on profiles + posts
    that the migration tool already populated. Any row whose host post or
    actor user can't be resolved is skipped (orphan / pre-migration).

  Idempotency:
    "Check then insert" — for each batch we first SELECT existing
    reactions for (target_type='post', target_id IN postBatch) and skip
    any (user_id, target_id) we already have. Safe to re-run after a
    partial failure or after the dual-write era already shipped some
    rows. No duplicate rows even without a DB-level unique constraint.

  Usage:
    APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
    APPWRITE_PROJECT_ID=66b8be7400121b5d4697 \
    APPWRITE_API_KEY=server-key-with-databases-read \
    APPWRITE_DATABASE_ID=66b32b3600246bc34956 \
    APPWRITE_POSTS_LIKE_COLLECTION_ID=<the-id> \
    SUPABASE_URL=https://your-project.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
    node scripts/backfill-likes.js

    Optional:
      DRY_RUN=1   Walk + resolve, no inserts.
      LIMIT=500   First N rows (smoke test).
      VERBOSE=1   Log every skipped/imported row.

  Security:
    Requires SUPABASE_SERVICE_ROLE_KEY — the reactions RLS policy keys off
    auth.uid() and would block our anon writes otherwise. Treat the key
    like a root credential — never commit it.
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
const APPWRITE_POSTS_LIKE_COLLECTION_ID = env("APPWRITE_POSTS_LIKE_COLLECTION_ID");
const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const VERBOSE = process.env.VERBOSE === "1";

const PAGE_SIZE = 100;
const INSERT_BATCH_SIZE = 200;

const aw = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const awDb = new Databases(aw);
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Resolution caches (Appwrite hex → Supabase UUID) ─────────────────────
const userIdCache = new Map();
const postIdCache = new Map();

// Bulk-resolve a batch of legacy hex ids against a Supabase table that
// has a `legacy_appwrite_id` mirror column. Misses are cached as null so
// we don't keep retrying the same orphaned rows.
const resolveBatch = async (table, hexIds, cache) => {
  const unresolved = hexIds.filter((h) => h && !cache.has(h));
  if (!unresolved.length) return;
  for (let i = 0; i < unresolved.length; i += 1000) {
    const slice = unresolved.slice(i, i + 1000);
    const { data, error } = await sb
      .from(table)
      .select("id, legacy_appwrite_id")
      .in("legacy_appwrite_id", slice);
    if (error) throw new Error(`${table} lookup failed: ${error.message}`);
    const found = new Map();
    for (const r of data || []) found.set(r.legacy_appwrite_id, r.id);
    for (const h of slice) cache.set(h, found.get(h) || null);
  }
};

// ── Page through the Appwrite likes collection ───────────────────────────
async function* iterAppwriteLikes() {
  let cursor = null;
  let scanned = 0;
  while (true) {
    const queries = [Query.limit(PAGE_SIZE), Query.orderAsc("$id")];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const response = await awDb.listDocuments(
      APPWRITE_DATABASE_ID,
      APPWRITE_POSTS_LIKE_COLLECTION_ID,
      queries,
    );
    const docs = response?.documents || [];
    if (!docs.length) break;
    for (const d of docs) {
      yield d;
      scanned += 1;
      if (LIMIT && scanned >= LIMIT) return;
    }
    cursor = docs[docs.length - 1].$id;
    if (docs.length < PAGE_SIZE) break;
  }
}

// Appwrite likes have varied around: { postId: '<hex>', userId: '<hex>' }
// or sometimes nested relations. Normalize.
const extractPostHex = (doc) => {
  const v = doc?.postId ?? doc?.post ?? null;
  if (typeof v === "string") return v;
  if (v?.$id) return v.$id;
  if (Array.isArray(v) && v[0]?.$id) return v[0].$id;
  return null;
};

const extractUserHex = (doc) => {
  const v = doc?.userId ?? doc?.user ?? doc?.likeOwner ?? null;
  if (typeof v === "string") return v;
  if (v?.$id) return v.$id;
  if (Array.isArray(v) && v[0]?.$id) return v[0].$id;
  return null;
};

// ── Driver ───────────────────────────────────────────────────────────────
async function run() {
  console.log("[backfill-likes] starting", { DRY_RUN, LIMIT, VERBOSE });
  let scanned = 0;
  let prepared = 0;
  let skippedNoMap = 0;
  let skippedDup = 0;
  let inserted = 0;
  let errors = 0;
  let pending = [];

  const flush = async () => {
    if (!pending.length) return;

    // 1. Resolve hex → uuid for posts and users in this batch.
    const userHexes = new Set();
    const postHexes = new Set();
    for (const d of pending) {
      const u = extractUserHex(d);
      const p = extractPostHex(d);
      if (u) userHexes.add(u);
      if (p) postHexes.add(p);
    }
    await Promise.all([
      resolveBatch("profiles", [...userHexes], userIdCache),
      resolveBatch("posts", [...postHexes], postIdCache),
    ]);

    // 2. Build candidate reaction rows (skip any we couldn't resolve).
    const candidates = [];
    for (const d of pending) {
      const userHex = extractUserHex(d);
      const postHex = extractPostHex(d);
      const userUuid = userHex ? userIdCache.get(userHex) : null;
      const postUuid = postHex ? postIdCache.get(postHex) : null;
      if (!userUuid || !postUuid) {
        skippedNoMap += 1;
        if (VERBOSE) console.log("  skip orphan", d.$id, { userHex, postHex });
        continue;
      }
      candidates.push({
        user_id: userUuid,
        target_type: "post",
        target_id: postUuid,
        emoji: "heart",
        created_at: d.$createdAt || new Date().toISOString(),
      });
    }
    prepared += candidates.length;

    // 3. Dedup against the existing rows in Supabase. One round-trip per
    //    batch of post UUIDs returns all reactions that already exist.
    const postUuidsThisBatch = Array.from(new Set(candidates.map((c) => c.target_id)));
    let alreadyThere = new Set();
    if (postUuidsThisBatch.length) {
      const { data: existing, error: dedupErr } = await sb
        .from("reactions")
        .select("user_id, target_id")
        .eq("target_type", "post")
        .in("target_id", postUuidsThisBatch);
      if (dedupErr) {
        errors += 1;
        console.error("dedup query failed:", dedupErr.message);
      } else {
        for (const r of existing || []) {
          alreadyThere.add(`${r.user_id}::${r.target_id}`);
        }
      }
    }

    const toInsert = candidates.filter((c) => {
      const key = `${c.user_id}::${c.target_id}`;
      if (alreadyThere.has(key)) {
        skippedDup += 1;
        return false;
      }
      // Defend against duplicates within this batch too (one user
      // double-liking on Appwrite due to old client bugs).
      if (alreadyThere.has(key)) return false;
      alreadyThere.add(key);
      return true;
    });

    // 4. Insert.
    if (DRY_RUN) {
      inserted += toInsert.length;
      if (VERBOSE) console.log(`  [dry-run] would insert ${toInsert.length} likes`);
    } else if (toInsert.length) {
      for (let i = 0; i < toInsert.length; i += INSERT_BATCH_SIZE) {
        const slice = toInsert.slice(i, i + INSERT_BATCH_SIZE);
        const { error } = await sb.from("reactions").insert(slice);
        if (error) {
          errors += 1;
          console.error(`insert failed (${slice.length}):`, error.message);
        } else {
          inserted += slice.length;
        }
      }
    }

    pending = [];
  };

  for await (const doc of iterAppwriteLikes()) {
    scanned += 1;
    pending.push(doc);
    if (pending.length >= INSERT_BATCH_SIZE) {
      await flush();
      if (scanned % 1000 === 0) {
        console.log(`  progress: scanned=${scanned} inserted=${inserted} dup=${skippedDup} orphan=${skippedNoMap} err=${errors}`);
      }
    }
  }
  await flush();

  console.log("[backfill-likes] done", {
    scanned,
    prepared,
    inserted,
    skippedDup,
    skippedNoMap,
    errors,
  });
  if (errors) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
