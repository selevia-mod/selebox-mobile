#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/backfill-follows-delta.js
  ─────────────────────────────────────────────────────────────────────────
  One-shot reconciliation: copy every row from Appwrite's followsCollection
  into Supabase's public.follows table. Run this once before flipping
  USE_SUPABASE_FOLLOWS=true on mobile.

  Why this exists:
    The Selebox migration tool (Selebox/migrate.html) backfilled the
    Supabase follows table during the cutover window in late April. Since
    then, mobile (USE_SUPABASE_FOLLOWS=false) has continued writing new
    follows ONLY to Appwrite, and the web app has been writing ONLY to
    Supabase. The two stores have diverged.

    Without this backfill, flipping the mobile flag would silently lose
    visibility into ~5+ days of Appwrite-side follows (mobile users would
    see their "following" list missing recent rows). This script closes
    that gap by walking the entire Appwrite followsCollection and
    upserting each row into Supabase, with PK conflict skipped.

  What it does NOT do:
    - It does NOT delete Supabase rows that are missing from Appwrite.
      Those are predominantly web-only follows we want to keep. The
      tradeoff is that any unfollow done on mobile in the past few days
      where the same pair also has a web-side row will appear stale for a
      moment after the flip; vanishingly rare and self-corrects.
    - It does NOT sync Supabase → Appwrite. The Appwrite collection
      becomes deprecated once the flag flips; we don't need it kept fresh.

  ID resolution:
    The Appwrite collection stores Appwrite hex IDs (24-char). The Supabase
    follows table stores UUIDs that match profiles.id. We resolve via
    profiles.legacy_appwrite_id, batched per page to avoid N+1 lookups.
    Rows where either side fails to resolve (deleted users, profile rows
    that never got legacy_appwrite_id populated) are skipped and counted
    in `skippedNoMap`.

  Usage:
    APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
    APPWRITE_PROJECT_ID=66b8be7400121b5d4697 \
    APPWRITE_API_KEY=your-server-api-key-with-databases-read \
    APPWRITE_DATABASE_ID=66b32b3600246bc34956 \
    APPWRITE_FOLLOWS_COLLECTION_ID=68402c7500218b490ac2 \
    SUPABASE_URL=https://your-project.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
    node scripts/backfill-follows-delta.js

    Optional flags:
      DRY_RUN=1     Walk Appwrite + resolve mappings, but skip the upsert.
                    Logs what WOULD have been written. Safe trial run.
      LIMIT=500     Only process the first N Appwrite rows (smoke test).
      VERBOSE=1     Print every skipped row with its hex IDs so you can
                    inspect why it didn't resolve.

  Idempotency:
    The upsert uses ignoreDuplicates: true on the (follower_id, following_id)
    primary key, so already-present rows are no-ops. Safe to re-run.

  After running:
    Compare counts:
      select count(*) from public.follows;            -- Supabase total
      // and (in Appwrite Console) followsCollection total

    They should be approximately equal. Small delta is expected because:
      1. Web-only follows live ONLY in Supabase (Supabase count > Appwrite).
      2. Rows with unresolvable user IDs are skipped (Supabase < Appwrite by
         the skippedNoMap count).

  Security:
    Requires the Supabase service-role key (RLS on public.follows blocks
    inserts where auth.uid() != follower_id, which is the right policy for
    runtime but blocks admin backfills). Treat the service-role key like a
    root credential.
*/

const { Client, Databases, Query } = require("node-appwrite");
const { createClient } = require("@supabase/supabase-js");

// ── Config ───────────────────────────────────────────────────────────────
const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const APPWRITE_FOLLOWS_COLLECTION_ID = process.env.APPWRITE_FOLLOWS_COLLECTION_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const VERBOSE = process.env.VERBOSE === "1";

const required = {
  APPWRITE_PROJECT_ID,
  APPWRITE_API_KEY,
  APPWRITE_DATABASE_ID,
  APPWRITE_FOLLOWS_COLLECTION_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
};
for (const [name, value] of Object.entries(required)) {
  if (!value) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
}

// Appwrite list pages max out at 100. We resolve IDs in 100-row batches
// and flush Supabase upserts in 500-row batches (PostgREST default
// payload limit is generous, 500 is comfortable).
const APPWRITE_PAGE_SIZE = 100;
const UPSERT_BATCH_SIZE = 500;

// ── Clients ──────────────────────────────────────────────────────────────
const appwrite = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const awDb = new Databases(appwrite);

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── ID-resolution cache ──────────────────────────────────────────────────
// Maps Appwrite hex → Supabase UUID (or null if no profile mapping found).
// Populated via batched profiles.legacy_appwrite_id lookups; persists for
// the lifetime of the run so the same hex isn't re-queried.
const idCache = new Map();

// Batch-resolve a list of Appwrite hex IDs against profiles.legacy_appwrite_id.
// Anything not in cache gets fetched in chunks of 1000 (safe IN-clause size).
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
    for (const hex of slice) {
      idCache.set(hex, found.get(hex) || null);
    }
  }
};

// ── Stats ────────────────────────────────────────────────────────────────
let scanned = 0; // Appwrite rows iterated
let prepared = 0; // Mapped rows ready to upsert
let skippedNoMap = 0; // Either side failed to resolve
let upserted = 0; // Rows handed to Supabase (some may already exist)
let upsertErrors = 0; // Batches that hit a Supabase error

// ── Page through Appwrite ────────────────────────────────────────────────
async function* iterAppwriteFollows() {
  let cursor = null;
  while (true) {
    const queries = [Query.limit(APPWRITE_PAGE_SIZE), Query.orderAsc("$id")];
    if (cursor) queries.push(Query.cursorAfter(cursor));

    let response;
    try {
      response = await awDb.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_FOLLOWS_COLLECTION_ID, queries);
    } catch (error) {
      console.error("listDocuments failed:", error?.message || error);
      console.error("Check that your API key has `databases.read` scope on the follows collection.");
      process.exit(1);
    }

    const docs = response?.documents || [];
    if (docs.length === 0) break;
    for (const doc of docs) yield doc;

    cursor = docs[docs.length - 1].$id;
    if (docs.length < APPWRITE_PAGE_SIZE) break;
  }
}

// ── Flush a batch of mapped rows to Supabase ─────────────────────────────
const flush = async (buffer) => {
  if (buffer.length === 0) return;
  if (DRY_RUN) {
    upserted += buffer.length;
    return;
  }
  const { error } = await sb.from("follows").upsert(buffer, {
    onConflict: "follower_id,following_id",
    ignoreDuplicates: true,
  });
  if (error) {
    upsertErrors += 1;
    console.error(`upsert batch failed (${buffer.length} rows): ${error.message}`);
    // Continue — one bad batch shouldn't abort the whole run.
  } else {
    upserted += buffer.length;
  }
};

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[backfill] starting (dryRun=${DRY_RUN}, limit=${LIMIT ?? "none"})`);
  console.log(`[backfill] appwrite ${APPWRITE_ENDPOINT} db=${APPWRITE_DATABASE_ID} coll=${APPWRITE_FOLLOWS_COLLECTION_ID}`);
  console.log(`[backfill] supabase ${SUPABASE_URL}`);

  const buffer = [];
  let pageDocs = [];

  const processPage = async () => {
    if (pageDocs.length === 0) return;

    const hexIds = new Set();
    for (const d of pageDocs) {
      if (d.followerId) hexIds.add(d.followerId);
      if (d.followingId) hexIds.add(d.followingId);
    }
    await resolveIdsBatch([...hexIds]);

    for (const d of pageDocs) {
      const followerUuid = d.followerId ? idCache.get(d.followerId) : null;
      const followingUuid = d.followingId ? idCache.get(d.followingId) : null;

      if (!followerUuid || !followingUuid) {
        skippedNoMap += 1;
        if (VERBOSE) {
          console.log(`  skip ${d.$id}: ${d.followerId} -> ${followerUuid || "?"} | ${d.followingId} -> ${followingUuid || "?"}`);
        }
        continue;
      }

      // Self-follow guard. The runtime FollowService throws on these too.
      if (followerUuid === followingUuid) {
        skippedNoMap += 1;
        continue;
      }

      prepared += 1;
      buffer.push({
        follower_id: followerUuid,
        following_id: followingUuid,
        // Preserve the Appwrite-side timestamp on insert. With
        // ignoreDuplicates, conflicts skip and existing rows keep their
        // existing created_at — so this only takes effect on net-new
        // rows, which is exactly what we want.
        created_at: d.$createdAt,
      });

      if (buffer.length >= UPSERT_BATCH_SIZE) {
        await flush(buffer);
        buffer.length = 0;
      }
    }

    pageDocs = [];
  };

  for await (const doc of iterAppwriteFollows()) {
    scanned += 1;
    pageDocs.push(doc);

    if (pageDocs.length >= APPWRITE_PAGE_SIZE) {
      await processPage();
      if (scanned % 5000 === 0) {
        process.stdout.write(
          `  scanned=${scanned} prepared=${prepared} upserted=${upserted} skipped=${skippedNoMap} errors=${upsertErrors}\r`,
        );
      }
    }

    if (LIMIT && scanned >= LIMIT) break;
  }

  // Drain.
  await processPage();
  await flush(buffer);

  console.log("");
  console.log("──────────────────────────────────────────────");
  console.log(`Mode:           ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`Appwrite rows:  ${scanned}`);
  console.log(`Prepared:       ${prepared}`);
  console.log(`Upserted:       ${upserted}  (includes already-present rows; PK conflict skipped)`);
  console.log(`Skipped:        ${skippedNoMap}  (no profile mapping or self-follow)`);
  console.log(`Upsert errors:  ${upsertErrors}`);
  console.log("──────────────────────────────────────────────");

  if (skippedNoMap > 0) {
    console.log("");
    console.log("⚠ Some rows had no Supabase mapping. Most likely deleted users or");
    console.log("  pre-migration accounts that never got profiles.legacy_appwrite_id");
    console.log("  populated. Re-run with VERBOSE=1 to see the offenders.");
  }

  if (upsertErrors > 0) {
    console.log("");
    console.log("⚠ Some batches failed to upsert. Re-run is safe (idempotent).");
    process.exit(1);
  }

  console.log("Done.");
})().catch((error) => {
  console.error("Fatal:", error?.message || error);
  process.exit(1);
});
