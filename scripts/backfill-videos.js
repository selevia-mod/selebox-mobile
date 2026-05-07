#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/backfill-videos.js
  ─────────────────────────────────────────────────────────────────────────
  One-shot reconciliation: copy historical Appwrite videos +
  video_likes + video_views into Supabase. Run after the dual-write
  ships in lib/video-appwrite.js so historical data converges.

  Three passes (in order — videos must exist before likes/views):
    Pass 1 — videos: Appwrite videosCollectionId → public.videos
    Pass 2 — likes:  Appwrite videoLikesCollectionId → public.video_likes
    Pass 3 — views:  Appwrite videoViewsCollectionId → public.video_views

  Uses public.videos.legacy_appwrite_id to:
    • Make pass 1 idempotent via ON CONFLICT (legacy_appwrite_id)
    • Resolve Appwrite video_id hex → Supabase UUID for passes 2 & 3

  Migration prereq:
    public.videos must have legacy_appwrite_id column. Most Selebox
    deployments already do (web's CDN webhooks use it). If your dev
    DB doesn't:
      alter table public.videos add column if not exists legacy_appwrite_id text;
      create index if not exists videos_legacy_appwrite_id_idx
        on public.videos (legacy_appwrite_id) where legacy_appwrite_id is not null;

  Usage:
    APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
    APPWRITE_PROJECT_ID=66b8be7400121b5d4697 \
    APPWRITE_API_KEY=server-key-with-databases-read \
    APPWRITE_DATABASE_ID=66b32b3600246bc34956 \
    APPWRITE_VIDEOS_COLLECTION_ID=66e585fc00332d4aa620 \
    APPWRITE_VIDEO_LIKES_COLLECTION_ID=67b40129001d48e27078 \
    APPWRITE_VIDEO_VIEWS_COLLECTION_ID=<videoMetricsCollectionId-or-views> \
    SUPABASE_URL=https://your-project.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
    node scripts/backfill-videos.js

    Optional:
      DRY_RUN=1   Walk + resolve, no writes.
      LIMIT=500   First N rows from each collection (smoke).
      VERBOSE=1   Log every skipped row.
      ONLY=videos|likes|views   Run just one pass.

  Idempotency:
    All three passes use ON CONFLICT DO NOTHING (or upsert-with-update
    for the videos pass so re-running picks up edited metadata too).
    Safe to re-run.

  Security:
    Requires SUPABASE_SERVICE_ROLE_KEY — RLS would otherwise block the
    inserts. Treat the key like a root credential.
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
const APPWRITE_VIDEOS_COLLECTION_ID = env("APPWRITE_VIDEOS_COLLECTION_ID");
const APPWRITE_VIDEO_LIKES_COLLECTION_ID = process.env.APPWRITE_VIDEO_LIKES_COLLECTION_ID || null;
const APPWRITE_VIDEO_VIEWS_COLLECTION_ID = process.env.APPWRITE_VIDEO_VIEWS_COLLECTION_ID || null;
const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const VERBOSE = process.env.VERBOSE === "1";
const ONLY = (process.env.ONLY || "").toLowerCase();

const PAGE_SIZE = 100;
const UPSERT_BATCH_SIZE = 500;

const aw = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const awDb = new Databases(aw);
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const profileCache = new Map();
const videoCache = new Map();

const resolveBatch = async (table, hexIds, cache) => {
  const unresolved = hexIds.filter((h) => h && !cache.has(h));
  if (!unresolved.length) return;
  for (let i = 0; i < unresolved.length; i += 1000) {
    const slice = unresolved.slice(i, i + 1000);
    const { data, error } = await sb.from(table).select("id, legacy_appwrite_id").in("legacy_appwrite_id", slice);
    if (error) throw new Error(`${table} lookup failed: ${error.message}`);
    const found = new Map();
    for (const r of data || []) found.set(r.legacy_appwrite_id, r.id);
    for (const h of slice) cache.set(h, found.get(h) || null);
  }
};

async function* iterAppwrite(collectionId) {
  let cursor = null;
  while (true) {
    const queries = [Query.limit(PAGE_SIZE), Query.orderAsc("$id")];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const response = await awDb.listDocuments(APPWRITE_DATABASE_ID, collectionId, queries);
    const docs = response?.documents || [];
    if (!docs.length) break;
    for (const d of docs) yield d;
    cursor = docs[docs.length - 1].$id;
    if (docs.length < PAGE_SIZE) break;
  }
}

const extractRel = (v) => {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return extractRel(v[0]);
  return v?.$id || v?.id || null;
};

// ── Pass 1: videos ───────────────────────────────────────────────────────
async function backfillVideos() {
  console.log("[videos] starting");
  let scanned = 0, prepared = 0, skippedNoMap = 0, upserted = 0, errors = 0;
  let buffer = [];
  let pending = [];

  const flush = async () => {
    if (!buffer.length) return;
    if (DRY_RUN) { upserted += buffer.length; buffer = []; return; }
    // For videos, we want re-runs to pick up any metadata edits — use
    // upsert-with-update on legacy_appwrite_id rather than ignoreDuplicates.
    const { error } = await sb.from("videos").upsert(buffer, { onConflict: "legacy_appwrite_id" });
    if (error) {
      errors += 1;
      console.error(`[videos] upsert failed (${buffer.length}):`, error.message);
    } else {
      upserted += buffer.length;
    }
    buffer = [];
  };

  const processBatch = async () => {
    if (!pending.length) return;
    const uploaderHexes = new Set();
    for (const d of pending) {
      const u = extractRel(d.uploader);
      if (u) uploaderHexes.add(u);
    }
    await resolveBatch("profiles", [...uploaderHexes], profileCache);

    for (const d of pending) {
      const uploaderHex = extractRel(d.uploader);
      const uploaderUuid = profileCache.get(uploaderHex);
      if (!uploaderUuid) {
        skippedNoMap += 1;
        if (VERBOSE) console.log(`  skip video ${d.$id}: uploader ${uploaderHex} → ?`);
        continue;
      }

      // Extract bunny_video_id from the Bunny.net URL. The Appwrite
      // videos collection doesn't store bunny_video_id as a separate
      // field — it lives embedded in `videoUrl` / `uri`. Pre-Bunny
      // videos (the retired AWS S3 / clips era) have URLs that don't
      // match any Bunny pattern; we skip those entirely because:
      //   1. public.videos.bunny_video_id is NOT NULL — would error
      //   2. The S3 storage was retired May 2026, so the video files
      //      are gone — backfilling a "ghost" row would surface an
      //      unplayable video to users (worse UX than not showing it)
      //
      // Recognized Bunny URL patterns:
      //   https://iframe.mediadelivery.net/embed/{library}/{video_id}
      //   https://video.bunnycdn.com/library/{library}/videos/{video_id}
      //   https://vz-{hash}.b-cdn.net/{video_id}/playlist.m3u8
      // The {video_id} is a UUID-shaped string in all variants.
      const url = d.videoUrl || d.video_url || d.uri || "";
      // Parse both bunny_video_id and bunny_library_id from the URL.
      // The Appwrite videos collection doesn't store either as a separate
      // field — they live embedded in the URL. Pre-Bunny videos (the
      // retired AWS S3 / clips era) have URLs that don't match any Bunny
      // pattern; we skip those entirely because:
      //   1. public.videos.bunny_video_id and bunny_library_id are NOT NULL
      //   2. The S3 storage was retired May 2026, so the video files
      //      are gone — backfilling a "ghost" row would surface an
      //      unplayable video to users (worse UX than not showing it)
      //
      // Bunny URL patterns + what we extract:
      //   https://iframe.mediadelivery.net/embed/{library}/{video_id}
      //     → library_id from path, video_id (UUID) from path
      //   https://video.bunnycdn.com/library/{library}/videos/{video_id}
      //     → library_id from path, video_id (UUID) from path
      //   https://vz-{hash}.b-cdn.net/{video_id}/playlist.m3u8
      //     → library not in URL; fall back to default library id
      const DEFAULT_BUNNY_LIBRARY_ID =
        process.env.DEFAULT_BUNNY_LIBRARY_ID || "541939";
      const bunnyVideoId = (() => {
        if (!url) return null;
        const uuidMatch = String(url).match(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
        );
        return uuidMatch ? uuidMatch[0] : null;
      })();
      const bunnyLibraryId = (() => {
        if (!url) return null;
        // Match `/library/{digits}/` or `/embed/{digits}/` from Bunny URLs.
        const libMatch = String(url).match(/\/(?:library|embed)\/(\d+)\//);
        if (libMatch) return libMatch[1];
        // Fall back to the default library when the URL is the b-cdn.net
        // shape that doesn't expose the library id explicitly.
        return DEFAULT_BUNNY_LIBRARY_ID;
      })();
      if (!bunnyVideoId) {
        skippedNoMap += 1;
        if (VERBOSE) console.log(`  skip video ${d.$id}: no Bunny ID parseable from URL "${url.slice(0, 80)}" (likely retired S3 video)`);
        continue;
      }

      prepared += 1;
      buffer.push({
        legacy_appwrite_id: d.$id,
        uploader_id: uploaderUuid,
        bunny_video_id: bunnyVideoId,
        bunny_library_id: bunnyLibraryId,
        title: d.title || null,
        description: d.description || null,
        video_url: url || null,
        thumbnail_url: d.thumbnail || d.thumbnail_url || null,
        status: d.status || "ready",
        tags: Array.isArray(d.tags) ? d.tags : null,
        category: d.category || null,
        is_monetized: !!d.is_monetized,
        duration: typeof d.duration === "number" ? d.duration : null,
      });
      if (buffer.length >= UPSERT_BATCH_SIZE) await flush();
    }
    pending = [];
  };

  for await (const doc of iterAppwrite(APPWRITE_VIDEOS_COLLECTION_ID)) {
    scanned += 1;
    pending.push(doc);
    if (pending.length >= PAGE_SIZE) await processBatch();
    if (LIMIT && scanned >= LIMIT) break;
  }
  await processBatch();
  await flush();

  console.log(`[videos] scanned=${scanned} prepared=${prepared} upserted=${upserted} skippedNoMap=${skippedNoMap} errors=${errors}`);
  return { scanned, prepared, upserted, skippedNoMap, errors };
}

// ── Pass 2: video_likes ──────────────────────────────────────────────────
async function backfillVideoLikes() {
  if (!APPWRITE_VIDEO_LIKES_COLLECTION_ID) {
    console.log("[likes] skipping — APPWRITE_VIDEO_LIKES_COLLECTION_ID not set");
    return { scanned: 0, prepared: 0, upserted: 0, skippedNoMap: 0, errors: 0 };
  }
  console.log("[likes] starting");
  let scanned = 0, prepared = 0, skippedNoMap = 0, upserted = 0, errors = 0;
  let buffer = [];
  let pending = [];

  const flush = async () => {
    if (!buffer.length) return;
    if (DRY_RUN) { upserted += buffer.length; buffer = []; return; }
    const { error } = await sb.from("video_likes").upsert(buffer, { onConflict: "video_id,user_id", ignoreDuplicates: true });
    if (error) {
      errors += 1;
      console.error(`[likes] upsert failed (${buffer.length}):`, error.message);
    } else {
      upserted += buffer.length;
    }
    buffer = [];
  };

  const processBatch = async () => {
    if (!pending.length) return;
    const userHexes = new Set();
    const videoHexes = new Set();
    for (const d of pending) {
      const u = extractRel(d.likeOwner);
      const v = extractRel(d.video);
      if (u) userHexes.add(u);
      if (v) videoHexes.add(v);
    }
    await Promise.all([
      resolveBatch("profiles", [...userHexes], profileCache),
      resolveBatch("videos", [...videoHexes], videoCache),
    ]);

    for (const d of pending) {
      const userHex = extractRel(d.likeOwner);
      const videoHex = extractRel(d.video);
      const userUuid = profileCache.get(userHex);
      const videoUuid = videoCache.get(videoHex);
      if (!userUuid || !videoUuid) {
        skippedNoMap += 1;
        if (VERBOSE) console.log(`  skip like ${d.$id}: user=${userUuid || "?"} video=${videoUuid || "?"}`);
        continue;
      }
      prepared += 1;
      buffer.push({ video_id: videoUuid, user_id: userUuid });
      if (buffer.length >= UPSERT_BATCH_SIZE) await flush();
    }
    pending = [];
  };

  for await (const doc of iterAppwrite(APPWRITE_VIDEO_LIKES_COLLECTION_ID)) {
    scanned += 1;
    pending.push(doc);
    if (pending.length >= PAGE_SIZE) await processBatch();
    if (LIMIT && scanned >= LIMIT) break;
  }
  await processBatch();
  await flush();

  console.log(`[likes] scanned=${scanned} prepared=${prepared} upserted=${upserted} skippedNoMap=${skippedNoMap} errors=${errors}`);
  return { scanned, prepared, upserted, skippedNoMap, errors };
}

// ── Pass 3: video_views (SKIPPED) ───────────────────────────────────────
// No public.video_views table exists in any Selebox migration. Web's
// view counts live on videos.views_count (denormalized counter, kept by
// Bunny.net analytics + a server-side trigger). Per-user view rows
// don't have a Supabase home, so this pass is a no-op.
async function backfillVideoViews() {
  console.log("[views] skipped — no video_views table on Supabase (views_count is a counter on videos)");
  return { scanned: 0, prepared: 0, upserted: 0, skippedNoMap: 0, errors: 0 };
}

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[backfill-videos] dryRun=${DRY_RUN} limit=${LIMIT ?? "none"}`);
  console.log(`[backfill-videos] supabase ${SUPABASE_URL}`);

  const reports = {};

  if (!ONLY || ONLY === "videos") reports.videos = await backfillVideos();
  if (!ONLY || ONLY === "likes")  reports.likes  = await backfillVideoLikes();
  if (!ONLY || ONLY === "views")  reports.views  = await backfillVideoViews();

  console.log("");
  console.log("──────────────────────────────────────────────");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  for (const [k, r] of Object.entries(reports)) {
    console.log(`${k.padEnd(8)}  scanned=${r.scanned}  upserted=${r.upserted}  skippedNoMap=${r.skippedNoMap}  errors=${r.errors}`);
  }
  console.log("──────────────────────────────────────────────");
  if (Object.values(reports).some((r) => r.errors > 0)) process.exit(1);
})().catch((e) => {
  console.error("Fatal:", e?.message || e);
  process.exit(1);
});
