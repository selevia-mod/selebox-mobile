// Supabase client — Phase A of the Appwrite → Supabase migration.
//
// Why this file exists:
//   The web app (Selebox/) is already running fully on Supabase. Mobile is
//   still on Appwrite. The migration will swap mobile services over table by
//   table behind this client. For now, this client just sits ready — Phase A
//   is plumbing only.
//
// React Native specifics (vs the web's `Selebox/supabase.js`):
//   - `react-native-url-polyfill/auto` is imported as the first line below.
//     supabase-js uses URL / URLSearchParams under the hood, and RN doesn't
//     ship those by default. The /auto import has side effects that install
//     the polyfills globally; subsequent imports are no-ops, so importing it
//     here means any module that pulls in the supabase client gets the
//     polyfill for free.
//   - Session persistence uses `@react-native-async-storage/async-storage`
//     instead of localStorage. AsyncStorage is already a dependency for
//     Stream Chat tokens, so we're not pulling in anything new.
//   - `detectSessionInUrl: false` because RN has no `window.location` to read
//     OAuth callback fragments from. OAuth flows on mobile go through
//     `expo-auth-session` and feed the resulting session into `setSession`
//     manually (handled in Phase B).
//   - `autoRefreshToken: true` so the client refreshes a few minutes before
//     the JWT expires; the next call hits Supabase with a fresh token.
//
// What this client can do today (Phase A, anonymous):
//   - Read any table that exposes rows to the `anon` role via RLS. On web's
//     current schema, that's `app_config` and most public-content reads.
//   - It CANNOT write — every write needs an authenticated session, which
//     Phase B adds. Until then, all writes still go through `lib/appwrite.js`.
//
// Mirrored helpers from the web's `Selebox/supabase.js`:
//   - `REACTIONS` — emoji enum, kept identical so reactions land in the same
//     `target_type`/`target_id`/`emoji` shape across web + mobile.
//   - `callEdgeFunction(name, payload)` — Phase D will use this once Stream
//     Chat tokens + admin email handler move to Supabase Edge Functions.
//   - `timeAgo`, `initials` — small util parity. Mobile already has its own
//     `lib/utils/time-ago.js`, so we don't re-export those here.

import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import secrets from "../private/secrets";

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = secrets;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  // Throw early instead of letting the createClient call fail with a vague
  // "Invalid URL" error halfway through app boot.
  throw new Error("Supabase credentials missing in private/secrets.js — check SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Reaction emoji set — kept in lock-step with the web's REACTIONS array so a
// like landed on either platform reads as the same kind on the other.
export const REACTIONS = [
  { key: "heart", emoji: "❤️", label: "Love" },
  { key: "laugh", emoji: "😂", label: "Haha" },
  { key: "sad", emoji: "😢", label: "Sad" },
  { key: "cry", emoji: "😭", label: "Cry" },
  { key: "angry", emoji: "😡", label: "Angry" },
];

// Calls a Supabase Edge Function with the current session's bearer token.
// Mirrors the helper in `Selebox/supabase.js`. Mobile will use this in Phase D
// for Stream Chat token issuance + the admin email handler. Throws if the
// user isn't signed in — until Phase B, that means this helper is a no-op.
export async function callEdgeFunction(functionName, payload = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in to Supabase");

  const url = `${SUPABASE_URL}/functions/v1/${functionName}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || "Edge function request failed");
  }

  return response.json();
}

// Lightweight smoke test — call this from a dev-only effect to confirm the
// client can reach the Supabase project. Returns `true` when the publishable
// key + URL are wired correctly. Pure read against `app_config` because that
// table exposes a public read policy on the current web schema.
export async function pingSupabase() {
  try {
    const { error } = await supabase.from("app_config").select("key", { count: "exact", head: true }).limit(1);
    if (error) {
      console.log("[supabase] ping failed:", error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.log("[supabase] ping threw:", error?.message || error);
    return false;
  }
}

export default supabase;
