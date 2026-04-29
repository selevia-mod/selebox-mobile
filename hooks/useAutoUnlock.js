import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Dimensions, Easing } from "react-native";
import { Query } from "react-native-appwrite";
import { appwriteConfig, databases } from "../lib/appwrite";
import { VideoUnlocksService } from "../lib/video-unlocks";
import { useGlobalContext } from "../context/global-provider";

const DEFAULT_UNLOCK_TIME_SECONDS = 180;

function formatUnlockTime(seconds) {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function buildUnlockTiming(seconds) {
  const unlockTime = Math.max(seconds, 1);
  return {
    unlockTime,
    reminderStart: Math.max(unlockTime - 15, 0),
    reminderEnd: Math.max(unlockTime - 5, 0),
    countdownStart: Math.max(unlockTime - 4, 0),
    seekBeforeUnlock: Math.max(unlockTime - 5, 0),
    label: formatUnlockTime(unlockTime),
  };
}

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
  const [bannerMessage, setBannerMessage] = useState("");
  const [showBanner, setShowBanner] = useState(false);
  const [countdown, setCountdown] = useState(null);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [isPurchaseBlocked, setIsPurchaseBlocked] = useState(false);
  const lastBannerRef = useRef({ key: null, ts: 0 });
  const [starRate, setStarRate] = useState(1);
  const [coinRate, setCoinRate] = useState(1);
  const [bannerTextWidth, setBannerTextWidth] = useState(0);
  const [bannerContainerWidth, setBannerContainerWidth] = useState(Dimensions.get("window").width);

  const bannerOpacity = useRef(new Animated.Value(0)).current;
  const bannerTranslateX = useRef(new Animated.Value(0)).current;
  const marqueeAnimRef = useRef(null);
  const windowWidth = useRef(Dimensions.get("window").width).current;
  const hideTimeoutRef = useRef(null);
  const allowBannerAfterUnlockRef = useRef(false);

  // 🔒 One-shot guards
  const hasAttemptedUnlock = useRef(false);

  const videoUnlockService = new VideoUnlocksService();
  const { globalSettings } = useGlobalContext();
  const unlockTimeSetting = globalSettings?.["VIDEO_UNLOCK_TIME"] ?? globalSettings?.VIDEO_UNLOCK_TIME;

  const unlockTiming = useMemo(() => {
    const parsed = Number(unlockTimeSetting);
    const unlockTimeSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_UNLOCK_TIME_SECONDS;
    return buildUnlockTiming(unlockTimeSeconds);
  }, [unlockTimeSetting]);

  const { unlockTime, reminderStart, reminderEnd, countdownStart, seekBeforeUnlock, label: unlockDurationLabel } = unlockTiming;

  /* ---------------- UI helpers ---------------- */
  const stopBannerMarquee = () => {
    marqueeAnimRef.current?.stop();
    marqueeAnimRef.current = null;
    bannerTranslateX.setValue(bannerContainerWidth || windowWidth);
  };

  const startBannerMarquee = (text, textWidth = bannerTextWidth, containerWidth = bannerContainerWidth) => {
    const viewportWidth = containerWidth || windowWidth;
    const contentWidth = Math.max(textWidth || viewportWidth, 1);
    const gap = 32; // space after text before it re-enters
    const distance = contentWidth + gap + viewportWidth; // ensure full text + gap scrolls through viewport
    const duration = 14000;

    stopBannerMarquee();
    bannerTranslateX.setValue(viewportWidth);

    marqueeAnimRef.current = Animated.loop(
      Animated.timing(bannerTranslateX, {
        toValue: -contentWidth - gap,
        duration,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
      { resetBeforeIteration: true },
    );

    marqueeAnimRef.current.start();

    return duration;
  };

  const fadeIn = () => {
    Animated.timing(bannerOpacity, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
  };

  const clearHideTimeout = () => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  };

  const fadeOut = () => {
    clearHideTimeout();
    Animated.timing(bannerOpacity, {
      toValue: 0,
      duration: 300,
      useNativeDriver: true,
    }).start(() => {
      stopBannerMarquee();
      setShowBanner(false);
      allowBannerAfterUnlockRef.current = false;
    });
  };

  const showBannerText = (text, duration = 4000, key = text) => {
    const now = Date.now();
    if (lastBannerRef.current.key === key && now - lastBannerRef.current.ts < duration) return; // prevent flicker
    lastBannerRef.current = { key, ts: now };
    setBannerMessage(text);
    setShowBanner(true);
    const marqueeDuration = startBannerMarquee(text, bannerTextWidth, bannerContainerWidth);
    fadeIn();
    clearHideTimeout();
    const autoHideDuration = Math.max(duration, marqueeDuration);
    hideTimeoutRef.current = setTimeout(fadeOut, autoHideDuration);
  };

  /* ---------------- Unlock logic ---------------- */
  const handleUnlock = async () => {
    // ❌ hard stop conditions
    if (hasAttemptedUnlock.current || !user || !video || isUnlocked || !monetizationActive || isPurchaseBlocked) {
      return false;
    }

    hasAttemptedUnlock.current = true; // 🔒 lock immediately
    setIsUnlocking(true);

    try {
      const res = await videoUnlockService.unlockVideo({
        videoId: video.$id,
        userId: user.$id,
        contentOwnerId: video.uploader,
      });

      // ❌ Not enough balance → open store (NO retry)
      if (!res?.success) {
        if (res?.requirePurchase) {
          onOpenStore?.();
          setCountdown(null);
          setShowBanner(false);
          setIsPurchaseBlocked(true);
          try {
            player?.pause();
            player?.seek?.(seekBeforeUnlock);
          } catch {}
          hasAttemptedUnlock.current = true; // block repeated calls until user retries
        }
        return false;
      }

      // ✅ Success
      await refetchStars?.();
      await refetchCoins?.(user.$id);

      onUnlocked?.();
      setIsPurchaseBlocked(false);
      setCountdown(null);
      allowBannerAfterUnlockRef.current = true;
      setTimeout(() => {
        showBannerText("❤️ Your support makes a difference! Thanks for helping your favorite creator.", 10000, "successPurchase");
      }, 1000);
      return true;
    } catch (err) {
      console.error("Unlock failed:", err);
      return false;
    } finally {
      setIsUnlocking(false);
    }
  };

  /* ---------------- Time tracking ---------------- */
  useEffect(() => {
    if (!player || !monetizationActive || isUnlocked || !autoUnlockEnabled) return;

    const sub = player.addListener("timeUpdate", ({ currentTime }) => {
      if (hasAttemptedUnlock.current || isPurchaseBlocked) return;

      // Early banners
      if (currentTime >= 2 && currentTime <= 12) {
        showBannerText(
          `Watching helps your favorite creator! After ${unlockDurationLabel}, ${starRate} star(s) or ${coinRate} coin(s) will be deducted.`,
          10000,
          "early",
        );
      }

      // Reminder
      if (currentTime >= reminderStart && currentTime <= reminderEnd) {
        showBannerText(`Continue watching? ${starRate} star(s) or ${coinRate} coin(s) will be deducted soon to unlock the rest.`, 10000, "reminder");
      }

      // Countdown
      if (currentTime >= countdownStart && currentTime < unlockTime) {
        const secondsLeft = Math.max(1, Math.floor(unlockTime - currentTime) + 1); // last seconds count down to unlock
        setCountdown((prev) => (prev === secondsLeft ? prev : secondsLeft));
      } else {
        setCountdown(null);
      }

      // 🔓 Unlock trigger (ONE TIME)
      if (currentTime >= unlockTime) {
        handleUnlock();
      }
    });

    return () => sub?.remove();
  }, [player, video?.$id, isUnlocked, monetizationActive, isPurchaseBlocked, starRate, coinRate, unlockTiming, autoUnlockEnabled]);

  useEffect(() => {
    if (!monetizationActive || (isUnlocked && !allowBannerAfterUnlockRef.current)) {
      setCountdown(null);
      setShowBanner(false);
      setIsPurchaseBlocked(false);
      stopBannerMarquee();
      clearHideTimeout();
      hasAttemptedUnlock.current = false;
    }
  }, [monetizationActive, isUnlocked]);

  useEffect(() => {
    if (autoUnlockEnabled) return;
    setCountdown(null);
    setShowBanner(false);
    stopBannerMarquee();
    clearHideTimeout();
    allowBannerAfterUnlockRef.current = false;
    lastBannerRef.current = { key: null, ts: 0 };
  }, [autoUnlockEnabled]);

  useEffect(() => {
    hasAttemptedUnlock.current = false;
    setCountdown(null);
    setShowBanner(false);
    setIsPurchaseBlocked(false);
    stopBannerMarquee();
    clearHideTimeout();
    allowBannerAfterUnlockRef.current = false;
    lastBannerRef.current = { key: null, ts: 0 };
  }, [video?.$id]);

  const onBannerContainerLayout = (e) => {
    const measuredWidth = e?.nativeEvent?.layout?.width || windowWidth;
    if (Math.abs(measuredWidth - bannerContainerWidth) > 2) {
      setBannerContainerWidth(measuredWidth);
    }
    startBannerMarquee(bannerMessage, bannerTextWidth, measuredWidth);
  };

  const onBannerContentSizeChange = (width) => {
    if (Math.abs(width - bannerTextWidth) > 2) {
      setBannerTextWidth(width);
    }
    startBannerMarquee(bannerMessage, width, bannerContainerWidth);
  };

  /* ---------------- Fetch deduction rates ---------------- */
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

  const resetUnlockFlow = () => {
    hasAttemptedUnlock.current = false;
    setIsPurchaseBlocked(false);
    setCountdown(null);
    setShowBanner(false);
    clearHideTimeout();
    stopBannerMarquee();
    allowBannerAfterUnlockRef.current = false;
    lastBannerRef.current = { key: null, ts: 0 };
  };

  const manualUnlock = async () => {
    if (isUnlocking) return false;
    if (isPurchaseBlocked) resetUnlockFlow();
    return handleUnlock();
  };

  const canShowBanner = showBanner && (!isUnlocked || allowBannerAfterUnlockRef.current);

  return {
    bannerMessage,
    bannerOpacity,
    bannerTranslateX,
    onBannerContainerLayout,
    onBannerContentSizeChange,
    bannerTextWidth,
    showBanner: canShowBanner,
    countdown,
    isUnlocking,
    isPurchaseBlocked,
    resetUnlockFlow,
    manualUnlock,
  };
}
