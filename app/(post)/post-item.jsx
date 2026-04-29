import { MaterialIcons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from "react-native";
import Share from "react-native-share";
import { ImageViewer, PostCard, PostCommentModal, PostLikesModal, StyledSafeAreaView } from "../../components";
import { consumePostCommentModalResume } from "../../lib/post-comment-modal-resume";
import { getPost } from "../../lib/posts";
import { getUserByID } from "../../lib/users";
import secrets from "../../private/secrets";

const normalizeRouteParam = (value) => {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] || null;
  return String(value);
};

const buildSafePostOwner = (owner, fallbackOwnerId = null) => {
  if (owner && typeof owner === "object" && owner?.$id) return owner;
  const ownerId = typeof owner === "string" ? owner : fallbackOwnerId;

  return {
    $id: ownerId || "deleted",
    username: "Deleted User",
    avatar: "",
  };
};

const PostItemScreen = () => {
  const params = useLocalSearchParams();
  const postId = useMemo(() => normalizeRouteParam(params.postId || params.focusPostId || params.id), [params.focusPostId, params.id, params.postId]);
  const focusCommentIdParam = useMemo(
    () => normalizeRouteParam(params.focusCommentId || params.commentId || params.comment),
    [params.comment, params.commentId, params.focusCommentId],
  );
  const focusReplyIdParam = useMemo(() => normalizeRouteParam(params.focusReplyId || params.replyId), [params.focusReplyId, params.replyId]);
  const openCommentsParam = useMemo(() => {
    const raw = normalizeRouteParam(params.openComments);
    return raw === "1" || raw === "true";
  }, [params.openComments]);

  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState("");
  const [isCommentModalVisible, setCommentModalVisible] = useState(false);
  const [isLikesModalVisible, setLikesModalVisible] = useState(false);
  const [commentModalFocus, setCommentModalFocus] = useState({ focusCommentId: null, focusReplyId: null });
  const [commentModalResumeToken, setCommentModalResumeToken] = useState(null);
  const [showImageViewer, setShowImageViewer] = useState(false);
  const [images, setImages] = useState([]);
  const [imageViewerInitialIndex, setImageViewerInitialIndex] = useState(0);
  const [isExpanded, setExpanded] = useState(false);
  const [isExpandedMenu, setExpandedMenu] = useState(false);

  const flatListRef = useRef(null);
  const autoOpenKeyRef = useRef(null);

  const hydratePostOwner = useCallback(async (postDocument) => {
    if (!postDocument) return postDocument;
    const owner = postDocument?.postOwner;

    if (owner && typeof owner === "object" && owner?.$id) {
      return { ...postDocument, postOwner: buildSafePostOwner(owner, owner?.$id) };
    }

    const ownerId = typeof owner === "string" ? owner : owner?.$id || owner?.id || null;
    if (!ownerId) {
      return { ...postDocument, postOwner: buildSafePostOwner(null) };
    }

    try {
      const ownerDocument = await getUserByID({ ID: ownerId });
      return { ...postDocument, postOwner: buildSafePostOwner(ownerDocument, ownerId) };
    } catch (error) {
      console.log("post-item: hydrate owner error", error);
      return { ...postDocument, postOwner: buildSafePostOwner(null, ownerId) };
    }
  }, []);

  const loadPost = useCallback(async () => {
    if (!postId) {
      setPost(null);
      setLoading(false);
      setErrorText("Post not found.");
      return;
    }

    setLoading(true);
    setErrorText("");

    try {
      const fetchedPost = await getPost({ ID: postId });
      const hydrated = await hydratePostOwner({
        ...fetchedPost,
        postUrls: Array.isArray(fetchedPost?.postUrls) ? fetchedPost.postUrls : [],
      });

      setPost(hydrated);
    } catch (error) {
      console.log("post-item: load post error", error);
      setPost(null);
      setErrorText("Unable to load this post.");
    } finally {
      setLoading(false);
    }
  }, [hydratePostOwner, postId]);

  useEffect(() => {
    loadPost();
  }, [loadPost]);

  useEffect(() => {
    if (!post?.$id) return;

    const shouldOpenComments = openCommentsParam || Boolean(focusCommentIdParam || focusReplyIdParam);
    if (!shouldOpenComments) return;

    const openKey = `${post.$id}:${focusCommentIdParam || ""}:${focusReplyIdParam || ""}`;
    if (autoOpenKeyRef.current === openKey) return;

    autoOpenKeyRef.current = openKey;
    setCommentModalFocus({
      focusCommentId: focusCommentIdParam || null,
      focusReplyId: focusReplyIdParam || null,
    });

    const timer = setTimeout(() => {
      setCommentModalResumeToken(null);
      setCommentModalVisible(true);
    }, 120);

    return () => clearTimeout(timer);
  }, [focusCommentIdParam, focusReplyIdParam, openCommentsParam, post?.$id]);

  const handleCommentPress = useCallback((item) => {
    if (item) setPost(item);
    setCommentModalFocus({ focusCommentId: null, focusReplyId: null });
    setCommentModalResumeToken(null);
    setCommentModalVisible(true);
  }, []);

  useFocusEffect(
    useCallback(() => {
      const pendingResume = consumePostCommentModalResume("post-item");
      if (!pendingResume?.postId) return;

      const targetPostId = String(pendingResume.postId);
      if (post?.$id && String(post.$id) !== targetPostId) return;

      if (pendingResume.postSnapshot?.$id && (!post || String(post.$id || "") !== String(pendingResume.postSnapshot.$id || ""))) {
        setPost(pendingResume.postSnapshot);
      }

      setCommentModalFocus({ focusCommentId: null, focusReplyId: null });
      setCommentModalResumeToken(pendingResume.token || null);
      setCommentModalVisible(true);
    }, [post?.$id]),
  );

  const handleLikesPress = useCallback((item) => {
    if (item) setPost(item);
    setLikesModalVisible(true);
  }, []);

  const handleSharePress = useCallback(async (item) => {
    if (!item?.$id) return;
    await Share.open({
      message: "Check out this post!",
      url: `${secrets.WEBSITE}/home/${item.$id}`,
      title: item?.post || "Post",
      type: "url",
    });
  }, []);

  const updatePostLikeCount = useCallback((targetPostId, newCount, isLikedByCurrentUser) => {
    setPost((prev) => {
      if (!prev || String(prev.$id || "") !== String(targetPostId || "")) return prev;
      return { ...prev, postLikes: newCount, ...(typeof isLikedByCurrentUser === "boolean" ? { isLikedByCurrentUser } : {}) };
    });
  }, []);

  const updatePostCommentCount = useCallback((targetPostId, newCount) => {
    setPost((prev) => {
      if (!prev || String(prev.$id || "") !== String(targetPostId || "")) return prev;
      return { ...prev, postComments: newCount };
    });
  }, []);

  const handleBack = useCallback(() => {
    if (typeof router.canGoBack === "function" && router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/home");
  }, []);

  const renderBody = () => {
    if (loading) {
      return (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="small" color="#fff" />
        </View>
      );
    }

    if (errorText || !post) {
      return (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center font-sans text-base text-white/85">{errorText || "Post not found."}</Text>
          <TouchableOpacity className="mt-4 rounded-xl bg-white/15 px-4 py-2" onPress={loadPost}>
            <Text className="font-sans text-sm font-semibold text-white">Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <ScrollView contentContainerStyle={{ paddingBottom: 80 }} showsVerticalScrollIndicator={false}>
        <PostCard
          item={post}
          index={0}
          flatListRef={flatListRef}
          handleLikesPress={handleLikesPress}
          handleCommentPress={handleCommentPress}
          handleSharePress={handleSharePress}
          onLikeChange={updatePostLikeCount}
          onOpenImageViewer={({ images: nextImages, initialIndex }) => {
            setImages(nextImages);
            setImageViewerInitialIndex(initialIndex);
            setShowImageViewer(true);
          }}
          onPostDeleted={() => {
            handleBack();
          }}
          isExpanded={isExpanded}
          onToggleExpand={() => setExpanded((prev) => !prev)}
          isExpandedMenu={isExpandedMenu}
          onToggleExpandMenu={() => setExpandedMenu((prev) => !prev)}
        />
      </ScrollView>
    );
  };

  return (
    <StyledSafeAreaView edges={["top"]}>
      <View className="h-full w-full">
        <View className="flex-row items-center px-4 py-2">
          <TouchableOpacity onPress={handleBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <MaterialIcons name="arrow-back" size={24} color="white" />
          </TouchableOpacity>
          <Text className="ml-2 font-sans text-lg font-semibold text-white">Post</Text>
        </View>

        {renderBody()}
      </View>

      <ImageViewer
        images={images}
        visible={showImageViewer}
        onClose={() => setShowImageViewer(false)}
        initialIndex={imageViewerInitialIndex}
        postItem={post}
        handleSharePress={handleSharePress}
        onLikeChange={updatePostLikeCount}
        onCommentChange={updatePostCommentCount}
      />

      <PostCommentModal
        isVisible={isCommentModalVisible}
        onClose={() => {
          setCommentModalVisible(false);
          setCommentModalFocus({ focusCommentId: null, focusReplyId: null });
          setCommentModalResumeToken(null);
        }}
        item={post}
        onCommentPosted={(newCount) => {
          if (!post?.$id) return;
          updatePostCommentCount(post.$id, newCount);
        }}
        focusCommentId={commentModalFocus.focusCommentId}
        focusReplyId={commentModalFocus.focusReplyId}
        resumeScope="post-item"
        resumeToken={commentModalResumeToken}
      />

      <PostLikesModal isVisible={isLikesModalVisible} onClose={() => setLikesModalVisible(false)} item={post} />
    </StyledSafeAreaView>
  );
};

export default PostItemScreen;
