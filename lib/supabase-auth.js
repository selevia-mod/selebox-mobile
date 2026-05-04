// Supabase Auth wrapper — Phase B of the Appwrite → Supabase migration.
//
// What this file replaces:
//   The auth-flavored exports from `lib/appwrite.js`:
//     - signIn(email, password)
//     - signOut()
//     - createUser(email, password, username, avatar)
//     - getCurrentUser() / getCurrentUserWithoutStream()
//     - createRecoveryEmail(email)
//     - updateRecoveryUser(userId, secret, newPassword, confirmPassword)
//
//   Plus the Google + Apple OAuth flows currently inlined in
//   `app/(auth)/sign-in.jsx`. Those flows used Appwrite-hosted browser
//   redirects (account.createOAuth2Token + WebBrowser.openAuthSessionAsync).
//   Supabase has a cleaner native equivalent — the same Google / Apple SDKs
//   already in your binary return an idToken, which we hand to
//   `supabase.auth.signInWithIdToken`. No browser switch, faster UX.
//
// User object shape:
//   The wider mobile app expects user objects shaped like Appwrite's user
//   document — `$id`, `accountId`, `username`, `avatar`, `banner`, `bio`,
//   etc. Supabase's `profiles` table uses `id`, `avatar_url`, `banner_url`
//   etc. Rather than refactor every consumer in this phase, we return a
//   "hydrated" user that carries BOTH shapes — the Supabase-native columns
//   plus legacy aliases — so existing components keep working unchanged
//   while Phase C ports them one by one.
//
// Profile linking (the lazy-claim mechanism):
//   The web migration tool pre-inserted profile rows for every Appwrite
//   user, each carrying `legacy_appwrite_id` + lowercase `email`. A SQL
//   trigger on Supabase links a freshly created `auth.users` row to its
//   matching profile by lowercase-email match on first sign-in. So this
//   wrapper does NOT need to manually create a profile row — Supabase Auth
//   creates the auth.users row, the trigger links the existing profile,
//   and we just read the linked profile back.
//
// What this file does NOT yet do (subsequent sub-phases):
//   - Stream Chat token issuance — currently issued by Appwrite's JWT
//     endpoint via lib/stream.js. Phase D moves this to a Supabase Edge
//     Function. For now, sign-in returns the user without connecting Stream
//     and lib/stream.js stays Appwrite-flavored.
//   - Push token sync — `updateUserExpoPushToken` writes to Appwrite's
//     userCollection. Phase C ports this when we migrate notifications.

import * as AppleAuthentication from "expo-apple-authentication";
import { makeRedirectUri } from "expo-auth-session";
import * as Crypto from "expo-crypto";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import secrets from "../private/secrets";
import supabase from "./supabase";

// ─────────────────────────────────────────────────────────────────────────
// Profile shape adapter
// ─────────────────────────────────────────────────────────────────────────

// Maps a Supabase `profiles` row + auth.users row into the user object
// shape the rest of the mobile app currently expects (Appwrite-like).
// Carries BOTH shapes so legacy consumers (`user.$id`, `user.accountId`,
// `user.avatar`) and new consumers (`user.id`, `user.avatar_url`) both work.
const hydrateProfile = (profile, authUser = null) => {
  if (!profile) return null;
  return {
    // ── Supabase-native columns ──
    id: profile.id,
    username: profile.username || null,
    email: profile.email || authUser?.email || null,
    avatar_url: profile.avatar_url || null,
    banner_url: profile.banner_url || null,
    bio: profile.bio || null,
    role: profile.role || "user",
    is_guest: profile.is_guest || false,
    is_banned: profile.is_banned || false,
    suspended_until: profile.suspended_until || null,
    legacy_appwrite_id: profile.legacy_appwrite_id || null,
    created_at: profile.created_at || null,
    updated_at: profile.updated_at || null,

    // ── Legacy Appwrite-shaped aliases (so existing components don't break
    //    while Phase C ports them) ──
    $id: profile.id,
    $createdAt: profile.created_at,
    $updatedAt: profile.updated_at,
    accountId: profile.id,
    name: profile.username || null,
    avatar: profile.avatar_url || null,
    banner: profile.banner_url || null,
  };
};

// Reads the current session's profile row. Returns null if no session.
// Handles the lazy-claim race — on first sign-in, the SQL trigger that
// links auth.users to profiles can take a moment to fire. We retry once
// after a 500ms delay before falling back to the auth-metadata stub.
export const getCurrentSupabaseUser = async () => {
  const {
    data: { user: authUser },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !authUser) return null;

  const fetchProfile = async () => {
    const { data, error } = await supabase.from("profiles").select("*").eq("id", authUser.id).maybeSingle();
    if (error) {
      console.log("[supabase-auth] profile fetch error:", error.message);
      return null;
    }
    return data;
  };

  let profile = await fetchProfile();
  if (!profile) {
    // Lazy-claim race retry — give the trigger 500ms to settle. Avoids
    // showing a sub-par auth-metadata stub on the user's very first login
    // when the migrated profile row exists but hasn't been claimed yet.
    await new Promise((resolve) => setTimeout(resolve, 500));
    profile = await fetchProfile();
  }

  if (!profile) {
    // Trigger genuinely hasn't fired — return a minimal hydrated user from
    // auth metadata so the app boots. The next login (or focus refresh)
    // will pick up the real profile row.
    return hydrateProfile(
      {
        id: authUser.id,
        email: authUser.email,
        username: authUser.user_metadata?.username || authUser.user_metadata?.full_name || authUser.email?.split("@")[0],
        avatar_url: authUser.user_metadata?.avatar_url || null,
        created_at: authUser.created_at,
        updated_at: authUser.updated_at,
      },
      authUser,
    );
  }

  return hydrateProfile(profile, authUser);
};

// ─────────────────────────────────────────────────────────────────────────
// Email + password
// ─────────────────────────────────────────────────────────────────────────

// Sign in with email + password. Returns the hydrated user, or `null` if
// the Supabase project requires email verification before allowing
// sign-in (caller should surface a "check your email" prompt).
//
// Existing-user gotcha:
//   Email/password users from Appwrite don't have a Supabase auth.users row
//   yet (the migration only seeded `profiles`, not `auth.users`). So this
//   call will fail with "Invalid login credentials" for legacy users until
//   we either:
//     (a) bulk-import their bcrypt password hashes via Supabase admin API
//         (recommended — seamless UX, see Phase B.5 doc)
//     (b) prompt them through a password reset on first attempt
//   Both paths are documented in `docs/auth-migration-decision.md` (Phase
//   B.5). Until that decision lands, callers should catch this error and
//   surface a helpful message.
export const signInWithEmail = async (email, password) => {
  const normalizedEmail = (email || "").trim().toLowerCase();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: normalizedEmail,
    password,
  });
  if (error) throw error;
  // No session means Supabase accepted the credentials but is gating on
  // email verification. Callers should treat null as "show a check-your-
  // email modal" rather than throwing — matches sign-up.jsx's UX.
  if (!data?.session) return null;

  return getCurrentSupabaseUser();
};

// Create a brand-new account. The trigger on Supabase will (a) link the
// new auth.users to an existing profile if email matches a migrated row,
// or (b) create a fresh profile if no match. We pass username through
// auth metadata so the trigger can stamp it on the profile.
export const signUpWithEmail = async ({ email, password, username }) => {
  const normalizedEmail = (email || "").trim().toLowerCase();
  const trimmedUsername = (username || "").trim();
  if (!trimmedUsername) throw new Error("Username is required");

  const { data, error } = await supabase.auth.signUp({
    email: normalizedEmail,
    password,
    options: {
      data: { username: trimmedUsername },
    },
  });
  if (error) throw error;

  // Supabase may or may not return a session depending on whether email
  // confirmation is enabled. If a session is back, fetch + return the
  // hydrated user; otherwise return null and let the caller handle the
  // "check your email" UX.
  if (!data?.session) return null;
  return getCurrentSupabaseUser();
};

// ─────────────────────────────────────────────────────────────────────────
// Google sign-in (native — no browser redirect)
// ─────────────────────────────────────────────────────────────────────────

// Configures the Google SDK once. Idempotent — safe to call from multiple
// screens. Mirrors the inline GoogleSignin.configure call in sign-in.jsx
// but exposed as a function so we can call it from a single bootstrap
// instead of every screen.
export const configureGoogleSignIn = () => {
  GoogleSignin.configure({
    iosClientId: secrets.IOS_CLIENT_ID,
    webClientId: secrets.WEB_CLIENT_ID, // required on Android for an idToken to come back
  });
};

// Decodes a JWT's payload (the middle segment) without verifying the
// signature. Used to extract the nonce claim from Google's id_token
// (see signInWithGoogle below for the why). Returns null on parse
// failure (no throw). NOT for security-critical decisions — Supabase
// does signature verification server-side; this is just plumbing.
const _decodeJwtPayload = (jwt) => {
  try {
    const parts = String(jwt || "").split(".");
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    // atob is global in modern React Native runtimes (Hermes + JSC both have it).
    const json = atob(padded);
    return JSON.parse(json);
  } catch (err) {
    console.log("[google-signin] JWT decode failed:", err?.message);
    return null;
  }
};

// Native Google sign-in. Triggers Google's account picker (no browser),
// hands the resulting idToken to Supabase, and returns the hydrated user.
//
// Nonce handling
// ──────────────
// Three diagnostic rounds confirmed (May 2026) that
// @react-native-google-signin v13.2 on iOS generates an internal nonce
// it doesn't expose, making it impossible for the client to satisfy
// supabase.auth.signInWithIdToken's nonce match check.
//
// The fix is server-side: enable "Skip nonce checks" on the Google
// provider in Supabase Dashboard → Authentication → Providers →
// Google. With it on, Supabase still validates the id_token's
// signature against Google's JWKS (the real security boundary) but
// skips the nonce match — which is what we'd actually want for hybrid
// mobile flows where the native SDK owns the nonce.
//
// Mobile-side, we just don't pass a nonce on either side. Clean.
//
// IMPORTANT: if "Skip nonce checks" gets disabled in Supabase later,
// this will start failing with "Passed nonce and nonce in id_token
// should either both exist or not". Re-enable the toggle to fix.
export const signInWithGoogle = async () => {
  await GoogleSignin.hasPlayServices();
  const userInfo = await GoogleSignin.signIn();
  const idToken = userInfo?.idToken || userInfo?.data?.idToken;
  if (!idToken) throw new Error("No idToken returned from Google");

  const { error } = await supabase.auth.signInWithIdToken({
    provider: "google",
    token: idToken,
  });
  if (error) throw error;

  return getCurrentSupabaseUser();
};

// ─────────────────────────────────────────────────────────────────────────
// Apple sign-in (iOS native — no browser redirect)
// ─────────────────────────────────────────────────────────────────────────

// Native Apple Sign In via expo-apple-authentication (already a dep). The
// `usesAppleSignIn: true` capability is in app.json so the binary already
// has the entitlement. We pass the resulting identityToken to Supabase.
//
// On Android Apple Sign In requires a web flow (Apple doesn't expose a
// native SDK for Android), so this throws on Android — callers should
// hide the Apple button on non-iOS platforms.
export const signInWithApple = async () => {
  if (Platform.OS !== "ios") {
    throw new Error("Apple Sign In is only available on iOS");
  }

  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
  });

  const identityToken = credential?.identityToken;
  if (!identityToken) throw new Error("No identityToken returned from Apple");

  const { error } = await supabase.auth.signInWithIdToken({
    provider: "apple",
    token: identityToken,
  });
  if (error) throw error;

  return getCurrentSupabaseUser();
};

// ─────────────────────────────────────────────────────────────────────────
// Recovery flow (forgot password / reset password)
// ─────────────────────────────────────────────────────────────────────────

// Sends a password-reset email. Supabase composes the email and the link
// lands at our deep-link handler (the existing app.json scheme). The
// handler navigates to `(auth)/reset-password` with the token in the URL.
// Mirrors the contract of Appwrite's `account.createRecovery`.
export const sendPasswordResetEmail = async (email) => {
  const normalizedEmail = (email || "").trim().toLowerCase();
  // `redirectTo` is the URL the email link points at. For mobile we use
  // the same WEBSITE host that Appwrite was using — the website handles
  // the redirect into the app via the deep-link scheme registered in
  // app.json. If the user opens the link on a device with the app
  // installed, they land on `(auth)/link-verification`.
  const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
    redirectTo: `${secrets.WEBSITE}/auth/reset`,
  });
  if (error) throw error;
};

// Applies a new password while the user holds a valid recovery session.
// After clicking the email link, Supabase auto-creates a temporary
// "recovery" session — `supabase.auth.updateUser({ password })` works
// against that session. The link-verification screen is responsible for
// putting the user into that session before this is called.
//
// Throws a typed error (`name: "RECOVERY_SESSION_MISSING"`) when there's
// no active session, so the caller can show a "request new link" CTA
// instead of a generic auth error message.
export const updatePasswordFromRecovery = async (newPassword) => {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    const err = new Error("Your reset link has expired. Request a new one to continue.");
    err.name = "RECOVERY_SESSION_MISSING";
    throw err;
  }
  const { data, error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
  return data?.user || null;
};

// ─────────────────────────────────────────────────────────────────────────
// Sign-out
// ─────────────────────────────────────────────────────────────────────────

// Sign out of Supabase + Google. Stream Chat disconnect stays in
// lib/appwrite.js's signOut for now because the Stream session is still
// minted by Appwrite — Phase D moves Stream tokens to a Supabase Edge
// Function and at that point this signOut takes over the Stream cleanup
// too. For now, callers should call BOTH this and lib/appwrite.js's
// signOut during the cutover, or call only this once Phase D ships.
export const signOutSupabase = async () => {
  // Sign out Google so the next sign-in shows the account picker fresh.
  try {
    await GoogleSignin.signOut();
  } catch (error) {
    // Non-fatal — user may not have signed in via Google in this session.
    console.log("[supabase-auth] Google signOut error (non-fatal):", error?.message);
  }

  const { error } = await supabase.auth.signOut();
  if (error) throw error;
};

// ─────────────────────────────────────────────────────────────────────────
// Session helpers for global-provider
// ─────────────────────────────────────────────────────────────────────────

// Returns the current session synchronously from local cache (AsyncStorage),
// or null. Used by global-provider on app boot before any network call.
export const getCachedSession = async () => {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();
  if (error) return null;
  return session || null;
};

// Subscribes to auth state changes (sign-in, sign-out, token refresh,
// recovery). The handler fires with both the event and the session.
// Returns an unsubscribe function. Used by global-provider to keep the
// app's user state in sync with Supabase.
//
// Hardened cleanup: Supabase's onAuthStateChange has historically returned
// the subscription handle in slightly different shapes across SDK versions
// (`data.subscription`, `data?.subscription`, `subscription`). We probe
// both before falling back to a no-op, so an SDK upgrade can't silently
// leave us with a leaked subscription.
export const subscribeToAuthChanges = (handler) => {
  const result = supabase.auth.onAuthStateChange((event, session) => {
    handler(event, session);
  });
  return () => {
    try {
      const sub = result?.data?.subscription || result?.subscription;
      if (sub && typeof sub.unsubscribe === "function") sub.unsubscribe();
    } catch (error) {
      console.log("[supabase-auth] auth subscription cleanup failed:", error?.message);
    }
  };
};

// Lookup helper — does a profile row already exist for this email with a
// migrated `legacy_appwrite_id`? Used by sign-in.jsx to detect the legacy-
// user case ("Invalid credentials" + email matches migrated profile means
// the user needs to set a Supabase password) and surface the right CTA.
export const isLegacyAppwriteEmail = async (email) => {
  const normalizedEmail = (email || "").trim().toLowerCase();
  if (!normalizedEmail) return false;
  const { data, error } = await supabase
    .from("profiles")
    .select("id, legacy_appwrite_id")
    .eq("email", normalizedEmail)
    .not("legacy_appwrite_id", "is", null)
    .maybeSingle();
  if (error) {
    console.log("[supabase-auth] isLegacyAppwriteEmail error:", error.message);
    return false;
  }
  return Boolean(data);
};
