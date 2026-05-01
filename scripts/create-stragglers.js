#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/create-stragglers.js
  ───────────────────────────────────────────────────────────────────
  One-off helper to create the 8 users that the bulk migration
  couldn't import. We don't pass a password_hash this time — Supabase
  generates a random one we throw away. On first sign-in, these users
  hit "Forgot password," receive a reset email, and pick a new
  password. The lazy-claim trigger still links them to their existing
  profile by email match.

  Same outcome as our OAuth-only users (25,362 of them have no
  password to migrate either). One-time friction, no data lost.

  Usage:
    SUPABASE_URL=https://your-project.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=eyJ... \
    node scripts/create-stragglers.js
*/

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(1);
}

// The 8 users that failed the bulk migration with "Database error
// creating new user." Determined empirically across multiple migration
// runs — the same emails fail every time, so it's a property of the
// user records themselves, not a transient.
const STRAGGLERS = [
  "buenc97@gmail.com",
  "reejayresurreccion@gmail.com",
  "maravillaantonette426@gmail.com",
  "abbysantillan21@gmail.com",
  "simplymich1624@gmail.com",
  "triciacamacho02@gmail.com",
  "che.reblando07@gmail.com",
  "xieyrazehel@gmail.com",
];

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

(async () => {
  let created = 0;
  let alreadyExisted = 0;
  let failed = 0;
  const failures = [];

  for (const email of STRAGGLERS) {
    try {
      // No password_hash on purpose. Supabase generates a random one
      // we'll never use. The user resets via "Forgot password" on
      // first sign-in.
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: {
          migrated_at: new Date().toISOString(),
          migration_note: "password-less straggler — reset on first sign-in",
        },
      });
      if (error) {
        if (/already.*registered|already.*exists/i.test(error.message)) {
          alreadyExisted += 1;
          console.log(`  • ${email}: already in auth.users (skipped)`);
        } else {
          failed += 1;
          failures.push({ email, reason: error.message });
          console.error(`  ✗ ${email}: ${error.message}`);
        }
      } else {
        created += 1;
        console.log(`  ✓ ${email}: created (no password)`);
      }
    } catch (err) {
      failed += 1;
      failures.push({ email, reason: err?.message || String(err) });
      console.error(`  ✗ ${email}: ${err?.message || err}`);
    }
  }

  console.log("");
  console.log("──────────────────────────────────────────────");
  console.log(`Stragglers result: ${STRAGGLERS.length} attempted`);
  console.log(`  created:        ${created}`);
  console.log(`  already exists: ${alreadyExisted}`);
  console.log(`  failed:         ${failed}`);
  console.log("──────────────────────────────────────────────");

  if (failures.length) {
    console.log("");
    console.log("Failures (also stuck in this round — diagnose individually):");
    failures.forEach((f) => console.log(`  - ${f.email}: ${f.reason}`));
  }
})().catch((error) => {
  console.error("Fatal:", error?.message || error);
  process.exit(1);
});
