import { router } from "expo-router";
import React, { memo, useEffect, useState } from "react";
import { Dimensions, FlatList, KeyboardAvoidingView, Platform, Text, TouchableOpacity, TouchableWithoutFeedback, View } from "react-native";
import FastImage from "react-native-fast-image";
import LoaderKit from "react-native-loader-kit";
import Modal from "react-native-modal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { fetchPostLikes } from "../lib/posts";
import TimeAgo from "../lib/utils/time-ago";

const SCREEN_HEIGHT = Dimensions.get("window").height;

const PostLikesModal = ({ item, isVisible, onClose, coverScreen = true }) => {
  const postID = item?.$id;
  const insets = useSafeAreaInsets();
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const [loading, setLoading] = useState(true);
  const [likes, setLikes] = useState([]);
  const [lastId, setLastId] = useState();
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const PAGE_SIZE = 10;

  useEffect(() => {
    if (!isVisible || !postID) {
      setLikes([]);
      setLastId(null);
      setHasMore(false);
      setIsFetchingMore(false);
      setLoading(true);
      return;
    }

    fetchLikes();
  }, [postID, isVisible]);

  const fetchLikes = async () => {
    try {
      if (postID) {
        setLoading(true);
        const postLikesData = await fetchPostLikes({ postId: postID, limit: PAGE_SIZE });
        const documents = postLikesData?.documents ?? [];
        const total = Number.isFinite(postLikesData?.total) ? postLikesData.total : documents.length;

        setLikes(documents);
        setLastId(documents[documents.length - 1]?.$id || null);
        setHasMore(documents.length < total);
      }
    } catch (error) {
      console.log("fetchLikes: error", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchMoreLikes = async () => {
    if (!postID || !lastId || !hasMore || isFetchingMore) return;
    try {
      setIsFetchingMore(true);
      const postLikesData = await fetchPostLikes({ postId: postID, lastId: lastId, limit: PAGE_SIZE });
      const documents = postLikesData?.documents ?? [];
      const uniqueLikes = documents.filter((like) => !likes.some((existing) => existing.$id === like.$id));
      if (uniqueLikes.length === 0) {
        setHasMore(false);
        return;
      }
      const updatedFetchedLikes = [...likes, ...uniqueLikes];
      const total = Number.isFinite(postLikesData?.total) ? postLikesData.total : updatedFetchedLikes.length;

      setLikes(updatedFetchedLikes);
      setLastId(documents[documents.length - 1]?.$id || lastId);
      setHasMore(updatedFetchedLikes.length < total);
    } catch (error) {
      console.log("fetchMoreLikes: error", error);
    } finally {
      setIsFetchingMore(false);
    }
  };

  const renderCommentItem = ({ item }) => {
    const handleUserPress = () => {
      onClose();
      if (user?.$id === item?.likeOwner?.$id) router.push("/profile");
      else router.push({ pathname: "/creator-profile", params: { userId: item?.likeOwner?.$id } });
    };

    return (
      <TouchableWithoutFeedback>
        <View className="mb-5 flex flex-row space-x-2">
          <TouchableOpacity onPress={handleUserPress}>
            <FastImage
              source={{ uri: item?.likeOwner?.avatar || "", priority: FastImage.priority.normal }}
              className="h-10 w-10 rounded-full"
              style={{ backgroundColor: theme.surfaceStrong }}
            />
          </TouchableOpacity>

          <View className="flex flex-1 flex-col justify-center">
            <View className="flex flex-row items-center space-x-1">
              <TouchableOpacity onPress={handleUserPress}>
                <Text className="font-sans text-sm font-semibold" style={{ color: theme.text }}>
                  {item?.likeOwner?.username || "Deleted User"}
                </Text>
              </TouchableOpacity>
              <Text className="font-sans text-xs" style={{ color: theme.textSoft }}>
                {TimeAgo(item?.$createdAt)}
              </Text>
            </View>
          </View>
        </View>
      </TouchableWithoutFeedback>
    );
  };

  return (
    <Modal
      isVisible={isVisible}
      coverScreen={coverScreen}
      onBackdropPress={onClose}
      onBackButtonPress={onClose}
      swipeDirection="down"
      onSwipeComplete={onClose}
      style={{ justifyContent: "flex-end", margin: 0 }}
      backdropOpacity={0.3}
      propagateSwipe
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{
          minHeight: SCREEN_HEIGHT * 0.6,
          maxHeight: SCREEN_HEIGHT * 0.7,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          paddingBottom: insets.bottom + 16,
          backgroundColor: theme.surfaceElevated,
        }}
      >
        {/* Drag Handle */}
        <View className="items-center py-2">
          <View className="h-1.5 w-20 rounded-full" style={{ backgroundColor: theme.handle }} />
        </View>

        {loading ? (
          <View className="flex-1 items-center justify-center">
            <LoaderKit style={{ width: 40, height: 40, opacity: 0.5 }} name={"LineScale"} color={theme.primary} />
          </View>
        ) : (
          <FlatList
            data={likes}
            keyExtractor={(item) => item?.$id || item?.id || `${item?.likeOwner?.$id}-${item?.$createdAt}`}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12, flexGrow: 1 }}
            showsVerticalScrollIndicator={false}
            renderItem={renderCommentItem}
            removeClippedSubviews={true}
            ListEmptyComponent={
              <View className="flex flex-1 items-center justify-center">
                <Text className="font-sans text-sm font-medium" style={{ color: theme.textSoft }}>
                  No Likes Available
                </Text>
              </View>
            }
            onEndReached={fetchMoreLikes}
          />
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
};

export default memo(PostLikesModal);
