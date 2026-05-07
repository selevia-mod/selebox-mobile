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
// Pagination: cursor-based off `reward_date`. Initial fetch grabs
// PAGE_SIZE most-recent days; older days stream in via onEndReached
// using the oldest visible day as a strict-less-than cursor. Filter
// chips (today/week/all) constrain BOTH the initial query and the
// load-more query so we never waste a page slot on a row outside the
// active window.

import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// 30 days fits a full month above the fold; load-more pulls another 30.
const PAGE_SIZE = 30;

// "today" / "week" filters constrain to a date range; "all" is unbounded.
// Returns the lower bound (>=) as a YYYY-MM-DD string, or null for all-time.
// We compute today off the device clock — the rows store local-day
// reward_date, so a UTC-anchored comparison would skew at midnight.
const lowerBoundFor = (filter) => {
  if (filter === "today") {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  if (filter === "week") {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return null;
};

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
  // Pagination state machine — cursor is the oldest loaded reward_date
  // string (YYYY-MM-DD). Same shape as coin-history; refs mirror
  // hot-path values so the loadMore closure doesn't churn identity.
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const cursorRef = useRef(null);
  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);

  // Build the base ad_rewards query. Both initial load and loadMore
  // call this; only the cursor (`before`) changes.
  const runQuery = useCallback(
    async ({ before = null, currentFilter }) => {
      const lower = lowerBoundFor(currentFilter);
      let q = supabase
        .from("ad_rewards")
        .select("reward_date, ads_watched, last_watched_at")
        .eq("user_id", user.$id)
        .order("reward_date", { ascending: false })
        .limit(PAGE_SIZE);
      if (lower)  q = q.gte("reward_date", lower);
      if (before) q = q.lt("reward_date", before);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },
    [user?.$id],
  );

  // Star balance is independent of the page state — fetch it alongside
  // page 1 so the header card paints with the real number.
  const fetchStarsBalance = useCallback(async () => {
    if (!user?.$id) return;
    try {
      const summary = await StarService.getStars(user.$id);
      setStars(summary?.stars ?? 0);
    } catch (e) {
      console.warn("[star-history] stars read failed:", e?.message);
    }
  }, [user?.$id]);

  const fetchInitial = useCallback(
    async (overrideFilter) => {
      if (!user?.$id) return;
      const currentFilter = overrideFilter ?? filter;
      try {
        const data = await runQuery({ before: null, currentFilter });
        setDays(data);
        const nextHasMore = data.length >= PAGE_SIZE;
        const nextCursor = data.length > 0 ? data[data.length - 1].reward_date : null;
        setHasMore(nextHasMore);
        setCursor(nextCursor);
        hasMoreRef.current = nextHasMore;
        cursorRef.current = nextCursor;
      } catch (e) {
        console.warn("[star-history] initial fetch failed:", e?.message);
        setDays([]);
        setHasMore(false);
        hasMoreRef.current = false;
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [user?.$id, filter, runQuery],
  );

  const fetchMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    if (!hasMoreRef.current) return;
    if (!cursorRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const data = await runQuery({ before: cursorRef.current, currentFilter: filter });
      setDays((prev) => {
        const seen = new Set(prev.map((d) => d.reward_date));
        const fresh = data.filter((d) => !seen.has(d.reward_date));
        if (fresh.length === 0) {
          hasMoreRef.current = false;
          setHasMore(false);
          return prev;
        }
        const merged = [...prev, ...fresh];
        const nextHasMore = data.length >= PAGE_SIZE;
        const nextCursor = data[data.length - 1].reward_date;
        hasMoreRef.current = nextHasMore;
        cursorRef.current = nextCursor;
        setHasMore(nextHasMore);
        setCursor(nextCursor);
        return merged;
      });
    } catch (e) {
      console.warn("[star-history] loadMore failed:", e?.message);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [filter, runQuery]);

  useEffect(() => {
    fetchInitial();
    fetchStarsBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.$id]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setDays([]);
    setCursor(null);
    setHasMore(true);
    cursorRef.current = null;
    hasMoreRef.current = true;
    fetchInitial();
    fetchStarsBalance();
  }, [fetchInitial, fetchStarsBalance]);

  const onChangeFilter = useCallback(
    (nextFilter) => {
      if (nextFilter === filter) return;
      setFilter(nextFilter);
      setLoading(true);
      setDays([]);
      setCursor(null);
      setHasMore(true);
      cursorRef.current = null;
      hasMoreRef.current = true;
      fetchInitial(nextFilter);
    },
    [filter, fetchInitial],
  );

  // Filter is now SQL-side; this just totals what's loaded for the
  // small "X stars earned in this period" footer caption.
  const totalEarned = useMemo(
    () => days.reduce((sum, d) => sum + (d.ads_watched || 0), 0),
    [days],
  );

  return (
    <StyledSafeAreaView>
      {/* width: "100%" overrides StyledSafeAreaView's items-center
          (align-items: center) which would otherwise size this View to
          its intrinsic content width and leave gutters on each side.
          Matches the pattern store.jsx uses (`w-full`). Same root cause
          as the coin-history balance card layout bug. */}
      <View style={{ flex: 1, width: "100%", backgroundColor: theme.background }}>
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

        {/* Balance summary card — same shape as Coin History.
            paddingHorizontal: 8 matches Coin History's tightening fix —
            the wider 16pt padding squeezed the middle text column hard
            enough to truncate the value on iOS. adjustsFontSizeToFit
            removed for the same reason: it raced the flex layout pass
            and produced inconsistent shrinking. numberOfLines={1} alone
            handles overflow now that the column has the room. */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 8,
            paddingVertical: 16,
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
          <View style={{ flex: 1, marginLeft: 10, marginRight: 8, minWidth: 0 }}>
            <Text
              numberOfLines={1}
              style={{ fontSize: 11, color: theme.textSoft }}
            >
              Current balance
            </Text>
            <Text
              numberOfLines={1}
              style={{ fontSize: 22, fontWeight: "700", color: theme.text, marginTop: 2 }}
            >
              {stars.toLocaleString()} {stars === 1 ? "star" : "stars"}
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
                onPress={() => onChangeFilter(f.key)}
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
        {!loading && days.length > 0 && (
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
        ) : days.length === 0 ? (
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
            data={days}
            keyExtractor={(d) => d.reward_date}
            renderItem={({ item }) => <DayRow item={item} theme={theme} />}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accentAmber} />
            }
            onEndReached={fetchMore}
            onEndReachedThreshold={0.4}
            ListFooterComponent={
              loadingMore ? (
                <View style={{ paddingVertical: 16, alignItems: "center" }}>
                  <ActivityIndicator color={theme.accentAmber} />
                </View>
              ) : !hasMore && days.length >= PAGE_SIZE ? (
                <View style={{ paddingVertical: 16, alignItems: "center" }}>
                  <Text style={{ fontSize: 11, color: theme.textSoft }}>No more history</Text>
                </View>
              ) : null
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
