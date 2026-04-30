// Threshold-crossing video unlock prompt — mirrors the web's Phase 6
// `openVideoMonetThresholdDialog`, rendered as an INLINE overlay sized to
// its parent so it sits over the video player area, not the whole screen.
//
// Behaviour
//   • Coin tile  → permanent unlock for this video
//   • Star tile  → pays for the next `recurringSec` only (10 min default)
//   • Auto-pick  → after `autoDeductSeconds` (default 5s) without input,
//                  fires onChoice("coin") if affordable, else onChoice("star").
//                  Suppressed entirely when both balances fall short.
//
// Visual language — premium violet, mobile-first
//   • Frosted backdrop (expo-blur) with a soft violet wash so the player
//     reads as "behind glass" rather than dimmed-to-black.
//   • Card carries a violet outer glow + a 1px violet hairline along the
//     top, anchoring the prompt to the rest of the app's accent system.
//   • Spring entrance (fade + scale) so the modal lands rather than pops.
//   • Progress bar uses a 3-stop violet gradient via stacked layers (no
//     extra deps).
//
// Renders nothing when `isVisible` is false; mount inside a `relative`
// parent — the overlay fills via absolute / inset 0.

import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, Pressable, Text, TouchableOpacity, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

const COIN_AMBER = "#fbbf24";
const COIN_AMBER_DEEP = "#f59e0b";
const STAR_VIOLET = "#a855f7";
const STAR_VIOLET_DEEP = "#7c3aed";
const DEFAULT_AUTO_DEDUCT_SECONDS = 5;

// Self-contained palette so the card reads as "premium violet glass"
// regardless of which theme (light or dark) the rest of the app is in.
// `theme.primaryContrast` is always white, but on a light-themed
// surfaceElevated card it disappears — so we ship our own surface here.
const GLASS_CARD_BG = "rgba(22, 14, 42, 0.96)"; // deep violet-tinted glass
const GLASS_BORDER = "rgba(168, 85, 247, 0.45)"; // STAR_VIOLET-derived
const GLASS_TILE_BG = "rgba(255, 255, 255, 0.04)";
const GLASS_TILE_BORDER = "rgba(255, 255, 255, 0.10)";
const TEXT_PRIMARY = "#FFFFFF";
const TEXT_SECONDARY = "rgba(229, 231, 245, 0.78)"; // soft white-violet
const TEXT_MUTED = "rgba(229, 231, 245, 0.55)";
const TEXT_FAINT = "rgba(229, 231, 245, 0.40)";

const VideoUnlockChoiceModal = ({
  isVisible,
  videoTitle,
  thresholdSeconds = 180,
  recurringSeconds = 600,
  coinCost = 1,
  starCost = 1,
  coinBalance = 0,
  starBalance = 0,
  loadingCurrency = null, // "coin" | "star" | null
  autoDeductSeconds = DEFAULT_AUTO_DEDUCT_SECONDS,
  onChoice,
  onCancel,
}) => {
  const { theme } = useAppTheme();
  const canCoin = coinBalance >= coinCost;
  const canStar = starBalance >= starCost;
  const canAutoDeduct = canCoin || canStar;
  const recurringMin = Math.max(1, Math.round(recurringSeconds / 60));
  const minutesElapsed = Math.max(1, Math.floor(thresholdSeconds / 60));

  const [secondsLeft, setSecondsLeft] = useState(autoDeductSeconds);
  const progressAnim = useRef(new Animated.Value(1)).current;
  const cardScale = useRef(new Animated.Value(0.94)).current;
  const cardOpacity = useRef(new Animated.Value(0)).current;

  // Entrance animation — runs each time the modal becomes visible. Spring
  // gives the card a confident landing that reads as "premium" without
  // being theatrical.
  useEffect(() => {
    if (!isVisible) {
      cardOpacity.setValue(0);
      cardScale.setValue(0.94);
      return;
    }
    Animated.parallel([
      Animated.timing(cardOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.spring(cardScale, { toValue: 1, friction: 7, tension: 110, useNativeDriver: true }),
    ]).start();
  }, [isVisible, cardOpacity, cardScale]);

  // Reset + start the countdown each time the modal opens. Pauses while a
  // currency is loading so we don't double-fire.
  useEffect(() => {
    if (!isVisible || loadingCurrency || !canAutoDeduct) {
      setSecondsLeft(autoDeductSeconds);
      progressAnim.setValue(1);
      return undefined;
    }
    setSecondsLeft(autoDeductSeconds);
    progressAnim.setValue(1);
    Animated.timing(progressAnim, {
      toValue: 0,
      duration: autoDeductSeconds * 1000,
      easing: Easing.linear,
      useNativeDriver: false, // animating width %
    }).start();

    const tick = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(tick);
          return 0;
        }
        return s - 1;
      });
    }, 1000);

    return () => clearInterval(tick);
  }, [isVisible, loadingCurrency, canAutoDeduct, autoDeductSeconds, progressAnim]);

  // Auto-pick when countdown hits 0. Coin first, star fallback.
  useEffect(() => {
    if (!isVisible || loadingCurrency) return;
    if (!canAutoDeduct) return;
    if (secondsLeft > 0) return;
    const autoPick = canCoin ? "coin" : canStar ? "star" : null;
    if (autoPick) onChoice?.(autoPick);
  }, [secondsLeft, isVisible, loadingCurrency, canAutoDeduct, canCoin, canStar, onChoice]);

  if (!isVisible) return null;

  const handlePick = (currency) => {
    if (loadingCurrency) return;
    if (currency === "coin" && !canCoin) return;
    if (currency === "star" && !canStar) return;
    onChoice?.(currency);
  };

  const renderTile = (currency) => {
    const isCoin = currency === "coin";
    const accent = isCoin ? COIN_AMBER : STAR_VIOLET;
    const accentDeep = isCoin ? COIN_AMBER_DEEP : STAR_VIOLET_DEEP;
    const cost = isCoin ? coinCost : starCost;
    const balance = isCoin ? coinBalance : starBalance;
    const enabled = isCoin ? canCoin : canStar;
    const isLoading = loadingCurrency === currency;

    return (
      <TouchableOpacity
        onPress={() => handlePick(currency)}
        disabled={!enabled || !!loadingCurrency}
        activeOpacity={0.85}
        accessibilityLabel={
          isCoin
            ? `Unlock forever for ${cost} ${cost === 1 ? "coin" : "coins"}`
            : `Continue for ${recurringMin} more minutes for ${cost} ${cost === 1 ? "star" : "stars"}`
        }
        style={{
          flex: 1,
          borderRadius: 14,
          overflow: "hidden",
          borderWidth: 1.5,
          borderColor: enabled ? accent : GLASS_TILE_BORDER,
          opacity: enabled ? 1 : 0.5,
          // Ambient shadow lift in the tile's own accent color — coin glows
          // amber, star glows violet. Reads as "tappable" before the user
          // touches anything.
          shadowColor: accent,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: enabled && !loadingCurrency ? 0.55 : 0,
          shadowRadius: 12,
          elevation: enabled ? 4 : 0,
          backgroundColor: GLASS_TILE_BG,
        }}
      >
        {/* Two-stop accent wash inside the tile so the tile feels like
            tinted glass over a violet base. Top half carries the accent
            colour at low alpha; lower half is plain violet glass. */}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "60%",
            backgroundColor: `${accent}26`,
          }}
        />
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "30%",
            backgroundColor: `${accent}14`,
          }}
        />

        <View style={{ paddingVertical: 10, paddingHorizontal: 8, alignItems: "center", justifyContent: "center" }}>
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 999,
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 6,
              backgroundColor: `${accentDeep}33`,
              borderWidth: 1,
              borderColor: `${accent}77`,
              shadowColor: accent,
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.6,
              shadowRadius: 6,
              elevation: 2,
            }}
          >
            {isCoin ? <MaterialCommunityIcons name="poker-chip" size={17} color={accent} /> : <Ionicons name="star" size={17} color={accent} />}
          </View>
          <Text className="font-bold" style={{ color: TEXT_PRIMARY, fontSize: 18, lineHeight: 20, letterSpacing: 0.3 }}>
            {cost}
          </Text>
          <Text className="mt-0.5 text-[9px]" style={{ color: accent, fontWeight: "800", letterSpacing: 1.2, textTransform: "uppercase" }}>
            {cost === 1 ? (isCoin ? "Coin" : "Star") : isCoin ? "Coins" : "Stars"}
          </Text>
          <View
            style={{
              marginTop: 6,
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderRadius: 999,
              backgroundColor: `${accent}1F`,
              borderWidth: 0.5,
              borderColor: `${accent}55`,
            }}
          >
            <Text className="text-[9px] font-bold" style={{ color: accent, letterSpacing: 0.5, textTransform: "uppercase" }}>
              {isCoin ? "Forever" : `${recurringMin}-min`}
            </Text>
          </View>
          <Text
            className="mt-1 text-[9px]"
            style={{ color: enabled ? TEXT_MUTED : TEXT_FAINT, textAlign: "center", letterSpacing: 0.1 }}
            numberOfLines={1}
          >
            {enabled ? (isCoin ? "Unlocks permanently" : `Recharges every ${recurringMin}m`) : `You have ${balance}`}
          </Text>
        </View>

        {/* Loading shimmer ring while the server is processing this pick. */}
        {isLoading ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              borderRadius: 14,
              borderWidth: 2,
              borderColor: accent,
            }}
          />
        ) : null}
      </TouchableOpacity>
    );
  };

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 50,
        elevation: 50,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {/* Frosted backdrop. Tap to dismiss. BlurView gives the
          "premium glass over the video" feel; the violet wash on top ties
          it to the app's primary accent without going purple-everything. */}
      <Pressable
        onPress={() => onCancel?.()}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
        }}
      >
        <BlurView intensity={Platform.OS === "ios" ? 35 : 60} tint="dark" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(76, 29, 149, 0.28)",
          }}
        />
      </Pressable>

      {/* Card. Animated.spring landing + violet outer glow + a 1px violet
          hairline along the top edge. Width capped to 92% of the player so
          it doesn't kiss the bezels.

          The card itself is rendered as a deep-violet GLASS surface — its
          own self-contained palette so white text + violet accents always
          read cleanly regardless of the surrounding app theme (light or
          dark). Background is a violet-tinted dark colour, slightly
          translucent so the BlurView behind it bleeds through. */}
      <Animated.View
        style={{
          width: "92%",
          maxWidth: 380,
          opacity: cardOpacity,
          transform: [{ scale: cardScale }],
          borderRadius: 20,
          overflow: "hidden",
          backgroundColor: GLASS_CARD_BG,
          borderWidth: 1,
          borderColor: GLASS_BORDER,
          shadowColor: STAR_VIOLET,
          shadowOffset: { width: 0, height: 14 },
          shadowOpacity: 0.55,
          shadowRadius: 28,
          elevation: 16,
        }}
      >
        {/* Bright violet hairline along the top edge — the strongest
            accent stripe on the card, anchors the eye. */}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            backgroundColor: STAR_VIOLET,
            opacity: 1,
          }}
        />
        {/* Soft inner highlight along the top — a 1px line of brighter
            violet at low alpha just under the hairline, sells the "glass
            with a lit edge" feel. */}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 2,
            left: 0,
            right: 0,
            height: 1,
            backgroundColor: "rgba(255, 255, 255, 0.18)",
          }}
        />
        {/* Ambient violet wash bleeding from the top into the upper third
            of the card. */}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 110,
            backgroundColor: STAR_VIOLET,
            opacity: 0.1,
          }}
        />
        {/* Subtle radial-ish glow in the top-left corner — second wash to
            give the surface depth. */}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: -40,
            left: -40,
            width: 160,
            height: 160,
            borderRadius: 999,
            backgroundColor: STAR_VIOLET,
            opacity: 0.14,
          }}
        />

        <View style={{ paddingHorizontal: 14, paddingTop: 14, paddingBottom: 12 }}>
          {/* Close affordance — top-right */}
          <TouchableOpacity
            onPress={() => onCancel?.()}
            accessibilityLabel="Close"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              padding: 5,
              borderRadius: 999,
              backgroundColor: "rgba(255, 255, 255, 0.08)",
              borderWidth: 1,
              borderColor: "rgba(255, 255, 255, 0.12)",
              zIndex: 1,
            }}
          >
            <Ionicons name="close" size={13} color={TEXT_SECONDARY} />
          </TouchableOpacity>

          {/* Header — icon chip + title row, compact for video-area heights. */}
          <View className="flex-row items-center" style={{ paddingRight: 28 }}>
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: 11,
                alignItems: "center",
                justifyContent: "center",
                marginRight: 10,
                backgroundColor: `${STAR_VIOLET}33`,
                borderWidth: 1,
                borderColor: STAR_VIOLET,
                shadowColor: STAR_VIOLET,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.55,
                shadowRadius: 10,
                elevation: 4,
              }}
            >
              <Ionicons name="play" size={16} color={STAR_VIOLET} />
            </View>
            <View className="flex-1">
              <Text className="font-bold" style={{ color: TEXT_PRIMARY, fontSize: 16, letterSpacing: 0.3, lineHeight: 20 }} numberOfLines={1}>
                Keep watching
              </Text>
              <Text
                className="text-[10px] font-medium"
                style={{ color: TEXT_SECONDARY, letterSpacing: 0.2, lineHeight: 13, marginTop: 2 }}
                numberOfLines={1}
              >
                First {minutesElapsed} min was free · pick how to continue
              </Text>
            </View>
          </View>

          {/* Two tappable tiles, side by side. */}
          <View className="mt-3 flex-row" style={{ gap: 10 }}>
            {renderTile("coin")}
            {renderTile("star")}
          </View>

          {/* Auto-deduct countdown. Premium violet treatment: bold "AUTO IN
              5S" label, hint text using softened white-violet, gradient
              progress bar via stacked layers (deep violet base + brighter
              violet sheen on top). Hidden entirely when neither balance is
              sufficient. */}
          {canAutoDeduct ? (
            <View className="mt-3">
              <View className="flex-row items-center justify-between" style={{ paddingHorizontal: 2 }}>
                <Text className="text-[10px] font-bold" style={{ color: STAR_VIOLET, letterSpacing: 0.8, textTransform: "uppercase" }}>
                  Auto in {secondsLeft}s
                </Text>
                <Text className="text-[10px] font-semibold" style={{ color: TEXT_MUTED, letterSpacing: 0.4, textTransform: "uppercase" }}>
                  {loadingCurrency ? "Processing…" : canCoin && canStar ? "Coin → Star" : canCoin ? "Coin" : "Star"}
                </Text>
              </View>
              <View
                className="mt-1.5 w-full overflow-hidden rounded-full"
                style={{
                  height: 5,
                  backgroundColor: "rgba(168, 85, 247, 0.18)",
                  borderWidth: 0.5,
                  borderColor: "rgba(168, 85, 247, 0.30)",
                }}
              >
                <Animated.View
                  style={{
                    height: "100%",
                    overflow: "hidden",
                    borderRadius: 999,
                    backgroundColor: STAR_VIOLET_DEEP,
                    width: progressAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: ["0%", "100%"],
                    }),
                    shadowColor: STAR_VIOLET,
                    shadowOffset: { width: 0, height: 0 },
                    shadowOpacity: 0.9,
                    shadowRadius: 6,
                  }}
                >
                  {/* Layered "gradient illusion": base deep violet with a
                      brighter overlay at partial alpha, plus a thin top
                      highlight giving the bar a jewel-like sheen. */}
                  <View
                    pointerEvents="none"
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      backgroundColor: STAR_VIOLET,
                      opacity: 0.7,
                    }}
                  />
                  <View
                    pointerEvents="none"
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      height: 1.5,
                      backgroundColor: "rgba(255, 255, 255, 0.45)",
                    }}
                  />
                </Animated.View>
              </View>
            </View>
          ) : (
            <View
              className="mt-3 rounded-xl"
              style={{
                paddingVertical: 9,
                paddingHorizontal: 10,
                backgroundColor: "rgba(168, 85, 247, 0.12)",
                borderWidth: 1,
                borderColor: "rgba(168, 85, 247, 0.40)",
              }}
            >
              <Text className="text-center text-[10px] font-semibold" style={{ color: TEXT_SECONDARY, letterSpacing: 0.3 }}>
                Out of coins and stars · Top up in the Store to keep watching
              </Text>
            </View>
          )}
        </View>
      </Animated.View>
    </View>
  );
};

export default VideoUnlockChoiceModal;
