// components/StoryActionBar.jsx
//
// Facebook-style Moments action bar (May 2026 revamp).
//
// Layout — non-owner:
//   [ Send message…              ] [ ♥ 👍 😂 😮 😡 ] [↻] [🔇]
//   └─── composer pill (flex) ───┘ └─ 5 inline rxns ─┘ ↑    ↑
//                                                     repost mute
//
// Layout — owner:
//   [ 👁 N views · M reactions ] [↻] [🔇]
//   └────── activity pill ─────┘ ↑    ↑
//                                repost mute
//
// Why this shape:
//   • Inline 5-emoji reactions match Facebook's Moments viewer — no
//     long-press picker, every reaction is one tap. The previous
//     design hid 4 of 5 reactions behind a long-press, which most
//     users never discovered.
//   • The composer pill (Send message) is the obvious reply CTA,
//     mirroring Facebook + Instagram. Tap opens a DM composer (or
//     shows a "coming soon" alert until that's wired).
//   • Repost + Mute are compact 32dp glass circles on the right —
//     present but de-emphasized. Mute is sticky per-session so users
//     don't have to re-mute every Moment.
//   • Owner mode replaces the composer with an Activity pill that
//     summarises views + reactions and opens the viewers sheet.

import { Feather } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { REACTIONS } from "./StoryReactionPicker";

const formatCount = (n) => {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 10000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(v / 1000)}k`;
};

// Repost utility button. Bumped to 38dp (1.2x of 32dp) per design
// pass — the icon is the only utility on the bar's first row now,
// so it can carry more visual weight. 20dp glyph fills the larger
// circle without looking lonely.
const SideIcon = ({ icon, label, onPress, IconFamily = Feather }) => (
  <Pressable
    onPress={onPress}
    hitSlop={6}
    accessibilityRole="button"
    accessibilityLabel={label}
    style={({ pressed }) => [
      styles.sideIcon,
      pressed && { transform: [{ scale: 0.92 }], backgroundColor: "rgba(255,255,255,0.18)" },
    ]}
  >
    <IconFamily name={icon} size={20} color="#fff" />
  </Pressable>
);

// Single reaction emoji button — Facebook Stories style.
// No bubble background, no ring; just a clean larger glyph that
// scales slightly on press and gets an accent dot below when it's
// the user's current pick. Reads as floating emojis over the media,
// which is exactly the visual language FB uses. The dot indicator
// keeps the active state communicable without bringing back the
// rounded glass pill.
const ReactionEmoji = ({ reaction, isActive, onPress }) => (
  <Pressable
    onPress={() => onPress(reaction.key)}
    hitSlop={4}
    accessibilityRole="button"
    accessibilityLabel={reaction.label}
    accessibilityState={{ selected: isActive }}
    style={({ pressed }) => [
      styles.reactionEmoji,
      pressed && { transform: [{ scale: 1.18 }] },
      isActive && { transform: [{ scale: 1.12 }] },
    ]}
  >
    <Text
      style={{
        fontSize: 30,
        // Soft drop shadow so emojis stay legible on bright media
        // without needing a backing pill.
        textShadowColor: "rgba(0,0,0,0.45)",
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 4,
      }}
    >
      {reaction.emoji}
    </Text>
    {isActive ? <View style={[styles.activeDot, { backgroundColor: reaction.accent }]} /> : null}
  </Pressable>
);

export default function StoryActionBar({
  isOwnStory,
  currentReaction,
  reactionCount = 0,
  totalViews = 0,
  onReactionPress,        // (reactionKey) => toggles/switches the reaction
  onComposerPress,        // tap "Send message…" — opens DM/composer
  onRepostPress,
  onViewersPress,         // owner → opens viewers sheet (also activity pill tap)
}) {
  const insets = useSafeAreaInsets();

  // Lift the bar a comfortable distance above the home indicator /
  // gesture bar. insets.bottom alone leaves the buttons hugging the
  // very edge. +24pt below the safe-area inset gives a comfortable
  // gap (was +28; trimmed slightly because the bar is now taller —
  // two stacked rows instead of one).

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { paddingBottom: insets.bottom + 54 }]}>
      {/* Bottom scrim removed entirely — both owner and viewer modes
          now sit transparent over the media. The composer pill and
          emojis carry their own subtle glass treatments where needed
          for legibility, so the hard scrim was just visual noise. */}

      {/* Row order swapped (May 2026) — reactions now sit ABOVE the
          composer/activity pill. Reasoning: when a link is attached,
          the SwipeUpHint sits just above this whole bar; putting the
          composer pill closer to it (and to the user's thumb) keeps
          the typing → swipe-up reading flow more natural. Reactions
          floating higher also reads as a separate "react" affordance
          rather than a dense input strip. */}
      {isOwnStory ? null : (
        <View style={styles.reactionRow}>
          {REACTIONS.map((rxn) => (
            <ReactionEmoji
              key={rxn.key}
              reaction={rxn}
              isActive={currentReaction === rxn.key}
              onPress={onReactionPress}
            />
          ))}
        </View>
      )}

      {/* Composer pill + repost — bottom row. Same shape on both
          owner and viewer sides; only the pill's content + tap
          action change. Owner sees views/reactions stats; tapping
          opens the viewers sheet. Viewer sees "Send message…" and
          tapping opens the DM composer. */}
      <View style={[styles.row, !isOwnStory && { marginTop: 6 }]}>
        {isOwnStory ? (
          <Pressable
            onPress={onViewersPress}
            accessibilityRole="button"
            accessibilityLabel="See viewers and reactions"
            style={({ pressed }) => [
              styles.composerPill,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Feather name="eye" size={16} color="rgba(255,255,255,0.92)" />
            <Text style={styles.composerText} numberOfLines={1}>
              {formatCount(totalViews)} {totalViews === 1 ? "view" : "views"}
              {reactionCount > 0 ? `  ·  ${formatCount(reactionCount)} ${reactionCount === 1 ? "reaction" : "reactions"}` : ""}
            </Text>
            <Feather name="chevron-right" size={16} color="rgba(255,255,255,0.55)" />
          </Pressable>
        ) : (
          <Pressable
            onPress={onComposerPress}
            accessibilityRole="button"
            accessibilityLabel="Send a message"
            style={({ pressed }) => [
              styles.composerPill,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Feather name="message-circle" size={16} color="rgba(255,255,255,0.7)" />
            <Text style={styles.composerPlaceholder} numberOfLines={1}>
              Send message…
            </Text>
          </Pressable>
        )}

        <View style={styles.utilityCluster}>
          <SideIcon icon="repeat" label="Share or repost" onPress={onRepostPress} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    // Was previously position:absolute / bottom:0 — that pinned the
    // bar to the inner bottom of the parent's padding box, which in
    // story-viewer.jsx (bottomArea: flex 0.12, paddingBottom: 30,
    // justifyContent: center) yielded inconsistent results across
    // devices and made paddingBottom bumps have no visible effect.
    // Flex layout with explicit width:100% gives the bar full
    // horizontal stretch and lets safe-area padding actually lift
    // the content as expected.
    width: "100%",
    paddingHorizontal: 10,
    paddingTop: 32,
  },
  scrimBottom: {
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  scrimTop: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: 32,
    backgroundColor: "rgba(0,0,0,0.18)",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  // Composer pill — looks like a chat input field. Used both for
  // "Send message…" (non-owner) and the activity stats pill (owner).
  composerPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.14)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  composerPlaceholder: {
    flex: 1,
    marginLeft: 8,
    color: "rgba(255,255,255,0.7)",
    fontSize: 14,
  },
  composerText: {
    flex: 1,
    marginLeft: 8,
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
  // Reaction row sits BELOW the composer row now (the user's sketch
  // calls for two stacked rows, with all 10 emojis on their own line).
  // space-between distributes the emojis evenly across the bar's full
  // width — picks the right gap whether the screen is 360dp or 430dp.
  reactionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    // Reactions are the TOP row now, so the gap goes BELOW (handled
    // via the composer row's marginTop). No marginTop here so the
    // reactions sit close to whatever's above them in bottomArea
    // (typically the SwipeUpHint when a link is attached).
    marginTop: 0,
    marginBottom: 4,
    paddingHorizontal: 2,
  },
  // 38dp container (1.2x of 32) holds a 30pt glyph with room for a
  // 4dp accent dot below for the active state.
  reactionEmoji: {
    width: 38,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  // Small accent dot beneath the active emoji — uses the reaction's
  // own accent colour from the REACTIONS registry.
  activeDot: {
    position: "absolute",
    bottom: 0,
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  utilityCluster: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: 6,
  },
  sideIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    // No dark fill — just a faint white outline so the glyph reads
    // clean on any media without a hard "black pill" look.
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
  },
});
