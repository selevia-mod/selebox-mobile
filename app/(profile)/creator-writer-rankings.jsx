// app/(profile)/creator-writer-rankings.jsx
//
// Creator & Writer Rankings — ranks users by aggregated engagement
// across all their books + videos. Backed by the
// `get_creator_writer_rankings(p_period, p_limit)` Supabase RPC.
//
// Score = (Reads + Likes×5 + Comments×15 + Rates×25) × (0.7 + avg/10)
//
// Layout mirrors the Supporter Leaderboard (same podium, same tier
// pill, same row treatment) so the two leaderboards feel like a
// matched set. Different tier labels + score copy so users can tell
// which board they're on at a glance:
//   • #1  → Top Voice       👑
//   • #2  → Rising Star     💎
//   • #3  → Featured Creator 💜
//   • #4+ → On the Charts   ✨
//
// Premium polish settings carried over from supporter-leaderboard:
//   • paddingHorizontal: 14 across header/podium/list
//   • #3 wrapper paddingTop: 50 (visibly lower than #2's 28 so #2
//     stands out)
//   • Pillars row marginTop: 2 (chips sit nearly on top of pillars)
//   • Outer container width: "100%" to defeat StyledSafeAreaView's
//     items-center constraint.

import { Feather, MaterialIcons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, InteractionManager, RefreshControl, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { StyledSafeAreaView } from "../../components";
import useAppTheme from "../../hooks/useAppTheme";
import { getCreatorWriterRankings } from "../../lib/rankings-supabase";

const PURPLE = "#8b5cf6";
const PURPLE_LIGHT = "#a78bfa";
const PURPLE_DEEP = "#6d28d9";

const PERIODS = [
  { key: "all_time", label: "All Time" },
  { key: "month", label: "This Month" },
  { key: "week", label: "This Week" },
];

const formatScore = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}K`;
  if (v >= 1_000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return v.toLocaleString();
};

// Score chip — distinct from the supporter board's gift-emoji chip.
// Uses a chart icon to read as "ranking score" rather than "coins."
const ScoreChip = ({ amount, size = "md", isDarkMode }) => {
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
      <Text style={{ fontSize: fs - 1, marginRight: 5 }}>🏆</Text>
      <Text
        style={{
          color: isDarkMode ? "#fff" : PURPLE_DEEP,
          fontSize: fs,
          fontWeight: "800",
          letterSpacing: 0.3,
        }}
      >
        {formatScore(amount)}
      </Text>
    </View>
  );
};

// Podium pillar — three stacked translucent layers fake a vertical
// gradient. Identical to the supporter-leaderboard pillar; kept
// inline rather than shared so the two screens can diverge later
// without coupling.
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
      <View
        style={{
          height: "55%",
          backgroundColor: isDarkMode ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.32)",
        }}
      />
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

const PodiumBlock = ({ rows, theme, isDarkMode, onPressUser }) => {
  const first = rows[0] || null;
  const second = rows[1] || null;
  const third = rows[2] || null;

  const renderEntry = (entry, rank) => {
    const isOne = rank === 1;
    const avatarSize = isOne ? 96 : 76;
    const showCrown = isOne;

    if (!entry) {
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
          {entry.avgRating > 0 ? ` · ★ ${entry.avgRating.toFixed(1)}` : ""}
        </Text>
        <View style={{ marginTop: 8 }}>
          <ScoreChip amount={entry.score} size={isOne ? "lg" : "md"} isDarkMode={isDarkMode} />
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={{ marginTop: 16, paddingHorizontal: 14 }}>
      {/* Avatars row — #2 left, #1 centre raised, #3 right. Bottom-
          aligned with #3 wrapper paddingTop:50 so it sits visibly
          lower than #2 (paddingTop:28), making #2 stand out. */}
      <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "center" }}>
        <View style={{ flex: 1, paddingTop: 28 }}>{renderEntry(second, 2)}</View>
        <View style={{ flex: 1.1 }}>{renderEntry(first, 1)}</View>
        <View style={{ flex: 1, paddingTop: 50 }}>{renderEntry(third, 3)}</View>
      </View>

      {/* Pillars under each avatar — #1 tallest, #2 medium, #3
          shortest. marginTop:2 so chips sit nearly on top of bars. */}
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

// Single row in the rankings list (positions 4+). Includes a small
// "metric strip" under the username with content count + avg
// rating, since for creator rankings the underlying signals are
// more interesting than for the supporter board.
const RankingRow = ({ entry, theme, isDarkMode, onPress }) => (
  <TouchableOpacity
    activeOpacity={0.85}
    onPress={() => onPress(entry)}
    style={{
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 12,
      paddingHorizontal: 12,
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
        {entry.avgRating > 0 ? ` · ★ ${entry.avgRating.toFixed(1)}` : ""}
      </Text>
    </View>
    <ScoreChip amount={entry.score} size="md" isDarkMode={isDarkMode} />
  </TouchableOpacity>
);

const CreatorWriterRankings = () => {
  const { theme, isDarkMode } = useAppTheme();
  const [period, setPeriod] = useState("all_time");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (nextPeriod = period, force = false) => {
      try {
        if (!force) setLoading(true);
        const data = await getCreatorWriterRankings({ period: nextPeriod, limit: 100, force });
        setRows(data || []);
      } catch (err) {
        console.warn("[creator-writer-rankings] load error", err?.message || err);
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
    setRows([]);
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
      {/* Force full-width — same fix as supporter-leaderboard. */}
      <View style={{ flex: 1, width: "100%", backgroundColor: theme.background }}>
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
              Creator & Writer Rankings
            </Text>
          </View>
          <View style={{ width: 38, height: 38 }} />
        </View>

        <FlatList
          data={restRows}
          keyExtractor={(item) => item.userId}
          renderItem={({ item }) => (
            <RankingRow entry={item} theme={theme} isDarkMode={isDarkMode} onPress={handlePressUser} />
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
                The top voices rising on Selebox 💜
              </Text>

              <PeriodFilter value={period} onChange={handlePeriodChange} theme={theme} isDarkMode={isDarkMode} />

              {loading ? (
                <View style={{ paddingVertical: 60, alignItems: "center" }}>
                  <ActivityIndicator color={PURPLE} size="large" />
                  <Text style={{ marginTop: 12, color: theme.textSoft, fontSize: 12, fontWeight: "600" }}>
                    Tallying the charts…
                  </Text>
                </View>
              ) : podiumRows.length === 0 ? (
                <View style={{ paddingVertical: 60, alignItems: "center", paddingHorizontal: 24 }}>
                  <Feather name="trending-up" size={36} color={PURPLE_LIGHT} />
                  <Text
                    style={{
                      marginTop: 12,
                      color: theme.text,
                      fontSize: 15,
                      fontWeight: "800",
                      textAlign: "center",
                    }}
                  >
                    No rankings yet
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
                    Publish a book or video to plant the leaderboard's first flag.
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
                    The rest of the charts
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
                  paddingHorizontal: 12,
                  lineHeight: 16,
                }}
              >
                Score = Views + Likes ×5 + Comments ×15
              </Text>
            ) : null
          }
        />
      </View>
    </StyledSafeAreaView>
  );
};

export default CreatorWriterRankings;
