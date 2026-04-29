import { Text, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import AnimatedSkeleton from "./AnimatedSkeleton";

const PostNativeAdPlaceholder = () => {
  const { theme } = useAppTheme();

  return (
    <>
      <View className="mt-3 w-full rounded-xl px-4 py-3" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
        {/* Simulated header: icon + headline + sponsored */}
        <View className="mb-2 flex-row items-center">
          <AnimatedSkeleton
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              backgroundColor: theme.skeletonBase,
              marginRight: 10,
            }}
          />
          <View>
            {/* Headline placeholder */}
            <AnimatedSkeleton
              style={{
                width: 120,
                height: 14,
                backgroundColor: theme.skeletonBase,
                borderRadius: 4,
              }}
            />
            <Text className="mt-1 text-xs" style={{ color: theme.textMuted }}>
              Sponsored
            </Text>
          </View>
        </View>

        {/* Body text placeholder */}
        <AnimatedSkeleton
          style={{
            height: 14,
            width: "90%",
            backgroundColor: theme.skeletonBase,
            borderRadius: 4,
            marginBottom: 10,
          }}
        />
        <AnimatedSkeleton
          style={{
            height: 14,
            width: "50%",
            backgroundColor: theme.skeletonBase,
            borderRadius: 4,
            marginBottom: 10,
          }}
        />
        <AnimatedSkeleton
          style={{
            height: 14,
            width: "30%",
            backgroundColor: theme.skeletonBase,
            borderRadius: 4,
            marginBottom: 10,
          }}
        />

        {/* Media placeholder */}
        <AnimatedSkeleton
          style={{
            width: "100%",
            height: 240,
            borderRadius: 10,
            backgroundColor: theme.skeletonBase,
            marginTop: 8,
          }}
        />

        {/* CTA button placeholder */}
        <View
          style={{
            backgroundColor: theme.primary,
            borderRadius: 8,
            paddingVertical: 10,
            alignItems: "center",
            marginTop: 10,
          }}
        >
          <Text className="text-sm font-semibold" style={{ color: theme.primaryContrast }}>
            Loading...
          </Text>
        </View>
      </View>
    </>
  );
};

export default PostNativeAdPlaceholder;
