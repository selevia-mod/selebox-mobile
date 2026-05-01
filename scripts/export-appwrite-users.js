#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/export-appwrite-users.js
  ────────────────────────────────────────────────────────────────────
  One-time dump of Appwrite Cloud users (with password hashes) into a
  flat JSON array that scripts/migrate-auth-users.js can consume.

  Why this exists:
    Appwrite Cloud doesn't expose password hashes via the dashboard UI.
    But the Server SDK's users.list() endpoint DOES include the
    `password` and `hash` fields when called with an API key that has
    `users.read` scope. We page through everything and write a flat
    JSON file in the shape the migration script expects.

  Usage:
    APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1 \
    APPWRITE_PROJECT_ID=your-project-id \
    APPWRITE_API_KEY=your-server-api-key-with-users-read \
    node scripts/export-appwrite-users.js

    Output: appwrite-users.json (in the same directory as this script)

    Optional flags:
      LIMIT=10                Only fetch the first N users (smoke test).
      OUT_FILE=./users.json   Custom output path.
      VERBOSE=1               Print each user as it's fetched.

  Idempotency:
    Re-running overwrites the output file. Safe to re-run.

  After running:
    Verify the output file:
      jq 'length' appwrite-users.json           # total user count
      jq '.[0]' appwrite-users.json             # peek at one row
      jq '[.[] | .hashAlgorithm] | group_by(.) | map({algo: .[0], count: length})' \
        appwrite-users.json                     # algo distribution
    Then feed it to scripts/migrate-auth-users.js.

  Security:
    The output file contains password hashes. Treat it like a credential.
    Don't commit it to git, don't post it anywhere, delete it after the
    migration is complete and verified.
*/

const fs = require("fs");
const path = require("path");
const { Client, Users, Query } = require("node-appwrite");

// ── Config ─────────────────────────────────────────────────────────
const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT || "https://cloud.appwrite.io/v1";
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
const OUT_FILE = process.env.OUT_FILE || path.resolve(__dirname, "appwrite-users.json");
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const VERBOSE = process.env.VERBOSE === "1";

if (!APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
  console.error("Missing APPWRITE_PROJECT_ID or APPWRITE_API_KEY env vars.");
  process.exit(1);
}

const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);

const users = new Users(client);

// ── Pagination ────────────────────────────────────────────────────
// Appwrite's users.list maxes out at 100 per page. We use cursor-based
// pagination (cursorAfter) which is more reliable than offset for
// large lists. Stops when a page returns < PAGE_SIZE rows.
const PAGE_SIZE = 100;

(async () => {
  console.log(`Connecting to ${APPWRITE_ENDPOINT}, project ${APPWRITE_PROJECT_ID}…`);
  if (LIMIT) console.log(`LIMIT=${LIMIT} — fetching only the first ${LIMIT} users`);

  const collected = [];
  let cursor = null;

  while (true) {
    const queries = [Query.limit(PAGE_SIZE), Query.orderAsc("$id")];
    if (cursor) queries.push(Query.cursorAfter(cursor));

    let response;
    try {
      response = await users.list(queries);
    } catch (error) {
      console.error("users.list failed:", error?.message || error);
      console.error("Check that your API key has `users.read` scope and isn't expired.");
      process.exit(1);
    }

    const page = response?.users || [];
    if (page.length === 0) break;

    for (const u of page) {
      // Normalize the shape so migrate-auth-users.js can consume it
      // without any further mapping. Appwrite's User SDK returns the
      // hash in `password` and the algo in `hash` (yes, the field is
      // literally named `hash`, which is unfortunate but documented).
      collected.push({
        $id: u.$id,
        email: u.email,
        password: u.password || null, // bcrypt/argon2/scrypt/... hash
        hashAlgorithm: u.hash || null, // bcrypt | argon2 | scrypt | ...
        $createdAt: u.$createdAt,
        $updatedAt: u.$updatedAt,
        name: u.name,
        emailVerification: u.emailVerification,
      });

      if (VERBOSE) console.log(`  ${u.email} (${u.hash || "no-hash"})`);

      if (LIMIT && collected.length >= LIMIT) break;
    }

    if (LIMIT && collected.length >= LIMIT) break;
    if (page.length < PAGE_SIZE) break;
    cursor = page[page.length - 1].$id;

    process.stdout.write(`  Fetched ${collected.length}…\r`);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(collected, null, 2));

  console.log("");
  console.log("──────────────────────────────────────────────");
  console.log(`Total users:    ${collected.length}`);
  console.log(`Output:         ${OUT_FILE}`);
  console.log("──────────────────────────────────────────────");

  // Quick stats — algo distribution + missing-hash count
  const algoCounts = {};
  let missingHash = 0;
  for (const u of collected) {
    const algo = u.hashAlgorithm || "(none)";
    algoCounts[algo] = (algoCounts[algo] || 0) + 1;
    if (!u.password) missingHash += 1;
  }
  console.log("Algorithm distribution:");
  for (const [algo, count] of Object.entries(algoCounts)) {
    console.log(`  ${algo.padEnd(20)} ${count}`);
  }
  console.log(`Users with no hash (OAuth-only, will need OAuth path): ${missingHash}`);
  console.log("");
  console.log("⚠ This file contains password hashes. Treat it like a credential.");
  console.log("   Delete it after the migration is verified.");
})().catch((error) => {
  console.error("Fatal:", error?.message || error);
  process.exit(1);
});
