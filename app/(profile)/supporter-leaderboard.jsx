// app/(profile)/supporter-leaderboard.jsx
//
// Supporter Leaderboard — ranks users by total coin activity across
// Selebox (coins bought + coins spent), descending. Backed by the
// `get_supporter_leaderboard(p_period, p_limit)` Supabase RPC. See
// `lib/leaderboard-supabase.js` for caching, tier resolution, and
// the underlying ABS(delta) sum logic.
//
// Layout:
//   • Header — back button + title + subtitle
//   • Time filter — All Time / This Month / This Week (pill row)
//   • Podium — top 3 with #1 elevated centre, #2 left, #3 right.
//     #1 wears a crown emoji over their avatar; the platform tier
//     badge ("Diamond Supporter 💎") shows beneath the username.
//   • Rest of leaderboard — numbered list (4+) on a violet card
//     surface, FlashList-friendly but small enough that FlatList
//     performs fine at top-100 cap.
//   • Pull-to-refresh + 5-min in-memory cache (handled in service).
//
// Premium purple identity, mode-aware:
//   • Light: white base, soft violet podium platform, glass cards,
//     saturated purple accents.
//   • Dark : deep slate base, glow-purple podium, purple-soft cards,
//     high-contrast white text. Mirrors the rest of the app's dark
//     identity.

import { Feather, MaterialIcons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, InteractionManager, RefreshControl, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { StyledSafeAreaView } from "../../components";
import useAppTheme from "../../hooks/useAppTheme";
import { getSupporterLeaderboard } from "../../lib/leaderboard-supabase";

const PURPLE = "#8b5cf6";
const PURPLE_LIGHT = "#a78bfa";
const PURPLE_DEEP = "#6d28d9";

const PERIODS = [
  { key: "all_time", label: "All Time" },
  { key: "month", label: "This Month" },
  { key: "week", label: "This Week" },
];

// Compact number formatter for coin pills (1.2K instead of 1234).
const formatCoins = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}K`;
  if (v >= 1_000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return v.toLocaleString();
};

// Coin chip — reused across podium + list rows. The amber gift glyph
// pairs with the brand purple background so the eye reads "coins" at
// a glance without needing a tooltip.
const CoinChip = ({ amount, size = "md", isDarkMode }) => {
  const padV = size === "lg" ? 6 : 4;
  const padH = size === "lg" ? 14 : 11;
  const fs = size === "lg" ? 15 : 13;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: isDarkMode ? "rgba(139,92,246,0.22)" : "#f5f0ff",
        borderWidth: 1,
        borderColor: isDarkMode ? "rgba(167,139,250,0.42)" : "rgba(139,92,246,0.28)",
        borderRadius: 999,
        paddingVertical: padV,
        paddingHorizontal: padH,
      }}
    >
      <Text style={{ fontSize: fs - 1, marginRight: 5 }}>🎁</Text>
      <Text
        style={{
          color: isDarkMode ? "#fff" : PURPLE_DEEP,
          fontSize: fs,
          fontWeight: "800",
          letterSpacing: 0.3,
        }}
      >
        {formatCoins(amount)}
      </Text>
    </View>
  );
};

// Podium pillar — three stacked translucent layers fake a vertical
// gradient without expo-linear-gradient (which isn't a project dep).
// Light/dark each get their own palette tuned for legibility.
const PodiumPillar = ({ rank, height, theme, isDarkMode }) => {
  const baseColor = rank === 1 ? PURPLE : rank === 2 ? PURPLE_LIGHT : "#c4b5fd";
  return (
    <View
      style={{
        height,
        width: "100%",
        borderTopLeftRadius: 14,
        borderTopRightRadius: 14,
        overflow: "hidden",
        backgroundColor: baseColor,
      }}
    >
      {/* Top sheen — bright violet wash so the pillar reads "lit from
          above". Lower opacity in dark mode so it doesn't blow out. */}
      <View
        style={{
          height: "55%",
          backgroundColor: isDarkMode ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.32)",
        }}
      />
      {/* Centred rank number — large, semi-translucent so it doesn't
          fight the avatar above. */}
      <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}>
        <Text
          style={{
            color: "rgba(255,255,255,0.96)",
            fontSize: rank === 1 ? 56 : 44,
            fontWeight: "900",
            letterSpacing: 1,
            textShadowColor: "rgba(91,33,182,0.45)",
            textShadowOffset: { width: 0, height: 2 },
            textShadowRadius: 6,
          }}
        >
          {rank}
        </Text>
      </View>
    </View>
  );
};

// Top 3 podium block. Position #1 centre + bigger; #2 left, #3 right.
// Each entry shows avatar + crown (rank 1 only) + name + tier badge +
// coin chip below.
const PodiumBlock = ({ rows, theme, isDarkMode, onPressUser }) => {
  const first = rows[0] || null;
  const second = rows[1] || null;
  const third = rows[2] || null;

  const renderEntry = (entry, rank) => {
    const isOne = rank === 1;
    const avatarSize = isOne ? 96 : 76;
    const showCrown = isOne;

    if (!entry) {
      // Placeholder slot when fewer than 3 supporters exist.
      return (
        <View style={{ flex: 1, alignItems: "center", paddingHorizontal: 4 }}>
          <View
            style={{
              width: avatarSize,
              height: avatarSize,
              borderRadius: avatarSize / 2,
              backgroundColor: isDarkMode ? "rgba(255,255,255,0.04)" : theme.surfaceMuted,
              borderWidth: 2,
              borderColor: isDarkMode ? "rgba(167,139,250,0.20)" : "rgba(139,92,246,0.15)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: theme.textSubtle, fontSize: 12, fontWeight: "700" }}>—</Text>
          </View>
          <Text style={{ marginTop: 8, color: theme.textSoft, fontSize: 12, fontWeight: "600" }}>Open spot</Text>
        </View>
      );
    }

    return (
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => onPressUser(entry)}
        style={{ flex: 1, alignItems: "center", paddingHorizontal: 4 }}
      >
        <View style={{ position: "relative" }}>
          {showCrown ? (
            <Text style={{ position: "absolute", top: -28, alignSelf: "center", fontSize: 30, zIndex: 5 }}>👑</Text>
          ) : null}
          {/* Glow halo on rank 1 — soft amber wash behind the avatar to
              echo the crown's gold. Subtle on rank 2/3 (purple). */}
          <View
            style={{
              position: "absolute",
              top: -6,
              left: -6,
              right: -6,
              bottom: -6,
              borderRadius: (avatarSize + 12) / 2,
              backgroundColor: isOne
                ? isDarkMode
                  ? "rgba(251,191,36,0.16)"
                  : "rgba(251,191,36,0.20)"
                : isDarkMode
                ? "rgba(139,92,246,0.18)"
                : "rgba(139,92,246,0.10)",
            }}
          />
          {entry.avatarUrl ? (
            <FastImage
              source={{ uri: entry.avatarUrl }}
              style={{
                width: avatarSize,
                height: avatarSize,
                borderRadius: avatarSize / 2,
                borderWidth: 3,
                borderColor: isOne ? "#fbbf24" : PURPLE,
              }}
            />
          ) : (
            <View
              style={{
                width: avatarSize,
                height: avatarSize,
                borderRadius: avatarSize / 2,
                borderWidth: 3,
                borderColor: isOne ? "#fbbf24" : PURPLE,
                backgroundColor: isDarkMode ? "rgba(139,92,246,0.18)" : "#f5f0ff",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: PURPLE, fontSize: avatarSize * 0.36, fontWeight: "800" }}>
                {(entry.username || "?").charAt(0).toUpperCase()}
              </Text>
            </View>
          )}
        </View>
        <Text
          numberOfLines={1}
          style={{
            marginTop: 12,
            color: theme.text,
            fontSize: isOne ? 16 : 13,
            fontWeight: "800",
            letterSpacing: 0.3,
            maxWidth: avatarSize + 20,
          }}
        >
          {entry.username}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            marginTop: 2,
            color: theme.textSoft,
            fontSize: isOne ? 12 : 11,
            fontWeight: "600",
          }}
        >
          {entry.tier.label} {entry.tier.emoji}
        </Text>
        <View style={{ marginTop: 8 }}>
          <CoinChip amount={entry.totalCoins} size={isOne ? "lg" : "md"} isDarkMode={isDarkMode} />
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={{ marginTop: 16, paddingHorizontal: 14 }}>
      {/* Avatars row — #2 left, #1 centre raised, #3 right. Bottom-
          aligned so the larger #1 avatar sits naturally taller. */}
      <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "center" }}>
        <View style={{ flex: 1, paddingTop: 28 }}>{renderEntry(second, 2)}</View>
        <View style={{ flex: 1.1 }}>{renderEntry(first, 1)}</View>
        <View style={{ flex: 1, paddingTop: 50 }}>{renderEntry(third, 3)}</View>
      </View>

      {/* Pillars under each avatar — #1 tallest, #2 medium, #3 shortest.
          Establishes the "podium" read with no expo-linear-gradient. */}
      <View style={{ flexDirection: "row", alignItems: "flex-end", marginTop: 2 }}>
        <View style={{ flex: 1, paddingHorizontal: 4 }}>
          <PodiumPillar rank={2} height={88} theme={theme} isDarkMode={isDarkMode} />
        </View>
        <View style={{ flex: 1.1, paddingHorizontal: 4 }}>
          <PodiumPillar rank={1} height={120} theme={theme} isDarkMode={isDarkMode} />
        </View>
        <View style={{ flex: 1, paddingHorizontal: 4 }}>
          <PodiumPillar rank={3} height={66} theme={theme} isDarkMode={isDarkMode} />
        </View>
      </View>
    </View>
  );
};

// Time-period segmented filter — pill row sitting just under the
// title. Active pill gets the saturated brand purple; inactive pills
// fade to a glass treatment.
const PeriodFilter = ({ value, onChange, theme, isDarkMode }) => (
  <View
    style={{
      flexDirection: "row",
      alignSelf: "center",
      marginTop: 16,
      padding: 4,
      borderRadius: 999,
      backgroundColor: isDarkMode ? "rgba(255,255,255,0.04)" : "#f5f0ff",
      borderWidth: 1,
      borderColor: isDarkMode ? "rgba(255,255,255,0.08)" : "rgba(139,92,246,0.18)",
    }}
  >
    {PERIODS.map((period) => {
      const active = value === period.key;
      return (
        <TouchableOpacity
          key={period.key}
          activeOpacity={0.85}
          onPress={() => onChange(period.key)}
          style={{
            paddingVertical: 7,
            paddingHorizontal: 16,
            borderRadius: 999,
            backgroundColor: active ? PURPLE : "transparent",
          }}
        >
          <Text
            style={{
              color: active ? "#ffffff" : theme.textSoft,
              fontSize: 12,
              fontWeight: active ? "800" : "600",
              letterSpacing: 0.3,
            }}
          >
            {period.label}
          </Text>
        </TouchableOpacity>
      );
    })}
  </View>
);

// Single row in the leaderboard list (positions 4+). Number on the
// left, avatar, name + tier label, coin chip on the right.
const LeaderRow = ({ entry, theme, isDarkMode, onPress }) => (
  <TouchableOpacity
    activeOpacity={0.85}
    onPress={() => onPress(entry)}
    style={{
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 12,
      paddingHorizontal: 14,
      marginBottom: 8,
      borderRadius: 16,
      backgroundColor: isDarkMode ? "rgba(255,255,255,0.04)" : "#ffffff",
      borderWidth: 1,
      borderColor: isDarkMode ? "rgba(255,255,255,0.08)" : "rgba(139,92,246,0.10)",
    }}
  >
    <View style={{ width: 28, alignItems: "center" }}>
      <Text style={{ color: theme.textSoft, fontSize: 14, fontWeight: "800" }}>{entry.rank}.</Text>
    </View>
    {entry.avatarUrl ? (
      <FastImage
        source={{ uri: entry.avatarUrl }}
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          marginLeft: 6,
          backgroundColor: theme.surfaceMuted,
          borderWidth: 1,
          borderColor: "rgba(139,92,246,0.20)",
        }}
      />
    ) : (
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          marginLeft: 6,
          backgroundColor: isDarkMode ? "rgba(139,92,246,0.18)" : "#f5f0ff",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: PURPLE, fontSize: 16, fontWeight: "800" }}>
          {(entry.username || "?").charAt(0).toUpperCase()}
        </Text>
      </View>
    )}
    <View style={{ flex: 1, marginLeft: 12 }}>
      <Text numberOfLines={1} style={{ color: theme.text, fontSize: 14, fontWeight: "700" }}>
        {entry.username}
      </Text>
      <Text numberOfLines={1} style={{ marginTop: 2, color: theme.textSoft, fontSize: 11, fontWeight: "600" }}>
        {entry.tier.label} {entry.tier.emoji}
      </Text>
    </View>
    <CoinChip amount={entry.totalCoins} size="md" isDarkMode={isDarkMode} />
  </TouchableOpacity>
);

const SupporterLeaderboard = () => {
  const { theme, isDarkMode } = useAppTheme();
  const [period, setPeriod] = useState("all_time");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (nextPeriod = period, force = false) => {
      try {
        if (!force) setLoading(true);
        const data = await getSupporterLeaderboard({ period: nextPeriod, limit: 100, force });
        setRows(data || []);
      } catch (err) {
        console.warn("[supporter-leaderboard] load error", err?.message || err);
        setRows([]);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [period],
  );

  useFocusEffect(
    useCallback(() => {
      // Defer the RPC behind the route transition so the screen
      // slide-in stays smooth (same pattern we applied to book-info,
      // creator-profile, and video-player).
      const handle = InteractionManager.runAfterInteractions(() => {
        load(period, false);
      });
      return () => handle?.cancel?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [period]),
  );

  const handlePeriodChange = (next) => {
    if (next === period) return;
    setPeriod(next);
    setRows([]); // wipe stale rows so the loader takes over briefly
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await load(period, true);
  };

  const handlePressUser = (entry) => {
    if (!entry?.userId) return;
    router.push({ pathname: "/creator-profile", params: { userId: entry.userId } });
  };

  const podiumRows = useMemo(() => rows.slice(0, 3), [rows]);
  const restRows = useMemo(() => rows.slice(3), [rows]);

  return (
    <StyledSafeAreaView>
      {/* `StyledSafeAreaView` applies `items-center` on its parent
          flex column, which collapses children to their intrinsic
          width. Force this container to stretch full-width with
          `width: "100%"` (mirrors the `h-full w-full` pattern used by
          profile.jsx + other (profile) screens). Without this, the
          podium + list rows shrink to mid-screen and the side gaps
          look huge regardless of padding values. */}
      <View style={{ flex: 1, width: "100%", backgroundColor: theme.background }}>
        {/* Header — back arrow + centred title + invisible spacer for
            symmetry. No title icon: the page is its own brand. */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 14,
            paddingTop: 6,
            paddingBottom: 4,
          }}
        >
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => router.back()}
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.surfaceMuted,
              borderWidth: 1,
              borderColor: theme.border,
            }}
          >
            <MaterialIcons name="arrow-back" size={20} color={theme.icon} />
          </TouchableOpacity>
          <View style={{ flex: 1, alignItems: "center" }}>
            <Text style={{ color: theme.text, fontSize: 16, fontWeight: "800", letterSpacing: 0.3 }}>
              Supporter Leaderboard
            </Text>
          </View>
          {/* Spacer matches the back-button hit area so the title stays
              perfectly centered. Render an invisible View, not null. */}
          <View style={{ width: 38, height: 38 }} />
        </View>

        <FlatList
          data={restRows}
          keyExtractor={(item) => item.userId}
          renderItem={({ item }) => (
            <LeaderRow entry={item} theme={theme} isDarkMode={isDarkMode} onPress={handlePressUser} />
          )}
          contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 32 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={PURPLE}
              colors={[PURPLE]}
            />
          }
          ListHeaderComponent={
            <View>
              {/* Subtitle */}
              <Text
                style={{
                  marginTop: 4,
                  textAlign: "center",
                  color: theme.textSoft,
                  fontSize: 13,
                  fontWeight: "500",
                  letterSpacing: 0.2,
                  paddingHorizontal: 24,
                }}
              >
                The fans who give the most love across Selebox 💜
              </Text>

              <PeriodFilter value={period} onChange={handlePeriodChange} theme={theme} isDarkMode={isDarkMode} />

              {loading ? (
                <View style={{ paddingVertical: 60, alignItems: "center" }}>
                  <ActivityIndicator color={PURPLE} size="large" />
                  <Text style={{ marginTop: 12, color: theme.textSoft, fontSize: 12, fontWeight: "600" }}>
                    Loading the love…
                  </Text>
                </View>
              ) : podiumRows.length === 0 ? (
                <View style={{ paddingVertical: 60, alignItems: "center", paddingHorizontal: 24 }}>
                  <Feather name="heart" size={36} color={PURPLE_LIGHT} />
                  <Text
                    style={{
                      marginTop: 12,
                      color: theme.text,
                      fontSize: 15,
                      fontWeight: "800",
                      textAlign: "center",
                    }}
                  >
                    No supporters yet
                  </Text>
                  <Text
                    style={{
                      marginTop: 6,
                      color: theme.textSoft,
                      fontSize: 12,
                      textAlign: "center",
                      lineHeight: 18,
                    }}
                  >
                    Send your first gift on a story to plant the leaderboard's first flag.
                  </Text>
                </View>
              ) : (
                <PodiumBlock
                  rows={podiumRows}
                  theme={theme}
                  isDarkMode={isDarkMode}
                  onPressUser={handlePressUser}
                />
              )}

              {restRows.length > 0 ? (
                <View style={{ marginTop: 22, marginBottom: 10, paddingHorizontal: 4 }}>
                  <Text
                    style={{
                      color: theme.accentPurple || PURPLE,
                      fontSize: 11,
                      fontWeight: "800",
                      letterSpacing: 1.2,
                      textTransform: "uppercase",
                    }}
                  >
                    The rest of the love
                  </Text>
                </View>
              ) : null}
            </View>
          }
          ListFooterComponent={
            !loading && rows.length > 0 ? (
              <Text
                style={{
                  marginTop: 18,
                  textAlign: "center",
                  color: theme.textSubtle,
                  fontSize: 11,
                  fontWeight: "500",
                  letterSpacing: 0.3,
                }}
              >
                Rankings refresh every few minutes.
              </Text>
            ) : null
          }
        />
      </View>
    </StyledSafeAreaView>
  );
};

export default SupporterLeaderboard;
