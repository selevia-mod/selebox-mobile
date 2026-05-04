import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Dimensions, FlatList, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import AnimatedSkeleton from "./AnimatedSkeleton";
import StyledDivider from "./StyledDivider";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const ITEM_SIZE = SCREEN_WIDTH * 0.18;

const PostSuggestedCreators = ({ forceUpdate, hideDivider = false }) => {
  const { user, globalSettings, allCreators } = useGlobalContext();
  const { theme } = useAppTheme();
  const [randomCreators, setRandomCreators] = useState([]);
  const POSTS_SUGGESTED_CREATORS_COUNT = Number(globalSettings["POSTS_SUGGESTED_CREATORS_COUNT"] || 15);

  useEffect(() => {
    getRandomCreators();
  }, [allCreators]);

  useEffect(() => {
    if (forceUpdate) {
      const shuffled = allCreators.sort(() => 0.5 - Math.random());
      const randomCreators = shuffled.slice(0, POSTS_SUGGESTED_CREATORS_COUNT);
      setRandomCreators(randomCreators);
    }
  }, [forceUpdate]);

  const getRandomCreators = async () => {
    try {
      const randomCreators = allCreators.slice(0, POSTS_SUGGESTED_CREATORS_COUNT);
      setRandomCreators(randomCreators);
    } catch (error) {
      console.log("getRandomCreators: error", error);
      return [];
    }
  };

  const handleCreatorProfilePressed = (item) => {
    if (user?.$id === item?.$id) router.push("/profile");
    else router.push({ pathname: "/creator-profile", params: { userId: item?.$id } });
  };

  const renderSkeleton = () => {
    return (
      <View className="flex-row">
        {[...Array(8)].map((_, index) => (
          <View key={index} className="mr-3 items-center justify-center" style={{ width: ITEM_SIZE }}>
            <AnimatedSkeleton
              style={{
                width: ITEM_SIZE,
                height: ITEM_SIZE,
                borderRadius: 10,
                backgroundColor: theme.skeletonBase,
              }}
            />
            <AnimatedSkeleton
              style={{
                width: ITEM_SIZE * 0.4,
                height: 10,
                marginTop: 8,
                borderRadius: 999,
                backgroundColor: theme.skeletonBase,
              }}
            />
          </View>
        ))}
      </View>
    );
  };

  const renderItem = ({ item }) => {
    return (
      <TouchableOpacity
        onPress={() => handleCreatorProfilePressed(item)}
        activeOpacity={0.7}
        className="mr-3 items-center justify-center"
        style={{ width: ITEM_SIZE }}
      >
        <FastImage
          source={{ uri: item.avatar, priority: FastImage.priority.normal }}
          style={{
            height: ITEM_SIZE,
            width: ITEM_SIZE,
            borderRadius: 10,
            marginTop: 4,
            backgroundColor: theme.surfaceStrong,
          }}
          resizeMode={FastImage.resizeMode.cover}
        />
        <View className="mt-2 flex-row items-center">
          <Text numberOfLines={1} ellipsizeMode="tail" className="text-[12px]" style={{ color: theme.textMuted }}>
            {item.username}
          </Text>
          <UserRoleBadgeIcons user={item} size={10} />
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View className="max-h-60">
      <Text className="text-md pb-2 font-bold" style={{ color: theme.text }}>
        Suggested Creators
      </Text>
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item, index) => item?.uri || index.toString()}
        data={randomCreators}
        renderItem={renderItem}
        ListEmptyComponent={renderSkeleton}
      />
      {!hideDivider && <StyledDivider color={theme.divider} className="mt-3" />}
    </View>
  );
};

export default PostSuggestedCreators;
