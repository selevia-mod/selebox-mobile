// components/ProfileMenuModal.jsx
//
// FB-style left drawer that opens when the user taps their avatar in the
// top-left of MainScreensHeader. Replaces the previous straight-to-
// /profile navigation with a quick-access menu — Profile, Community,
// Supporter Leaderboard, Creator/Writer Rankings, Payments, Author
// Section, Creator Section, Log out.
//
// Design language (mode-aware):
//   • Light mode → premium WHITE base with violet/purple accents.
//     Background is the same `theme.background` (subtle violet tint,
//     #faf8ff) that the rest of the app uses; cards sit on `theme.card`
//     (#ffffff) with soft purple borders. Section labels + icon chips
//     glow violet against the white. Reads cleanly in daylight.
//   • Dark mode → deep slate base (`theme.surfaceElevated` / #0e1118)
//     with the same purple chips and glass cards. Mirrors the rest of
//     the app's dark identity.
//   • Slides in from the left (react-native-modal slideInLeft).
//   • Each row: rounded purple icon bubble + title + subtitle, full-
//     width tap target. "Coming Soon" rows wear an amber pill, sit at
//     ~55% opacity, and surface a friendly Alert instead of routing.
//   • Top "profile" card carries avatar + USERNAME + "Your Profile
//     Account" subtitle — taps the full card to navigate to /profile.
//   • Bottom Log out is its own row with a destructive red icon chip.
//
// All routes are existing — no new screens. The menu is pure shortcut
// surface, mirroring what's already accessible deeper inside Edit
// Profile / Settings.

import { Feather, Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback } from "react";
import { Alert, Dimensions, Pressable, ScrollView, Text, View } from "react-native";
import FastImage from "react-native-fast-image";
import RNModal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDispatch } from "react-redux";
import { useGlobalContext } from "../context/global-provider";
import { useProfileDrawer } from "../context/profile-drawer-provider";
import useAppTheme from "../hooks/useAppTheme";
import { signOut } from "../lib/appwrite";
import { clearUserReducer, setIsLoggedReducer } from "../store/reducers/auth";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

// Brand purple — consistent across light + dark. theme.primary is the
// same #8b5cf6 in both modes; this constant just keeps fallbacks short.
const PURPLE = "#8b5cf6";
const PURPLE_LIGHT = "#a78bfa";

// Icon chip — small rounded-square with a purple-soft tint behind a
// monochrome glyph. Used for every menu row + the avatar header's
// online-dot mirror style.
const IconChip = ({ children, tone = "purple", size = 40, theme, isDarkMode }) => {
  const palette = {
    purple: {
      bg: isDarkMode ? "rgba(139,92,246,0.18)" : "rgba(139,92,246,0.10)",
      border: isDarkMode ? "rgba(167,139,250,0.32)" : "rgba(139,92,246,0.22)",
    },
    amber: {
      bg: theme.accentAmberSoft || "rgba(245,158,11,0.18)",
      border: "rgba(245,158,11,0.32)",
    },
    danger: {
      bg: isDarkMode ? "rgba(239,68,68,0.16)" : "rgba(239,68,68,0.08)",
      border: isDarkMode ? "rgba(239,68,68,0.40)" : "rgba(239,68,68,0.28)",
    },
  };
  const p = palette[tone] || palette.purple;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 14,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: p.bg,
        borderWidth: 1,
        borderColor: p.border,
      }}
    >
      {children}
    </View>
  );
};

// Single menu row. `comingSoon` flips the look + intercepts taps with
// an Alert. `tone` lets a destructive row (Log out) re-tint its chip.
const MenuRow = ({ icon, title, subtitle, onPress, comingSoon = false, tone = "purple", theme, isDarkMode }) => {
  const handlePress = () => {
    if (comingSoon) {
      Alert.alert(`${title} — Coming soon`, "We're cooking this one up. Check back in an upcoming release.");
      return;
    }
    onPress?.();
  };

  // Card surface tokens — light mode gets a clean white card with a
  // soft violet border; dark mode keeps the glass-on-dark treatment.
  const cardBg = isDarkMode ? "rgba(255,255,255,0.04)" : theme.card || "#ffffff";
  const cardBorder = isDarkMode ? "rgba(255,255,255,0.08)" : "rgba(139,92,246,0.14)";

  return (
    <Pressable
      onPress={handlePress}
      android_ripple={{ color: "rgba(139,92,246,0.10)" }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 14,
        paddingHorizontal: 14,
        borderRadius: 18,
        backgroundColor: cardBg,
        borderWidth: 1,
        borderColor: cardBorder,
        opacity: comingSoon ? 0.6 : pressed ? 0.85 : 1,
        // Subtle elevation in light mode so the white cards visually
        // lift off the violet-tinted drawer base. No-op in dark mode.
        ...(isDarkMode
          ? null
          : {
              shadowColor: "#7c3aed",
              shadowOpacity: 0.06,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: 2 },
              elevation: 1,
            }),
      })}
    >
      <IconChip tone={tone} theme={theme} isDarkMode={isDarkMode} size={42}>
        {icon}
      </IconChip>
      {/* `minWidth: 0` is the magic that lets the title row truncate
          properly inside a flex-row parent. Without it, the title
          column refuses to shrink past its intrinsic content width
          and gets clipped on narrower phones (~360pt screens) — the
          drawer overflows the safe text area, "Creator & Writer
          Rankings" rendered as "Creator & Write..". */}
      <View style={{ flex: 1, marginLeft: 12, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text
            style={{
              color: theme.text,
              fontSize: 15,
              fontWeight: "700",
              letterSpacing: 0.2,
              // `flex: 1` (not `flexShrink: 1`) so the text claims all
              // remaining space in this row before any sibling (e.g.
              // the SOON badge below) gets a chance to push it out.
              // numberOfLines={1} truncates inside that allocation,
              // producing "Creator & Writer Ranki…" on tight screens
              // instead of the much-too-aggressive "Creator & Write..".
              flex: 1,
            }}
            numberOfLines={1}
          >
            {title}
          </Text>
          {comingSoon ? (
            <View
              style={{
                marginLeft: 8,
                paddingHorizontal: 7,
                paddingVertical: 2,
                borderRadius: 999,
                backgroundColor: theme.accentAmberSoft || "rgba(245,158,11,0.18)",
                borderWidth: 1,
                borderColor: "rgba(245,158,11,0.40)",
              }}
            >
              <Text
                style={{
                  color: theme.accentAmber || "#f59e0b",
                  fontSize: 9,
                  fontWeight: "800",
                  letterSpacing: 0.5,
                }}
              >
                SOON
              </Text>
            </View>
          ) : null}
        </View>
        {subtitle ? (
          <Text
            style={{
              marginTop: 2,
              color: theme.textSoft,
              fontSize: 12,
              lineHeight: 16,
            }}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {!comingSoon ? <Feather name="chevron-right" size={18} color={theme.iconMuted || theme.textSubtle} /> : null}
    </Pressable>
  );
};

// Self-contained drawer. Reads its own open-state, user, and logout
// dependencies from context + redux instead of via props, so it can
// be rendered ONCE at the (tabs) layout level without prop-drilling.
// MainScreensHeader just calls `setOpen(true)` on avatar tap; the
// modal handles everything else (navigation, logout confirmation,
// session teardown).
const ProfileMenuModal = () => {
  const { theme, isDarkMode } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { open, setOpen } = useProfileDrawer();
  const { user, setUser, setIsLogged } = useGlobalContext();
  const dispatch = useDispatch();

  const close = () => setOpen(false);

  // Mirrors edit-profile.jsx's logout flow exactly. Drawer closes
  // BEFORE signOut() so the slide-out animation doesn't fight with
  // the (tabs) layout tearing down on isLogged → false.
  const handleLogout = useCallback(() => {
    Alert.alert(
      "Logout",
      "Are you sure you want to log out?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Yes",
          style: "destructive",
          onPress: async () => {
            setOpen(false);
            try {
              await signOut();
            } finally {
              setUser(false);
              setIsLogged(false);
              dispatch(clearUserReducer());
              dispatch(setIsLoggedReducer(false));
            }
          },
        },
      ],
      { cancelable: true },
    );
  }, [dispatch, setIsLogged, setOpen, setUser]);

  // Wrapped navigation — close the drawer FIRST so the fade-out is the
  // dominant visual, then push the route on the next animation frame.
  // The single rAF gap is enough for React to flush the visible→false
  // state change so the modal's native-driven fadeOut starts; navigation
  // then mounts the destination screen against an already-disappearing
  // drawer rather than competing with it for the same paint frame.
  //
  // Earlier we tried (a) `router.push()` then `onClose()` synchronously
  // and (b) the inverse with a 120ms setTimeout — (a) made the screen
  // transition stutter as the modal close JS-render landed mid-push,
  // (b) made the tap feel sluggish. rAF (~16ms) lands cleanly between
  // the two: instant feedback, smooth handoff.
  //
  // `router.navigate` (not `router.push`) — when the user opens the
  // drawer from the Books tab, taps Supporter Leaderboard, and then
  // hits back inside the leaderboard, we want them to land back on the
  // Books tab they came from. With `router.push` to a *bare* path like
  // "/supporter-leaderboard" (which expo-router has to auto-resolve
  // through the file-based router), the tabs Tab Navigator was losing
  // its active-tab memory and the back pop reset it to the initial
  // route (home). `navigate` keeps the existing navigation state and
  // is the documented way to deep-link to a screen in another route
  // group without mangling the back stack.
  //
  // Paths now spell out the route group explicitly (`/(profile)/...`
  // instead of just `/supporter-leaderboard`). expo-router can resolve
  // either form, but qualified paths are far more reliable across
  // pushed-screen-then-back flows because the router doesn't have to
  // guess which group the bare segment lives in — it pushes straight
  // into that group's nested Stack.
  //
  // Drawer-as-shelf: we deliberately do NOT close the drawer on menu
  // tap any more. The drawer is mounted at the (tabs) layout level
  // with coverScreen=false, so when router.navigate pushes a new
  // route group the (tabs) layout (and the drawer with it) is hidden
  // by react-navigation. When the user pops back, (tabs) is visible
  // again and the drawer is right there in the same open state —
  // no animation re-trigger, no flag, no race condition. Logout +
  // backdrop tap still close via onClose() so the drawer doesn't
  // hang around for genuinely-dismissive interactions.
  const go = (path) => {
    router.navigate(path);
  };

  // Drawer width — 86% of the screen on phones. Enough room for the
  // long subtitles ("Find your idols. Become someone's idol.") without
  // obliterating the user's spatial sense of "the rest of the app is
  // still over there to the right."
  const drawerWidth = Math.min(380, SCREEN_WIDTH * 0.86);

  // Mode-aware drawer base.
  //   • Light: theme.background (#faf8ff — subtle violet wash, the
  //     same surface the home tab uses) so the drawer feels native to
  //     the rest of the app rather than a floating "dark control panel".
  //   • Dark: theme.surfaceElevated (#272727 / #0e1118) — premium
  //     deep base.
  const drawerBg = isDarkMode ? theme.surfaceElevated || "#0e1118" : theme.background || "#faf8ff";

  // Avatar header — light mode: white card with purple gradient
  // accents (border + soft purple wash); dark mode: glass-on-dark.
  const headerBg = isDarkMode ? "rgba(139,92,246,0.10)" : "#ffffff";
  const headerBorder = isDarkMode ? "rgba(167,139,250,0.28)" : "rgba(139,92,246,0.22)";

  // Divider above Log out — soft slate in light, soft white in dark.
  const dividerColor = isDarkMode ? "rgba(255,255,255,0.08)" : "rgba(15,23,42,0.08)";

  return (
    <RNModal
      isVisible={open}
      onBackdropPress={close}
      onSwipeComplete={close}
      swipeDirection={["left"]}
      backdropOpacity={isDarkMode ? 0.55 : 0.32}
      animationIn="slideInLeft"
      // Open with a slide-in (gives the drawer its premium "reveal"),
      // close with a quick fade-out. The drawer no longer animates
      // out + back in on a drawer-tap → destination → back round-trip
      // (it stays mounted at the (tabs) layout level via
      // coverScreen=false), so these timings only fire on first-open
      // and on backdrop-dismiss / logout. 120/100 keeps both feeling
      // snappy; matches the Slack / Linear left-drawer feel.
      animationOut="fadeOut"
      animationInTiming={120}
      animationOutTiming={100}
      backdropTransitionInTiming={100}
      backdropTransitionOutTiming={0}
      useNativeDriver
      useNativeDriverForBackdrop
      // coverScreen=false renders the modal INLINE inside its parent
      // (the (tabs) layout's wrapper View) instead of via RN's native
      // <Modal> overlay. The native overlay would float on top of
      // pushed destinations (Community, Payments, etc.) and look
      // broken; the inline form is bound to its parent's render tree,
      // so when navigation covers (tabs) it covers the drawer too,
      // and when navigation pops back the drawer is right there in
      // its still-open state. This is the structural fix that lets
      // us drop the close/reopen-on-back dance entirely.
      coverScreen={false}
      style={{ margin: 0, justifyContent: "flex-start", alignItems: "flex-start" }}
    >
      <View
        style={{
          width: drawerWidth,
          height: "100%",
          backgroundColor: drawerBg,
          paddingTop: insets.top + 6,
          paddingBottom: insets.bottom + 12,
          paddingHorizontal: 14,
          borderTopRightRadius: 24,
          borderBottomRightRadius: 24,
          // Right-edge purple-tinted shadow in both modes — gives the
          // drawer that "lifted off the canvas" premium feel.
          shadowColor: isDarkMode ? "#000" : "#7c3aed",
          shadowOffset: { width: 8, height: 0 },
          shadowOpacity: isDarkMode ? 0.45 : 0.18,
          shadowRadius: 22,
          elevation: 12,
          // Soft violet hairline along the right edge — subtle but
          // anchors the drawer in light mode where the shadow is
          // gentler.
          borderRightWidth: isDarkMode ? 0 : 1,
          borderRightColor: "rgba(139,92,246,0.10)",
        }}
      >
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 16 }}>
          {/* Profile header card — taps to open the user's profile.
              Mirrors the Canva mockup's avatar-plus-name top tile. */}
          <Pressable
            onPress={() => go("/(profile)/profile")}
            android_ripple={{ color: "rgba(139,92,246,0.18)" }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              padding: 14,
              borderRadius: 20,
              backgroundColor: headerBg,
              borderWidth: 1,
              borderColor: headerBorder,
              marginBottom: 18,
              opacity: pressed ? 0.88 : 1,
              ...(isDarkMode
                ? null
                : {
                    shadowColor: "#7c3aed",
                    shadowOpacity: 0.10,
                    shadowRadius: 10,
                    shadowOffset: { width: 0, height: 4 },
                    elevation: 2,
                  }),
            })}
          >
            {user?.avatar ? (
              <FastImage
                source={{ uri: user.avatar }}
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 14,
                  backgroundColor: theme.surfaceMuted,
                  borderWidth: 2,
                  borderColor: theme.accentPurple || PURPLE,
                }}
              />
            ) : (
              <View
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 14,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: theme.accentPurpleSoft || "rgba(139,92,246,0.16)",
                  borderWidth: 2,
                  borderColor: theme.accentPurple || PURPLE,
                }}
              >
                <Ionicons name="person" size={26} color={theme.accentPurple || PURPLE} />
              </View>
            )}
            <View style={{ flex: 1, marginLeft: 14 }}>
              <Text
                style={{
                  color: theme.text,
                  fontSize: 18,
                  fontWeight: "800",
                  letterSpacing: 0.4,
                }}
                numberOfLines={1}
              >
                {(user?.username || "You").toUpperCase()}
              </Text>
              <Text
                style={{
                  marginTop: 2,
                  color: theme.textSoft,
                  fontSize: 12,
                  letterSpacing: 0.2,
                }}
                numberOfLines={1}
              >
                Your Profile Account
              </Text>
            </View>
            <Feather name="chevron-right" size={18} color={theme.iconMuted || theme.textSubtle} />
          </Pressable>

          {/* "Coming soon" group — discovery & community surfaces that
              aren't built yet but signal where the platform is going.
              Visually muted so users don't keep tapping them. */}
          <View style={{ marginBottom: 14 }}>
            <SectionLabel theme={theme}>Discover & Community</SectionLabel>
            <View style={{ marginTop: 6 }}>
              <MenuRow
                icon={<Feather name="users" size={18} color={isDarkMode ? PURPLE_LIGHT : PURPLE} />}
                title="Community"
                subtitle="Your Fans Club — post and engage with readers."
                // Re-gated as "coming soon" pending the next round of
                // backend hardening + UX polish. Tapping shows the
                // SOON Alert instead of routing to /(community).
                comingSoon
                theme={theme}
                isDarkMode={isDarkMode}
              />
              <View style={{ height: 8 }} />
              <MenuRow
                icon={<MaterialCommunityIcons name="trophy-outline" size={18} color={isDarkMode ? PURPLE_LIGHT : PURPLE} />}
                title="Supporter Leaderboard"
                subtitle="The biggest hearts on Selebox."
                onPress={() => go("/(profile)/supporter-leaderboard")}
                theme={theme}
                isDarkMode={isDarkMode}
              />
              <View style={{ height: 8 }} />
              <MenuRow
                icon={<MaterialCommunityIcons name="chart-line" size={18} color={isDarkMode ? PURPLE_LIGHT : PURPLE} />}
                title="Creator & Writer Rankings"
                subtitle="The top voices rising this season."
                onPress={() => go("/(profile)/creator-writer-rankings")}
                theme={theme}
                isDarkMode={isDarkMode}
              />
            </View>
          </View>

          {/* Active shortcuts — these all map to existing routes. The
              Edit Profile screen has the same destinations buried two
              taps deep; this drawer surfaces them one tap from any
              main screen via the avatar. */}
          <View style={{ marginBottom: 14 }}>
            <SectionLabel theme={theme}>Your Tools</SectionLabel>
            <View style={{ marginTop: 6 }}>
              <MenuRow
                icon={<MaterialCommunityIcons name="hand-coin-outline" size={20} color={isDarkMode ? PURPLE_LIGHT : PURPLE} />}
                title="Payments"
                subtitle="Manage payouts and tax details."
                onPress={() => go("/(payments)/payments")}
                theme={theme}
                isDarkMode={isDarkMode}
              />
              <View style={{ height: 8 }} />
              <MenuRow
                icon={<MaterialCommunityIcons name="notebook-edit-outline" size={20} color={isDarkMode ? PURPLE_LIGHT : PURPLE} />}
                title="Author Section"
                subtitle="Write, edit, and publish stories."
                onPress={() => go("/(book)/catalog")}
                theme={theme}
                isDarkMode={isDarkMode}
              />
              <View style={{ height: 8 }} />
              <MenuRow
                icon={<MaterialCommunityIcons name="movie-edit-outline" size={20} color={isDarkMode ? PURPLE_LIGHT : PURPLE} />}
                title="Creator Section"
                subtitle="Upload and manage your videos."
                onPress={() => go("/(video)/creator-section")}
                theme={theme}
                isDarkMode={isDarkMode}
              />
            </View>
          </View>

          {/* Log out — destructive, sits on its own with a small top
              divider so it's never accidentally lumped in with the
              navigation rows above. Confirmation prompt is the
              caller's responsibility (onLogout) — we just close + fire. */}
          <View
            style={{
              marginTop: 8,
              paddingTop: 14,
              borderTopWidth: 1,
              borderTopColor: dividerColor,
            }}
          >
            <MenuRow
              icon={<Feather name="log-out" size={18} color={theme.danger || "#ef4444"} />}
              title="Log out"
              subtitle="Sign out of this account."
              onPress={handleLogout}
              tone="danger"
              theme={theme}
              isDarkMode={isDarkMode}
            />
          </View>
        </ScrollView>
      </View>
    </RNModal>
  );
};

// Section heading label — small all-caps purple-brand text. Used to
// break the menu into "Discover & Community" / "Your Tools" buckets
// so a returning user can scan quickly without reading every row.
// In light mode we use the saturated brand purple so the label stays
// readable on white; in dark mode we soften with the lighter purple.
const SectionLabel = ({ children, theme }) => (
  <Text
    style={{
      color: theme.accentPurple || PURPLE,
      fontSize: 10,
      fontWeight: "800",
      letterSpacing: 1.2,
      textTransform: "uppercase",
      marginLeft: 4,
      marginBottom: 2,
      opacity: 0.9,
    }}
  >
    {children}
  </Text>
);

export default ProfileMenuModal;
