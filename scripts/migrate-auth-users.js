#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/migrate-auth-users.js
  ─────────────────────────────────────────────────────────────────────────
  One-time bulk import of Appwrite auth users into Supabase auth.users.

  Why this exists:
    The web migration tool (Selebox/migrate.html) seeded `profiles` rows for
    every Appwrite user with their `legacy_appwrite_id` + lowercase email,
    but it did NOT touch auth.users — that's intentional, because Appwrite
    password hashes can't be pulled out via the public API. The web app's
    migration plan was "lazy auth" — claim the profile on first sign-in
    after the user re-registers.

    Mobile is now flipping to Supabase Auth too. To preserve every existing
    user's password (so they don't have to reset on the new system), we
    bulk-create auth.users rows from a database export that contains the
    Appwrite password hashes. The Supabase lazy-claim trigger then links
    each new auth.users to its existing profile by lowercase-email match.

    After this script runs, every Appwrite user can sign in to Supabase
    with their existing email + password. Zero friction, zero churn.

  How to get the input file (Appwrite doesn't expose hashes via the public
  API, so you need ONE of these):

    Option A — Appwrite Cloud / self-hosted Backups
      Dashboard → Settings → Backups → Export. Find users.json in the
      archive. Hashes are in the `password` field with `hashAlgorithm`
      identifying which algo was used.

    Option B — Direct DB query (self-host only)
      MariaDB/Postgres backing Appwrite has a `_users` table. Export rows
      to JSON.

    Option C — appwrite migrate export (CLI)
      `appwrite migrate export --resource=users --format=json`
      Includes hashes when run with admin scope.

  Input file shape (JSON array, one object per user):
    [
      {
        "$id": "abc123",                          // Appwrite user ID
        "email": "user@example.com",
        "password": "$2y$10$abcdef...",           // bcrypt / argon2 hash
        "hashAlgorithm": "bcrypt",                // bcrypt | argon2 | scrypt | ...
        "$createdAt": "2024-01-01T00:00:00.000+00:00",
        "$updatedAt": "2024-06-01T00:00:00.000+00:00",
        "name": "username",                       // Appwrite stores name as username
        "emailVerification": true                 // optional — if true we mark email confirmed
      },
      ...
    ]

  Usage:
    SUPABASE_URL=https://your-project.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
    INPUT_FILE=./appwrite-users.json \
    node scripts/migrate-auth-users.js

    Optional flags:
      DRY_RUN=1                   List what would happen, make no changes.
      LIMIT=50                    Only process the first N users (smoke test).
      CONCURRENCY=5               Parallel inserts (default 5; Supabase rate-limits).
      SKIP_UNSUPPORTED_HASHES=1   Skip users with non-bcrypt/argon2 hashes
                                  rather than failing them. Fallback path:
                                  these users will be prompted to reset.

  Idempotency:
    The script reads the existing Supabase auth.users and skips emails that
    already have a row. Safe to re-run after a failure or after pulling a
    fresh export with new accounts.

  After running:
    Spot-check by signing into the mobile app (with the feature flag flipped)
    using a known Appwrite account's existing email + password. If sign-in
    succeeds, the hash format is compatible. Repeat with one Google user
    and one Apple user — those don't have meaningful passwords (they used
    the GOOGLE_SIGNIN_DEFAULT_PASSWORD constant), so they'll need OAuth
    sign-in (which doesn't go through this migration).
*/

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// ── Config ───────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INPUT_FILE = process.env.INPUT_FILE || path.resolve(__dirname, "appwrite-users.json");
const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const CONCURRENCY = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : 5;
const SKIP_UNSUPPORTED_HASHES = process.env.SKIP_UNSUPPORTED_HASHES === "1";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  console.error("Service role key is required — the publishable key won't work for auth.admin.*");
  process.exit(1);
}
if (!fs.existsSync(INPUT_FILE)) {
  console.error(`Input file not found: ${INPUT_FILE}`);
  console.error("Set INPUT_FILE env var or place appwrite-users.json next to this script.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Hash format normalization ────────────────────────────────────────────
// Supabase Auth's `password_hash` field accepts standard bcrypt
// ($2a$, $2b$, $2y$) and argon2id ($argon2id$). Anything else is rejected.
//
// Appwrite supports several formats:
//   - bcrypt — usually $2y$10$... — works directly with Supabase
//   - argon2 — $argon2id$... — works directly
//   - scrypt / scryptModified / sha / phpass / md5 / plaintext — NOT
//     compatible. Users with these hashes need a password reset.
//
// We normalize known formats and flag unsupported ones for review.
const normalizeHash = (rawHash, algorithm) => {
  if (!rawHash) return { ok: false, reason: "missing_hash" };

  const algo = (algorithm || "").toLowerCase();
  const trimmed = String(rawHash).trim();

  // bcrypt — Appwrite default for new users in recent versions
  if (algo === "bcrypt" || /^\$2[aby]\$\d{2}\$/.test(trimmed)) {
    return { ok: true, hash: trimmed, algo: "bcrypt" };
  }

  // argon2id
  if (algo.startsWith("argon2") || trimmed.startsWith("$argon2id$")) {
    return { ok: true, hash: trimmed, algo: "argon2id" };
  }

  // Everything else — Appwrite supports them but Supabase doesn't accept
  // them in password_hash. Flag for the caller to decide.
  return { ok: false, reason: `unsupported_algo:${algo || "unknown"}` };
};

// ── Existing-user pre-load (for idempotency) ─────────────────────────────
// Pages through auth.users and builds a Set of lowercase emails already in
// Supabase. Uses the admin API which paginates 1000 at a time.
const loadExistingEmails = async () => {
  console.log("Loading already-migrated emails from Supabase auth…");
  const seen = new Set();
  let page = 1;
  const PAGE_SIZE = 1000;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const users = data?.users || [];
    if (users.length === 0) break;
    for (const u of users) {
      if (u.email) seen.add(u.email.toLowerCase());
    }
    if (users.length < PAGE_SIZE) break;
    page += 1;
  }
  console.log(`  ${seen.size} email(s) already in Supabase auth`);
  return seen;
};

// ── Concurrency-limited map ──────────────────────────────────────────────
const limitedMap = async (items, limit, fn) => {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
};

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
  console.log(`Reading input from ${INPUT_FILE}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(INPUT_FILE, "utf8"));
  } catch (error) {
    console.error("Failed to parse input JSON:", error.message);
    process.exit(1);
  }

  // Accept either an array OR { users: [...] } shape (Appwrite export uses
  // the wrapped shape; raw exports may be flat arrays).
  const allUsers = Array.isArray(raw) ? raw : Array.isArray(raw?.users) ? raw.users : null;
  if (!allUsers) {
    console.error("Input must be an array of users or { users: [...] }.");
    process.exit(1);
  }
  console.log(`Found ${allUsers.length} user(s) in input`);

  const users = LIMIT ? allUsers.slice(0, LIMIT) : allUsers;
  if (LIMIT) console.log(`LIMIT set — processing only first ${users.length}`);

  if (DRY_RUN) console.log("DRY_RUN=1 — no inserts will be performed");

  const existingEmails = await loadExistingEmails();

  let migrated = 0;
  let skippedExisting = 0;
  let skippedNoEmail = 0;
  let skippedNoHash = 0;
  let skippedUnsupported = 0;
  let failed = 0;
  const failures = [];
  const unsupported = [];

  await limitedMap(users, CONCURRENCY, async (u) => {
    const email = (u?.email || "").trim().toLowerCase();
    if (!email) {
      skippedNoEmail += 1;
      return;
    }
    if (existingEmails.has(email)) {
      skippedExisting += 1;
      return;
    }

    const norm = normalizeHash(u?.password, u?.hashAlgorithm);
    if (!norm.ok) {
      if (norm.reason === "missing_hash") {
        skippedNoHash += 1;
        return;
      }
      // Unsupported algo. Either skip silently (script flag) or fail loud.
      unsupported.push({ email, reason: norm.reason, $id: u?.$id });
      if (SKIP_UNSUPPORTED_HASHES) {
        skippedUnsupported += 1;
        return;
      }
      failed += 1;
      failures.push({ email, reason: norm.reason });
      console.error(`  ✗ ${email}: ${norm.reason}`);
      return;
    }

    if (DRY_RUN) {
      migrated += 1;
      return;
    }

    try {
      const { error } = await supabase.auth.admin.createUser({
        email,
        password_hash: norm.hash,
        // Mark every migrated user as email-verified. They were already
        // valid Appwrite users with a working email; forcing re-verification
        // on the new system would lock them out for no reason. (Previous
        // version had a `|| true` that silently always evaluated true —
        // the explicit `true` makes the intent obvious + lints cleanly.)
        email_confirm: true,
        user_metadata: {
          username: u?.name || u?.username || null,
          legacy_appwrite_id: u?.$id || null,
          migrated_at: new Date().toISOString(),
        },
      });
      if (error) throw error;
      migrated += 1;
      // Mark seen so a duplicate inside the same input batch doesn't
      // re-attempt creation.
      existingEmails.add(email);
    } catch (error) {
      failed += 1;
      failures.push({ email, reason: error.message });
      console.error(`  ✗ ${email}: ${error.message}`);
    }
  });

  console.log("");
  console.log("──────────────────────────────────────────────────────────");
  console.log(`Summary:`);
  console.log(`  migrated:           ${migrated}`);
  console.log(`  skipped (existing): ${skippedExisting}`);
  console.log(`  skipped (no email): ${skippedNoEmail}`);
  console.log(`  skipped (no hash):  ${skippedNoHash}`);
  console.log(`  skipped (unsupp.):  ${skippedUnsupported}`);
  console.log(`  failed:             ${failed}`);
  console.log("──────────────────────────────────────────────────────────");

  if (unsupported.length) {
    const outPath = path.resolve(__dirname, "auth-migration-unsupported.json");
    fs.writeFileSync(outPath, JSON.stringify(unsupported, null, 2));
    console.log(`Unsupported-hash users written to ${outPath}`);
    console.log("These users will need to use the password-reset flow on first sign-in.");
  }
  if (failures.length) {
    const outPath = path.resolve(__dirname, "auth-migration-failures.json");
    fs.writeFileSync(outPath, JSON.stringify(failures, null, 2));
    console.log(`Failures written to ${outPath}`);
  }
})().catch((error) => {
  console.error("Fatal:", error?.message || error);
  process.exit(1);
});
