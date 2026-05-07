#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/backfill-withdrawals.js
  ─────────────────────────────────────────────────────────────────────────
  CRITICAL: this script restores withdrawal history. Pre-cutover withdrawals
  live in Appwrite's `users-withdrawals` collection (id 68d65111000d1eec1349)
  and were never copied into Supabase. Without this script, every author
  sees an inflated "Remaining Balance" because withdrawn amounts aren't
  subtracted from earnings, and the Withdrawal Status section shows blank.

  What this does:
    1. Pages through Appwrite users-withdrawals (collection from secrets)
    2. For each withdrawal doc:
       - Resolves userId (Appwrite hex) → Supabase author_id (uuid)
         via profiles.legacy_appwrite_id
       - Converts `amount` (pesos as float, e.g. 234.00) → amount_php_minor
         (centavos, 23400)
       - Maps status to Supabase enum (pending/approved/paid/rejected)
       - Maps timestamps:
           $createdAt → requested_at
           $updatedAt + status='approved' → approved_at
           $updatedAt + status='paid' → paid_at
       - Inserts into public.author_withdrawals
    3. Uses ON CONFLICT (legacy_appwrite_id) DO NOTHING for idempotency

  Prerequisites:
    1. Add legacy_appwrite_id column to author_withdrawals first:
         ALTER TABLE public.author_withdrawals
           ADD COLUMN IF NOT EXISTS legacy_appwrite_id text UNIQUE;
       Without it, re-runs would create duplicates.
    2. Set SUPABASE_SERVICE_ROLE_KEY (RLS otherwise blocks inserts).
    3. Set the APPWRITE_USERS_WITHDRAWALS_COLLECTION_ID env var
       (= "68d65111000d1eec1349", per private/secrets.js).

  Usage:
    APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
    APPWRITE_PROJECT_ID=66b8be7400121b5d4697 \
    APPWRITE_API_KEY=server-key-with-databases-read \
    APPWRITE_DATABASE_ID=66b32b3600246bc34956 \
    APPWRITE_USERS_WITHDRAWALS_COLLECTION_ID=68d65111000d1eec1349 \
    SUPABASE_URL=https://zplisqwoejxrdrpbfass.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
    node scripts/backfill-withdrawals.js

    Optional:
      DRY_RUN=1            Walk + resolve, no writes. Recommended FIRST.
      LIMIT=200            First N withdrawal docs only (smoke).
      VERBOSE=1            Log every skipped row.
      USER_EMAIL=foo@bar.com    Only backfill withdrawals for one user
                                (useful for verifying a single tester).
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
const APPWRITE_USERS_WITHDRAWALS_COLLECTION_ID = env("APPWRITE_USERS_WITHDRAWALS_COLLECTION_ID");
const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const VERBOSE = process.env.VERBOSE === "1";
const USER_EMAIL = process.env.USER_EMAIL || null;

const PAGE_SIZE = 100;
const RESOLVE_BATCH_SIZE = 500;
const INSERT_BATCH_SIZE = 200;

const aw = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const awDb = new Databases(aw);
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const profileCache = new Map();

async function resolveProfileBatch(hexIds) {
  const unresolved = hexIds.filter((h) => h && !profileCache.has(h));
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

const pesosToCentavos = (pesos) => {
  const n = Number(pesos);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
};

const mapStatus = (raw) => {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "approved") return "approved";
  if (s === "paid" || s === "completed") return "paid";
  if (s === "rejected" || s === "denied" || s === "cancelled") return "rejected";
  return "pending"; // default
};

async function ensureSchemaReady() {
  const { error } = await sb.from("author_withdrawals").select("legacy_appwrite_id").limit(1);
  if (error && /legacy_appwrite_id/.test(error.message)) {
    console.error("──────────────────────────────────────────────");
    console.error("FATAL: public.author_withdrawals.legacy_appwrite_id is missing.");
    console.error("Run this in Supabase SQL Editor first:");
    console.error("  ALTER TABLE public.author_withdrawals");
    console.error("    ADD COLUMN IF NOT EXISTS legacy_appwrite_id text UNIQUE;");
    console.error("──────────────────────────────────────────────");
    process.exit(1);
  }
  if (error) {
    console.error(`Schema probe failed: ${error.message}`);
    process.exit(1);
  }
}

async function main() {
  console.log(`[backfill-withdrawals] dryRun=${DRY_RUN} limit=${LIMIT ?? "none"} verbose=${VERBOSE} userEmail=${USER_EMAIL ?? "all"}`);
  console.log(`[backfill-withdrawals] appwrite ${APPWRITE_ENDPOINT}`);
  console.log(`[backfill-withdrawals] supabase ${SUPABASE_URL}`);

  await ensureSchemaReady();

  // If filtering by single user email, get their hex first
  let filterUserHex = null;
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
    filterUserHex = data.legacy_appwrite_id;
    console.log(`[backfill-withdrawals] filtering for ${data.email} (${data.username}) hex=${filterUserHex}`);
  }

  let scanned = 0;
  let prepared = 0;
  let inserted = 0;
  let skippedNoUser = 0;
  let skippedNoAmount = 0;
  let skippedFiltered = 0;
  let errors = 0;
  let cursor = null;
  let limitReached = false;

  while (true) {
    const queries = [Query.limit(PAGE_SIZE), Query.orderAsc("$id")];
    if (cursor) queries.push(Query.cursorAfter(cursor));

    let res;
    try {
      res = await awDb.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_USERS_WITHDRAWALS_COLLECTION_ID, queries);
    } catch (err) {
      console.error(`Appwrite listDocuments failed: ${err.message}`);
      errors++;
      break;
    }
    if (!res.documents || res.documents.length === 0) break;

    scanned += res.documents.length;

    // Resolve all profiles in this page
    const userHexes = [...new Set(res.documents.map((d) => d.userId).filter(Boolean))];
    await resolveProfileBatch(userHexes);

    const rowsToInsert = [];
    for (const doc of res.documents) {
      if (LIMIT && prepared >= LIMIT) {
        limitReached = true;
        break;
      }
      // Filter by single user if requested
      if (filterUserHex && doc.userId !== filterUserHex) {
        skippedFiltered++;
        continue;
      }
      const profile = profileCache.get(doc.userId);
      if (!profile) {
        skippedNoUser++;
        if (VERBOSE) console.log(`  skip: no profile for userId ${doc.userId} (withdrawal $id ${doc.$id})`);
        continue;
      }
      const amountPhpMinor = pesosToCentavos(doc.amount);
      if (amountPhpMinor <= 0) {
        skippedNoAmount++;
        if (VERBOSE) console.log(`  skip: zero/invalid amount ${doc.amount} (withdrawal $id ${doc.$id})`);
        continue;
      }
      const status = mapStatus(doc.status);
      const requestedAt = doc.$createdAt;
      const updatedAt = doc.$updatedAt;

      // Compute net + fee from Appwrite fields:
      //   amount = gross requested
      //   amountToReceive = what user actually got (after platform fee)
      //   fee = amount - amountToReceive
      const netPhpMinor = pesosToCentavos(doc.amountToReceive ?? doc.amount);
      const feePhpMinor = Math.max(0, amountPhpMinor - netPhpMinor);

      // payout_method check constraint accepts: gcash | maya | bank | gotyme
      // Legacy Appwrite docs don't store the method on the withdrawal itself
      // (it's in users-payment-information). Default to 'gcash' for backfill;
      // the actual payment was already made, this is just historical record.
      const validMethods = ["gcash", "maya", "bank", "gotyme"];
      const rawMethod = String(doc.paymentMethod || "").toLowerCase();
      const payoutMethod = validMethods.includes(rawMethod) ? rawMethod : "gcash";

      rowsToInsert.push({
        legacy_appwrite_id: doc.$id,
        author_id: profile.id,
        amount_php_minor: amountPhpMinor,
        net_php_minor: netPhpMinor,
        fee_php_minor: feePhpMinor,
        amount_coins: 0, // legacy didn't track coins separately
        status,
        payout_method: payoutMethod,
        // payout_details is NOT NULL — populate with marker + Appwrite ref
        // so the original payment info doc can be looked up if needed.
        payout_details: {
          source: "legacy_appwrite_backfill",
          appwrite_payment_info_ref: doc.usersPaymentInformation || null,
          appwrite_amount_to_receive: doc.amountToReceive || null,
          original_method_unknown: !validMethods.includes(rawMethod),
        },
        requested_at: requestedAt,
        approved_at: status === "approved" || status === "paid" ? updatedAt : null,
        paid_at: status === "paid" ? updatedAt : null,
        rejection_reason: status === "rejected" ? (doc.rejectionReason || null) : null,
      });
      prepared++;
    }

    if (!DRY_RUN && rowsToInsert.length > 0) {
      for (let i = 0; i < rowsToInsert.length; i += INSERT_BATCH_SIZE) {
        const batch = rowsToInsert.slice(i, i + INSERT_BATCH_SIZE);
        const { error } = await sb
          .from("author_withdrawals")
          .upsert(batch, { onConflict: "legacy_appwrite_id", ignoreDuplicates: true });
        if (error) {
          console.error(`  batch insert failed (${batch.length} rows): ${error.message}`);
          errors++;
        } else {
          inserted += batch.length;
        }
      }
    }

    if (limitReached) break;

    if (res.documents.length < PAGE_SIZE) break;
    cursor = res.documents[res.documents.length - 1].$id;
    console.log(`  scanned=${scanned} prepared=${prepared} inserted=${inserted} skippedNoUser=${skippedNoUser} skippedNoAmount=${skippedNoAmount}`);
  }

  console.log("──────────────────────────────────────────────");
  console.log(`[backfill-withdrawals] DONE`);
  console.log(`  scanned:           ${scanned}`);
  console.log(`  prepared:          ${prepared}`);
  console.log(`  inserted:          ${inserted}${DRY_RUN ? "  (DRY RUN — nothing actually written)" : ""}`);
  console.log(`  skipped no user:   ${skippedNoUser}`);
  console.log(`  skipped no amount: ${skippedNoAmount}`);
  if (filterUserHex) console.log(`  skipped filtered:  ${skippedFiltered}`);
  console.log(`  errors:            ${errors}`);
  console.log("──────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
