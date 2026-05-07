// app/(store)/star-history.jsx — Star earning history.
//
// Opens when the user taps the Stars balance card on /store. Shows
// each day's ad-watch count from public.ad_rewards (one row per
// user per calendar day; ads_watched is the count for that day,
// last_watched_at is the most recent timestamp).
//
// Per-event timestamps aren't available — the schema stores daily
// aggregates only. To list "ad watched at 10:14, ad watched at
// 09:52" we'd need a phase-2 ad_reward_events table. Tracked.
//
// Filter chips:
//   • All time   — every row
//   • This week  — last 7 days
//   • Today      — only today
//
// Pagination: simple cap at 60 days. Far enough back for most users
// to see their pattern; further back can be a phase-2 cursor read.

import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { StarIcon, StyledSafeAreaView } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { StarService } from "../../lib/stars";
import supabase from "../../lib/supabase";

const FILTERS = [
  { key: "all",    label: "All time" },
  { key: "week",   label: "This week" },
  { key: "today",  label: "Today" },
];

const dayLabel = (dateString) => {
  if (!dateString) return "";
  const d = new Date(dateString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today - target) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
};

const timeLabel = (isoString) => {
  if (!isoString) return null;
  return new Date(isoString).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

export default function StarHistory() {
  const { theme } = useAppTheme();
  const { user } = useGlobalContext();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [days, setDays] = useState([]);
  const [filter, setFilter] = useState("all");
  const [stars, setStars] = useState(0);

  const fetchHistory = useCallback(async () => {
    if (!user?.$id) return;
    try {
      // Daily aggregate read — one row per (user, day).
      const { data, error } = await supabase
        .from("ad_rewards")
        .select("reward_date, ads_watched, last_watched_at")
        .eq("user_id", user.$id)
        .order("reward_date", { ascending: false })
        .limit(60);
      if (error) {
        console.warn("[star-history] fetch failed:", error.message);
        setDays([]);
      } else {
        setDays(data || []);
      }

      // Pull current star balance for the summary card. Falls back
      // gracefully if the read errors — empty / 0 is a valid state.
      try {
        const summary = await StarService.getStars(user.$id);
        setStars(summary?.stars ?? 0);
      } catch (e) {
        console.warn("[star-history] stars read failed:", e?.message);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.$id]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchHistory();
  }, [fetchHistory]);

  const filtered = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return days.filter((d) => {
      const target = new Date(d.reward_date);
      const diffDays = Math.round((today - target) / (1000 * 60 * 60 * 24));
      if (filter === "today") return diffDays === 0;
      if (filter === "week")  return diffDays >= 0 && diffDays < 7;
      return true;
    });
  }, [days, filter]);

  const totalEarned = useMemo(
    () => filtered.reduce((sum, d) => sum + (d.ads_watched || 0), 0),
    [filtered],
  );

  return (
    <StyledSafeAreaView>
      <View style={{ flex: 1, backgroundColor: theme.background }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderColor: theme.border,
          }}
        >
          <TouchableOpacity onPress={() => router.back()} accessibilityLabel="Back">
            <Ionicons name="arrow-back" size={24} color={theme.icon} />
          </TouchableOpacity>
          <Text style={{ marginLeft: 12, fontSize: 17, fontWeight: "600", color: theme.text }}>
            Star history
          </Text>
        </View>

        {/* Balance summary card — same shape as Coin History but with
            the existing StarIcon and the amber accent the rest of the
            app uses for stars. */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 16,
            paddingVertical: 14,
            backgroundColor: theme.accentAmberSoft,
          }}
        >
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: theme.accentAmberSoft,
              borderWidth: 1,
              borderColor: theme.accentAmber,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <StarIcon size={24} color={theme.coin} />
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ fontSize: 11, color: theme.textSoft }}>Current balance</Text>
            <Text style={{ fontSize: 22, fontWeight: "700", color: theme.text }}>
              {stars} stars
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => router.replace("/store")}
            style={{
              backgroundColor: theme.accentAmber,
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 18,
            }}
          >
            <Text style={{ color: theme.primaryContrast, fontSize: 12, fontWeight: "600" }}>
              Earn more
            </Text>
          </TouchableOpacity>
        </View>

        <View
          style={{
            flexDirection: "row",
            paddingHorizontal: 16,
            paddingVertical: 10,
            gap: 8,
            borderBottomWidth: 1,
            borderColor: theme.border,
          }}
        >
          {FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <TouchableOpacity
                key={f.key}
                onPress={() => setFilter(f.key)}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 5,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: active ? theme.accentAmber : theme.border,
                  backgroundColor: active ? theme.accentAmber : "transparent",
                }}
              >
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: "600",
                    color: active ? theme.primaryContrast : theme.textSoft,
                  }}
                >
                  {f.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Total-in-window summary — small footer-style line so the
            user knows the filter actually changed something. */}
        {!loading && filtered.length > 0 && (
          <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 }}>
            <Text style={{ fontSize: 11, color: theme.textSoft }}>
              {totalEarned} {totalEarned === 1 ? "star" : "stars"} earned in this period
            </Text>
          </View>
        )}

        {loading ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={theme.accentAmber} />
          </View>
        ) : filtered.length === 0 ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
            <StarIcon size={36} color={theme.textSoft} />
            <Text style={{ marginTop: 12, fontSize: 15, fontWeight: "500", color: theme.text }}>
              No stars earned yet
            </Text>
            <Text
              style={{
                marginTop: 6,
                fontSize: 12,
                color: theme.textSoft,
                textAlign: "center",
                lineHeight: 18,
              }}
            >
              Watch a rewarded ad in the store to earn your first star.
            </Text>
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(d) => d.reward_date}
            renderItem={({ item }) => <DayRow item={item} theme={theme} />}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accentAmber} />
            }
          />
        )}
      </View>
    </StyledSafeAreaView>
  );
}

const DayRow = ({ item, theme }) => {
  const count = item.ads_watched || 0;
  const lastTime = timeLabel(item.last_watched_at);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderColor: theme.border,
      }}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          backgroundColor: theme.accentAmberSoft,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <StarIcon size={18} color={theme.coin} />
      </View>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.text }}>
          {dayLabel(item.reward_date)}
        </Text>
        <Text style={{ fontSize: 11, color: theme.textSoft, marginTop: 2 }}>
          {count} {count === 1 ? "ad" : "ads"} watched
          {lastTime ? ` · last ${lastTime}` : ""}
        </Text>
      </View>
      <Text style={{ fontSize: 14, fontWeight: "700", color: theme.accentAmber }}>
        +{count}
      </Text>
    </View>
  );
}
