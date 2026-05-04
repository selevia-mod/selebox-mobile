#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/backfill-earnings.js
  ─────────────────────────────────────────────────────────────────────────
  CRITICAL: this script restores money owed to creators. Pre-cutover
  earnings live in Appwrite's `userEarnings` collection and were never
  copied into Supabase during the videos / books / posts migrations.
  Without this script, every author sees ₱0.00 on their Payments page,
  and the Withdraw button has nothing to draw against — even though
  they earned real money before the migration.

  What this does:
    1. Pages through Appwrite userEarnings (collection id from secrets)
    2. For each earning doc:
       - Resolves contentOwner (Appwrite hex) → Supabase author_id (uuid)
         via profiles.legacy_appwrite_id
       - Resolves earningFromUser (Appwrite hex) → Supabase source_user_id
         (uuid) — same lookup, different field; nullable if unresolvable
       - Maps contentType ('post' / 'clip' / 'video' / 'book') →
         source_type
       - Maps earningType ('coin' / 'star') → currency_used (with a
         conservative default of 'coin' for older docs that didn't
         distinguish)
       - Computes net_php_minor from earningAmountToPhp (which Appwrite
         stored in pesos as a float, e.g. 12.50) → 1250 centavos
       - Inserts into public.author_earnings with status='available'
         and available_at=$createdAt-as-timestamp
    3. Uses ON CONFLICT (legacy_appwrite_id) DO NOTHING for idempotency

  Prerequisites:
    1. Deploy migration_author_earnings_legacy_appwrite_id.sql FIRST.
       Without it, the unique constraint doesn't exist and re-runs would
       create duplicates. Script will detect missing column and abort.
    2. Set SUPABASE_SERVICE_ROLE_KEY (RLS otherwise blocks inserts).
    3. Set the APPWRITE_USER_EARNINGS_COLLECTION_ID env var
       (= "68d2c7350025b497965a", per private/secrets.js).

  Usage:
    APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
    APPWRITE_PROJECT_ID=66b8be7400121b5d4697 \
    APPWRITE_API_KEY=server-key-with-databases-read \
    APPWRITE_DATABASE_ID=66b32b3600246bc34956 \
    APPWRITE_USER_EARNINGS_COLLECTION_ID=68d2c7350025b497965a \
    SUPABASE_URL=https://zplisqwoejxrdrpbfass.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
    node scripts/backfill-earnings.js

    Optional:
      DRY_RUN=1            Walk + resolve, no writes. Recommended FIRST.
      LIMIT=200            First N earning docs only (smoke).
      VERBOSE=1            Log every skipped row.
      SHARE_PCT=100        Override the share split (default 100 = author
                           keeps 100% of the unlock cost — matches
                           current credit_author_earnings logic).
      COIN_RATE_MINOR=20   coin → centavos rate (default 20, i.e. 1
                           coin = ₱0.20). Used only when computing
                           gross/net_coins for display.
      STAR_RATE_MINOR=5    star → centavos rate (default 5).
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
const APPWRITE_USER_EARNINGS_COLLECTION_ID = env("APPWRITE_USER_EARNINGS_COLLECTION_ID");
const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const VERBOSE = process.env.VERBOSE === "1";
const SHARE_PCT = Number(process.env.SHARE_PCT || 100);
const COIN_RATE_MINOR = Number(process.env.COIN_RATE_MINOR || 20);
const STAR_RATE_MINOR = Number(process.env.STAR_RATE_MINOR || 5);

const PAGE_SIZE = 100;
const RESOLVE_BATCH_SIZE = 500;
const INSERT_BATCH_SIZE = 200;

const aw = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const awDb = new Databases(aw);
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Cache of profiles.legacy_appwrite_id → profiles.id (uuid). Caches
// negative lookups too (set to null) to avoid re-querying for users that
// don't exist in Supabase (deleted accounts etc.).
const profileCache = new Map();

async function resolveProfileBatch(hexIds) {
  const unresolved = hexIds.filter((h) => h && !profileCache.has(h));
  if (unresolved.length === 0) return;
  for (let i = 0; i < unresolved.length; i += RESOLVE_BATCH_SIZE) {
    const slice = unresolved.slice(i, i + RESOLVE_BATCH_SIZE);
    const { data, error } = await sb
      .from("profiles")
      .select("id, legacy_appwrite_id")
      .in("legacy_appwrite_id", slice);
    if (error) throw new Error(`profiles lookup failed: ${error.message}`);
    const found = new Set();
    (data || []).forEach((row) => {
      if (row.legacy_appwrite_id) {
        profileCache.set(row.legacy_appwrite_id, row.id);
        found.add(row.legacy_appwrite_id);
      }
    });
    slice.forEach((id) => {
      if (!found.has(id)) profileCache.set(id, null);
    });
  }
}

// Map Appwrite contentType → Supabase source_type. The DB CHECK
// constraint (after migration_author_earnings_source_type_extend.sql)
// allows: chapter, video, book_bulk, post, clip. Appwrite's `book`
// value represents a whole-book bulk unlock — Supabase calls that
// `book_bulk`, so translate. Unknown types collapse to null so the
// caller can skip the row rather than triggering a constraint
// violation downstream.
const mapContentType = (raw) => {
  const t = String(raw || "").trim().toLowerCase();
  if (t === "chapter") return "chapter";
  if (t === "video") return "video";
  if (t === "book") return "book_bulk";
  if (t === "book_bulk") return "book_bulk";
  if (t === "post") return "post";
  if (t === "clip" || t === "clips") return "clip";
  return null;
};

// Map Appwrite earningType → Supabase currency_used. Older docs may
// not have this field; default to 'coin' since that was the original
// monetization currency. We still try star/stars in case.
const mapCurrency = (raw) => {
  const t = String(raw || "").trim().toLowerCase();
  if (t === "star" || t === "stars") return "star";
  if (t === "coin" || t === "coins") return "coin";
  return "coin";
};

// Convert pesos-as-float (e.g. 12.50) to centavos integer (1250).
// Defensive: rounds and floors negatives.
const pesosToCentavos = (pesos) => {
  const n = Number(pesos);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
};

async function ensureSchemaReady() {
  // Probe: try selecting legacy_appwrite_id. If the column doesn't
  // exist, abort with a clear message rather than silently inserting
  // dupes on re-run.
  const { error } = await sb.from("author_earnings").select("legacy_appwrite_id").limit(1);
  if (error && /legacy_appwrite_id/.test(error.message)) {
    console.error("──────────────────────────────────────────────");
    console.error("FATAL: public.author_earnings.legacy_appwrite_id is missing.");
    console.error("Deploy migration_author_earnings_legacy_appwrite_id.sql first, then re-run.");
    console.error("──────────────────────────────────────────────");
    process.exit(1);
  }
  if (error) {
    console.error(`Schema probe failed: ${error.message}`);
    process.exit(1);
  }
}

async function main() {
  console.log(`[backfill-earnings] dryRun=${DRY_RUN} limit=${LIMIT ?? "none"} verbose=${VERBOSE}`);
  console.log(`[backfill-earnings] sharePct=${SHARE_PCT} coinRate=${COIN_RATE_MINOR} starRate=${STAR_RATE_MINOR}`);
  console.log(`[backfill-earnings] appwrite ${APPWRITE_ENDPOINT}`);
  console.log(`[backfill-earnings] supabase ${SUPABASE_URL}`);

  await ensureSchemaReady();

  let scanned = 0;
  let prepared = 0;
  let inserted = 0;
  let skippedNoOwner = 0;
  let skippedNoAmount = 0;
  let errors = 0;
  let cursor = null;

  let limitReached = false;
  while (true) {
    const queries = [Query.limit(PAGE_SIZE), Query.orderAsc("$id")];
    if (cursor) queries.push(Query.cursorAfter(cursor));

    let res;
    try {
      res = await awDb.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_USER_EARNINGS_COLLECTION_ID, queries);
    } catch (err) {
      console.error("[backfill-earnings] Appwrite listDocuments failed:", err.message);
      errors++;
      break;
    }

    const docs = res?.documents || [];
    if (docs.length === 0) break;

    // Pre-resolve every author_id + source_user_id on this page in one
    // round-trip (or two — they may overlap, that's fine).
    const hexIds = new Set();
    for (const d of docs) {
      if (d.contentOwner) hexIds.add(d.contentOwner);
      if (d.earningFromUser) hexIds.add(d.earningFromUser);
    }
    await resolveProfileBatch(Array.from(hexIds));

    // Build the insert batch. Note: when LIMIT is hit mid-page we
    // capture the flag and break AFTER the flush below — earlier
    // versions used `break pageLoop` here, which jumped past the flush
    // entirely. That dropped the last batch on partial-page runs.
    const rows = [];
    for (const doc of docs) {
      scanned++;
      if (LIMIT && scanned > LIMIT) { limitReached = true; break; }

      const contentOwnerHex = doc.contentOwner;
      const fromUserHex = doc.earningFromUser;
      const authorUuid = profileCache.get(contentOwnerHex);
      if (!authorUuid) {
        if (VERBOSE) console.log(`  skip ${doc.$id}: contentOwner ${contentOwnerHex} not in profiles`);
        skippedNoOwner++;
        continue;
      }
      const sourceUserUuid = fromUserHex ? profileCache.get(fromUserHex) || null : null;

      const sourceType = mapContentType(doc.contentType);
      if (!sourceType) {
        if (VERBOSE) console.log(`  skip ${doc.$id}: unsupported contentType=${doc.contentType}`);
        skippedNoAmount++;
        continue;
      }

      const currencyUsed = mapCurrency(doc.earningType);
      const netPhpMinor = pesosToCentavos(doc.earningAmountToPhp);

      if (netPhpMinor <= 0) {
        if (VERBOSE) console.log(`  skip ${doc.$id}: earningAmountToPhp=${doc.earningAmountToPhp}`);
        skippedNoAmount++;
        continue;
      }

      // gross_coins CHECK constraint requires > 0. Use earningAmount
      // when present (the unit count of coins or stars the user
      // actually paid); fall back to deriving from netPhpMinor and
      // the currency rate so the row is still acceptable. Final
      // floor of 1 guarantees the > 0 invariant for ancient docs
      // that lack both fields.
      const earningAmount = Number(doc.earningAmount) || 0;
      const coinToPhpMinor = currencyUsed === "star" ? STAR_RATE_MINOR : COIN_RATE_MINOR;
      const derivedFromPhp = coinToPhpMinor > 0 ? Math.ceil(netPhpMinor / coinToPhpMinor) : 0;
      const grossCoins = Math.max(1, earningAmount, derivedFromPhp);
      const netCoins = grossCoins;

      const availableAt = doc.$createdAt ? new Date(doc.$createdAt).toISOString() : new Date().toISOString();

      rows.push({
        author_id: authorUuid,
        source_user_id: sourceUserUuid,
        source_type: sourceType,
        source_id: doc.contentId || doc.$id,
        gross_coins: grossCoins,
        share_pct: SHARE_PCT,
        net_coins: netCoins,
        coin_to_php_minor: coinToPhpMinor,
        net_php_minor: netPhpMinor,
        currency_used: currencyUsed,
        status: "available",
        available_at: availableAt,
        legacy_appwrite_id: doc.$id,
      });
      prepared++;
    }

    // Flush the batch.
    if (rows.length > 0 && !DRY_RUN) {
      for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
        const slice = rows.slice(i, i + INSERT_BATCH_SIZE);
        const { error } = await sb
          .from("author_earnings")
          .upsert(slice, { onConflict: "legacy_appwrite_id", ignoreDuplicates: true });
        if (error) {
          console.error(`  insert batch failed: ${error.message}`);
          errors += slice.length;
        } else {
          inserted += slice.length;
        }
      }
    } else if (rows.length > 0 && DRY_RUN) {
      inserted += rows.length;
    }

    cursor = docs[docs.length - 1]?.$id || null;

    process.stdout.write(
      `  page done — scanned=${scanned} prepared=${prepared} inserted=${inserted} skippedNoOwner=${skippedNoOwner} skippedNoAmount=${skippedNoAmount} errors=${errors}\r`,
    );

    if (limitReached || !cursor) break;
  }

  console.log("");
  console.log("──────────────────────────────────────────────");
  console.log(`[backfill-earnings] DONE`);
  console.log(`  scanned:            ${scanned}`);
  console.log(`  prepared:           ${prepared}`);
  console.log(`  inserted:           ${inserted}${DRY_RUN ? " (dry-run)" : ""}`);
  console.log(`  skipped (no owner): ${skippedNoOwner}`);
  console.log(`  skipped (no amt):   ${skippedNoAmount}`);
  console.log(`  errors:             ${errors}`);
  console.log("──────────────────────────────────────────────");
  console.log("");
  console.log("Verify in Supabase SQL Editor:");
  console.log("  select count(distinct author_id) as authors_with_earnings,");
  console.log("         count(*) as total_rows,");
  console.log("         sum(net_php_minor)/100.0 as total_pesos");
  console.log("  from public.author_earnings;");
  console.log("");
}

main().catch((err) => {
  console.error("[backfill-earnings] fatal:", err);
  process.exit(1);
});
