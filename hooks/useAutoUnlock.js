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
import { useGlobalContext } from "../context/global-provider";
import { USE_SUPABASE_WALLET } from "../lib/feature-flags";
import { VideoUnlocksService, computeNextThresholdSeconds } from "../lib/video-unlocks";
// Phase F.5 — Supabase video unlock path. When the flag is on, the
// hook routes through Supabase's atomic `unlock_video_threshold` RPC
// instead of the Appwrite Cloud Function. The web client uses the
// exact same RPC, so balances + unlocks stay in sync across platforms.
import { getPaidThroughSeconds as getPaidThroughSecondsSupabase, unlockVideoThreshold as unlockVideoThresholdSupabase } from "../lib/wallet-supabase";

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
  // Synchronous companion to showChoiceModalRef. The state-mirrored ref
  // updates only in a useEffect (one render late), so two timeUpdate
  // events firing in the same JS tick — common when a scrub-forward
  // emits both the scrub event and the post-seek settle event — would
  // both observe ref.current=false and each call openChoiceModal,
  // leading to chained modals. This ref is flipped synchronously inside
  // openChoiceModal/closeChoiceModal so the guard is airtight.
  const modalActiveRef = useRef(false);
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
        if (USE_SUPABASE_WALLET) {
          // Prefer the canonical Supabase UUID over the legacy Appwrite
          // hex `$id`. wallet-supabase.getPaidThroughSeconds bails with
          // `0` when the id isn't UUID-shaped, which would silently swallow
          // the resume position for migrated (legacy 541939) videos that
          // still surface their hex ID via `$id`.
          paid = await getPaidThroughSecondsSupabase({ videoId: video?.id || video?.$id });
        } else {
          paid = await videoUnlockService.getPaidThroughSeconds({
            videoId: video?.$id,
            userId: user?.$id,
          });
        }
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
      // Synchronous idempotency guard — the state-backed ref lags by one
      // render, which would otherwise let back-to-back timeUpdate events
      // each open the modal.
      if (modalActiveRef.current) return;
      modalActiveRef.current = true;
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
    modalActiveRef.current = false;
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
      const threshold = nextThresholdRef.current;
      if (!Number.isFinite(threshold)) return; // permanently unlocked

      // Hard clamp on every tick where the playhead is at/past the
      // threshold — DO NOT bail just because the modal is already open.
      // Bailing here was the root cause of the "two modals back-to-back
      // after one scrub" bug: when the user scrubbed to e.g. 15:00 with
      // threshold=180s, the initial pause+seek-to-180 didn't always
      // settle (expo-video's currentTime setter is best-effort), so the
      // player kept ticking from ~900s. After a star-unlock, the player
      // resumed from 900s instead of 180s and IMMEDIATELY tripped the
      // next threshold (780s), forcing the user to dismiss/pay a second
      // modal for the same scrub action. By re-clamping on every tick
      // while we're past threshold, the playhead is dragged back to the
      // boundary regardless of how the underlying native player behaves.
      if (currentTime >= threshold) {
        try {
          player.pause();
          if (typeof player.seek === "function") {
            player.seek(threshold);
          } else {
            player.currentTime = threshold;
          }
        } catch {}
        // openChoiceModal is internally idempotent (modalActiveRef), so
        // calling it on subsequent settle ticks is a no-op.
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

      let res;
      try {
        if (USE_SUPABASE_WALLET) {
          // Phase F.5 — Supabase atomic unlock. The RPC returns
          //   { ok, balance_after, cost, mode: 'permanent' | 'window', error? }
          // We adapt to the legacy `{ success, used, cost, mode }` shape so
          // the rest of the function below stays unchanged.
          let rpc;
          try {
            // Use the canonical Supabase UUID. Legacy Appwrite hex IDs
            // (still surfaced via `$id` for migrated 541939 videos) get
            // rejected by unlock_video_threshold's UUID validator before
            // even hitting Postgres, which would manifest as a silent
            // "modal opens but won't unlock" UX.
            rpc = await unlockVideoThresholdSupabase({
              videoId: video.id || video.$id,
              currency,
              thresholdSeconds: safeThreshold,
            });
          } catch (rpcError) {
            // Network / auth error — distinct from app-level "ok: false".
            // Keep the modal open so the user can retry or pick the
            // other currency. The server enforces idempotency (a
            // double-tap on the same threshold is a no-op or returns
            // already_unlocked), so retries are safe.
            console.log("Supabase unlock_video_threshold RPC threw:", rpcError?.message);
            return false;
          }
          if (!rpc?.ok) {
            res = { success: false, requirePurchase: rpc?.error === "insufficient_balance" };
          } else {
            res = {
              success: true,
              used: currency === "coin" ? "coins" : "stars",
              cost: rpc.cost,
              mode: rpc.mode || (currency === "coin" ? "permanent" : "window"),
            };
          }
        } else {
          res = await videoUnlockService.unlockVideo({
            videoId: video.$id,
            userId: user.$id,
            contentOwnerId: video.uploader,
            currency,
            threshold: safeThreshold,
          });
        }

        if (!res?.success) {
          // Insufficient balance / network error / etc. — keep the modal
          // open so the user can pick the other option, top up, or dismiss.
          // The disabled-button affordance in the modal already conveys
          // "out of balance" when applicable.
          return false;
        }

        // Wallet balances refresh. On Supabase, refetchCoins (refetchBalance)
        // already updates BOTH coin + star state from a single getWallet
        // call, so we skip the redundant refetchStars to avoid two
        // round-trips for the same data. The realtime subscription is the
        // belt-and-suspenders catch-up.
        if (USE_SUPABASE_WALLET) {
          await refetchCoins?.(user.$id);
        } else {
          await refetchStars?.();
          await refetchCoins?.(user.$id);
        }

        // Determine effective mode: prefer the server's signal, fall back to
        // the user's pick.
        const mode =
          res.mode || (res.used === "coins" ? "permanent" : res.used === "stars" ? "window" : currency === "coin" ? "permanent" : "window");

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
          // threshold. Defensive — failures don't block playback. On
          // Supabase the unlock_video_threshold RPC already updated
          // video_progress atomically, so this branch is Appwrite-only.
          if (!USE_SUPABASE_WALLET) {
            videoUnlockService
              .setPaidThroughSeconds({
                videoId: video.$id,
                userId: user.$id,
                seconds: newPaidThrough,
              })
              .catch(() => {});
          }

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
    //
    // Set the dismiss cooldown so any straggler timeUpdate events caused
    // by the close gesture / modal exit animation don't immediately
    // re-pop the modal before the user can react. DISMISS_COOLDOWN_MS is
    // declared above the listener and was previously read-only — without
    // arming it here the cooldown was dead code.
    dismissCooldownUntilRef.current = Date.now() + DISMISS_COOLDOWN_MS;
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

  /* ---------------- Cost rates (per-video → per-app default → 1) ---------------- */
  // Resolution order:
  //   1. video.unlock_cost_coins / unlock_cost_stars — per-video override
  //      set in the studio (mirrors web's monetization editor).
  //   2. globalSettings.default_video_unlock_coins / _stars — app-wide
  //      defaults from public.app_config (synced via global-settings-supabase).
  //   3. Last-resort fallback to 1 so the modal still renders something.
  //
  // The previous implementation hit Appwrite's coinDeductionCollection
  // with `databases.listDocuments`. Post-Supabase-auth cutover the
  // Appwrite session no longer exists, so that call 401s and the
  // catch silently bottoms out to 1/1 — the modal would show a
  // misleading "1 coin / 1 star" cost. Reading from Supabase columns
  // and app_config keeps rates accurate.
  useEffect(() => {
    const parseRate = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    const perVideoCoin = parseRate(video?.unlock_cost_coins);
    const perVideoStar = parseRate(video?.unlock_cost_stars);
    const defaultCoin =
      parseRate(globalSettings?.default_video_unlock_coins) ??
      parseRate(globalSettings?.["default_video_unlock_coins"]) ??
      parseRate(globalSettings?.DEFAULT_VIDEO_UNLOCK_COINS) ??
      1;
    const defaultStar =
      parseRate(globalSettings?.default_video_unlock_stars) ??
      parseRate(globalSettings?.["default_video_unlock_stars"]) ??
      parseRate(globalSettings?.DEFAULT_VIDEO_UNLOCK_STARS) ??
      1;

    setCoinRate(perVideoCoin ?? defaultCoin);
    setStarRate(perVideoStar ?? defaultStar);
  }, [video?.unlock_cost_coins, video?.unlock_cost_stars, globalSettings]);

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
