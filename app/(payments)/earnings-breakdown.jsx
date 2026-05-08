import { Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, Text, TouchableOpacity, View } from "react-native";
import { StyledSafeAreaView, StyledTitle } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import {
  getAuthorEarningsSummary,
  getAuthorEarningsTransactions,
} from "../../lib/earnings-supabase";
import supabase from "../../lib/supabase";

// Per-category transaction log. Each row is one unlock event:
//
//   Chapter Title                               +5 coins
//   May 5, 2026 · 3:42 PM
//
// Authors get an obvious "what just happened" view instead of an
// aggregated rollup that read ambiguously (the previous "448 unlocks ·
// 143 by coin · 305 by star" layout kept making people think a single
// reader spent 143 coins).
//
// Pagination: server-side offset + limit. Loads PAGE_SIZE rows at a
// time when the user nears the bottom. Memory stays flat regardless of
// how many lifetime unlocks the author has.
const PAGE_SIZE = 15;

// Format the created_at ISO string into a friendly "May 5, 2026 · 3:42 PM"
// shown on every row. Falls back to "—" if the date is missing.
const formatTimestamp = (iso) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `${date} · ${time}`;
  } catch (_) {
    return "—";
  }
};

const EarningsBreakdown = () => {
  const { theme } = useAppTheme();
  const params = useLocalSearchParams();
  const category = String(params.category || "book");
  const label = String(params.label || "Earnings");
  const monthYear = String(params.monthYear || "");

  const { user } = useGlobalContext();
  const [summary, setSummary] = useState({
    total_pesos: 0,
    total_coins: 0,
    total_stars: 0,
    total_unlocks: 0,
  });
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Cancellation token shared across all "refresh" entry points (mount,
  // focus, realtime INSERT, pull-to-refresh). Each refresh increments
  // the token; in-flight loads compare and bail if their token is
  // stale, preventing setState on an unmounted component or out-of-
  // order responses overwriting newer data.
  const refreshTokenRef = useRef(0);

  // Refetch the first page + summary. Used on mount, on focus, on
  // realtime INSERTs, and on pull-to-refresh. Does NOT show the
  // skeleton spinner unless `showSkeleton` is true — silent refreshes
  // (focus, realtime) keep the existing items rendered until the new
  // data arrives.
  const loadFirstPage = useCallback(
    async ({ showSkeleton = false } = {}) => {
      const token = ++refreshTokenRef.current;
      if (showSkeleton) setLoading(true);
      try {
        const [sum, page] = await Promise.all([
          getAuthorEarningsSummary({ category, monthYear }),
          getAuthorEarningsTransactions({ category, monthYear, limit: PAGE_SIZE, offset: 0 }),
        ]);
        if (token !== refreshTokenRef.current) return; // stale
        setSummary(sum);
        setItems(page.items);
        setHasMore(page.hasMore);
      } catch (err) {
        if (token !== refreshTokenRef.current) return;
        if (showSkeleton) {
          // Only blank state on the cold-load path; silent refreshes
          // keep showing whatever was there before so a transient
          // network blip doesn't make the screen flash empty.
          setSummary({ total_pesos: 0, total_coins: 0, total_stars: 0, total_unlocks: 0 });
          setItems([]);
          setHasMore(false);
        }
      } finally {
        if (token === refreshTokenRef.current && showSkeleton) setLoading(false);
      }
    },
    [category, monthYear],
  );

  // Initial cold load — show the spinner, blank items.
  useEffect(() => {
    setItems([]);
    setHasMore(false);
    loadFirstPage({ showSkeleton: true });
  }, [loadFirstPage]);

  // Re-fetch on focus — covers the "writer navigates away, an unlock
  // happens, they navigate back" case.
  //
  // The first focus event fires on initial mount, racing with the
  // cold-load useEffect above. If both run, the cold load (token=1)
  // gets superseded by the focus load (token=2), and the focus load
  // runs with showSkeleton=false so the loading flag never clears
  // → screen stuck on spinner with empty items. The earlier
  // refreshTokenRef-based guard didn't work because the cold load
  // increments the token synchronously before the focus check runs.
  //
  // Simple fix: a one-shot ref that swallows the initial focus event.
  // The cold-load useEffect owns the first fetch; subsequent real
  // focus events (after navigating away and back) trigger refetches
  // as intended.
  const isInitialFocusRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (isInitialFocusRef.current) {
        isInitialFocusRef.current = false;
        return;
      }
      loadFirstPage({ showSkeleton: false });
    }, [loadFirstPage]),
  );

  // Realtime — subscribe to author_earnings INSERTs for THIS user.
  // When a new earnings row lands (a reader unlocked the writer's
  // content), refetch the first page so the new entry appears at the
  // top + the summary card updates. We use refetch instead of
  // optimistically prepending payload.new because the raw author_
  // earnings row doesn't carry the resolved chapter/book title that
  // each item card needs — getAuthorEarningsTransactions joins those
  // in. One extra read per realtime event is cheap.
  useEffect(() => {
    if (!user?.$id) return;
    const channel = supabase
      .channel(`author-earnings-${user.$id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "author_earnings",
          filter: `author_id=eq.${user.$id}`,
        },
        () => {
          loadFirstPage({ showSkeleton: false });
        },
      )
      .subscribe();
    return () => {
      try {
        supabase.removeChannel(channel);
      } catch (_) {
        // Defensive — removeChannel can throw on some SDK versions
        // when the channel is mid-subscribe. Same pattern as
        // messages-supabase realtime cleanup.
      }
    };
  }, [user?.$id, loadFirstPage]);

  // Pull-to-refresh — manual escape hatch. Same fetch as everything
  // else; just toggles the spinner so the user gets visual confirmation.
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadFirstPage({ showSkeleton: false });
    } finally {
      setRefreshing(false);
    }
  }, [loadFirstPage]);

  // Lazy-load the next page when the user scrolls near the bottom.
  // Server-side offset paging — simple, stable for the time scale
  // earnings rows arrive at (concurrent inserts during scrolling
  // aren't a real concern here).
  const handleEndReached = useCallback(async () => {
    if (loading || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const page = await getAuthorEarningsTransactions({
        category,
        monthYear,
        limit: PAGE_SIZE,
        offset: items.length,
      });
      setItems((prev) => [...prev, ...page.items]);
      setHasMore(page.hasMore);
    } catch (_) {
      // Silently stop pagination on error; user can pull-to-refresh
      // by re-entering the screen.
    } finally {
      setLoadingMore(false);
    }
  }, [category, monthYear, items.length, hasMore, loading, loadingMore]);

  // Match the colored tile accents from the Earnings page.
  const accent =
    category === "book" ? { color: theme.accentTeal, soft: theme.accentTealSoft, icon: "book" } :
    category === "video" ? { color: theme.accentPurple, soft: theme.accentPurpleSoft, icon: "videocam" } :
    category === "post" ? { color: theme.accentAmber, soft: theme.accentAmberSoft, icon: "document-text-outline" } :
    { color: theme.like, soft: theme.likeSoft, icon: "film-outline" };

  // One row per unlock event.
  const renderItem = ({ item }) => {
    const isStar = item.currency === "star";
    const amountColor = theme.text;
    const amountIconName = isStar ? "star" : "circle-multiple";
    const amountSuffix = isStar
      ? item.amount === 1 ? "star" : "stars"
      : item.amount === 1 ? "coin" : "coins";

    return (
      <View
        className="mt-3 rounded-2xl p-3"
        style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
      >
        <View className="flex-row items-start justify-between">
          <View className="flex-1 pr-3">
            <Text
              className="text-[14px] font-semibold"
              style={{ color: theme.text }}
              numberOfLines={2}
            >
              {item.title}
            </Text>
            <Text className="mt-1 text-[11px]" style={{ color: theme.textSubtle }}>
              {formatTimestamp(item.created_at)}
            </Text>
          </View>
          <View className="flex-row items-center" style={{ gap: 4 }}>
            <Text className="text-[15px] font-semibold" style={{ color: amountColor }}>
              +{item.amount}
            </Text>
            <MaterialCommunityIcons name={amountIconName} size={14} color={theme.accentAmber} />
            <Text className="text-[12px]" style={{ color: theme.textSoft }}>
              {amountSuffix}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  return (
    <StyledSafeAreaView>
      <View className="h-full w-full" style={{ backgroundColor: theme.background }}>
        {/* Header */}
        <View className="flex-row items-center justify-between px-4 pb-2 pt-2">
          <TouchableOpacity
            activeOpacity={0.7}
            className="h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
            onPress={() => router.back()}
          >
            <MaterialIcons name="arrow-back" size={22} color={theme.icon} />
          </TouchableOpacity>
          <View className="flex-row items-center">
            <StyledTitle className="py-0" icon={<Ionicons name={accent.icon} size={20} color={accent.color} />} title={label} />
          </View>
          <View className="h-10 w-10" />
        </View>

        {/* Summary card — totals across ALL filtered rows, not just visible */}
        <View
          className="mx-4 mt-2 rounded-2xl p-4"
          style={{ backgroundColor: accent.soft, borderWidth: 1, borderColor: theme.border }}
        >
          <Text className="text-[12px] font-semibold" style={{ color: theme.textSoft }}>
            {monthYear ? "Earnings this month" : "Lifetime earnings"}
          </Text>
          <Text className="mt-1 font-bold" style={{ color: theme.text, fontSize: 22 }}>
            ₱ {summary.total_pesos.toFixed(2)}
          </Text>
          <View className="mt-2 flex-row items-center" style={{ gap: 12, flexWrap: "wrap" }}>
            <View className="flex-row items-center" style={{ gap: 4 }}>
              <MaterialCommunityIcons name="circle-multiple" size={13} color={theme.accentAmber} />
              <Text className="text-[12px]" style={{ color: theme.textSoft }}>
                {summary.total_coins.toLocaleString()} coins
              </Text>
            </View>
            <Text className="text-[12px]" style={{ color: theme.textSubtle }}>•</Text>
            <View className="flex-row items-center" style={{ gap: 4 }}>
              <MaterialCommunityIcons name="star" size={13} color={theme.accentAmber} />
              <Text className="text-[12px]" style={{ color: theme.textSoft }}>
                {summary.total_stars.toLocaleString()} stars
              </Text>
            </View>
            <Text className="text-[12px]" style={{ color: theme.textSubtle }}>•</Text>
            <View className="flex-row items-center" style={{ gap: 4 }}>
              <MaterialCommunityIcons name="lock-open-variant" size={13} color={theme.iconMuted} />
              <Text className="text-[12px]" style={{ color: theme.textSoft }}>
                {summary.total_unlocks.toLocaleString()} {summary.total_unlocks === 1 ? "unlock" : "unlocks"}
              </Text>
            </View>
          </View>
        </View>

        {/* Transaction list */}
        {loading ? (
          <View className="mt-12 items-center">
            <ActivityIndicator size="small" color={theme.primary} />
          </View>
        ) : items.length === 0 ? (
          <View className="mt-12 items-center px-8">
            <Ionicons name={accent.icon} size={42} color={theme.iconMuted} />
            <Text className="mt-3 text-center text-[14px]" style={{ color: theme.textSoft }}>
              No earnings yet for this category
              {monthYear ? " in this month" : ""}.
            </Text>
            <Text className="mt-1 text-center text-[11px]" style={{ color: theme.textSubtle }}>
              When readers unlock your {label.toLowerCase()}, each transaction will show up here.
            </Text>
          </View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(it, i) => `${it.source_type}:${it.source_id}:${it.created_at}:${i}`}
            renderItem={renderItem}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, paddingTop: 4 }}
            showsVerticalScrollIndicator={false}
            // Keep the React Native virtualized list lean — only mount
            // a small window of rows even if the user has thousands of
            // lifetime transactions.
            initialNumToRender={PAGE_SIZE}
            maxToRenderPerBatch={PAGE_SIZE}
            windowSize={5}
            removeClippedSubviews
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={handleRefresh}
                tintColor={theme.primary}
              />
            }
            // Server-side pagination — fetch the next PAGE_SIZE when
            // the user scrolls within half a screen of the bottom.
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.5}
            ListFooterComponent={
              loadingMore ? (
                <View className="items-center py-4">
                  <ActivityIndicator size="small" color={theme.primary} />
                  <Text className="mt-2 text-[11px]" style={{ color: theme.textSubtle }}>
                    Loading more transactions
                  </Text>
                </View>
              ) : !hasMore && items.length >= PAGE_SIZE ? (
                <View className="items-center py-4">
                  <Text className="text-[11px]" style={{ color: theme.textSubtle }}>
                    End of history
                  </Text>
                </View>
              ) : null
            }
          />
        )}
      </View>
    </StyledSafeAreaView>
  );
};

export default EarningsBreakdown;
