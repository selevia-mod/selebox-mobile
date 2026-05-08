// components/PostReaction.jsx
//
// Shared FB-style reaction renderers. Two exports:
//
//   <PostReactionIcon reactionKey={...} size={18} mutedColor={...} />
//     Used in the post action bar's Like button. Renders a single
//     vector icon (size × size) inside a same-size wrapper. All five
//     reaction states + the no-reaction outline heart use vector
//     icons (no system emoji), so the row's height is identical in
//     every state and there's no font-line-box clipping.
//
//   <PostReactionStack reactionKey={...} count={N} />
//     Used in the post stats row above the action bar. Renders the
//     "❤️😂 12" stack: heart icon baseline, optionally followed by
//     the user's non-heart reaction icon overlapping the heart's
//     right edge, then the count.
//
// Why custom SVG icons instead of emoji glyphs?
// We tried Apple Color Emoji rendering at multiple fontSize/
// lineHeight combinations. Emoji glyphs need ~1.3× their fontSize
// in vertical space (chin descenders on 😂 / 😭 / 😡, ascender
// halos on ❤️). Any lineHeight that clamps the row to a fixed
// height clips that overhang. Vector SVGs render at exactly their
// `width × height` with zero overhang, so we get pixel-perfect
// consistency across iOS and Android with no clipping. We also
// duck the Apple Color Emoji "white shine" artifact on ❤️.
//
// The 5 reaction icons live in assets/reactions/ as standalone
// SVG files in the FB-Lite badge style (colored circle + white
// face inside). They're imported as React components via
// react-native-svg-transformer (configured in metro.config.js),
// which means each .svg file is treated as a first-class component
// accepting `width` / `height` props.
//
// The picker continues to use the emoji glyphs from lib/reactions.js
// for the colorful "premium reveal" feel — only the inline action
// button + stats row use these flat custom SVGs.

import { AntDesign } from "@expo/vector-icons";
import { Text, View } from "react-native";
import HeartReact from "../assets/reactions/Heart-react.svg";
import HahaReact from "../assets/reactions/Haha-react.svg";
import SadReact from "../assets/reactions/Sad-react.svg";
import CryReact from "../assets/reactions/Cry-react.svg";
import AngryReact from "../assets/reactions/Angry-react.svg";

// Reaction → custom SVG component mapping. All five reactions ship
// as react-native-svg-transformer imports from assets/reactions/.
// File sizes (round 2 — second batch of source SVGs):
//   Heart  8.9 KB · 0 gradients
//   Sad    9.2 KB · 0 gradients
//   Haha   3.7 KB · 35 stops · 2 filters
//   Cry    18 KB  · 18 stops · 9 filters
//   Angry  14 KB  · 112 stops
//
// First batch was rejected for lag (Haha was 57 KB / 219 stops).
// The current batch is much lighter. Cry's 9 filters and Angry's
// 112-stop gradient remain the highest-risk items; if perf shows
// regression, swap those individual entries back to the icon-library
// fallback (see git history for the { lib: …, name: …, color: … }
// shape and the renderReactionIcon branching helper).
const REACTION_ICONS = {
  heart: HeartReact,
  laugh: HahaReact,
  sad: SadReact,
  cry: CryReact,
  angry: AngryReact,
};


// ─────────────────────────────────────────────────────────────────────
// Single reaction glyph for the action button.
//
// Renders the user's chosen reaction (or an outline heart when not
// reacted) inside a square `size × size` wrapper. The wrapper
// guarantees the row never grows between states. The custom SVG
// components carry their own colors, so we just hand them the
// dimensions and let them paint.
// ─────────────────────────────────────────────────────────────────────
export function PostReactionIcon({ reactionKey, size = 18, mutedColor = "#9ca3af" }) {
  const ReactionSvg = REACTION_ICONS[reactionKey];
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {ReactionSvg ? (
        <ReactionSvg width={size} height={size} />
      ) : (
        <AntDesign name="hearto" size={size} color={mutedColor} />
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// FB-style stats row: stacked reaction icons + count.
//
// Logic:
//   • count === 0  → render nothing (caller should hide the row).
//   • count >= 1  + reactionKey is null/heart → just the heart icon.
//   • count === 1 + reactionKey is non-heart → JUST the user's icon
//     (don't pretend a heart exists when the user is the sole reactor
//     with a non-heart pick — that would be a lie).
//   • count >= 2  + reactionKey is non-heart → stacked: heart icon
//     followed by user's reaction icon overlapping the heart's right
//     edge by ~4pt (FB stacking pattern).
//
// Sizing:
//   Both icons are 15pt rendered inside identically-sized wrapper
//   Views (alignItems / justifyContent center). All 5 icons + the
//   heart are vector glyphs at the exact same pixel footprint, so
//   they line up with no height mismatch.
// ─────────────────────────────────────────────────────────────────────
export function PostReactionStack({ reactionKey, count, textColor }) {
  const safeCount = Number.isFinite(count) ? count : 0;
  if (safeCount <= 0) return null;

  const userReactedNonHeart = reactionKey && reactionKey !== "heart";
  const isLoneUserReaction = userReactedNonHeart && safeCount === 1;
  const showHeart = !isLoneUserReaction;
  const showStackedUser = userReactedNonHeart && !isLoneUserReaction;
  const UserSvg = userReactedNonHeart ? REACTION_ICONS[reactionKey] : null;

  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      {showHeart ? <HeartReact width={15} height={15} /> : null}
      {(showStackedUser || isLoneUserReaction) && UserSvg ? (
        <View
          // Overlap into the heart's right edge when both are shown;
          // no negative margin when the icon is alone (lone-user case).
          style={{ marginLeft: showStackedUser ? -4 : 0 }}
        >
          <UserSvg width={15} height={15} />
        </View>
      ) : null}
      <Text
        style={{
          marginLeft: 6,
          fontSize: 12,
          fontWeight: "500",
          color: textColor || "#6b7280",
        }}
      >
        {safeCount}
      </Text>
    </View>
  );
}

export default { PostReactionIcon, PostReactionStack };
