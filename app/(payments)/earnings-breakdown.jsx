import { Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Text, TouchableOpacity, View } from "react-native";
import { StyledSafeAreaView, StyledTitle } from "../../components";
import useAppTheme from "../../hooks/useAppTheme";
import { getAuthorEarningsBreakdownByItem } from "../../lib/earnings-supabase";

// Per-item earnings breakdown for one category (book / video / post /
// clip). Reached by tapping a tile on the Payments → Earnings screen;
// receives `category`, `label` (for the header), and an optional
// `monthYear` to scope to a single month.
//
// Each list row shows:
//   • Title (joined from books / videos / chapters)
//   • Total earnings in pesos
//   • Unlock count + currency split (coin / star)
//   • Last unlock timestamp
//
// Sorted by pesos desc — top earners surface first.
const EarningsBreakdown = () => {
  const { theme } = useAppTheme();
  const params = useLocalSearchParams();
  const category = String(params.category || "book");
  const label = String(params.label || "Earnings");
  const monthYear = String(params.monthYear || "");

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const rows = await getAuthorEarningsBreakdownByItem({ category, monthYear });
        if (!cancelled) setItems(rows);
      } catch (err) {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [category, monthYear]);

  // Total at the top — sum of items shown in this list.
  const totalPesos = items.reduce((sum, it) => sum + (Number(it.total_pesos) || 0), 0);
  const totalUnlocks = items.reduce((sum, it) => sum + (Number(it.unlock_count) || 0), 0);

  // Match the colored tile accents from the Earnings page so the
  // category context carries through visually.
  const accent =
    category === "book" ? { color: theme.accentTeal, soft: theme.accentTealSoft, icon: "book" } :
    category === "video" ? { color: theme.accentPurple, soft: theme.accentPurpleSoft, icon: "videocam" } :
    category === "post" ? { color: theme.accentAmber, soft: theme.accentAmberSoft, icon: "document-text-outline" } :
    { color: theme.like, soft: theme.likeSoft, icon: "film-outline" };

  const renderItem = ({ item, index }) => (
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
          <View className="mt-1.5 flex-row items-center" style={{ gap: 10, flexWrap: "wrap" }}>
            <View className="flex-row items-center" style={{ gap: 4 }}>
              <MaterialCommunityIcons name="lock-open-variant" size={12} color={theme.iconMuted} />
              <Text className="text-[11px]" style={{ color: theme.textSoft }}>
                {item.unlock_count} {item.unlock_count === 1 ? "unlock" : "unlocks"}
              </Text>
            </View>
            {item.coin_count > 0 ? (
              <View className="flex-row items-center" style={{ gap: 4 }}>
                <MaterialCommunityIcons name="circle-multiple" size={12} color={theme.accentAmber} />
                <Text className="text-[11px]" style={{ color: theme.textSoft }}>
                  {item.coin_count} coin
                </Text>
              </View>
            ) : null}
            {item.star_count > 0 ? (
              <View className="flex-row items-center" style={{ gap: 4 }}>
                <MaterialCommunityIcons name="star" size={12} color={theme.accentAmber} />
                <Text className="text-[11px]" style={{ color: theme.textSoft }}>
                  {item.star_count} star
                </Text>
              </View>
            ) : null}
          </View>
        </View>
        <View className="items-end">
          <Text
            className="font-semibold"
            style={{ color: theme.text, fontSize: 16 }}
            adjustsFontSizeToFit
            numberOfLines={1}
            minimumFontScale={0.7}
          >
            ₱ {item.total_pesos.toFixed(2)}
          </Text>
          <Text className="text-[10px]" style={{ color: theme.textSubtle }}>
            #{index + 1}
          </Text>
        </View>
      </View>
    </View>
  );

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

        {/* Summary */}
        <View
          className="mx-4 mt-2 rounded-2xl p-4"
          style={{ backgroundColor: accent.soft, borderWidth: 1, borderColor: theme.border }}
        >
          <Text className="text-[12px] font-semibold" style={{ color: theme.textSoft }}>
            {monthYear ? "Earnings this month" : "Lifetime earnings"}
          </Text>
          <Text className="mt-1 font-bold" style={{ color: theme.text, fontSize: 22 }}>
            ₱ {totalPesos.toFixed(2)}
          </Text>
          <Text className="mt-1 text-[11px]" style={{ color: theme.textSoft }}>
            {items.length} {items.length === 1 ? "item" : "items"} · {totalUnlocks} {totalUnlocks === 1 ? "unlock" : "unlocks"}
          </Text>
        </View>

        {/* List */}
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
              When readers unlock your {label.toLowerCase()}, the breakdown will show up here.
            </Text>
          </View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(it, i) => `${it.source_type}:${it.source_id || i}`}
            renderItem={renderItem}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, paddingTop: 4 }}
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>
    </StyledSafeAreaView>
  );
};

export default EarningsBreakdown;
