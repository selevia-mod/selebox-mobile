#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/backfill-comments.js
  ─────────────────────────────────────────────────────────────────────────
  One-shot reconciliation: copy historical Appwrite VIDEO comments
  (videosCommentsCollectionId + videosCommentRepliesCollectionId) AND
  POST comments (postsCommentCollectionId + postsCommentRepliesCollectionId)
  into Supabase's `comments` table.

  Why this exists:
    Mobile dual-write (lib/video-appwrite.js + lib/posts.js) ensures
    every NEW Appwrite-side comment also lands on Supabase. But the
    historical Appwrite-only comments (everything before the dual-write
    shipped) are still invisible to web. This script catches them up.

  Migration prerequisite:
    Run Selebox/migration_comments_legacy_id.sql first — it adds the
    `legacy_appwrite_id` mirror column on comments that this script
    populates. Without it, parent-resolution for replies fails.

  Two-pass:
    Pass 1 — top-level comments only (parent_id IS NULL on Appwrite).
             Insert into Supabase, populate legacy_appwrite_id.
    Pass 2 — replies (parent_id set). Resolve parent's Supabase UUID
             via legacy_appwrite_id and insert.
    The two passes prevent reply-before-parent ordering issues.

  Usage:
    APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
    APPWRITE_PROJECT_ID=66b8be7400121b5d4697 \
    APPWRITE_API_KEY=server-key-with-databases-read \
    APPWRITE_DATABASE_ID=66b32b3600246bc34956 \
    APPWRITE_VIDEO_COMMENTS_COLLECTION_ID=67c5364f0022104ac841 \
    APPWRITE_VIDEO_COMMENT_REPLIES_COLLECTION_ID=69afc7fd002871bfd104 \
    APPWRITE_POST_COMMENTS_COLLECTION_ID=6835c7ea002030d23fe7 \
    APPWRITE_POST_COMMENT_REPLIES_COLLECTION_ID=69b2d2f900180492c91a \
    SUPABASE_URL=https://your-project.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
    node scripts/backfill-comments.js

    Optional:
      DRY_RUN=1   Walk + resolve, no upserts.
      LIMIT=500   First N rows from each collection (smoke test).
      VERBOSE=1   Log every skipped row.
      VIDEO_ONLY=1 / POST_ONLY=1   Run just one half.

  Idempotency:
    Inserts use ON CONFLICT (legacy_appwrite_id) DO NOTHING. Re-runs
    are no-ops on rows already imported. Safe to re-run after a partial
    failure or after a fresh batch of dual-write writes.

  Security:
    Requires SUPABASE_SERVICE_ROLE_KEY — RLS on comments would otherwise
    block the insert. Treat the key like a root credential.
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
const APPWRITE_VIDEO_COMMENTS_COLLECTION_ID = env("APPWRITE_VIDEO_COMMENTS_COLLECTION_ID");
const APPWRITE_VIDEO_COMMENT_REPLIES_COLLECTION_ID = process.env.APPWRITE_VIDEO_COMMENT_REPLIES_COLLECTION_ID || null;
const APPWRITE_POST_COMMENTS_COLLECTION_ID = env("APPWRITE_POST_COMMENTS_COLLECTION_ID");
const APPWRITE_POST_COMMENT_REPLIES_COLLECTION_ID = process.env.APPWRITE_POST_COMMENT_REPLIES_COLLECTION_ID || null;
const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const VERBOSE = process.env.VERBOSE === "1";
const VIDEO_ONLY = process.env.VIDEO_ONLY === "1";
const POST_ONLY = process.env.POST_ONLY === "1";

const PAGE_SIZE = 100;
const UPSERT_BATCH_SIZE = 500;

const aw = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const awDb = new Databases(aw);
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Resolution caches ────────────────────────────────────────────────────
const userIdCache = new Map();   // appwrite hex → supabase uuid
const videoIdCache = new Map();
const postIdCache = new Map();
const commentIdCache = new Map(); // appwrite-doc-id → supabase-uuid

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

// ── Page through an Appwrite collection ──────────────────────────────────
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

// Pull common fields (Appwrite stores nested relations in different
// shapes — `video`, `videoComment`, `postId`, etc. — depending on
// collection version). This normalizes them.
const extractParentHex = (doc) => {
  for (const k of ["videoComment", "videoComments", "postComment", "postComments", "parentComment", "parentCommentId", "replyToComment"]) {
    const v = doc?.[k];
    if (!v) continue;
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
      const first = v[0];
      if (typeof first === "string") return first;
      if (first?.$id) return first.$id;
    }
    if (v?.$id) return v.$id;
  }
  return null;
};

const extractHostHex = (doc) => {
  if (typeof doc?.video === "string") return { kind: "video", id: doc.video };
  if (typeof doc?.video?.$id === "string") return { kind: "video", id: doc.video.$id };
  if (typeof doc?.postId === "string") return { kind: "post", id: doc.postId };
  if (typeof doc?.postId?.$id === "string") return { kind: "post", id: doc.postId.$id };
  return null;
};

// ── Backfill driver for one collection ──────────────────────────────────
async function backfill({ label, collectionId, hostKind /* 'video' | 'post' */, isReply }) {
  if (!collectionId) {
    console.log(`[${label}] skipping — collection id not set`);
    return { scanned: 0, prepared: 0, skippedNoMap: 0, upserted: 0, errors: 0 };
  }
  console.log(`[${label}] starting`);
  let scanned = 0, prepared = 0, skippedNoMap = 0, upserted = 0, errors = 0;
  let buffer = [];
  let pending = [];

  const flush = async () => {
    if (!buffer.length) return;
    if (DRY_RUN) { upserted += buffer.length; buffer = []; return; }
    const { error } = await sb
      .from("comments")
      .upsert(buffer, { onConflict: "legacy_appwrite_id", ignoreDuplicates: true });
    if (error) {
      errors += 1;
      console.error(`[${label}] upsert failed (${buffer.length}):`, error.message);
    } else {
      upserted += buffer.length;
    }
    buffer = [];
  };

  const processBatch = async () => {
    if (!pending.length) return;
    // Collect ids to resolve.
    const userHexes = new Set(), hostHexes = new Set(), parentHexes = new Set();
    for (const d of pending) {
      if (d.commentOwner) userHexes.add(d.commentOwner);
      const host = extractHostHex(d);
      if (host?.id) hostHexes.add(host.id);
      if (isReply) {
        const p = extractParentHex(d);
        if (p) parentHexes.add(p);
      }
    }
    await Promise.all([
      resolveBatch("profiles", [...userHexes], userIdCache),
      hostKind === "video"
        ? resolveBatch("videos", [...hostHexes], videoIdCache)
        : resolveBatch("posts", [...hostHexes], postIdCache),
      isReply ? resolveBatch("comments", [...parentHexes], commentIdCache) : Promise.resolve(),
    ]);

    for (const d of pending) {
      const userUuid = userIdCache.get(d.commentOwner);
      const host = extractHostHex(d);
      const hostUuid = host?.kind === "video" ? videoIdCache.get(host.id) : postIdCache.get(host.id);
      const parentHex = isReply ? extractParentHex(d) : null;
      const parentUuid = isReply ? (parentHex ? commentIdCache.get(parentHex) : null) : null;

      const ok = userUuid && hostUuid && (!isReply || parentUuid);
      if (!ok) {
        skippedNoMap += 1;
        if (VERBOSE) console.log(`  skip ${d.$id}: user=${userUuid || "?"} host=${hostUuid || "?"} parent=${parentUuid || "?"}`);
        continue;
      }

      prepared += 1;
      const row = {
        user_id: userUuid,
        body: (d.comment || "").trim(),
        legacy_appwrite_id: d.$id,
        parent_id: parentUuid || null,
      };
      if (host.kind === "video") row.video_id = hostUuid;
      else row.post_id = hostUuid;
      buffer.push(row);
      if (buffer.length >= UPSERT_BATCH_SIZE) await flush();
    }
    pending = [];
  };

  for await (const doc of iterAppwrite(collectionId)) {
    scanned += 1;
    pending.push(doc);
    if (pending.length >= PAGE_SIZE) await processBatch();
    if (LIMIT && scanned >= LIMIT) break;
  }
  await processBatch();
  await flush();

  console.log(`[${label}] scanned=${scanned} prepared=${prepared} upserted=${upserted} skippedNoMap=${skippedNoMap} errors=${errors}`);
  return { scanned, prepared, upserted, skippedNoMap, errors };
}

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[backfill-comments] dryRun=${DRY_RUN} limit=${LIMIT ?? "none"}`);
  console.log(`[backfill-comments] supabase ${SUPABASE_URL}`);

  const reports = {};

  // Pass 1 — top-level comments first (videos + posts).
  if (!POST_ONLY) {
    reports.videoTop = await backfill({
      label: "video-top",
      collectionId: APPWRITE_VIDEO_COMMENTS_COLLECTION_ID,
      hostKind: "video",
      isReply: false,
    });
  }
  if (!VIDEO_ONLY) {
    reports.postTop = await backfill({
      label: "post-top",
      collectionId: APPWRITE_POST_COMMENTS_COLLECTION_ID,
      hostKind: "post",
      isReply: false,
    });
  }

  // Pass 2 — replies (parents now exist in Supabase from pass 1).
  if (!POST_ONLY && APPWRITE_VIDEO_COMMENT_REPLIES_COLLECTION_ID) {
    reports.videoReply = await backfill({
      label: "video-reply",
      collectionId: APPWRITE_VIDEO_COMMENT_REPLIES_COLLECTION_ID,
      hostKind: "video",
      isReply: true,
    });
  }
  if (!VIDEO_ONLY && APPWRITE_POST_COMMENT_REPLIES_COLLECTION_ID) {
    reports.postReply = await backfill({
      label: "post-reply",
      collectionId: APPWRITE_POST_COMMENT_REPLIES_COLLECTION_ID,
      hostKind: "post",
      isReply: true,
    });
  }

  console.log("");
  console.log("──────────────────────────────────────────────");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  for (const [k, r] of Object.entries(reports)) {
    console.log(`${k.padEnd(12)}  scanned=${r.scanned}  upserted=${r.upserted}  skippedNoMap=${r.skippedNoMap}  errors=${r.errors}`);
  }
  console.log("──────────────────────────────────────────────");
  const anyError = Object.values(reports).some((r) => r.errors > 0);
  if (anyError) process.exit(1);
})().catch((e) => {
  console.error("Fatal:", e?.message || e);
  process.exit(1);
});
