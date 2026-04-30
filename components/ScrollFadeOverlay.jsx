// Bottom (or top) fade overlay for scrollable regions — gives the user a visual
// "there's more content below" affordance without introducing scrollbars.
//
// Renders a non-interactive linear gradient that fades from transparent at the
// far edge of the scroll area to a solid color at the near edge, so the bottom
// row of content appears to dissolve into the parent surface. This is the same
// premium pattern web uses for capped scroll regions (cohort lists, tag picks,
// chat menus) and matches the design language we're carrying across Books /
// Videos / Profile.
//
// Usage: place the wrapper around the ScrollView with `position: relative`,
// then drop <ScrollFadeOverlay color={theme.card} /> as a sibling so it
// overlays the bottom of the ScrollView. pointerEvents="none" lets taps pass
// through to the items behind it.
//
// Implementation note: we use react-native-svg's LinearGradient (already a
// project dep — used by BookRating) instead of pulling in expo-linear-gradient
// just for this. The gradient renders natively and is ~free at this scale.

import { View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

const ScrollFadeOverlay = ({
  color,
  // Height of the fade region in dp. 28 is enough to read as a clear fade
  // without obscuring more than the bottom row of pills.
  height = 28,
  // "bottom" (default) or "top". Top variants are useful when a list scrolls
  // upward and we want to hint at content above.
  position = "bottom",
}) => {
  const isBottom = position === "bottom";
  // Stops describe a top→bottom gradient inside the SVG; we flip the alpha
  // ramp depending on which edge we're decorating.
  const startOpacity = isBottom ? 0 : 1;
  const endOpacity = isBottom ? 1 : 0;
  const gradientId = `scroll-fade-${position}`;

  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        height,
        ...(isBottom ? { bottom: 0 } : { top: 0 }),
      }}
    >
      <Svg width="100%" height={height} preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={String(startOpacity)} />
            <Stop offset="1" stopColor={color} stopOpacity={String(endOpacity)} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height={height} fill={`url(#${gradientId})`} />
      </Svg>
    </View>
  );
};

export default ScrollFadeOverlay;
