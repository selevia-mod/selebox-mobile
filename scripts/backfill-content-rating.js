#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/backfill-content-rating.js
  ─────────────────────────────────────────────────────────────────────────
  One-shot reconciliation: copy `contentRating` values from the original
  Appwrite books collection into the new `content_rating` column on
  Supabase `public.books`.

  Why this exists:
    The Supabase migration didn't preserve content_rating — every book was
    defaulted to 'Rated PG' regardless of its original Appwrite value.
    Authors who had marked their book "Rated 18" lost that flag and would
    otherwise have to manually re-toggle the Mature Content switch.

    This script reads each Appwrite book's contentRating field, finds the
    matching Supabase row by legacy_appwrite_id, and writes back the
    correct rating. After this runs, books that were Rated 18 in Appwrite
    are Rated 18 in Supabase too.

  Prereq: ALTER TABLE public.books ADD COLUMN content_rating TEXT NOT NULL
  DEFAULT 'Rated PG'  must already have run.

  Usage:
    APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
    APPWRITE_PROJECT_ID=66b8be7400121b5d4697 \
    APPWRITE_API_KEY=server-key-with-databases-read \
    APPWRITE_DATABASE_ID=66b32b3600246bc34956 \
    APPWRITE_BOOKS_COLLECTION_ID=... \
    SUPABASE_URL=https://your-project.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
    node scripts/backfill-content-rating.js

    Optional:
      DRY_RUN=1   Walk + resolve only, no writes.
      LIMIT=500   Only process first N books (smoke test).
      VERBOSE=1   Log every row including skips.

  Idempotency:
    Updates `content_rating` directly via legacy_appwrite_id match. Safe
    to re-run — re-running just re-applies the same value.

  Security:
    Requires SUPABASE_SERVICE_ROLE_KEY — bypasses RLS for the bulk update.
    Treat the key like a root credential.
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

const APPWRITE_ENDPOINT      = env("APPWRITE_ENDPOINT", "https://fra.cloud.appwrite.io/v1");
const APPWRITE_PROJECT_ID    = env("APPWRITE_PROJECT_ID");
const APPWRITE_API_KEY       = env("APPWRITE_API_KEY");
const APPWRITE_DATABASE_ID   = env("APPWRITE_DATABASE_ID");
const APPWRITE_BOOKS_COLL_ID = env("APPWRITE_BOOKS_COLLECTION_ID");
const SUPABASE_URL           = env("SUPABASE_URL");
const SUPABASE_KEY           = env("SUPABASE_SERVICE_ROLE_KEY");

const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT   = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const VERBOSE = process.env.VERBOSE === "1";

const APPWRITE_PAGE_SIZE = 100;

const appwrite = new Client()
  .setEndpoint(APPWRITE_ENDPOINT)
  .setProject(APPWRITE_PROJECT_ID)
  .setKey(APPWRITE_API_KEY);
const awDb = new Databases(appwrite);

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  console.log("──────────────────────────────────────────────────────────");
  console.log(" backfill-content-rating");
  console.log("──────────────────────────────────────────────────────────");
  console.log(`  DRY_RUN:    ${DRY_RUN}`);
  console.log(`  LIMIT:      ${LIMIT ?? "none"}`);
  console.log(`  Appwrite:   ${APPWRITE_ENDPOINT} (project ${APPWRITE_PROJECT_ID})`);
  console.log(`  Supabase:   ${SUPABASE_URL}`);
  console.log("──────────────────────────────────────────────────────────\n");

  let offset = 0;
  let totalSeen = 0;
  let totalRated18 = 0;
  let totalRatedPG = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  while (true) {
    const queries = [
      Query.limit(APPWRITE_PAGE_SIZE),
      Query.offset(offset),
    ];

    let page;
    try {
      page = await awDb.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_BOOKS_COLL_ID, queries);
    } catch (err) {
      console.error(`Appwrite list failed at offset ${offset}:`, err.message);
      break;
    }

    if (!page.documents.length) break;

    for (const book of page.documents) {
      totalSeen++;
      const rating = book.contentRating;

      if (rating === "Rated 18") {
        totalRated18++;
      } else if (rating === "Rated PG" || !rating) {
        totalRatedPG++;
      }

      // Only update rows where the Appwrite source had a NON-DEFAULT value.
      // Books that were already "Rated PG" in Appwrite don't need a write
      // because Supabase defaulted them to "Rated PG" already — saves a
      // pile of unnecessary writes.
      if (rating !== "Rated 18") {
        if (VERBOSE) console.log(`  skip ${book.$id} (rating=${rating || "null"})`);
        totalSkipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [dry] would set Rated 18 → ${book.$id} (${book.title || "(no title)"})`);
        totalUpdated++;
        continue;
      }

      const { error } = await sb
        .from("books")
        .update({ content_rating: "Rated 18" })
        .eq("legacy_appwrite_id", book.$id);

      if (error) {
        console.error(`  err ${book.$id}: ${error.message}`);
        totalErrors++;
      } else {
        totalUpdated++;
        if (VERBOSE) console.log(`  ok  ${book.$id} (${book.title || "(no title)"}) → Rated 18`);
      }
    }

    offset += page.documents.length;
    if (LIMIT && totalSeen >= LIMIT) break;

    // Tiny breather so we don't hammer Appwrite from a sustained loop
    await new Promise(r => setTimeout(r, 30));
  }

  console.log("\n──────────────────────────────────────────────────────────");
  console.log(" Done");
  console.log("──────────────────────────────────────────────────────────");
  console.log(`  Books seen:           ${totalSeen}`);
  console.log(`  Originally Rated 18:  ${totalRated18}`);
  console.log(`  Originally Rated PG:  ${totalRatedPG}`);
  console.log(`  Updated to Rated 18:  ${totalUpdated}`);
  console.log(`  Skipped (PG/null):    ${totalSkipped}`);
  console.log(`  Errors:               ${totalErrors}`);
  console.log("──────────────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
