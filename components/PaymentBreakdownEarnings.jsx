import { Ionicons } from "@expo/vector-icons";
import { Text, TouchableOpacity, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import AnimatedSkeleton from "./AnimatedSkeleton";

// Earnings breakdown tile. Renders read-only by default; pass `onPress`
// to make it tappable (used by Books / Videos / Post tiles to open the
// per-item drill-down screen). When tappable, a chevron hints at the
// affordance and the whole tile lifts on press.
//
// Optional `description` renders as small soft text below the amount —
// used to surface context that doesn't fit in the title (e.g. the
// 7-day hold period note on the Pending tile, or "Tap to see
// breakdown" on the per-source-type tiles). Mirrors the web's
// Author Earnings card copy.
const PaymentBreakdownEarnings = ({
  title = "Earnings",
  amount = "₱ 0.00",
  description = null,
  loading = false,
  icon = null,
  iconBgColor = "",
  iconBackgroundColor,
  onPress,
}) => {
  const { theme } = useAppTheme();

  const interactive = typeof onPress === "function";

  // Inner content shared between the read-only View and the tappable
  // wrapper. Same markup either way — only the wrapper element differs.
  const body = (
    <>
      <View className="flex-row items-center justify-between">
        <View className="flex-1 flex-row items-center">
          {icon && (
            <View
              className={`mr-2 h-7 w-7 items-center justify-center rounded-lg ${iconBgColor}`}
              style={iconBackgroundColor ? { backgroundColor: iconBackgroundColor } : null}
            >
              {icon}
            </View>
          )}
          <Text className="text-[13px] font-bold tracking-wide" style={{ color: theme.textSoft }} numberOfLines={1} ellipsizeMode="tail">
            {title}
          </Text>
        </View>
        {interactive ? (
          <Ionicons name="chevron-forward" size={16} color={theme.iconMuted} />
        ) : null}
      </View>

      <View className="mt-4">
        {loading ? (
          <AnimatedSkeleton style={{ width: "50%", height: 30, backgroundColor: theme.skeletonBase }} />
        ) : (
          <Text className="font-semibold" style={{ fontSize: 24, color: theme.text }} adjustsFontSizeToFit minimumFontScale={0.7} numberOfLines={1}>
            {amount}
          </Text>
        )}
      </View>

      {description ? (
        <Text
          className="mt-2 text-[11px] leading-[15px]"
          style={{ color: theme.textSubtle || theme.textSoft }}
          numberOfLines={2}
        >
          {description}
        </Text>
      ) : null}
    </>
  );

  if (interactive) {
    return (
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.85}
        className="mt-[8px] w-full rounded-2xl px-3 py-3"
        style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
      >
        {body}
      </TouchableOpacity>
    );
  }

  return (
    <View className="mt-[8px] w-full rounded-2xl px-3 py-3" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
      {body}
    </View>
  );
};

export default PaymentBreakdownEarnings;
