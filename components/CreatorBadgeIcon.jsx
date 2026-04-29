import { Image } from "react-native";

const CREATOR_BADGE_WIDTH = 855;
const CREATOR_BADGE_HEIGHT = 992;
const CREATOR_BADGE_SCALE = 1.08;
const CREATOR_BADGE_SOURCE = require("../assets/icons/creator-badge.png");

export const getCreatorBadgeDimensions = (size, scale = CREATOR_BADGE_SCALE) => ({
  width: (size * CREATOR_BADGE_WIDTH * scale) / CREATOR_BADGE_HEIGHT,
  height: size * scale,
});

export default function CreatorBadgeIcon({ width = 120, height, color: _color, style, ...props }) {
  const computedHeight = height ?? (width * CREATOR_BADGE_HEIGHT) / CREATOR_BADGE_WIDTH;

  return (
    <Image
      source={CREATOR_BADGE_SOURCE}
      accessibilityRole="image"
      resizeMode="contain"
      style={[{ width, height: computedHeight }, style]}
      {...props}
    />
  );
}
