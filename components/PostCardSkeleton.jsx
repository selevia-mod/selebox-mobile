import { View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import AnimatedSkeleton from "./AnimatedSkeleton";

const PostCardSkeletonItem = () => {
  const { theme } = useAppTheme();

  return (
    <View className="mt-1.5 rounded-lg" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
      <View className="flex flex-row items-center justify-center px-4 py-2">
        <View className="mr-2">
          <AnimatedSkeleton style={{ height: 35, width: 35, borderRadius: 5 }} className="mt-1" />
        </View>
        <View className="flex-1">
          <AnimatedSkeleton className="h-4 w-28 rounded" />
          <AnimatedSkeleton className="mt-2 h-3 w-20 rounded" />
        </View>
        <AnimatedSkeleton className="h-[18px] w-[18px] rounded" style={{ marginTop: -5 }} />
      </View>

      <View className="px-4 py-1">
        <AnimatedSkeleton className="h-4 w-[85%] rounded" />
        <AnimatedSkeleton className="mt-2 h-4 w-[65%] rounded" />
        <AnimatedSkeleton className="mt-1 h-4 w-[25%] rounded" />
      </View>

      <View className="px-4 pb-3 pt-2">
        <View className="flex-row items-center justify-between">
          <View className="flex-1 flex-row items-center justify-center">
            <AnimatedSkeleton className="h-4 w-4 rounded-full" />
            <AnimatedSkeleton className="ml-2 h-4 w-10 rounded" />
          </View>
          <View className="flex-1 flex-row items-center justify-center">
            <AnimatedSkeleton className="h-4 w-4 rounded-full" />
            <AnimatedSkeleton className="ml-2 h-4 w-14 rounded" />
          </View>
          <View className="flex-1 flex-row items-center justify-center">
            <AnimatedSkeleton className="h-4 w-4 rounded-full" />
            <AnimatedSkeleton className="ml-2 h-4 w-12 rounded" />
          </View>
        </View>
      </View>
    </View>
  );
};

const PostCardSkeleton = ({ count = 1, className = "" }) => (
  <View className={className} pointerEvents="none">
    {Array.from({ length: count }).map((_, index) => (
      <PostCardSkeletonItem key={`post-card-skeleton-${index}`} />
    ))}
  </View>
);

export default PostCardSkeleton;
