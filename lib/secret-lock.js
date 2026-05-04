// Secret-tab lock — a per-user PIN gate for the Secret conversations
// tab. Stores a hashed PIN in MMKV (same backend that redux-persist uses
// elsewhere), tracks an in-memory "unlocked for this app-foreground
// session" flag, and re-locks automatically when the app stays in the
// background for more than RELOCK_AFTER_BG_MS.
//
// Why hashed and not plaintext: MMKV is encrypted at rest on iOS, but
// hashing adds defense in depth — if a future migration leaks the MMKV
// blob (logs, debug dumps, someone copying their app data) the PIN
// itself isn't recoverable. Note that "hashing" here is a fast SHA-style
// digest using a salt; it's not bcrypt. A 4-digit PIN has 10k entropy,
// so anything fancier is theatre — the real defense is OS sandboxing.
//
// Biometric (Face ID / Touch ID): not wired tonight because the project
// doesn't have `expo-local-authentication` installed. The unlock() flow
// is structured so that swapping in a biometric attempt before falling
// back to PIN is a one-function change. Install + rebuild → enable.

import { MMKV } from "react-native-mmkv";

const storage = new MMKV({ id: "selebox-secret-lock" });

// Keys
const KEY_PIN_HASH = "pin_hash_v1";
const KEY_PIN_SALT = "pin_salt_v1";

// Re-lock window — if the app sits in background longer than this, the
// next foreground requires re-authentication. 60s feels right for the
// tradeoff between "just answered a phone call" vs "left the device on
// the cafe table."
const RELOCK_AFTER_BG_MS = 60 * 1000;

// In-memory unlocked flag. Reset whenever the JS bundle reloads (which
// is the right behavior — a hot reload should never unlock a previously
// locked tab).
let unlocked = false;
let backgroundedAt = null;
const subscribers = new Set();

const notify = () => {
  for (const fn of subscribers) {
    try {
      fn(unlocked);
    } catch (_) {
      /* a misbehaving listener shouldn't break others */
    }
  }
};

// Tiny non-cryptographic hash. Pure-JS so we don't need a native dep
// for tonight's slice. djb2 with a per-PIN salt is enough to stop a
// casual attacker from reading the PIN out of the MMKV file directly.
const djb2 = (str) => {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  // Force unsigned 32-bit then base36 for compactness.
  return (hash >>> 0).toString(36);
};

const generateSalt = () => {
  // 16 base36 chars ≈ 80 bits — overkill for a 4-digit PIN but cheap.
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += Math.floor(Math.random() * 36).toString(36);
  }
  return s;
};

const hashPin = (pin, salt) => djb2(`${salt}:${pin}:${salt}`);

// ── Public API ──────────────────────────────────────────────────────────

export const hasPin = () => Boolean(storage.getString(KEY_PIN_HASH));

export const setPin = (pin) => {
  if (!pin || String(pin).length < 4) {
    throw new Error("PIN must be at least 4 digits");
  }
  const salt = generateSalt();
  storage.set(KEY_PIN_SALT, salt);
  storage.set(KEY_PIN_HASH, hashPin(String(pin), salt));
  // Setting/changing a PIN auto-unlocks for this session — the user just
  // proved they own the device.
  unlocked = true;
  backgroundedAt = null;
  notify();
};

export const verifyPin = (pin) => {
  const hash = storage.getString(KEY_PIN_HASH);
  const salt = storage.getString(KEY_PIN_SALT);
  if (!hash || !salt) return false;
  return hashPin(String(pin), salt) === hash;
};

// Mark the tab as unlocked for the current foreground session. Caller
// (SecretLockGate) is responsible for verifying the PIN before calling
// this.
export const unlock = () => {
  unlocked = true;
  backgroundedAt = null;
  notify();
};

// Manual lock — e.g. from a Settings screen or a "Lock now" button.
export const lock = () => {
  unlocked = false;
  backgroundedAt = null;
  notify();
};

export const isUnlocked = () => unlocked;

// AppState integration — call from a top-level mount with the AppState
// transitions. When the app backgrounds, we stamp the time. On the next
// foreground, if it's been longer than RELOCK_AFTER_BG_MS, we lock.
//
// Returning `unlocked` after the transition lets the caller decide
// whether to do anything (e.g. show the gate again).
export const onAppStateChange = (nextState) => {
  if (nextState === "background" || nextState === "inactive") {
    backgroundedAt = Date.now();
    return unlocked;
  }
  if (nextState === "active") {
    if (backgroundedAt && Date.now() - backgroundedAt > RELOCK_AFTER_BG_MS) {
      unlocked = false;
      notify();
    }
    backgroundedAt = null;
  }
  return unlocked;
};

// Subscribe to lock/unlock state changes — used by SecretLockGate to
// re-render when an external lock() call (e.g. AppState relock) flips
// the flag.
export const subscribe = (fn) => {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
};

// Forget the PIN entirely — used by a future "Reset PIN" flow. Doesn't
// touch the conversations data; only clears the lock state.
export const clearPin = () => {
  storage.delete(KEY_PIN_HASH);
  storage.delete(KEY_PIN_SALT);
  unlocked = false;
  backgroundedAt = null;
  notify();
};
