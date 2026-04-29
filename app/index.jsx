import { Dimensions, FlatList, View } from "react-native";
import { useSelector } from "react-redux";
import { Loader, StyledSafeAreaView } from "../components";
import AnimatedSkeleton from "../components/AnimatedSkeleton";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";

const { width: screenWidth } = Dimensions.get("window");

const FeedSkeleton = () => {
  const { theme } = useAppTheme();

  return (
    <StyledSafeAreaView>
      <View className="flex flex-1 px-0.5 pb-5">
        <View className="px-3.5">
          <View className="flex h-[50px] flex-row items-center justify-between border-b" style={{ borderBottomColor: theme.border }}>
            <View className="flex-1 flex-row items-center">
              <AnimatedSkeleton style={{ height: 35, width: 35, borderRadius: 5 }} />
              <View className="ml-3 h-[40px] flex-row items-center space-x-2">
                <AnimatedSkeleton className="h-4 w-4 rounded-full" />
                <AnimatedSkeleton className="h-4 w-10 rounded" />
              </View>
            </View>
            <View className="flex-1 items-center">
              <AnimatedSkeleton className="h-6 w-24 rounded" />
            </View>
            <View className="flex-1 flex-row items-center justify-end">
              <AnimatedSkeleton className="h-6 w-6 rounded" />
              <AnimatedSkeleton className="ml-3 h-6 w-6 rounded" />
              <AnimatedSkeleton className="ml-3 h-6 w-6 rounded" />
            </View>
          </View>
        </View>

        <View className="flex-row">
          <View className="w-full flex-row items-center space-x-3 rounded-lg p-3">
            <AnimatedSkeleton className="h-10 w-10 rounded-full" />
            <View className="h-11 flex-1 flex-row items-center justify-between rounded-full px-4" style={{ backgroundColor: theme.surfaceMuted }}>
              <AnimatedSkeleton className="h-4 w-[55%] rounded" />
              <View className="flex-row items-center space-x-2">
                <AnimatedSkeleton className="h-8 w-8 rounded" />
                <AnimatedSkeleton className="h-8 w-8 rounded" />
                <AnimatedSkeleton className="h-8 w-8 rounded" />
              </View>
            </View>
          </View>
        </View>

        <View className="w-full pb-1">
          <FlatList
            horizontal
            data={[1, 2, 3, 4]}
            keyExtractor={(item) => item.toString()}
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="px-3"
            renderItem={() => (
              <View className="mr-2">
                <AnimatedSkeleton style={{ width: 112, height: 176, borderRadius: 12 }} />
                <View className="mt-2 items-center">
                  <AnimatedSkeleton style={{ width: 50, height: 10, borderRadius: 6 }} />
                </View>
              </View>
            )}
          />
        </View>

        <View>
          {Array.from({ length: 4 }).map((_, index) => (
            <View key={`post-skeleton-${index}`} className="mt-1.5 flex flex-1 rounded-lg" style={{ backgroundColor: theme.surfaceMuted }}>
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

              <View className="flex flex-col space-y-2 px-4 pb-3">
                <View className="flex-row items-center space-x-2 self-end">
                  <AnimatedSkeleton className="h-3 w-16 rounded" />
                  <AnimatedSkeleton className="h-3 w-20 rounded" />
                </View>
                <View className="h-[1px] w-full rounded" style={{ backgroundColor: theme.divider }} />
                <View className="flex-row items-center justify-between space-x-2 pb-1">
                  <View className="flex-1 flex-row items-center justify-center space-x-2">
                    <AnimatedSkeleton className="h-4 w-4 rounded-full" />
                    <AnimatedSkeleton className="h-4 w-10 rounded" />
                  </View>
                  <View className="flex-1 flex-row items-center justify-center space-x-2">
                    <AnimatedSkeleton className="h-4 w-4 rounded-full" />
                    <AnimatedSkeleton className="h-4 w-14 rounded" />
                  </View>
                  <View className="flex-1 flex-row items-center justify-center space-x-2">
                    <AnimatedSkeleton className="h-4 w-4 rounded-full" />
                    <AnimatedSkeleton className="h-4 w-12 rounded" />
                  </View>
                </View>
              </View>
            </View>
          ))}
        </View>
      </View>
    </StyledSafeAreaView>
  );
};

const Welcome = () => {
  const { loading } = useGlobalContext();
  const { user } = useSelector((state) => state.auth);

  if (loading) return user ? <FeedSkeleton /> : <Loader isLoading={loading} />;

  return <Loader isLoading={true} />;
};

export default Welcome;
