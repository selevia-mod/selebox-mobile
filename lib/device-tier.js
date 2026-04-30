// Device tier detection — Phase E.1.
//
// What this is:
//   A small probe that reads the device's total RAM + OS at startup,
//   classifies it into one of three tiers ("low" / "mid" / "high"), and
//   exposes the result synchronously to any caller. The tier is the
//   single signal we use to gate expensive UX (feed video autoplay,
//   complex Reanimated transitions, full-res image variants) so older
//   phones don't thrash or thermal-throttle through normal use.
//
// Why total RAM + OS (not e.g. CPU benchmarking):
//   - It's a stable signal that never changes per session, so we can
//     cache the answer and never re-probe.
//   - expo-device already exposes it cross-platform with no native
//     rebuild, so this module is OTA-safe.
//   - It correlates well with device generation in practice — RAM
//     budgets track GPU/CPU generations on both Apple and Android.
//   - FPS sampling at runtime is jittery (one expensive layout pass
//     skews the average) and adds debouncing complexity for no win.
//
// Per-platform thresholds:
//   iOS
//     - low:  ≤ 2 GB   (iPhone 6/6s/7/SE 1st gen, iPad mini 4)
//     - mid:  3 GB or 4 GB  (iPhone 8/X/XR/SE 2nd-3rd gen, iPad 6-9)
//     - high: ≥ 5 GB  (iPhone 11 Pro and newer flagships)
//   Android
//     - low:  ≤ 4 GB OR Android (Go edition)
//     - mid:  5–8 GB
//     - high: ≥ 9 GB
//
// API:
//   - getDeviceTier()         → 'low' | 'mid' | 'high'  (sync, cached)
//   - useDeviceTier()         → React hook returning the same string
//   - isLowTier()             → boolean shortcut
//   - prefersReducedMotion()  → boolean — currently aliases isLowTier().
//                                A future revision can fold in the system's
//                                AccessibilityInfo.isReduceMotionEnabled()
//                                preference here so callers don't have to
//                                check both.
//   - getDeviceTierSnapshot() → { tier, ramBytes, ramGB, osName, isAndroidGo }
//                                for diagnostics / settings screen
//
// Failure mode:
//   If expo-device returns nothing (e.g. emulator, very old runtime) we
//   default to "mid" — never to "low" or "high". This is the
//   conservative midpoint: we don't accidentally degrade UX on a real
//   flagship just because the probe hiccupped, and we don't enable
//   autoplay on a phone that can't handle it.

import { useEffect, useState } from "react";
import * as Device from "expo-device";
import { Platform } from "react-native";

const BYTES_PER_GB = 1024 * 1024 * 1024;

// One-time probe — populated lazily on first call to getDeviceTier()
// (or eagerly when the global provider boots). Subsequent reads are
// just an object lookup.
let cachedSnapshot = null;

const buildSnapshot = () => {
  // Device.totalMemory returns total RAM in bytes. May be 0 / undefined
  // on simulators or unsupported runtimes — the classifier handles that.
  const ramBytes = Number(Device.totalMemory) || 0;
  const ramGB = ramBytes ? ramBytes / BYTES_PER_GB : 0;
  const osName = Device.osName || Platform.OS;
  // Android Go is a memory-constrained variant of Android (originally
  // for ≤ 1 GB devices, now ≤ 2 GB). expo-device exposes
  // `isLowRamDevice` on Android — we prefer that over heuristics.
  const isAndroidGo = Platform.OS === "android" && Boolean(Device.isLowRamDevice);

  return {
    ramBytes,
    ramGB,
    osName,
    isAndroidGo,
    tier: classifyTier({ ramGB, osName, isAndroidGo }),
  };
};

const classifyTier = ({ ramGB, osName, isAndroidGo }) => {
  // Probe failed (RAM unknown). Default to mid — see "Failure mode" up top.
  if (!ramGB) return "mid";

  const isIOS = osName === "iOS" || osName === "iPadOS" || Platform.OS === "ios";
  const isAndroid = osName === "Android" || Platform.OS === "android";

  if (isIOS) {
    if (ramGB <= 2.5) return "low"; // ≤ 2 GB — RAM reads vary slightly, give the upper bound a touch of slack
    if (ramGB <= 4.5) return "mid"; // 3 GB or 4 GB — iPhone 8/X/XR/SE
    return "high"; // ≥ 5 GB — iPhone 11 Pro+
  }

  if (isAndroid) {
    if (isAndroidGo) return "low"; // Android Go regardless of RAM
    if (ramGB <= 4.5) return "low"; // ≤ 4 GB — entry-level Androids
    if (ramGB <= 8.5) return "mid"; // 5–8 GB
    return "high"; // ≥ 9 GB
  }

  // Unknown platform — be conservative.
  return "mid";
};

// Returns the cached tier, probing once on first call. Safe to call from
// anywhere, including outside React (e.g., inside a service module).
export const getDeviceTier = () => {
  if (!cachedSnapshot) cachedSnapshot = buildSnapshot();
  return cachedSnapshot.tier;
};

// Forces a fresh probe. Only useful if some upstream code (like the
// emulator switching during a hot-reload) changes Device.totalMemory
// mid-session. Real users never need this.
export const refreshDeviceTier = () => {
  cachedSnapshot = buildSnapshot();
  return cachedSnapshot.tier;
};

// Full snapshot for diagnostics — settings screen, debug panel, etc.
// Includes the raw ramBytes/ramGB so a "tap-to-reveal" debug UI can
// surface "iPhone 12 Pro · 6.0 GB · high tier" without a re-probe.
export const getDeviceTierSnapshot = () => {
  if (!cachedSnapshot) cachedSnapshot = buildSnapshot();
  return cachedSnapshot;
};

// Boolean shortcuts for the most common gates. Inlined logic at call
// sites is fine too; these just keep the intent legible.
export const isLowTier = () => getDeviceTier() === "low";
export const isMidTier = () => getDeviceTier() === "mid";
export const isHighTier = () => getDeviceTier() === "high";

// "Should we skip lush animations?" — currently aliases isLowTier().
// Later we can fold in AccessibilityInfo's reduce-motion preference
// (the user toggling Reduce Motion in iOS / Android settings) so
// callers always go through one check. The function name reflects
// that future contract.
export const prefersReducedMotion = () => isLowTier();

// Returns FlashList configuration appropriate for the given tier.
// Centralized so every list in the app can adopt the same low-tier
// trade-offs in one line — the alternative (`isLowTier()` ? ... : ...)
// scattered across screens drifts out of sync the moment someone
// adjusts a number for one list and forgets the others.
//
//   drawDistance:
//     The pixel distance ahead/behind the viewport that FlashList
//     keeps rendered. Smaller = fewer mounted rows = less RAM. We cut
//     it ~60% on low tier (1 screen vs 2.4 screens worth).
//
//   removeClippedSubviews:
//     On Android this physically detaches off-screen views from the
//     window manager, freeing native memory. It can cause a tiny
//     flicker on re-attach which is why mid/high keep it off, but on
//     low-tier the memory headroom matters more than the flicker.
//
//   onEndReachedThreshold:
//     How early to fire pagination relative to list length. Slightly
//     more aggressive on low-tier so we hide the network round-trip
//     behind the user's still-coming scroll momentum.
//
// Callers pass `screenHeight` (Dimensions.get('window').height) so we
// can derive drawDistance in pixels without the helper having to import
// react-native at module scope.
export const getFlashListConfig = ({ screenHeight, tier = getDeviceTier() } = {}) => {
  const baseScreen = Number.isFinite(screenHeight) && screenHeight > 0 ? screenHeight : 800;
  if (tier === "low") {
    return {
      drawDistance: Math.round(baseScreen * 1.0),
      removeClippedSubviews: true,
      onEndReachedThreshold: 1.5,
    };
  }
  if (tier === "mid") {
    return {
      drawDistance: Math.round(baseScreen * 1.8),
      removeClippedSubviews: false,
      onEndReachedThreshold: 1.2,
    };
  }
  // high
  return {
    drawDistance: Math.round(baseScreen * 2.4),
    removeClippedSubviews: false,
    onEndReachedThreshold: 1.1,
  };
};

// FlatList counterpart to getFlashListConfig — same idea, different
// prop names. FlatList exposes windowSize (number of viewport heights
// rendered ahead+behind) instead of drawDistance, plus
// initialNumToRender / maxToRenderPerBatch which let us throttle
// first-paint and batch sizes on slow devices.
//
// Used by surfaces that haven't moved to FlashList yet (e.g.
// SupabaseConversationsList). FlashList feeds should prefer
// getFlashListConfig.
export const getFlatListConfig = ({ tier = getDeviceTier() } = {}) => {
  if (tier === "low") {
    return {
      windowSize: 5,
      initialNumToRender: 6,
      maxToRenderPerBatch: 5,
      removeClippedSubviews: true,
      onEndReachedThreshold: 1.5,
    };
  }
  if (tier === "mid") {
    return {
      windowSize: 11,
      initialNumToRender: 10,
      maxToRenderPerBatch: 10,
      removeClippedSubviews: false,
      onEndReachedThreshold: 1.2,
    };
  }
  // high — FlatList defaults are fine here, but we surface them
  // explicitly so callers don't need to remember which props to omit.
  return {
    windowSize: 21,
    initialNumToRender: 10,
    maxToRenderPerBatch: 10,
    removeClippedSubviews: false,
    onEndReachedThreshold: 1.0,
  };
};

// React hook — returns the current tier. Probes once on mount via the
// useState initializer (which runs synchronously, so the first paint
// already has the correct value). The follow-up useEffect re-reads
// the cached value once in case the module loaded before expo-device
// finished initializing — empty deps so it runs exactly once on
// mount, not on every state change.
export const useDeviceTier = () => {
  const [tier, setTier] = useState(() => getDeviceTier());
  useEffect(() => {
    const next = getDeviceTier();
    if (next !== tier) setTier(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return tier;
};
