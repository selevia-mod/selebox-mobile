import { AntDesign, MaterialCommunityIcons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, Text, TouchableOpacity, View } from "react-native";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { consumePostCommentModalResume } from "../lib/post-comment-modal-resume";
import { fetchPosts } from "../lib/posts";
import { useModalMessage } from "../lib/useModalMessage";
import CustomAlertModal from "./CustomAlertModal";
import ImageViewer from "./ImageViewer";
import PostCard from "./PostCard";
import PostCommentModal from "./PostCommentModal";
import PostLikesModal from "./PostLikesModal";

const ProfilePostTab = ({
  userId,
  nestedScrollEnabled = false,
  sectionTitle = "Posts",
  listRef,
  contentPaddingTop = 0,
  onScroll,
  onLoadingChange,
  suppressEmptyState = false,
}) => {
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const [posts, setPosts] = useState([]);
  const [lastId, setLastId] = useState();
  const [hasMore, setHasMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { message, messageOpen, showMessage, closeMessage } = useModalMessage();
  const [showImageViewer, setShowImageViewer] = useState(false);
  const [images, setImages] = useState([]);
  const [imageViewerInitialIndex, setImageViewerInitialIndex] = useState(0);
  const [currentPost, setCurrentPost] = useState();
  const [isCommentModalVisible, setCommentModalVisible] = useState(false);
  const [isLikesModalVisible, setLikesModalVisible] = useState(false);
  const [commentModalResumeToken, setCommentModalResumeToken] = useState(null);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [showScrollUp, setShowScrollUp] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState(null);
  const [expandedMenuIndex, setExpandedMenuIndex] = useState(null);
  const internalListRef = useRef(null);
  const flatListRef = listRef || internalListRef;
  const hasLoadedRef = useRef(false);
  const isLoggedInUser = user?.$id === userId;

  useFocusEffect(
    useCallback(() => {
      getPosts();
    }, [userId]),
  );

  useFocusEffect(
    useCallback(() => {
      const pendingResume = consumePostCommentModalResume("profile-post-tab");
      if (!pendingResume?.postId) return;

      const targetPostId = String(pendingResume.postId);
      const matchingPost = posts.find((entry) => String(entry?.$id || "") === targetPostId);
      const fallbackPost = matchingPost || pendingResume.postSnapshot || null;
      if (!fallbackPost?.$id) return;

      setCurrentPost(fallbackPost);
      setCommentModalResumeToken(pendingResume.token || null);
      setCommentModalVisible(true);
    }, [posts]),
  );

  const getPosts = async () => {
    if (!hasLoadedRef.current) onLoadingChange?.(true);
    try {
      if (userId) {
        const postsData = await fetchPosts({ limit: 10, userId: userId });
        if (postsData.documents.length > 0) {
          setPosts(postsData.documents);
          setLastId(postsData.documents[postsData.documents.length - 1].$id);
          setHasMore(postsData.documents.length < postsData.total);
        }
      }
    } catch (error) {
      console.log("fetchPosts: error", error);
    } finally {
      if (!hasLoadedRef.current) {
        hasLoadedRef.current = true;
        onLoadingChange?.(false);
      }
    }
  };

  const fetchMorePosts = async () => {
    try {
      if (!lastId || !hasMore) return;
      setIsFetchingMore(true);
      const postsData = await fetchPosts({ limit: 10, lastId: lastId, userId: userId });
      const uniquePosts = postsData.documents.filter((post) => !posts.some((existing) => existing.$id === post.$id));
      if (uniquePosts.length === 0) {
        setHasMore(false);
        setIsFetchingMore(false);
        return;
      }
      const updatedFetchedPosts = [...posts, ...uniquePosts];
      setPosts(updatedFetchedPosts);
      setLastId(postsData.documents[postsData.documents.length - 1].$id);
      if (updatedFetchedPosts >= postsData.total) setHasMore(false);
    } catch (error) {
      console.log("fetchMorePosts: error", error);
    } finally {
      setIsFetchingMore(false);
    }
  };

  const onRefresh = async () => {
    await getPosts();
  };

  const updatePostCommentCount = (postId, newCount) => {
    setPosts((prevPosts) => prevPosts.map((post) => (post.$id === postId ? { ...post, postComments: newCount } : post)));
    setCurrentPost((prevPost) => (prevPost?.$id === postId ? { ...prevPost, postComments: newCount } : prevPost));
  };

  const updatePostLikeCount = (postId, newCount, isLikedByCurrentUser) => {
    setPosts((prevPosts) =>
      prevPosts.map((post) =>
        post.$id === postId ? { ...post, postLikes: newCount, ...(typeof isLikedByCurrentUser === "boolean" ? { isLikedByCurrentUser } : {}) } : post,
      ),
    );
    setCurrentPost((prevPost) =>
      prevPost?.$id === postId
        ? { ...prevPost, postLikes: newCount, ...(typeof isLikedByCurrentUser === "boolean" ? { isLikedByCurrentUser } : {}) }
        : prevPost,
    );
  };

  const handleCommentPress = (item) => {
    if (item?.$id) {
      router.push({
        pathname: "/post-item",
        params: {
          postId: item.$id,
          openComments: "1",
        },
      });
      return;
    }
    setCurrentPost(item);
    setCommentModalResumeToken(null);
    setCommentModalVisible(true);
  };

  const handleLikesPress = (item) => {
    setCurrentPost(item);
    setLikesModalVisible(true);
  };

  const handleScroll = (event) => {
    const offsetY = event.nativeEvent.contentOffset.y;
    setShowScrollUp(offsetY > 500);
  };

  const scrollToTop = () => {
    if (flatListRef.current && posts.length > 0) {
      flatListRef.current.scrollToOffset({ offset: 0, animated: true });
    }
  };

  const handleSharePress = () => showMessage("🚧 New Feature Incoming! \n\n 🚀Something awesome is in the works—stay tuned!", 400);

  const handleCombinedScroll = (event) => {
    handleScroll(event);
    onScroll?.(event);
  };

  const handleScrollToIndexFailed = useCallback(({ averageItemLength, index }) => {
    const offset = Math.max(0, averageItemLength * index);
    flatListRef.current?.scrollToOffset?.({ offset, animated: true });
  }, []);

  const renderListHeader = () => (
    <View style={{ paddingTop: contentPaddingTop }}>
      {sectionTitle ? (
        <Text className="mb-2 text-xl font-bold" style={{ color: theme.text }}>
          {sectionTitle}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View className="flex-1">
      {showScrollUp && (
        <TouchableOpacity
          activeOpacity={0.7}
          className="absolute bottom-[20] right-1 z-50 rounded-full p-3"
          style={{ backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}
          onPress={scrollToTop}
        >
          <AntDesign name="arrowup" size={18} color={theme.icon} />
        </TouchableOpacity>
      )}
      <FlashList
        ref={flatListRef}
        data={posts}
        extraData={{ expandedIndex: expandedIndex, expandedMenuIndex: expandedMenuIndex }}
        nestedScrollEnabled={nestedScrollEnabled}
        ListHeaderComponent={renderListHeader}
        refreshing={refreshing}
        onRefresh={fetchPosts}
        onScroll={handleCombinedScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        estimatedItemSize={485}
        renderItem={({ item, index }) => (
          <PostCard
            item={item}
            index={index}
            flatListRef={flatListRef}
            handleLikesPress={handleLikesPress}
            handleCommentPress={handleCommentPress}
            handleSharePress={handleSharePress}
            onLikeChange={updatePostLikeCount}
            onOpenImageViewer={({ images: nextImages, initialIndex, item: selectedPost }) => {
              setImages(nextImages);
              setImageViewerInitialIndex(initialIndex);
              setCurrentPost(selectedPost);
              setShowImageViewer(true);
            }}
            onPostDeleted={(postId) => {
              setPosts((prev) => prev.filter((p) => p.$id !== postId));
            }}
            isExpanded={expandedIndex === index}
            onToggleExpand={() => {
              setExpandedIndex((prev) => (prev === index ? null : index));
            }}
            isExpandedMenu={expandedMenuIndex === index}
            onToggleExpandMenu={() => {
              setExpandedMenuIndex((prev) => (prev === index ? null : index));
            }}
          />
        )}
        keyExtractor={(item, index) => item.$id ?? index.toString()}
        onScrollToIndexFailed={handleScrollToIndexFailed}
        onEndReached={fetchMorePosts}
        refreshControl={
          <RefreshControl
            tintColor={theme.primary}
            titleColor={theme.text}
            refreshing={refreshing}
            onRefresh={useCallback(async () => {
              setRefreshing(true);
              await onRefresh();
              setRefreshing(false);
            })}
          />
        }
        ListFooterComponent={
          isFetchingMore ? (
            <View className="items-center py-4">
              <ActivityIndicator size="small" color={theme.primary} />
            </View>
          ) : null
        }
        contentContainerStyle={{ paddingBottom: 50 }}
        ListEmptyComponent={
          suppressEmptyState ? null : (
            <View className="flex-1 items-center justify-center px-4 py-12">
              <MaterialCommunityIcons name="post-outline" size={48} color={theme.textSoft} />
              <Text className="mt-4 font-sans text-lg font-semibold" style={{ fontFamily: "Poppins-SemiBold", color: theme.text }}>
                No Posts Yet
              </Text>
              <Text className="mt-2 text-center font-sans text-sm" style={{ fontFamily: "Poppins-Regular", color: theme.textSoft }}>
                {isLoggedInUser
                  ? "You haven't published any posts yet.\nStart writing and share your first post!"
                  : "This user hasn't published any posts yet."}
              </Text>
            </View>
          )
        }
      />
      <ImageViewer
        images={images}
        visible={showImageViewer}
        onClose={() => setShowImageViewer(false)}
        initialIndex={imageViewerInitialIndex}
        postItem={currentPost}
        handleSharePress={handleSharePress}
        onLikeChange={updatePostLikeCount}
        onCommentChange={updatePostCommentCount}
      />
      <PostCommentModal
        isVisible={isCommentModalVisible}
        onClose={() => {
          setCommentModalVisible(false);
          setCommentModalResumeToken(null);
        }}
        item={currentPost}
        onCommentPosted={(newCount) => updatePostCommentCount(currentPost.$id, newCount)}
        resumeScope="profile-post-tab"
        resumeToken={commentModalResumeToken}
      />
      <PostLikesModal isVisible={isLikesModalVisible} onClose={() => setLikesModalVisible(false)} item={currentPost} />
      <CustomAlertModal message={message} messageOpen={messageOpen} closeMessage={closeMessage} />
    </View>
  );
};

export default ProfilePostTab;
