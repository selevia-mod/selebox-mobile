#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/inspect-appwrite-users.js
  ─────────────────────────────────────────────────────────────────────────
  One-off diagnostic: dump the full attribute set of a few Appwrite users
  so we can see exactly which fields hold the role/badge data. Use this
  when backfill-roles.js produces suspicious counts (e.g., 0 pioneers
  when 50+ are expected) — the cause is usually a field name drift
  between mobile's expectations and Appwrite's actual schema.

  Usage:
    Set the same env vars as backfill-roles.js (APPWRITE_*), then:
      node scripts/inspect-appwrite-users.js
    Or to inspect specific users by Appwrite ID:
      USER_IDS=66c9c0ff01a983484d54,67acc23e0024dd430720 node scripts/inspect-appwrite-users.js

  By default prints the FIRST 5 users and lists every attribute that
  isn't $id, $createdAt, $updatedAt, etc. — only the user-defined
  attributes (so we can see role/badge fields).
*/

const { Client, Databases, Query } = require("node-appwrite");

const env = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing required env var: ${k}`);
    process.exit(1);
  }
  return v;
};

const APPWRITE_ENDPOINT = env("APPWRITE_ENDPOINT");
const APPWRITE_PROJECT_ID = env("APPWRITE_PROJECT_ID");
const APPWRITE_API_KEY = env("APPWRITE_API_KEY");
const APPWRITE_DATABASE_ID = env("APPWRITE_DATABASE_ID");
const APPWRITE_USER_COLLECTION_ID = env("APPWRITE_USER_COLLECTION_ID");

const appwrite = new Databases(
  new Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID)
    .setKey(APPWRITE_API_KEY)
);

const SYSTEM_KEYS = new Set([
  "$id", "$collectionId", "$databaseId", "$createdAt", "$updatedAt",
  "$permissions", "$sequence",
]);

const printDoc = (doc) => {
  const userAttrs = {};
  for (const [k, v] of Object.entries(doc)) {
    if (SYSTEM_KEYS.has(k)) continue;
    userAttrs[k] = v;
  }
  console.log("\n────────────────────────────────────────────────────────");
  console.log(`$id:        ${doc.$id}`);
  console.log(`username:   ${doc.username || doc.name || "(no username)"}`);
  console.log(`attributes:`);
  for (const [k, v] of Object.entries(userAttrs)) {
    if (k === "username" || k === "name") continue;
    const val = typeof v === "string" && v.length > 80 ? v.slice(0, 80) + "…" : v;
    console.log(`  ${k.padEnd(26)} ${typeof v === "object" ? JSON.stringify(val) : val}`);
  }
};

const main = async () => {
  const ids = (process.env.USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

  if (ids.length) {
    console.log(`[inspect] fetching ${ids.length} specific user(s)…`);
    for (const id of ids) {
      try {
        const doc = await appwrite.getDocument(
          APPWRITE_DATABASE_ID,
          APPWRITE_USER_COLLECTION_ID,
          id
        );
        printDoc(doc);
      } catch (e) {
        console.error(`  ${id}: ${e.message}`);
      }
    }
    return;
  }

  // Scan-mode: walk ALL users, print only those that look like they
  // have role data (non-empty `roles` array, or any boolean flag set).
  // Helpful when you don't know specific usernames upfront.
  console.log(`[inspect] scanning Appwrite users for any with role data…`);
  let cursor = null;
  let scanned = 0;
  let printed = 0;
  const PRINT_LIMIT = 10;
  const distribution = { rolesArray: 0, creator: 0, moderator: 0, auditor: 0 };

  while (printed < PRINT_LIMIT) {
    const queries = [Query.limit(100), Query.orderAsc("$id")];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const page = await appwrite.listDocuments(
      APPWRITE_DATABASE_ID,
      APPWRITE_USER_COLLECTION_ID,
      queries
    );
    if (!page.documents.length) break;

    for (const doc of page.documents) {
      scanned += 1;
      const hasRoles = Array.isArray(doc.roles) && doc.roles.length > 0;
      const hasFlag = doc.creator === true || doc.moderator === true || doc.auditor === true;
      if (!hasRoles && !hasFlag) continue;

      if (hasRoles) distribution.rolesArray += 1;
      if (doc.creator === true) distribution.creator += 1;
      if (doc.moderator === true) distribution.moderator += 1;
      if (doc.auditor === true) distribution.auditor += 1;

      if (printed < PRINT_LIMIT) {
        printDoc(doc);
        printed += 1;
      }
    }
    cursor = page.documents[page.documents.length - 1]?.$id;
    if (page.documents.length < 100) break;
    process.stdout.write(`  scanned ${scanned} users…\r`);
  }
  console.log("\n");
  console.log("[inspect] role-data scan summary (full collection):");
  console.log(`  scanned:               ${scanned}`);
  console.log(`  with roles[] populated: ${distribution.rolesArray}`);
  console.log(`  with creator=true:      ${distribution.creator}`);
  console.log(`  with moderator=true:    ${distribution.moderator}`);
  console.log(`  with auditor=true:      ${distribution.auditor}`);
  console.log(`  printed (capped):       ${printed} of ${PRINT_LIMIT}`);
};

main().catch((err) => {
  console.error("[inspect] fatal:", err);
  process.exit(1);
});
