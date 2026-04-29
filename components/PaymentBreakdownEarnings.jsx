import { Text, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import AnimatedSkeleton from "./AnimatedSkeleton";

const PaymentBreakdownEarnings = ({ title = "Earnings", amount = "₱ 0.00", loading = false, icon = null, iconBgColor = "", iconBackgroundColor }) => {
  const { theme } = useAppTheme();
  return (
    <View className="mt-4 w-full rounded-2xl px-3 py-3" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
      {/* Header */}
      <View className="flex-row items-center">
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

      <View className="mt-4">
        {loading ? (
          <AnimatedSkeleton style={{ width: "50%", height: 30, backgroundColor: theme.skeletonBase }} />
        ) : (
          <Text className="font-semibold" style={{ fontSize: 24, color: theme.text }} adjustsFontSizeToFit minimumFontScale={0.7} numberOfLines={1}>
            {amount}
          </Text>
        )}
      </View>
    </View>
  );
};

export default PaymentBreakdownEarnings;
