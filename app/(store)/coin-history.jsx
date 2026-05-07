// app/(store)/coin-history.jsx — Coin purchase history.
//
// Opens when the user taps the Coins balance card on /store. Shows
// every coin_purchases row for the current user, grouped by day,
// with status badges (Credited / Refunded / Backfilled). The row
// shape mirrors the design mockup approved May 2026.
//
// Data source:
//   public.coin_purchases — written by hitpay-webhook (and apple-iap-
//   webhook on iOS). Joined to coin_packages so we can show the
//   total coin amount each row contributed.
//
// Filter chips:
//   • All        — every row
//   • Purchases  — status in ('credited', 'completed')
//   • Refunds    — status in ('refunded')
//
// Pagination: cursor-based off `created_at`. Initial fetch grabs
// PAGE_SIZE most-recent rows, then onEndReached fetches older rows
// using the oldest visible row's created_at as a strict-less-than
// cursor. Filter changes reset the cursor (the SQL WHERE includes the
// filter, so a page of "refunds" never wastes a slot on a credited row).
// hasMore goes false when a page returns fewer than PAGE_SIZE rows.

import { FontAwesome5, Ionicons } from "@expo/vector-icons";
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
import { StyledSafeAreaView } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import supabase from "../../lib/supabase";

const FILTERS = [
  { key: "all",       label: "All" },
  { key: "purchases", label: "Purchases" },
  { key: "refunds",   label: "Refunds" },
];

// 20 fits comfortably above the fold on a phone screen and is small
// enough that initial paint feels instant; older pages stream in on
// scroll. Matches the page size pattern used elsewhere (notifications,
// books library).
const PAGE_SIZE = 20;

// Translate a filter chip into the array of `status` values to ask
// Postgres for. `all` returns null (no filter applied at the SQL level).
const statusFilterFor = (filter) => {
  if (filter === "purchases") return ["credited", "completed"];
  if (filter === "refunds")   return ["refunded"];
  return null;
};

// Date label formatter — "Today" / "Yesterday" / "Mon, May 5" / etc.
const dayLabel = (isoString) => {
  if (!isoString) return "";
  const d = new Date(isoString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today - target) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
};

const timeLabel = (isoString) => {
  if (!isoString) return "";
  return new Date(isoString).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

export default function CoinHistory() {
  const { theme } = useAppTheme();
  const { user, balance } = useGlobalContext();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState("all");
  // Pagination state machine. cursor = null means "fetch from the top
  // (no `created_at <` filter)"; subsequent pages set it to the oldest
  // visible row's created_at. hasMore goes false once a page returns
  // fewer than PAGE_SIZE rows. loadingMore is a re-entrancy guard so
  // a fast scroll-end can't fan out duplicate requests.
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Ref-mirrored copies the loadMore closure can read without retriggering
  // useCallback every time these flip. Without these, onEndReached would
  // keep getting fresh function identities and FlashList could fire it
  // multiple times mid-scroll.
  const cursorRef = useRef(null);
  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);

  // Build the base query once per call. Both initial load and loadMore
  // run through here; only the cursor (`before`) changes between them.
  const runQuery = useCallback(
    async ({ before = null, currentFilter }) => {
      const statuses = statusFilterFor(currentFilter);
      let q = supabase
        .from("coin_purchases")
        .select(`
          id,
          status,
          amount_minor,
          currency,
          hitpay_payment_id,
          apple_transaction_id,
          platform,
          created_at,
          completed_at,
          metadata,
          coin_packages ( base_coins, bonus_coins )
        `)
        .eq("user_id", user.$id)
        .order("created_at", { ascending: false })
        .limit(PAGE_SIZE);
      if (statuses) q = q.in("status", statuses);
      if (before) q = q.lt("created_at", before); // strict-less so we never re-fetch the cursor row
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },
    [user?.$id],
  );

  // Initial / refresh / filter-change fetch — wipes everything and starts
  // from the most-recent row. The "filter" arg defaults to current state
  // but lets a filter-change handler pass the new filter synchronously
  // (otherwise the closure would still see the previous filter on the
  // first call after switching chips).
  const fetchInitial = useCallback(
    async (overrideFilter) => {
      if (!user?.$id) return;
      const currentFilter = overrideFilter ?? filter;
      try {
        const data = await runQuery({ before: null, currentFilter });
        setRows(data);
        const nextHasMore = data.length >= PAGE_SIZE;
        const nextCursor = data.length > 0 ? data[data.length - 1].created_at : null;
        setHasMore(nextHasMore);
        setCursor(nextCursor);
        hasMoreRef.current = nextHasMore;
        cursorRef.current = nextCursor;
      } catch (e) {
        console.warn("[coin-history] initial fetch failed:", e?.message);
        setRows([]);
        setHasMore(false);
        hasMoreRef.current = false;
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [user?.$id, filter, runQuery],
  );

  // Append a page of older rows. Guards: bail if no cursor (means we
  // haven't even loaded page 1), if we already know there's no more, or
  // if a loadMore is already in flight.
  const fetchMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    if (!hasMoreRef.current) return;
    if (!cursorRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const data = await runQuery({ before: cursorRef.current, currentFilter: filter });
      // Defensive dedupe — if a refetch raced us, drop any rows we
      // already have. Worst case we just append fewer rows.
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        const fresh = data.filter((r) => !seen.has(r.id));
        if (fresh.length === 0) {
          hasMoreRef.current = false;
          setHasMore(false);
          return prev;
        }
        const merged = [...prev, ...fresh];
        const nextHasMore = data.length >= PAGE_SIZE;
        const nextCursor = data[data.length - 1].created_at;
        hasMoreRef.current = nextHasMore;
        cursorRef.current = nextCursor;
        setHasMore(nextHasMore);
        setCursor(nextCursor);
        return merged;
      });
    } catch (e) {
      console.warn("[coin-history] loadMore failed:", e?.message);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [filter, runQuery]);

  useEffect(() => {
    // Initial mount → load page 1 with whatever filter is current.
    fetchInitial();
    // We deliberately do NOT include `filter` in deps here — the chip-
    // change handler below calls fetchInitial(newFilter) explicitly so
    // the new filter applies to the SQL on the very first call without
    // a render cycle in between.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.$id]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setRows([]);
    setCursor(null);
    setHasMore(true);
    cursorRef.current = null;
    hasMoreRef.current = true;
    fetchInitial();
  }, [fetchInitial]);

  // Chip handler — wipes current page state and fetches page 1 with the
  // newly-selected filter. Bypasses the deps-driven re-fetch by passing
  // the filter explicitly so we don't paint a stale list briefly.
  const onChangeFilter = useCallback(
    (nextFilter) => {
      if (nextFilter === filter) return;
      setFilter(nextFilter);
      setLoading(true);
      setRows([]);
      setCursor(null);
      setHasMore(true);
      cursorRef.current = null;
      hasMoreRef.current = true;
      fetchInitial(nextFilter);
    },
    [filter, fetchInitial],
  );

  // Group by day. Filter is now SQL-side (see runQuery + statusFilterFor)
  // so this purely re-shapes rows into [header, ...rows, header, ...]
  // for the FlatList. Insertion-ordered Map preserves the descending
  // chronology of the underlying SELECT.
  const grouped = useMemo(() => {
    const groups = new Map();
    for (const r of rows) {
      const label = dayLabel(r.created_at);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(r);
    }
    const flat = [];
    for (const [label, items] of groups) {
      flat.push({ type: "header", id: `h-${label}`, label });
      for (const it of items) flat.push({ type: "row", id: it.id, item: it });
    }
    return flat;
  }, [rows]);

  const renderItem = ({ item }) => {
    if (item.type === "header") {
      return (
        <View style={{ paddingHorizontal: 16, paddingVertical: 8, backgroundColor: theme.surfaceMuted }}>
          <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSoft }}>
            {item.label}
          </Text>
        </View>
      );
    }
    return <Row item={item.item} theme={theme} />;
  };

  return (
    <StyledSafeAreaView>
      {/* width: "100%" overrides StyledSafeAreaView's items-center
          (align-items: center) which would otherwise size this View to
          its intrinsic content width and leave gutters on each side.
          Matches the same pattern store.jsx uses (`w-full`). Without
          this, paddingHorizontal changes on the balance card below had
          no visible effect because the card was already maxed at the
          content's natural width — the bug Charles spotted at 12:40. */}
      <View style={{ flex: 1, width: "100%", backgroundColor: theme.background }}>
        {/* Header */}
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
            Coin history
          </Text>
        </View>

        {/* Balance summary card.
            paddingHorizontal: 8 (was 16) — on iOS the wider card padding
            squeezed the middle text column hard enough to truncate
            "Current b…" and "548 c…" even with numberOfLines+adjustsFont.
            8pt on each side reclaims 16pt of width which is plenty.
            adjustsFontSizeToFit removed — it was racing the layout pass
            and producing inconsistent results; numberOfLines={1} alone
            handles overflow gracefully now that the column has room. */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 8,
            paddingVertical: 16,
            backgroundColor: theme.accentPurpleSoft,
          }}
        >
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: theme.accentAmberSoft,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <FontAwesome5 name="coins" size={20} color={theme.coin} />
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
              {(balance ?? 0).toLocaleString()} {balance === 1 ? "coin" : "coins"}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => router.replace("/store")}
            style={{
              backgroundColor: theme.accentPurple,
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 18,
            }}
          >
            <Text style={{ color: theme.primaryContrast, fontSize: 12, fontWeight: "600" }}>
              Buy more
            </Text>
          </TouchableOpacity>
        </View>

        {/* Filter chips */}
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
                  borderColor: active ? theme.accentPurple : theme.border,
                  backgroundColor: active ? theme.accentPurple : "transparent",
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

        {/* History list */}
        {loading ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={theme.accentPurple} />
          </View>
        ) : grouped.length === 0 ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
            <FontAwesome5 name="coins" size={36} color={theme.textSoft} />
            <Text style={{ marginTop: 12, fontSize: 15, fontWeight: "500", color: theme.text }}>
              No coin history yet
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
              Coin purchases will appear here once you buy a pack from the store.
            </Text>
          </View>
        ) : (
          <FlatList
            data={grouped}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accentPurple} />
            }
            onEndReached={fetchMore}
            onEndReachedThreshold={0.4}
            ListFooterComponent={
              loadingMore ? (
                <View style={{ paddingVertical: 16, alignItems: "center" }}>
                  <ActivityIndicator color={theme.accentPurple} />
                </View>
              ) : !hasMore && rows.length >= PAGE_SIZE ? (
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

// Single coin-purchase row. Pulled out so the FlatList renderer
// stays tidy and the row is easy to extend (e.g., add a tap-for-
// receipt action later).
const Row = ({ item, theme }) => {
  const totalCoins = (item?.coin_packages?.base_coins || 0) + (item?.coin_packages?.bonus_coins || 0);
  const amountPhp = ((item?.amount_minor || 0) / 100).toFixed(0);
  const isRefund = item?.status === "refunded";
  const isBackfill = !!item?.metadata?.backfill_reason;
  const platformLabel = item?.platform === "apple_ios" ? "Apple" : "GCash";

  // Status pill color matches semantic intent. Backfilled gets its
  // own treatment (info blue) so users can see "this was added back
  // manually" — bonus transparency for the recovered users.
  const badge = isRefund
    ? { bg: theme.surfaceMuted, fg: theme.textSoft, label: "Refunded" }
    : isBackfill
      ? { bg: theme.accentBlueSoft, fg: theme.accentBlue, label: "Backfilled" }
      : { bg: theme.accentGreenSoft, fg: theme.accentGreen, label: "Credited" };

  const amountColor = isRefund ? theme.danger : theme.accentGreen;
  const amountSign = isRefund ? "−" : "+";

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
        <FontAwesome5 name="coins" size={16} color={theme.coin} />
      </View>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.text }}>
          {totalCoins} coin pack
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 2, flexWrap: "wrap" }}>
          <Text style={{ fontSize: 11, color: theme.textSoft }}>
            PHP {amountPhp} · {platformLabel} · {timeLabel(item.created_at)}
          </Text>
          <View
            style={{
              marginLeft: 6,
              paddingHorizontal: 6,
              paddingVertical: 1,
              borderRadius: 4,
              backgroundColor: badge.bg,
            }}
          >
            <Text style={{ fontSize: 9, fontWeight: "700", color: badge.fg }}>
              {badge.label}
            </Text>
          </View>
        </View>
      </View>
      <Text style={{ fontSize: 14, fontWeight: "700", color: amountColor }}>
        {amountSign}{totalCoins}
      </Text>
    </View>
  );
};
