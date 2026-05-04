#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/backfill-blocks-hides.js
  ─────────────────────────────────────────────────────────────────────────
  One-shot reconciliation: copy every row from Appwrite's
  userBlocksCollection and userHiddenContentCollection into Supabase's
  user_blocks and post_hides tables. Run this once after enabling the
  dual-write in lib/safety.js so historical mobile-side blocks/hides
  start syncing to web.

  Why this exists:
    Up until today, mobile wrote blocks + hides to Appwrite only and
    web wrote to Supabase only. Web couldn't see mobile blocks; mobile
    couldn't see web blocks. Cross-platform safety state was split.

    The dual-write in lib/safety.js fixes new writes going forward, but
    the historical Appwrite-only rows still need to be moved across.
    This script does that one time. Idempotent — re-running upserts
    with PK conflict skipped, so safe to retry on partial failure.

  ID resolution:
    Appwrite hex IDs → Supabase UUIDs via profiles.legacy_appwrite_id.
    Same mapping the migration tool populated.
    Rows where either user can't be resolved are skipped and counted
    in `skippedNoMap`.

  Usage:
    APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
    APPWRITE_PROJECT_ID=66b8be7400121b5d4697 \
    APPWRITE_API_KEY=your-server-api-key-with-databases-read \
    APPWRITE_DATABASE_ID=66b32b3600246bc34956 \
    APPWRITE_USER_BLOCKS_COLLECTION_ID=6965f68e003dc73c4107 \
    APPWRITE_USER_HIDDEN_CONTENT_COLLECTION_ID=696605910005a4d0b989 \
    SUPABASE_URL=https://your-project.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
    node scripts/backfill-blocks-hides.js

    Optional flags:
      DRY_RUN=1   Walk Appwrite + resolve mappings, but skip the upsert.
      LIMIT=500   Only process the first N rows from each collection.
      VERBOSE=1   Print every skipped row.

  Idempotency:
    Both upserts use ignoreDuplicates: true on the natural PKs
    (user_id, blocked_user_id) and (user_id, post_id). Already-present
    rows are no-ops. Safe to re-run.

  Security:
    Requires the Supabase service-role key (RLS on user_blocks /
    post_hides blocks inserts where auth.uid() != user_id). Treat it
    like a root credential.
*/

const { Client, Databases, Query } = require("node-appwrite");
const { createClient } = require("@supabase/supabase-js");

// ── Config ───────────────────────────────────────────────────────────────
const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const APPWRITE_USER_BLOCKS_COLLECTION_ID = process.env.APPWRITE_USER_BLOCKS_COLLECTION_ID;
const APPWRITE_USER_HIDDEN_CONTENT_COLLECTION_ID = process.env.APPWRITE_USER_HIDDEN_CONTENT_COLLECTION_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const VERBOSE = process.env.VERBOSE === "1";

const required = {
  APPWRITE_PROJECT_ID,
  APPWRITE_API_KEY,
  APPWRITE_DATABASE_ID,
  APPWRITE_USER_BLOCKS_COLLECTION_ID,
  APPWRITE_USER_HIDDEN_CONTENT_COLLECTION_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
};
for (const [name, value] of Object.entries(required)) {
  if (!value) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
}

const APPWRITE_PAGE_SIZE = 100;
const UPSERT_BATCH_SIZE = 500;

const aw = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const awDb = new Databases(aw);
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── ID-resolution cache ──────────────────────────────────────────────────
const idCache = new Map();

const resolveIdsBatch = async (hexIds) => {
  const unresolved = [];
  for (const hex of hexIds) {
    if (hex && !idCache.has(hex)) unresolved.push(hex);
  }
  if (unresolved.length === 0) return;

  for (let i = 0; i < unresolved.length; i += 1000) {
    const slice = unresolved.slice(i, i + 1000);
    const { data, error } = await sb.from("profiles").select("id, legacy_appwrite_id").in("legacy_appwrite_id", slice);
    if (error) throw new Error(`profiles lookup failed: ${error.message}`);

    const found = new Map();
    for (const row of data || []) found.set(row.legacy_appwrite_id, row.id);
    for (const hex of slice) idCache.set(hex, found.get(hex) || null);
  }
};

// ── Page through an Appwrite collection ──────────────────────────────────
async function* iterAppwrite(collectionId) {
  let cursor = null;
  while (true) {
    const queries = [Query.limit(APPWRITE_PAGE_SIZE), Query.orderAsc("$id")];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const response = await awDb.listDocuments(APPWRITE_DATABASE_ID, collectionId, queries);
    const docs = response?.documents || [];
    if (docs.length === 0) break;
    for (const doc of docs) yield doc;
    cursor = docs[docs.length - 1].$id;
    if (docs.length < APPWRITE_PAGE_SIZE) break;
  }
}

// Resolve a batch of Appwrite post-id hexes to Supabase posts.id UUIDs
// via the migration's posts.legacy_appwrite_id mirror column. Mirrors
// resolveIdsBatch but for posts instead of profiles. Caches results in
// `postIdCache`.
const postIdCache = new Map();
const resolvePostHexBatch = async (hexIds) => {
  const unresolved = hexIds.filter((h) => h && !postIdCache.has(h));
  if (unresolved.length === 0) return;
  for (let i = 0; i < unresolved.length; i += 1000) {
    const slice = unresolved.slice(i, i + 1000);
    const { data, error } = await sb.from("posts").select("id, legacy_appwrite_id").in("legacy_appwrite_id", slice);
    if (error) throw new Error(`posts lookup failed: ${error.message}`);
    const found = new Map();
    for (const row of data || []) found.set(row.legacy_appwrite_id, row.id);
    for (const hex of slice) postIdCache.set(hex, found.get(hex) || null);
  }
};

// ── Blocks backfill ──────────────────────────────────────────────────────
async function backfillBlocks() {
  console.log("[backfill] blocks: starting");
  let scanned = 0, prepared = 0, skippedNoMap = 0, upserted = 0, upsertErrors = 0;
  let buffer = [];
  let pendingDocs = [];

  const flush = async () => {
    if (buffer.length === 0) return;
    if (DRY_RUN) { upserted += buffer.length; buffer = []; return; }
    const { error } = await sb
      .from("user_blocks")
      .upsert(buffer, { onConflict: "user_id,blocked_user_id", ignoreDuplicates: true });
    if (error) {
      upsertErrors += 1;
      console.error(`[backfill] blocks upsert failed (${buffer.length}): ${error.message}`);
    } else {
      upserted += buffer.length;
    }
    buffer = [];
  };

  const processPending = async () => {
    if (pendingDocs.length === 0) return;
    const hexes = new Set();
    for (const d of pendingDocs) {
      if (d.blockerId) hexes.add(d.blockerId);
      if (d.blockedUserId) hexes.add(d.blockedUserId);
    }
    await resolveIdsBatch([...hexes]);
    for (const d of pendingDocs) {
      const u = idCache.get(d.blockerId);
      const b = idCache.get(d.blockedUserId);
      if (!u || !b || u === b) {
        skippedNoMap += 1;
        if (VERBOSE) console.log(`  skip block ${d.$id}: blocker=${d.blockerId}→${u || "?"} blocked=${d.blockedUserId}→${b || "?"}`);
        continue;
      }
      prepared += 1;
      buffer.push({ user_id: u, blocked_user_id: b });
      if (buffer.length >= UPSERT_BATCH_SIZE) await flush();
    }
    pendingDocs = [];
  };

  for await (const doc of iterAppwrite(APPWRITE_USER_BLOCKS_COLLECTION_ID)) {
    scanned += 1;
    pendingDocs.push(doc);
    if (pendingDocs.length >= APPWRITE_PAGE_SIZE) await processPending();
    if (LIMIT && scanned >= LIMIT) break;
  }
  await processPending();
  await flush();

  console.log(`[blocks] scanned=${scanned} prepared=${prepared} upserted=${upserted} skipped=${skippedNoMap} errors=${upsertErrors}`);
  return { scanned, prepared, upserted, skippedNoMap, upsertErrors };
}

// ── Hides backfill ───────────────────────────────────────────────────────
// Two-pass per page:
//   1. Resolve userId hexes → Supabase user UUIDs (via profiles.legacy_appwrite_id)
//   2. Resolve contentId hexes → Supabase post UUIDs (via posts.legacy_appwrite_id)
// Both caches persist for the lifetime of the run.
async function backfillHides() {
  console.log("[backfill] hides: starting");
  let scanned = 0, prepared = 0, skippedNoMap = 0, skippedNonPost = 0;
  let upserted = 0, upsertErrors = 0;
  let buffer = [];
  let pendingDocs = [];

  const flush = async () => {
    if (buffer.length === 0) return;
    if (DRY_RUN) { upserted += buffer.length; buffer = []; return; }
    const { error } = await sb
      .from("post_hides")
      .upsert(buffer, { onConflict: "user_id,post_id", ignoreDuplicates: true });
    if (error) {
      upsertErrors += 1;
      console.error(`[backfill] hides upsert failed (${buffer.length}): ${error.message}`);
    } else {
      upserted += buffer.length;
    }
    buffer = [];
  };

  const processPending = async () => {
    if (pendingDocs.length === 0) return;
    const userHexes = new Set();
    const postHexes = new Set();
    for (const d of pendingDocs) {
      if (d.contentType !== "post") continue;
      if (d.userId) userHexes.add(d.userId);
      if (d.contentId) postHexes.add(d.contentId);
    }
    await Promise.all([
      resolveIdsBatch([...userHexes]),
      resolvePostHexBatch([...postHexes]),
    ]);

    for (const d of pendingDocs) {
      if (d.contentType !== "post") {
        skippedNonPost += 1;
        continue;
      }
      const u = idCache.get(d.userId);
      const p = postIdCache.get(d.contentId);
      if (!u || !p) {
        skippedNoMap += 1;
        if (VERBOSE) console.log(`  skip hide ${d.$id}: user=${d.userId}→${u || "?"} post=${d.contentId}→${p || "?"}`);
        continue;
      }
      prepared += 1;
      buffer.push({ user_id: u, post_id: p });
      if (buffer.length >= UPSERT_BATCH_SIZE) await flush();
    }
    pendingDocs = [];
  };

  for await (const doc of iterAppwrite(APPWRITE_USER_HIDDEN_CONTENT_COLLECTION_ID)) {
    scanned += 1;
    pendingDocs.push(doc);
    if (pendingDocs.length >= APPWRITE_PAGE_SIZE) await processPending();
    if (LIMIT && scanned >= LIMIT) break;
  }
  await processPending();
  await flush();

  console.log(`[hides] scanned=${scanned} prepared=${prepared} upserted=${upserted} skippedNonPost=${skippedNonPost} skippedNoMap=${skippedNoMap} errors=${upsertErrors}`);
  return { scanned, prepared, upserted, skippedNoMap, skippedNonPost, upsertErrors };
}

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[backfill] starting (dryRun=${DRY_RUN}, limit=${LIMIT ?? "none"})`);
  console.log(`[backfill] supabase ${SUPABASE_URL}`);

  const blocks = await backfillBlocks();
  const hides = await backfillHides();

  console.log("");
  console.log("──────────────────────────────────────────────");
  console.log(`Mode:       ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`Blocks:     scanned=${blocks.scanned} upserted=${blocks.upserted} skipped=${blocks.skippedNoMap} errors=${blocks.upsertErrors}`);
  console.log(`Hides:      scanned=${hides.scanned} upserted=${hides.upserted} skippedNonPost=${hides.skippedNonPost} skippedNoMap=${hides.skippedNoMap} errors=${hides.upsertErrors}`);
  console.log("──────────────────────────────────────────────");

  if (blocks.skippedNoMap > 0 || hides.skippedNoMap > 0) {
    console.log("");
    console.log("⚠ Some rows had no Supabase mapping (missing legacy_appwrite_id");
    console.log("  on profiles or posts). Re-run with VERBOSE=1 to inspect.");
  }
  if (blocks.upsertErrors + hides.upsertErrors > 0) process.exit(1);
  console.log("Done.");
})().catch((e) => {
  console.error("Fatal:", e?.message || e);
  process.exit(1);
});
