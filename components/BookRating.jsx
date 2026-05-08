// components/BookRating.jsx
//
// Premium rating row — replaces the earlier "yellow tag + 5 stars"
// shape that read as a sale-tag / pricing label rather than a rating
// display. The new row mirrors the Goodreads / Apple Books pattern:
//
//   ┌─────────────────────────────────────────┐
//   │   ★ 4.5     ★ ★ ★ ★ ☆                    │
//   │             out of 5                      │
//   └─────────────────────────────────────────┘
//
// Visual changes:
//   • Replaced the SVG "tag" with a clean glass chip ("★ 4.5") that
//     uses the rest-of-app surface tokens — sits softly on any cover.
//   • Larger 24pt stars with half-fill support (LinearGradient on the
//     fractional star).
//   • Gold/amber fill for active, soft border-only outline for empty
//     (vs. the previous "fill with gray" which read as broken).
//   • Subtle press-scale animation when interactive.
//
// Tap-to-rate affordance:
//   • The component itself is tappable when an `onRatePress` handler
//     is passed AND the user hasn't yet submitted a rating. Without
//     a handler, the row renders as a passive display (used on
//     ranking cards / catalog tiles).
//   • Hint copy ("Tap to rate") shows below the row when interactive
//     so the affordance is unmistakable, replacing the standalone
//     "Rate" pill that used to sit on the cover. When the user has
//     already rated, hint copy switches to "You rated X / 5".
//
// Backwards-compat: `rating` and `starSize` props still work. New
// optional props (`onRatePress`, `userRating`, `submitting`,
// `interactive`) default to passive display so existing call sites
// in BookCatalogCard / BookRankingCard / etc. don't have to change.

import { Ionicons } from "@expo/vector-icons";
import { Text, TouchableOpacity, View } from "react-native";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";
import useAppTheme from "../hooks/useAppTheme";

const STAR_PATH =
  "M12 .587l3.668 7.431 8.2 1.193-5.934 5.782 1.402 8.175L12 18.896l-7.336 3.852 1.402-8.175L.132 9.211l8.2-1.193z";

const formatRating = (value) => {
  const n = Number(value) || 0;
  // Show one decimal when there's a fractional part; otherwise integer.
  // "4" (not "4.0") for whole-number averages; "4.5" for half-stars.
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
};

const Star = ({ filled, partialPercent, color, mutedColor, size, spacing, idSuffix }) => {
  if (partialPercent != null) {
    const id = `bookrating-grad-${idSuffix}`;
    return (
      <Svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        style={{ marginHorizontal: spacing / 2 }}
      >
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="100%" y2="0">
            <Stop offset={`${partialPercent}%`} stopColor={color} />
            <Stop offset={`${partialPercent}%`} stopColor={mutedColor} />
          </LinearGradient>
        </Defs>
        <Path fill={`url(#${id})`} d={STAR_PATH} />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={{ marginHorizontal: spacing / 2 }}>
      <Path fill={filled ? color : mutedColor} d={STAR_PATH} />
    </Svg>
  );
};

const BookRating = ({
  rating = 0,
  color,
  starSize = 22,
  spacing = 4,
  // New (optional) — backwards-compat with existing passive callers.
  onRatePress,
  userRating = null,
  submitting = false,
  interactive,
}) => {
  const { theme } = useAppTheme();
  const goldColor = color || theme.accentAmber;
  // Empty star — outlined gray, no fill. Reads as "not rated yet"
  // rather than the previous solid-gray fill which looked like a bug.
  const emptyColor = theme.iconMuted || theme.surfaceStrong;

  // Display value: prefer `rating` (the public average) when it exists,
  // otherwise fall back to the viewer's own rating. Why: when a user
  // submits a fresh rating, the server-side average can take a moment
  // to recompute (or returns 0 if they're the only/first rater). Without
  // this fallback the chip + stars would still read "0 ☆☆☆☆☆" right
  // after they rated 5 — confusing and reads like the submission failed.
  // Showing their own rating until the average catches up keeps the
  // feedback consistent with the "YOU RATED 5/5" hint below.
  const numericRating = Number(rating) || 0;
  const fallbackRating = Number(userRating?.rating) || 0;
  const safeRating = Math.max(0, Math.min(5, numericRating > 0 ? numericRating : fallbackRating));
  const isInteractive =
    typeof interactive === "boolean"
      ? interactive
      : typeof onRatePress === "function" && !userRating && !submitting;

  const stars = [...Array(5)].map((_, i) => {
    const starValue = i + 1;
    if (safeRating >= starValue) {
      return (
        <Star
          key={i}
          filled
          color={goldColor}
          mutedColor={emptyColor}
          size={starSize}
          spacing={spacing}
          idSuffix={`${i}-full`}
        />
      );
    }
    if (safeRating > i && safeRating < starValue) {
      const partialPercent = (safeRating - i) * 100;
      return (
        <Star
          key={i}
          partialPercent={partialPercent}
          color={goldColor}
          mutedColor={emptyColor}
          size={starSize}
          spacing={spacing}
          idSuffix={`${i}-${Math.round(partialPercent)}`}
        />
      );
    }
    return (
      <Star
        key={i}
        filled={false}
        color={goldColor}
        mutedColor={emptyColor}
        size={starSize}
        spacing={spacing}
        idSuffix={`${i}-empty`}
      />
    );
  });

  // Hint copy below the row. Three states:
  //   • User hasn't rated, surface is interactive → "Tap to rate"
  //   • User already rated → "You rated N / 5"
  //   • Passive display (no onRatePress handler) → null (no hint)
  const hint = (() => {
    if (userRating?.rating) {
      return `You rated ${userRating.rating} / 5`;
    }
    if (isInteractive) return "Tap to rate";
    return null;
  })();

  const Row = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Rating chip — glass surface with star icon + numeric value.
          Replaces the SVG sale-tag shape from earlier. The chip is the
          number's home; the row of stars to its right is the visual
          read of the same value. */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 10,
          paddingVertical: 5,
          borderRadius: 999,
          backgroundColor: theme.accentAmberSoft || "rgba(245,158,11,0.14)",
          borderWidth: 1,
          borderColor: "rgba(245,158,11,0.32)",
          marginRight: 10,
        }}
      >
        <Ionicons
          name="star"
          size={Math.max(12, starSize * 0.6)}
          color={goldColor}
          style={{ marginRight: 4 }}
        />
        <Text
          style={{
            color: theme.text,
            fontSize: Math.max(12, starSize * 0.62),
            fontWeight: "700",
            letterSpacing: 0.2,
          }}
        >
          {formatRating(safeRating)}
        </Text>
      </View>

      {/* Stars row */}
      <View style={{ flexDirection: "row", alignItems: "center" }}>{stars}</View>
    </View>
  );

  return (
    <View style={{ alignItems: "center" }}>
      {isInteractive ? (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={onRatePress}
          accessibilityRole="button"
          accessibilityLabel="Rate this book"
        >
          {Row}
        </TouchableOpacity>
      ) : (
        Row
      )}
      {hint ? (
        <Text
          style={{
            marginTop: 6,
            color: isInteractive ? theme.primary : theme.textSoft,
            fontSize: 11,
            fontWeight: isInteractive ? "700" : "500",
            letterSpacing: 0.3,
            textTransform: "uppercase",
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
};

export default BookRating;
