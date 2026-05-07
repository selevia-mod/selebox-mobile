import { Text, View } from "react-native";
import FastImage from "react-native-fast-image";
import { useMomentRing } from "../context/moment-rings-provider";
import useAppTheme from "../hooks/useAppTheme";
// Phase E.4 — tier-aware image source. Avatars are rendered everywhere
// (feed cards, comments, message rows, profile lists), so optimizing
// them at the source has the broadest reach for a tiny diff. The
// helper appends Bunny Optimizer ?width&quality params on Bunny URLs
// (no-op on others) so low-tier devices decode smaller bitmaps for
// the same on-screen tile.
import { optimizedImageUri } from "../lib/utils/image-source";

// Returns true when the URI is a non-empty string. Empty strings, null, undefined,
// and non-string values all fall through to the monogram fallback.
const hasValidAvatar = (uri) => typeof uri === "string" && uri.trim().length > 0;

// "Marniel Ardiente" -> "MA"
// "Zeke"             -> "ZE"
// "C2"               -> "C2"
// ""                 -> "?"
const getInitials = (name) => {
  if (!name || typeof name !== "string") return "?";
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
};

// Deterministic color picker — same name always picks the same palette slot.
const getMonogramColor = (name, theme) => {
  const palette = [theme.primary, theme.accentTeal, theme.accentPink, theme.accentBlue, theme.accentGreen, theme.accentAmber];
  if (!name || typeof name !== "string") return palette[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return palette[Math.abs(hash) % palette.length];
};

/**
 * UserAvatar — square avatar tile with consistent fallback behavior.
 *
 * Renders the user's photo when avatarUri is a non-empty string. When it's
 * missing/empty/invalid, renders a colored monogram tile with the user's
 * initials instead. Color is deterministic from the name.
 *
 * Props:
 *   - name        : string. Used for initials + deterministic color.
 *   - avatarUri   : string|null. Photo URL. Falls through to monogram if empty.
 *   - userId      : string|null. When provided, the avatar is wrapped in a
 *                   purple Moment ring IF the viewer follows that user AND
 *                   that user has an active Moment (resolved by the
 *                   MomentRingsProvider context). Omit (or pass null/undef)
 *                   to opt out — current callers without the prop continue
 *                   to render exactly as before.
 *   - size        : number (px). Default 48.
 *   - borderRadius: number (px). Default 12 (matches Tailwind rounded-xl).
 *   - borderColor : string|null. If provided, applies a 1px border.
 *   - priority    : "low" | "normal" | "high". FastImage priority. Default "normal".
 *                   Avatars are secondary content; keep it normal in lists so the
 *                   primary thumbnail/photo isn't starved of bandwidth. Pass "high"
 *                   when the avatar IS the focus (profile header, full-screen).
 *   - style       : object. Additional style overrides for the outer container.
 */
const UserAvatar = ({ name, avatarUri, userId = null, size = 48, borderRadius = 12, borderColor = null, priority = "normal", style, ...rest }) => {
  const { theme } = useAppTheme();
  const showPhoto = hasValidAvatar(avatarUri);
  const monogramColor = getMonogramColor(name, theme);
  // Hook always runs (Rules of Hooks); returns false when userId is
  // null/undef so callers that don't pass userId pay nothing.
  const hasMomentRing = useMomentRing(userId);

  // Initials font size scales with avatar size; 40% of size, floor 12.
  const fontSize = Math.max(12, Math.round(size * 0.4));

  const containerStyle = [
    {
      width: size,
      height: size,
      borderRadius,
    },
    borderColor ? { borderWidth: 1, borderColor } : null,
    style,
  ];

  // Inner avatar element (photo OR monogram). The ring wrapper below
  // applies the purple border around whichever variant we render.
  const fastImagePriority = priority === "low" ? FastImage.priority.low : priority === "high" ? FastImage.priority.high : FastImage.priority.normal;
  const inner = showPhoto ? (
    <FastImage
      source={{ uri: optimizedImageUri(avatarUri, { width: size }), priority: fastImagePriority }}
      style={[...containerStyle, { backgroundColor: theme.surfaceMuted }]}
      resizeMode={FastImage.resizeMode.cover}
      accessibilityLabel={`${name || "User"} avatar`}
      {...rest}
    />
  ) : (
    <View
      style={[...containerStyle, { backgroundColor: monogramColor, alignItems: "center", justifyContent: "center" }]}
      accessibilityLabel={`${name || "User"} avatar`}
      {...rest}
    >
      <Text style={{ color: theme.primaryContrast, fontSize, fontWeight: "700" }}>{getInitials(name)}</Text>
    </View>
  );

  // No ring → return inner directly so callers without userId don't
  // pay an extra View in the tree.
  if (!hasMomentRing) return inner;

  // Ring wrapper — 2dp accent border + 2dp padding so the avatar's
  // background isn't bisected by the ring. borderRadius math: outer
  // is 4 bigger (2 padding + 2 border) so the ring corner matches
  // the avatar corner concentrically.
  return (
    <View
      style={{
        padding: 2,
        borderRadius: borderRadius + 4,
        borderWidth: 2,
        borderColor: theme.accentPurple,
        alignSelf: "flex-start",
      }}
    >
      {inner}
    </View>
  );
};

export default UserAvatar;
