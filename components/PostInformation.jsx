import { AntDesign, FontAwesome } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { useSelector } from "react-redux";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import FormatNumber from "../lib/format-number";
import { createPostLike, deletePostLike, getPostLike, updatePost } from "../lib/posts";
import StyledDivider from "./StyledDivider";

const PostInformation = ({ item, handleLikesPress, handleCommentPress, handleSharePress, onLikeChange }) => {
  const postID = item?.$id;
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(item?.postLikes ?? 0);
  const { globalSettings } = useSelector((state) => state.app);
  const likedRef = useRef(false);
  const likeCountRef = useRef(0);
  const debounceRef = useRef(null);

  const likeColor = theme.like;
  const commentColor = theme.comment;

  likedRef.current = liked;
  likeCountRef.current = likeCount;

  useEffect(() => {
    setLikeCount(item?.postLikes ?? 0);
  }, [item?.postLikes]);

  useEffect(() => {
    let isCancelled = false;

    if (typeof item?.isLikedByCurrentUser === "boolean") {
      setLiked(item.isLikedByCurrentUser);
      return () => {
        isCancelled = true;
      };
    }

    if (!postID || !user?.$id) {
      setLiked(false);
      return () => {
        isCancelled = true;
      };
    }

    const handleGetLike = async () => {
      try {
        const response = await getPostLike({ postId: postID, likeOwner: user?.$id });
        if (!isCancelled) {
          setLiked(response?.documents?.length > 0);
        }
      } catch (error) {
        console.log("getPostLike error", error);
        if (!isCancelled) {
          setLiked(false);
        }
      }
    };

    handleGetLike();

    return () => {
      isCancelled = true;
    };
  }, [item?.isLikedByCurrentUser, postID, user?.$id]);

  const syncLike = async () => {
    try {
      if (likedRef.current) {
        const existing = await getPostLike({ postId: postID, likeOwner: user?.$id });
        if (!existing?.documents?.length) await createPostLike({ postId: postID, likeOwner: user?.$id });
      } else {
        const existing = await getPostLike({ postId: postID, likeOwner: user?.$id });
        if (existing?.documents?.[0]) await deletePostLike({ postLikeId: existing.documents[0].$id });
      }
      await updatePost({ ID: postID, postLikes: likeCountRef.current });
    } catch (error) {
      console.log("syncLike error", error);
    }
  };

  const handleLike = () => {
    if (!postID || !user?.$id) return;
    const newLiked = !liked;
    const currentCount = Number.isFinite(likeCount) ? likeCount : 0;
    const nextCount = newLiked ? currentCount + 1 : Math.max(0, currentCount - 1);

    setLiked(newLiked);
    setLikeCount(nextCount);
    onLikeChange?.(postID, nextCount, newLiked);

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(syncLike, 500);
  };

  const handleComment = () => handleCommentPress(item);

  const handleShowLikes = () => handleLikesPress(item);

  const handleShare = async () => handleSharePress(item);

  return (
    <View className="flex flex-col space-y-2 px-4">
      <View className="flex flex-row items-center space-x-2 self-end pt-3 pb-1.5">
        <TouchableOpacity
          onPress={handleShowLikes}
          className="flex-row items-center space-x-1 rounded-full px-3 py-1"
          style={{ backgroundColor: theme.likeSoft }}
        >
          <FontAwesome name="heart" size={14} color={likeColor} />
          <Text className="text-sm font-semibold" style={{ color: likeColor }}>
            {FormatNumber(likeCount)}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleComment}
          className="flex-row items-center space-x-1 rounded-full px-3 py-1"
          style={{ backgroundColor: theme.commentSoft }}
        >
          <FontAwesome name="comment" size={14} color={commentColor} />
          <Text className="text-sm font-semibold" style={{ color: commentColor }}>
            {item?.postComments}
          </Text>
        </TouchableOpacity>
      </View>
      <StyledDivider color={theme.divider} className="mb-0" />
      <View className="flex flex-row items-center justify-between space-x-2 pb-2">
        <TouchableOpacity
          onPress={handleLike}
          activeOpacity={1.0}
          className="flex-1 flex-row items-center justify-center space-x-1 px-3 py-2 opacity-80"
        >
          <AntDesign name="like1" size={15} color={liked ? theme.primary : theme.icon} />
          <Text className="font-sans text-sm font-medium" style={{ color: liked ? theme.primary : theme.text }}>
            {liked ? "Liked" : "Like"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handleComment}
          activeOpacity={1.0}
          className="flex-1 flex-row items-center justify-center space-x-1 px-3 py-2 opacity-80"
        >
          <FontAwesome name="comments" size={15} color={theme.icon} />
          <Text className="font-sans text-sm font-medium" style={{ color: theme.text }}>
            Comment
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handleShare}
          activeOpacity={1.0}
          className="flex-1 flex-row items-center justify-center space-x-1 px-3 py-2 opacity-80"
        >
          <FontAwesome name="share" size={15} color={theme.icon} />
          <Text className="font-sans text-sm font-medium" style={{ color: theme.text }}>
            Share
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

export default PostInformation;
