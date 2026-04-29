import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Animated, Platform } from "react-native";
import { AdEventType, InterstitialAd, TestIds } from "react-native-google-mobile-ads";
import { useGlobalContext } from "../context/global-provider";
import { StarService } from "../lib/stars";

const COOLDOWN_KEY = "cooldownEndTime";

export function useRewardedStar({ userId, cooldownSeconds, setStarsData }) {
  const { globalSettings } = useGlobalContext();
  const [cooldownEndTime, setCooldownEndTime] = useState(null);
  const [remainingTime, setRemainingTime] = useState(0);
  const [adLoaded, setAdLoaded] = useState(false);
  const [starLoading, setStarLoading] = useState(false);
  const [showPlusOne, setShowPlusOne] = useState(false);
  const [cooldownMessageOpen, setCooldownMessageOpen] = useState(false);

  const plusOneAnim = useRef(new Animated.Value(0)).current;

  // Keep ad instance stable using useMemo
  const productionID = Platform.OS === "android" ? globalSettings?.["ANDROID_INTERSTITIAL_PROD_ID"] : globalSettings?.["IOS_INTERSTITIAL_PROD_ID"];

  const adUnitID = __DEV__ ? TestIds.INTERSTITIAL : productionID;
  const interstitial = useMemo(() => InterstitialAd.createForAdRequest(adUnitID), [adUnitID]);

  // Ad event listeners
  useEffect(() => {
    const unsubscribeLoaded = interstitial.addAdEventListener(AdEventType.LOADED, () => {
      setAdLoaded(true);
    });

    const unsubscribeError = interstitial.addAdEventListener(AdEventType.ERROR, (error) => {
      setAdLoaded(false);
    });

    const unsubscribeClosed = interstitial.addAdEventListener(AdEventType.CLOSED, async () => {
      setAdLoaded(false);
      interstitial.load(); // preload next ad

      try {
        setStarLoading(true);
        const result = await StarService.earnStar(userId);
        setStarsData(result);
        setShowPlusOne(true);

        Animated.timing(plusOneAnim, {
          toValue: -30,
          duration: 700,
          useNativeDriver: true,
        }).start(() => {
          setShowPlusOne(false);
          plusOneAnim.setValue(0);
        });

        const endTime = Date.now() + cooldownSeconds * 1000;
        await AsyncStorage.setItem(COOLDOWN_KEY, String(endTime));
        setCooldownEndTime(endTime);
      } catch (err) {
        Alert.alert("Error", err.message);
      } finally {
        setStarLoading(false);
      }
    });

    interstitial.load(); // initial load

    return () => {
      unsubscribeLoaded();
      unsubscribeError();
      unsubscribeClosed();
    };
  }, [interstitial]);

  // Load cooldown from storage
  useEffect(() => {
    const loadCooldown = async () => {
      const saved = await AsyncStorage.getItem(COOLDOWN_KEY);
      if (saved) setCooldownEndTime(Number(saved));
    };
    loadCooldown();
  }, []);

  // Cooldown countdown
  useEffect(() => {
    if (!cooldownEndTime) return;
    const interval = setInterval(() => {
      const diff = Math.max(0, cooldownEndTime - Date.now());
      setRemainingTime(Math.ceil(diff / 1000));
      if (diff <= 0) {
        clearInterval(interval);
        setCooldownEndTime(null);
        AsyncStorage.removeItem(COOLDOWN_KEY);
        setCooldownMessageOpen(false);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownEndTime]);

  // Show ad
  const showAd = () => {
    if (cooldownEndTime && remainingTime > 0) {
      setCooldownMessageOpen(true);
      return;
    }
    if (adLoaded) {
      interstitial.show();
    } else {
      Alert.alert("Ad not ready", "Please wait a moment and try again.");
    }
  };

  return {
    showAd,
    starLoading,
    showPlusOne,
    cooldownMessageOpen,
    remainingTime,
    setCooldownMessageOpen,
    plusOneAnim,
  };
}
