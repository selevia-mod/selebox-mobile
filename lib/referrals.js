// lib/referrals.js
// ────────────────────────────────────────────────────────────────────────
// Referrals — invite-link generation + signup-time redemption.
//
// Why this module exists:
//   The Goals tab "Invite N friends" quests previously credited on
//   Share.sharedAction, which was trivially game-able (tap "Copy link"
//   in the share sheet → goal ticks without anyone signing up). The
//   real signal is "did a NEW account tie itself to my referral code
//   on signup?" — which only the server can verify. This module wires
//   the two halves of that flow:
//
//     • INVITER side: build the invite URL using their referral_code.
//       Goals tab opens the share sheet with that URL but does NOT
//       tick the goal locally. The tick is fired server-side inside
//       `redeem_referral` (see migration_referrals.sql).
//
//     • INVITEE side: capture `?ref=<code>` from the launch URL /
//       deep link, stash it in AsyncStorage as
//       PENDING_REFERRAL_KEY, and call redeemPendingReferral() right
//       after signup completes. The server validates and credits
//       the inviter's invite_friend / w_invite_friend /
//       m_invite_friend counters atomically.
//
// Public API (stable):
//   • getMyReferralCode()           — calls get_my_referral_code RPC,
//                                      caches the result for the session.
//   • buildInviteUrl(code)          — `${WEBSITE}/?ref=${code}`
//   • capturePendingReferral(code)  — stash for later redemption.
//   • redeemPendingReferral(userId) — read stash, call RPC, clear.
//   • parseRefFromUrl(url)          — pulls `?ref=…` out of any URL.
//
// Auth:
//   redeem_referral and get_my_referral_code are SECURITY DEFINER so
//   they bypass RLS, but they read auth.uid() / take p_invitee_id
//   from the call site. Mobile signs requests with the user's session
//   token after auth completes — no special handling needed here.

import AsyncStorage from "@react-native-async-storage/async-storage";
import secrets from "../private/secrets";
import supabase from "./supabase";

const PENDING_REFERRAL_KEY = "@referrals/pending_code_v1";
// Stable per-install device id used by the anti-farm gate on
// redeem_referral. The server checks this against prior `referrals`
// rows — same id appearing twice = same-device farm attempt, credit
// suppressed (relationship still records for analytics).
//
// Reinstalling the app resets this id, which is intentional: making
// a farmer reinstall the app for each fake account is significant
// friction relative to the 20-star payout. Not crypto-strong by any
// stretch; the goal is "stable across launches on the same install,"
// not "tamper-proof."
const DEVICE_ID_KEY = "@referrals/device_id_v1";

// In-memory cache for the current user's code. Populated on first
// getMyReferralCode call; cleared on sign-out.
let cachedMyCode = null;
// In-memory cache for the device id so we don't re-hit AsyncStorage
// on every redeem call.
let cachedDeviceId = null;

/**
 * Returns a stable per-install device id, creating one on first call.
 * Persisted in AsyncStorage so it survives app restarts. Reinstalling
 * the app generates a fresh id (storage is wiped with the app data).
 *
 * Non-crypto random — Math.random + Date.now is good enough to avoid
 * collisions across installs and to identify "same install" for the
 * anti-farm gate. We don't need this to be unforgeable; we need it to
 * be stable.
 */
const getOrCreateDeviceId = async () => {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (existing) {
      cachedDeviceId = existing;
      return existing;
    }
  } catch {
    /* read failure → fall through to generate a fresh id */
  }
  // 16 bytes of entropy serialised hex-style. Time component up front
  // makes timestamp ordering possible if we ever want to bucket
  // devices by first-seen for fraud analytics.
  const ts = Date.now().toString(36);
  const rand1 = Math.random().toString(36).slice(2, 12);
  const rand2 = Math.random().toString(36).slice(2, 12);
  const id = `${ts}-${rand1}-${rand2}`;
  try {
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  } catch {
    /* write failure → keep the in-memory cache so this session
       still works, and AsyncStorage will accept it on next launch. */
  }
  cachedDeviceId = id;
  return id;
};

/**
 * Fetch and memoize the current user's referral code.
 * @returns {Promise<string|null>} The 8-char code, or null if not signed in.
 */
export const getMyReferralCode = async () => {
  if (cachedMyCode) return cachedMyCode;
  try {
    const { data, error } = await supabase.rpc("get_my_referral_code");
    if (error) {
      if (__DEV__) console.warn("[referrals] get_my_referral_code:", error.message);
      return null;
    }
    if (typeof data === "string" && data.length > 0) {
      cachedMyCode = data;
      return data;
    }
    return null;
  } catch (err) {
    if (__DEV__) console.warn("[referrals] get_my_referral_code threw:", err?.message);
    return null;
  }
};

/**
 * Reset the in-memory code cache. Call from the auth sign-out path so
 * the next user doesn't briefly see the previous user's code.
 */
export const resetReferralCache = () => {
  cachedMyCode = null;
};

/**
 * Build the share URL for a given code. Format matches what
 * parseRefFromUrl reads back, so a round-trip works:
 *   buildInviteUrl("ABCD1234")  → "https://www.selebox.com/?ref=ABCD1234"
 */
export const buildInviteUrl = (code) => {
  const base = secrets?.WEBSITE || "https://www.selebox.com";
  if (!code) return base;
  // Use a query param rather than a path segment so the marketing
  // site can keep its existing routes; landing.js only needs to
  // forward `?ref` to the app via the universal link.
  return `${base}/?ref=${encodeURIComponent(code)}`;
};

/**
 * Pull `?ref=<code>` out of any URL string. Returns null if the URL
 * doesn't carry a ref param. Defensive against malformed URLs (the
 * deep link layer occasionally hands us garbage during cold starts).
 */
export const parseRefFromUrl = (url) => {
  if (!url || typeof url !== "string") return null;
  // Match `?ref=…` or `&ref=…` up to the next `&` / `#` / end-of-string.
  // Avoids `new URL()` because React Native's URL polyfill is shaky on
  // some Android builds and we'd rather a tiny regex than a dependency.
  const m = url.match(/[?&]ref=([^&#]+)/i);
  if (!m || !m[1]) return null;
  try {
    const decoded = decodeURIComponent(m[1]);
    // Codes are alphanumeric only — strip anything weirder than that
    // before sending to the server. Cheap defense against a malformed
    // URL trying to inject SQL through the RPC string param.
    return decoded.replace(/[^A-Za-z0-9]/g, "");
  } catch {
    return null;
  }
};

/**
 * Stash a pending referral code for later redemption. Called from the
 * deep-link handler at app cold-start when `?ref=` is present in the
 * launch URL. Survives the auth flow — the user might tap an invite
 * link, get bounced to the App Store, install, open the app, and
 * THEN sign up. AsyncStorage persists across that gap.
 *
 * @param {string} code
 */
export const capturePendingReferral = async (code) => {
  if (!code || typeof code !== "string") return;
  // Same alphanumeric-only sanitization as parseRefFromUrl in case the
  // caller didn't pre-sanitize.
  const cleaned = code.replace(/[^A-Za-z0-9]/g, "");
  if (cleaned.length === 0 || cleaned.length > 32) return;
  try {
    await AsyncStorage.setItem(PENDING_REFERRAL_KEY, cleaned);
  } catch {
    /* AsyncStorage write failures are silent — losing a referral is
       a worse-but-recoverable outcome than crashing the app. */
  }
};

/**
 * Redeem any pending referral code stashed by capturePendingReferral.
 * Call this from the post-signup hook (right after the new user's
 * Supabase profile row exists). Idempotent: clears the stash whether
 * the RPC succeeds, fails, or finds no pending code.
 *
 * @param {string} inviteeId  The new user's Supabase UUID.
 * @returns {Promise<{ok:boolean, redeemed?:boolean, error?:string}>}
 */
export const redeemPendingReferral = async (inviteeId) => {
  if (!inviteeId) return { ok: false, error: "missing_invitee" };
  let code = null;
  try {
    code = await AsyncStorage.getItem(PENDING_REFERRAL_KEY);
  } catch {
    /* read failure → treat as no pending code */
  }
  if (!code) return { ok: true, redeemed: false };

  let deviceId = null;
  try {
    deviceId = await getOrCreateDeviceId();
  } catch {
    /* device id is best-effort; if AsyncStorage is unavailable for
       some reason, the server treats null as "no device fingerprint"
       and only the velocity cap layer is in effect. */
  }

  try {
    const { data, error } = await supabase.rpc("redeem_referral", {
      p_inviter_code: code,
      p_invitee_id: inviteeId,
      p_invitee_device: deviceId,
    });
    if (error) {
      if (__DEV__) console.warn("[referrals] redeem_referral error:", error.message);
      // Don't clear the stash on transient errors — let the next app
      // launch retry. We only clear on terminal outcomes (success or
      // server-validated failures like invalid_code / self_referral).
      // Network errors don't carry a payload, so distinguish here.
      return { ok: false, error: error.message };
    }
    // Server-validated outcomes — clear the stash regardless of
    // ok:true/false. A failed redeem (invalid code, self-referral)
    // means this code will never succeed, so retrying is pointless.
    try {
      await AsyncStorage.removeItem(PENDING_REFERRAL_KEY);
    } catch {
      /* cleanup failure → next launch retries; idempotent on server. */
    }
    if (data?.ok) {
      // `invitee_stars` is the welcome bonus the server credited to
      // the new user's wallet (current default: 20 stars). Forwarded
      // up so the caller can show a "Welcome — you got N stars from
      // your invite!" toast.
      //
      // Two paths return ok:true with NO invitee_stars (and no toast
      // surfaced):
      //   1. already_redeemed — invitee was already linked to someone.
      //   2. credit_eligible:false — the server's anti-farm gate
      //      blocked the payout (same-device collision or the
      //      inviter blew past their velocity cap). Staying silent
      //      on this case is intentional UX — we don't want to tip
      //      off a farmer that they were flagged.
      return {
        ok: true,
        redeemed: !data.already_redeemed && data.credit_eligible !== false,
        inviteeStars: data.invitee_stars ?? 0,
      };
    }
    return { ok: false, error: data?.error || "unknown" };
  } catch (err) {
    if (__DEV__) console.warn("[referrals] redeem_referral threw:", err?.message);
    return { ok: false, error: err?.message || "exception" };
  }
};

/**
 * Convenience: read the launch URL once, parse the ref, stash it.
 * Designed to be called from app/_layout.jsx Linking.getInitialURL()
 * on cold start.
 *
 * @param {string|null} url
 */
export const captureReferralFromUrl = async (url) => {
  const code = parseRefFromUrl(url);
  if (!code) return false;
  await capturePendingReferral(code);
  return true;
};
