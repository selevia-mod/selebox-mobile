#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/backfill-video-views.js
  ─────────────────────────────────────────────────────────────────────────
  One-shot reconciliation: copy historical per-(video, viewer) rows from
  Appwrite's `videos-views` collection into Supabase's
  `public.video_views` table, then let the existing trigger
  (_tg_video_views_count, defined in migration_videos_engagement_counts.sql)
  bump videos.views_count automatically on each insert.

  How it maps:
    Appwrite videos-views row          → Supabase video_views row
    {                                    {
      video:     <hex>      ─resolve→     video_id:   <uuid>,
      user:      <hex>      ─resolve→     viewer_id:  <uuid>,
      viewCount: <int>      ────────→     IGNORED (Supabase schema is
                                                   "unique viewers" — one
                                                   row per pair regardless
                                                   of re-watch count),
      $createdAt:<iso>      ────────→     created_at: <iso>,
    }                                    }

    Resolution uses legacy_appwrite_id mirror columns on profiles +
    videos that the migration tool already populated. Any row whose
    video or viewer can't be resolved is skipped (orphan / pre-migration).

  Why we ignore viewCount:
    The Appwrite schema stored a `viewCount` per (video, user) pair so
    re-watches could be counted. Supabase's video_views has
    (video_id, viewer_id) as a composite PK — its semantic is unique
    viewers, not total view events. Inserting once per pair preserves
    the unique-viewer semantic (and keeps videos.views_count aligned
    with `count(*) from video_views`, which the migration uses).

    If you need re-watch counts later, add a `view_count integer not
    null default 1` column to video_views and populate it from this
    same source.

  Idempotency:
    composite PK (video_id, viewer_id) makes inserts idempotent. We
    upsert with ignoreDuplicates so re-running the script after a
    partial failure converges. The trigger only fires on actual
    INSERTs, so re-runs don't double-increment views_count.

  Usage:
    APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
    APPWRITE_PROJECT_ID=66b8be7400121b5d4697 \
    APPWRITE_API_KEY=server-key-with-databases-read \
    APPWRITE_DATABASE_ID=66b32b3600246bc34956 \
    APPWRITE_VIDEO_VIEWS_COLLECTION_ID=6915eafa0028f383e7d0 \
    SUPABASE_URL=https://your-project.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
    node scripts/backfill-video-views.js

    Optional:
      DRY_RUN=1     Walk + resolve, no writes.
      LIMIT=500     First N rows (smoke test).
      VERBOSE=1     Log every skipped/inserted row.

  Security:
    Requires SUPABASE_SERVICE_ROLE_KEY — RLS on video_views requires
    auth.uid() = viewer_id, which we can't satisfy from a script. The
    service role bypasses RLS. Treat the key like a root credential.
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
// Default to the videos-views collection ID we observed (6915eafa0028f383e7d0).
// Override via env if your project moved or renamed it.
const APPWRITE_VIDEO_VIEWS_COLLECTION_ID = env(
  "APPWRITE_VIDEO_VIEWS_COLLECTION_ID",
  "6915eafa0028f383e7d0",
);
const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const VERBOSE = process.env.VERBOSE === "1";

const PAGE_SIZE = 100;
const INSERT_BATCH_SIZE = 500;

const aw = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const awDb = new Databases(aw);
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Resolution caches (Appwrite hex → Supabase UUID) ─────────────────────
const profileCache = new Map();
const videoCache = new Map();

// Bulk-resolve a batch of hex IDs against a Supabase table that has a
// `legacy_appwrite_id` mirror column. Misses cache as null so we don't
// retry the same orphans on every batch.
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

// Appwrite relation values can be a hex string, an embedded object with
// $id, or an array (for array-typed relations). Normalize to a hex.
const extractRel = (v) => {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return extractRel(v[0]);
  return v?.$id || v?.id || null;
};

// ── Page through the Appwrite videos-views collection ────────────────────
async function* iterAppwriteViews() {
  let cursor = null;
  let scanned = 0;
  while (true) {
    const queries = [Query.limit(PAGE_SIZE), Query.orderAsc("$id")];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const response = await awDb.listDocuments(
      APPWRITE_DATABASE_ID,
      APPWRITE_VIDEO_VIEWS_COLLECTION_ID,
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

// ── Driver ───────────────────────────────────────────────────────────────
async function run() {
  console.log("[backfill-video-views] starting", {
    DRY_RUN,
    LIMIT,
    VERBOSE,
    collection: APPWRITE_VIDEO_VIEWS_COLLECTION_ID,
  });

  let scanned = 0;
  let prepared = 0;
  let skippedNoMap = 0;
  let inserted = 0;
  let errors = 0;
  let pending = [];

  const flush = async () => {
    if (!pending.length) return;

    // 1. Resolve hex → uuid for videos and viewers in this batch.
    const userHexes = new Set();
    const videoHexes = new Set();
    for (const d of pending) {
      const u = extractRel(d.user);
      const v = extractRel(d.video);
      if (u) userHexes.add(u);
      if (v) videoHexes.add(v);
    }
    await Promise.all([
      resolveBatch("profiles", [...userHexes], profileCache),
      resolveBatch("videos", [...videoHexes], videoCache),
    ]);

    // 2. Build candidate rows. Skip orphans (video or viewer not on
    //    Supabase) — usually pre-migration test accounts or videos
    //    deleted between collection write and migration.
    const candidates = [];
    const seenInBatch = new Set(); // dedup duplicates within the batch
    for (const d of pending) {
      const userHex = extractRel(d.user);
      const videoHex = extractRel(d.video);
      const userUuid = userHex ? profileCache.get(userHex) : null;
      const videoUuid = videoHex ? videoCache.get(videoHex) : null;
      if (!userUuid || !videoUuid) {
        skippedNoMap += 1;
        if (VERBOSE) console.log(`  skip orphan: video=${videoHex || "?"} user=${userHex || "?"}`);
        continue;
      }
      const key = `${videoUuid}::${userUuid}`;
      if (seenInBatch.has(key)) continue; // dedupe within batch
      seenInBatch.add(key);
      candidates.push({
        video_id: videoUuid,
        viewer_id: userUuid,
        created_at: d.$createdAt || new Date().toISOString(),
      });
    }
    prepared += candidates.length;

    // 3. Upsert with ignoreDuplicates so the composite PK
    //    (video_id, viewer_id) absorbs re-runs and overlaps without
    //    error. The trigger fires only on real INSERTs (not the
    //    no-op upsert path), so views_count is increment-once-per-pair.
    if (DRY_RUN) {
      inserted += candidates.length;
      if (VERBOSE) console.log(`  [dry-run] would upsert ${candidates.length} view rows`);
    } else if (candidates.length) {
      for (let i = 0; i < candidates.length; i += INSERT_BATCH_SIZE) {
        const slice = candidates.slice(i, i + INSERT_BATCH_SIZE);
        const { error } = await sb
          .from("video_views")
          .upsert(slice, { onConflict: "video_id,viewer_id", ignoreDuplicates: true });
        if (error) {
          errors += 1;
          console.error(`  upsert failed (${slice.length}):`, error.message);
        } else {
          inserted += slice.length;
        }
      }
    }

    pending = [];
  };

  for await (const doc of iterAppwriteViews()) {
    scanned += 1;
    pending.push(doc);
    if (pending.length >= INSERT_BATCH_SIZE) {
      await flush();
      if (scanned % 1000 === 0) {
        console.log(
          `  progress: scanned=${scanned} inserted=${inserted} orphan=${skippedNoMap} err=${errors}`,
        );
      }
    }
  }
  await flush();

  console.log("[backfill-video-views] done", {
    scanned,
    prepared,
    inserted,
    skippedNoMap,
    errors,
  });
  if (errors) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
