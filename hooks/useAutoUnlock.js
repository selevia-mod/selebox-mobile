// Mobile mirror of the web's Phase 6 video monetization gate.
//
// Web reference: js/app.js → setupVideoMonetGate / openVideoMonetThresholdDialog.
// Behavior we replicate:
//   • First paid threshold lands at `initialSec` (default 180s = 3 min).
//   • At every threshold, pause the player and ask the user to pick a
//     currency. Coin = permanent unlock (never prompted again on this video).
//     Star = pays for the next `recurringSec` (default 600s = 10 min) only,
//     then re-prompts at the next threshold.
//   • Re-watching below `paid_through_seconds` is free — `computeNextThreshold`
//     returns the first threshold AFTER the paid mark, so resumes don't
//     double-charge.
//   • Cancelling the modal leaves the player paused. Pressing play crosses
//     the threshold again → re-prompts. (No retry timers; the listener does
//     all the work.)
//
// Differences from web noted inline. Public API is preserved enough that
// `video-player.jsx` only needs minor wiring changes (mount the choice modal,
// drop the floating "Unlock now" pill).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Dimensions } from "react-native";
import { Query } from "react-native-appwrite";
import { useGlobalContext } from "../context/global-provider";
import { appwriteConfig, databases } from "../lib/appwrite";
import { VideoUnlocksService, computeNextThresholdSeconds } from "../lib/video-unlocks";

const DEFAULT_INITIAL_SECONDS = 180;
const DEFAULT_RECURRING_SECONDS = 600;
const PERMANENTLY_UNLOCKED = Number.POSITIVE_INFINITY;

export default function useAutoUnlock({
  player,
  user,
  video,
  isUnlocked,
  monetizationActive = false,
  refetchCoins,
  refetchStars,
  onUnlocked,
  onOpenStore,
  autoUnlockEnabled = true,
}) {
  /* ---------------- Public state ---------------- */
  const [showChoiceModal, setShowChoiceModal] = useState(false);
  const [modalThreshold, setModalThreshold] = useState(DEFAULT_INITIAL_SECONDS);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [loadingCurrency, setLoadingCurrency] = useState(null); // "coin" | "star" | null
  const [paidThroughSeconds, setPaidThroughSeconds] = useState(0);
  const [starRate, setStarRate] = useState(1);
  const [coinRate, setCoinRate] = useState(1);

  /* ---------------- Refs (closure-stable signals for the listener) ---------------- */
  const showChoiceModalRef = useRef(false);
  const isUnlockingRef = useRef(false);
  const nextThresholdRef = useRef(DEFAULT_INITIAL_SECONDS);
  const sessionStartedRef = useRef(false);

  const { globalSettings } = useGlobalContext();
  const videoUnlockService = useMemo(() => new VideoUnlocksService(), []);

  /* ---------------- Tunables (read from app_config / globalSettings) ---------------- */
  const initialSec = useMemo(() => {
    // Reads in preference order:
    //   1. `VIDEO_UNLOCK_TIME` — current admin-panel key on Appwrite. Was
    //      historically 120 (the old 2-min pill), now updated to 180 by
    //      the team. Single source of truth until the Supabase migration.
    //   2. `video_initial_unlock_seconds` — web-side snake_case key, kept
    //      as a forward-compat alias for after the migration.
    //   3. `VIDEO_INITIAL_UNLOCK_SECONDS` — uppercase mirror of (2).
    // Falls back to 180 if none are set or all are unparseable.
    const candidates = [
      globalSettings?.["VIDEO_UNLOCK_TIME"],
      globalSettings?.VIDEO_UNLOCK_TIME,
      globalSettings?.["video_initial_unlock_seconds"],
      globalSettings?.video_initial_unlock_seconds,
      globalSettings?.["VIDEO_INITIAL_UNLOCK_SECONDS"],
    ];
    for (const v of candidates) {
      const parsed = Number(v);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return DEFAULT_INITIAL_SECONDS;
  }, [globalSettings]);

  const recurringSec = useMemo(() => {
    // Mirror the web's `video_recurring_unlock_seconds`. Fallback to 600.
    const candidates = [globalSettings?.["VIDEO_RECURRING_UNLOCK_SECONDS"], globalSettings?.VIDEO_RECURRING_UNLOCK_SECONDS];
    for (const v of candidates) {
      const parsed = Number(v);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return DEFAULT_RECURRING_SECONDS;
  }, [globalSettings]);

  /* ---------------- Mirror state into refs ---------------- */
  useEffect(() => {
    showChoiceModalRef.current = showChoiceModal;
  }, [showChoiceModal]);
  useEffect(() => {
    isUnlockingRef.current = isUnlocking;
  }, [isUnlocking]);

  /* ---------------- Session seeding ---------------- */
  // Fetch paid_through once per video, compute the initial threshold.
  // Re-evaluating on isUnlocked flips would clobber post-payment state, so
  // sessionStartedRef gates it.
  useEffect(() => {
    if (sessionStartedRef.current) return;
    if (!monetizationActive) return;

    sessionStartedRef.current = true;

    (async () => {
      if (isUnlocked) {
        // Already permanently unlocked from a prior session — no thresholds.
        nextThresholdRef.current = PERMANENTLY_UNLOCKED;
        setModalThreshold(initialSec);
        setPaidThroughSeconds(0);
        return;
      }

      let paid = 0;
      try {
        paid = await videoUnlockService.getPaidThroughSeconds({
          videoId: video?.$id,
          userId: user?.$id,
        });
      } catch {
        paid = 0;
      }

      setPaidThroughSeconds(paid);
      const next = computeNextThresholdSeconds(paid, { initialSec, recurringSec });
      nextThresholdRef.current = next;
      setModalThreshold(next);
    })();
  }, [monetizationActive, isUnlocked, initialSec, recurringSec, video?.$id, user?.$id, videoUnlockService]);

  /* ---------------- Modal helpers ---------------- */
  const openChoiceModal = useCallback(
    (threshold) => {
      // Pause first so the playhead doesn't drift during the user's decision
      // window — keeps the audio cue tight and prevents re-firing while the
      // modal is mid-animation.
      try {
        player?.pause();
      } catch {}
      setModalThreshold(threshold);
      setShowChoiceModal(true);
    },
    [player],
  );

  const closeChoiceModal = useCallback(() => {
    setShowChoiceModal(false);
    setLoadingCurrency(null);
  }, []);

  /* ---------------- Time tracking ---------------- */
  // expo-video can emit `timeUpdate` events even while the player is paused —
  // sometimes a single trailing tick after a pause/seek, sometimes repeated
  // ticks with currentTime jittering by 50–500 ms as the player settles.
  // Two layers of defense:
  //   1. `lastSeenTimeRef` — skip ticks where the playhead hasn't actually
  //      moved by a non-trivial amount.
  //   2. `dismissCooldownUntilRef` — after the user closes the modal, hard
  //      gate the listener for 1500 ms so any straggler timeUpdate events
  //      caused by the close gesture / seek settling can't immediately
  //      re-pop the modal. Long enough to swallow the jitter, short enough
  //      that intentional "tap close, then tap play" still gets the next
  //      prompt naturally.
  const lastSeenTimeRef = useRef(-Infinity);
  const dismissCooldownUntilRef = useRef(0);
  const DISMISS_COOLDOWN_MS = 1500;

  // Listener attaches whenever monetization is active and the video isn't
  // permanently unlocked yet. We don't bail on `isUnlocked` because under the
  // star (window) model the parent flips isUnlocked=true after every payment
  // but the listener still needs to keep watching for the NEXT threshold.
  useEffect(() => {
    if (!player || !monetizationActive || !autoUnlockEnabled) return;

    const sub = player.addListener("timeUpdate", ({ currentTime }) => {
      // Hard cooldown — swallows everything for ~1.5s after a dismiss.
      if (Date.now() < dismissCooldownUntilRef.current) return;

      // Skip static ticks. 100ms tolerance covers floating-point jitter and
      // settle-after-seek noise on Android; real playback advancement
      // accumulates past this between ticks within a few hundred ms.
      if (Math.abs(currentTime - lastSeenTimeRef.current) < 0.1) return;
      lastSeenTimeRef.current = currentTime;

      if (isUnlockingRef.current) return;
      if (showChoiceModalRef.current) return;
      const threshold = nextThresholdRef.current;
      if (!Number.isFinite(threshold)) return; // permanently unlocked

      if (currentTime >= threshold) {
        // Hard clamp the playhead at the threshold so the user can't
        // fast-forward past unbilled content. We resume in handleChoice on
        // success.
        try {
          player.pause();
          if (typeof player.seek === "function") {
            player.seek(threshold);
          } else {
            player.currentTime = threshold;
          }
        } catch {}
        openChoiceModal(threshold);
      }
    });

    return () => sub?.remove();
  }, [player, monetizationActive, autoUnlockEnabled, openChoiceModal]);

  /* ---------------- Choice handler ---------------- */
  const handleChoice = useCallback(
    async (currency) => {
      if (isUnlockingRef.current) return false;
      if (!user || !video) return false;
      if (currency !== "coin" && currency !== "star") return false;

      const threshold = nextThresholdRef.current;
      const safeThreshold = Number.isFinite(threshold) ? threshold : initialSec;

      isUnlockingRef.current = true;
      setIsUnlocking(true);
      setLoadingCurrency(currency);

      try {
        const res = await videoUnlockService.unlockVideo({
          videoId: video.$id,
          userId: user.$id,
          contentOwnerId: video.uploader,
          currency,
          threshold: safeThreshold,
        });

        if (!res?.success) {
          // Insufficient balance / network error / etc. — keep the modal
          // open so the user can pick the other option, top up, or dismiss.
          // The disabled-button affordance in the modal already conveys
          // "out of balance" when applicable.
          return false;
        }

        // Wallet balances refresh — both currencies, since the server may
        // have charged either one (until backend honors the `currency` param).
        await refetchStars?.();
        await refetchCoins?.(user.$id);

        // Determine effective mode: prefer the server's signal, fall back to
        // the user's pick.
        const mode = res.mode || (res.used === "coins" ? "permanent" : res.used === "stars" ? "window" : currency === "coin" ? "permanent" : "window");

        if (mode === "permanent") {
          // Coin path — never prompt again on this video.
          nextThresholdRef.current = PERMANENTLY_UNLOCKED;
          onUnlocked?.();
        } else {
          // Star path — paid through end of this window; advance to next
          // threshold via the same `computeNext` math the web uses.
          const newPaidThrough = safeThreshold + recurringSec - 1;
          setPaidThroughSeconds(newPaidThrough);
          const next = computeNextThresholdSeconds(newPaidThrough, { initialSec, recurringSec });
          nextThresholdRef.current = next;
          setModalThreshold(next);

          // Persist server-side so the next session resumes at the right
          // threshold. Defensive — failures don't block playback.
          videoUnlockService
            .setPaidThroughSeconds({
              videoId: video.$id,
              userId: user.$id,
              seconds: newPaidThrough,
            })
            .catch(() => {});

          // Flip isUnlocked so the locked-overlay UI dismisses for the
          // duration of the window. The listener will re-prompt at the next
          // threshold regardless.
          onUnlocked?.();
        }

        // Close the modal and resume playback from the threshold mark we
        // clamped to before opening it.
        closeChoiceModal();
        try {
          player?.play();
        } catch {}

        return true;
      } catch (err) {
        console.error("Threshold unlock failed:", err);
        return false;
      } finally {
        isUnlockingRef.current = false;
        setIsUnlocking(false);
        setLoadingCurrency(null);
      }
    },
    [user, video, initialSec, recurringSec, refetchStars, refetchCoins, onUnlocked, closeChoiceModal, player, videoUnlockService],
  );

  const handleCancel = useCallback(() => {
    // User dismissed the modal. Player stays paused (we already paused on
    // open). When they hit play, the timeUpdate listener crosses the
    // threshold again and re-opens the modal — same UX as the web.
    closeChoiceModal();
  }, [closeChoiceModal]);

  /* ---------------- Manual / external trigger ---------------- */
  // Used by the download flow ("must unlock first") and any other surface that
  // wants to force the choice modal to appear regardless of playhead position.
  const manualUnlock = useCallback(async () => {
    if (isUnlockingRef.current) return false;
    if (!Number.isFinite(nextThresholdRef.current)) return true; // already permanently unlocked
    openChoiceModal(nextThresholdRef.current);
    return false; // caller should treat the open-modal as "user decision pending"
  }, [openChoiceModal]);

  /* ---------------- Resets ---------------- */
  useEffect(() => {
    if (monetizationActive) return;
    closeChoiceModal();
    nextThresholdRef.current = DEFAULT_INITIAL_SECONDS;
    setModalThreshold(DEFAULT_INITIAL_SECONDS);
    setPaidThroughSeconds(0);
  }, [monetizationActive, closeChoiceModal]);

  useEffect(() => {
    if (autoUnlockEnabled) return;
    closeChoiceModal();
  }, [autoUnlockEnabled, closeChoiceModal]);

  // Switching to a new video resets the entire flow.
  useEffect(() => {
    sessionStartedRef.current = false;
    nextThresholdRef.current = DEFAULT_INITIAL_SECONDS;
    setModalThreshold(DEFAULT_INITIAL_SECONDS);
    setPaidThroughSeconds(0);
    lastSeenTimeRef.current = -Infinity;
    closeChoiceModal();
  }, [video?.$id, closeChoiceModal]);

  /* ---------------- Cost rates (per-genre) ---------------- */
  // Same lookup as before so creators can override default costs per genre.
  // The modal reads coinCost / starCost from these values.
  useEffect(() => {
    const fetchRates = async () => {
      if (!video?.tags || video?.tags.length === 0) {
        setStarRate(1);
        setCoinRate(1);
        return;
      }
      try {
        const genreTag = (video.tags[video.tags.length - 1] || "others").toLowerCase();
        let res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.coinDeductionCollectionId, [
          Query.equal("genre", genreTag),
        ]);

        if (res.total === 0) {
          res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.coinDeductionCollectionId, [Query.equal("genre", "others")]);
        }

        const doc = res.documents?.[0];
        setStarRate(Number(doc?.starDeduction || 1));
        setCoinRate(Number(doc?.coinDeduction || 1));
      } catch (err) {
        console.error("Failed to fetch deduction rates", err?.message || err);
        setStarRate(1);
        setCoinRate(1);
      }
    };

    fetchRates();
  }, [video?.tags]);

  const resetUnlockFlow = useCallback(() => {
    closeChoiceModal();
  }, [closeChoiceModal]);

  /* ---------------- Backward-compat exports (kept so video-player doesn't
       break before its JSX is updated). The banner / countdown / pill paths
       are dead under the new model, but exporting null/no-op shapes keeps
       any consumer destructure safe. ---------------- */
  const dummyAnim = useRef(new Animated.Value(0)).current;
  const dummyTranslate = useRef(new Animated.Value(Dimensions.get("window").width)).current;
  const noop = useCallback(() => {}, []);

  return {
    // ── New, threshold-model API ──────────────────────────────────────
    showChoiceModal,
    modalThreshold,
    paidThroughSeconds,
    initialUnlockSeconds: initialSec,
    recurringSeconds: recurringSec,
    starRate,
    coinRate,
    loadingCurrency,
    handleChoice,
    handleCancel,
    manualUnlock,
    resetUnlockFlow,
    isUnlocking,

    // ── Legacy banner / countdown / early-CTA (now no-ops) ────────────
    bannerMessage: "",
    bannerOpacity: dummyAnim,
    bannerTranslateX: dummyTranslate,
    onBannerContainerLayout: noop,
    onBannerContentSizeChange: noop,
    bannerTextWidth: 0,
    showBanner: false,
    countdown: null,
    isPurchaseBlocked: false,
    canUnlockEarly: false,
  };
}
