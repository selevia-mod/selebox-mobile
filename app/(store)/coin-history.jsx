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
// Pagination: simple — fetch up to 100 most-recent rows. If usage
// grows beyond that, swap to lastId-cursor (same pattern as the
// notification list).

import { FontAwesome5, Ionicons } from "@expo/vector-icons";
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
import { StyledSafeAreaView } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import supabase from "../../lib/supabase";

const FILTERS = [
  { key: "all",       label: "All" },
  { key: "purchases", label: "Purchases" },
  { key: "refunds",   label: "Refunds" },
];

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

  const fetchHistory = useCallback(async () => {
    if (!user?.$id) return;
    try {
      // Join coin_packages so each row carries the pack's
      // base_coins + bonus_coins for displaying the total.
      const { data, error } = await supabase
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
        .limit(100);
      if (error) {
        console.warn("[coin-history] fetch failed:", error.message);
        setRows([]);
        return;
      }
      setRows(data || []);
    } catch (e) {
      console.warn("[coin-history] fetch threw:", e?.message);
      setRows([]);
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

  // Apply filter, then group by day.
  const grouped = useMemo(() => {
    const filtered = rows.filter((r) => {
      if (filter === "purchases") return r.status === "credited" || r.status === "completed";
      if (filter === "refunds")   return r.status === "refunded";
      return true;
    });
    const groups = new Map();
    for (const r of filtered) {
      const label = dayLabel(r.created_at);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(r);
    }
    // Flatten into FlatList-friendly array of { type: 'header'|'row', ... }
    const flat = [];
    for (const [label, items] of groups) {
      flat.push({ type: "header", id: `h-${label}`, label });
      for (const it of items) flat.push({ type: "row", id: it.id, item: it });
    }
    return flat;
  }, [rows, filter]);

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
      <View style={{ flex: 1, backgroundColor: theme.background }}>
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

        {/* Balance summary card */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 16,
            paddingVertical: 14,
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
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ fontSize: 11, color: theme.textSoft }}>Current balance</Text>
            <Text style={{ fontSize: 22, fontWeight: "700", color: theme.text }}>
              {balance ?? 0} coins
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
                onPress={() => setFilter(f.key)}
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
