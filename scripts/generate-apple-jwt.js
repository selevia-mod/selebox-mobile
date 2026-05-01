#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/generate-apple-jwt.js
  ────────────────────────────────────────────────────────────────────
  Generates the JWT that Supabase's Apple OAuth provider needs in its
  "Secret Key (for OAuth)" field. Apple OAuth secret JWTs expire every
  6 months — re-run this script and paste the new JWT into Supabase
  whenever the old one is about to expire.

  What you need before running:
    • Team ID            (Apple Developer → Membership)
    • Key ID             (Apple Developer → Keys → click your Sign in
                          with Apple key)
    • Service ID         (Apple Developer → Identifiers → Services
                          IDs — for us this is "com.selebox.signin")
    • .p8 private key    (Downloaded ONCE when the key was created.
                          Path on disk passed via APPLE_P8_PATH.)

  Usage:
    APPLE_TEAM_ID=ABC123XYZ4 \
    APPLE_KEY_ID=XYZ987ABC1 \
    APPLE_SERVICE_ID=com.selebox.signin \
    APPLE_P8_PATH=/path/to/AuthKey_XYZ987ABC1.p8 \
    node scripts/generate-apple-jwt.js

  The script prints the JWT to stdout. Copy it into Supabase Dashboard
  → Authentication → Providers → Apple → Secret Key (for OAuth) field.
  Save in Supabase. Done.

  Security note:
    The .p8 file is your private key. Do NOT commit it to git, do NOT
    paste it anywhere online, do NOT share it. Keep it in 1Password /
    a secure folder. The JWT this script generates is already a
    derived credential (and expires in 6 months) so it's lower-risk
    than the .p8 itself, but treat it carefully too.
*/

const fs = require("fs");
const crypto = require("crypto");

const TEAM_ID = process.env.APPLE_TEAM_ID;
const KEY_ID = process.env.APPLE_KEY_ID;
const SERVICE_ID = process.env.APPLE_SERVICE_ID;
const P8_PATH = process.env.APPLE_P8_PATH;

if (!TEAM_ID || !KEY_ID || !SERVICE_ID || !P8_PATH) {
  console.error("Missing required env vars. Need:");
  console.error("  APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_SERVICE_ID, APPLE_P8_PATH");
  process.exit(1);
}

if (!fs.existsSync(P8_PATH)) {
  console.error(`.p8 file not found at: ${P8_PATH}`);
  process.exit(1);
}

const p8 = fs.readFileSync(P8_PATH, "utf8");

// JWT header — Apple wants alg=ES256 (ECDSA using P-256 and SHA-256).
const header = {
  alg: "ES256",
  kid: KEY_ID,
  typ: "JWT",
};

// JWT payload — Apple's required claims for client_secret JWTs:
//   iss  Team ID
//   iat  current epoch seconds
//   exp  iat + at most 6 months (we use 5 months 27 days for safety)
//   aud  always https://appleid.apple.com
//   sub  Service ID
const now = Math.floor(Date.now() / 1000);
const payload = {
  iss: TEAM_ID,
  iat: now,
  exp: now + 60 * 60 * 24 * 180 - 60 * 60 * 24 * 3, // ~5mo 27d
  aud: "https://appleid.apple.com",
  sub: SERVICE_ID,
};

// Base64URL encode helper — same encoding JWTs use.
const b64url = (input) =>
  Buffer.from(typeof input === "string" ? input : JSON.stringify(input))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const signingInput = `${b64url(header)}.${b64url(payload)}`;

// Sign with the .p8 private key using ECDSA P-256 SHA-256.
const sign = crypto.createSign("SHA256");
sign.update(signingInput);
sign.end();

let signature;
try {
  // dsaEncoding=ieee-p1363 produces a 64-byte (r||s) signature, which
  // is what JWS expects for ES256. Without this, crypto.sign emits a
  // DER-encoded signature that Apple rejects.
  signature = sign.sign({
    key: p8,
    dsaEncoding: "ieee-p1363",
  });
} catch (error) {
  console.error("Failed to sign JWT:", error.message);
  console.error("Common causes:");
  console.error("  • .p8 file is corrupted or not the matching key");
  console.error("  • .p8 contents missing -----BEGIN/END PRIVATE KEY----- lines");
  process.exit(1);
}

const signatureB64 = signature
  .toString("base64")
  .replace(/=/g, "")
  .replace(/\+/g, "-")
  .replace(/\//g, "_");

const jwt = `${signingInput}.${signatureB64}`;

console.log("");
console.log("──────────────────────────────────────────────────────");
console.log("Apple OAuth Client Secret JWT");
console.log("──────────────────────────────────────────────────────");
console.log(jwt);
console.log("──────────────────────────────────────────────────────");
console.log("");
console.log("Paste this into Supabase Dashboard → Authentication →");
console.log("Providers → Apple → Secret Key (for OAuth).");
console.log("");
console.log(`Expires: ${new Date(payload.exp * 1000).toISOString()}`);
console.log("(Re-run this script and update Supabase ~5 months from now.)");
console.log("");
