import { Entypo, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { memo, useEffect, useRef, useState } from "react";
import { Alert, Animated, Dimensions, FlatList, InteractionManager, Text, TouchableOpacity, TouchableWithoutFeedback, View } from "react-native";
import FastImage from "react-native-fast-image";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { deletePost } from "../lib/posts";
import TimeAgo from "../lib/time-ago";
import { handleAppLink } from "../utils/appLinks";
import LinkPreviewCard from "./LinkPreviewCard";
import PostInformation from "./PostInformation";
import StyledDivider from "./StyledDivider";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";

const { width: screenWidth } = Dimensions.get("window");
const DEFAULT_IMAGE_ASPECT_RATIO = 1;

const PostCard = ({
  item,
  index,
  flatListRef,
  handleLikesPress,
  handleCommentPress,
  handleSharePress,
  onLikeChange,
  onOpenImageViewer,
  setImages,
  setShowImageViewer,
  onPostDeleted,
  onPostDeleteRequest,
  onPostDeleteSuccess,
  onPostDeleteError,
  isExpanded,
  onToggleExpand,
  isExpandedMenu,
  onToggleExpandMenu,
  onOpenSafetySheet,
  isPending = false,
}) => {
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const isLoggedInUser = user?.$id === item?.postOwner?.$id;
  const [currentIndex, setCurrentIndex] = useState(0);
  const [imageAspectRatios, setImageAspectRatios] = useState({});
  const [imageErrors, setImageErrors] = useState({});

  const flatListImageRef = useRef(null);
  const dropdownOpacity = useRef(new Animated.Value(0)).current;
  const dropdownTranslateY = useRef(new Animated.Value(-10)).current;
  const expanded = isExpanded;
  const lineCount = item.post ? item.post.split(/\r\n|\r|\n/).length : 0;

  useEffect(() => {
    if (!isExpandedMenu) {
      Animated.parallel([
        Animated.timing(dropdownOpacity, {
          toValue: 0,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(dropdownTranslateY, {
          toValue: -10,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(dropdownOpacity, {
          toValue: 1,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(dropdownTranslateY, {
          toValue: 0,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [isExpandedMenu]);

  const toggleExpanded = () => {
    if (expanded && flatListRef?.current) {
      flatListRef?.current?.scrollToIndex({ index, animated: true, viewPosition: 0 });
    }
    onToggleExpand(index);
  };

  const handleProfilePress = () => {
    if (isLoggedInUser) router.push("/profile");
    else router.push({ pathname: "/creator-profile", params: { userId: item?.postOwner?.$id } });
  };

  const toggleDropdown = () => {
    if (!isLoggedInUser) {
      onOpenSafetySheet?.();
      return;
    }
    onToggleExpandMenu(index);
  };

  const handleEditPost = () => {
    // Handle edit post
    if (!isLoggedInUser) return;
    toggleDropdown();
    router.push({ pathname: "/create-post", params: { post: JSON.stringify(item) } });
  };

  const handleDeletePost = () => {
    Alert.alert(
      "Delete post",
      "Are you sure you want to delete this post?",
      [
        {
          text: "Cancel",
          style: "cancel",
        },
        {
          text: "Delete",
          onPress: () => {
            try {
              if (!item?.$id) return;
              if (onPostDeleteRequest) {
                onPostDeleteRequest(item);
                return;
              }
              onPostDeleted?.(item.$id);
              InteractionManager.runAfterInteractions(() => {
                deletePost({ ID: item.$id })
                  .then(() => {
                    onPostDeleteSuccess?.(item.$id);
                  })
                  .catch((error) => {
                    console.log("deletePost: error", error);
                    onPostDeleteError?.(item, error);
                  });
              });
            } catch (error) {
              console.log("deletePost: error", error);
              onPostDeleteError?.(item, error);
            }
          },
          style: "destructive",
        },
      ],
      { cancelable: true },
    );
  };

  const handleScroll = (event) => {
    const customScreenWidth = screenWidth - 32;
    const index = Math.round(event.nativeEvent.contentOffset.x / customScreenWidth);
    setCurrentIndex(index);
  };

  const extractFirstUrl = (text) => {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = text?.match(urlRegex);
    return urls ? urls[0] : null;
  };

  const resolvePostUrl = (value) => {
    if (!value) return null;
    if (typeof value === "string") return value;
    if (value?.uri) return value.uri;
    if (value?.href) return value.href;
    if (typeof value?.toString === "function") return value.toString();
    return null;
  };

  const firstUrl = extractFirstUrl(item.post);
  const resolvedPostUrls = Array.isArray(item.postUrls) ? item.postUrls.map(resolvePostUrl).filter(Boolean) : [];

  const openImageViewer = (initialIndex = 0) => {
    if (typeof onOpenImageViewer === "function") {
      onOpenImageViewer({
        images: resolvedPostUrls,
        initialIndex,
        item,
      });
      return;
    }

    setImages?.(resolvedPostUrls);
    setShowImageViewer?.(true);
  };

  const renderPostUrls = ({ item: imageUrl, index: imageIndex }) => {
    const handleImagePress = () => {
      if (firstUrl) {
        handleAppLink(firstUrl);
        return;
      }
      openImageViewer(imageIndex);
    };

    const handleImageLongPress = () => {
      // Keep the full-screen viewer available even when the image opens a link on tap
      openImageViewer(imageIndex);
    };

    const aspectRatio = imageAspectRatios[imageUrl] || DEFAULT_IMAGE_ASPECT_RATIO;
    const hasError = imageErrors[imageUrl];
    const onImageLoad = (event) => {
      const { width, height } = event.nativeEvent?.source || event.nativeEvent || {};
      if (!width || !height) return;
      const nextRatio = width / height;
      setImageAspectRatios((prev) => {
        if (prev[imageUrl] === nextRatio) return prev;
        return { ...prev, [imageUrl]: nextRatio };
      });
    };
    return (
      <View style={{ width: screenWidth }}>
        <TouchableOpacity disabled={hasError} activeOpacity={0.7} onPress={handleImagePress} onLongPress={handleImageLongPress}>
          {!hasError ? (
            <FastImage
              source={{ uri: imageUrl, priority: FastImage.priority.high }}
              style={{ width: "100%", aspectRatio, backgroundColor: theme.mediaBackground }}
              resizeMode={FastImage.resizeMode.contain}
              onLoad={onImageLoad}
              onError={() => setImageErrors((prev) => ({ ...prev, [imageUrl]: true }))}
            />
          ) : (
            <View
              style={{
                width: "100%",
                aspectRatio,
                borderRadius: 8,
                justifyContent: "center",
                alignItems: "center",
                backgroundColor: theme.surfaceMuted,
              }}
            >
              <MaterialIcons name="image-not-supported" size={85} color={theme.iconMuted} />
              <Text className="text-lg font-medium" style={{ color: theme.textMuted }}>
                Failed to load image
              </Text>
            </View>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View className="mt-1.5" key={item?.$id}>
      {isPending && (
        <View className="mb-2 rounded-xl px-3 py-2" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface }}>
          <View className="flex-row items-center">
            <View className="mr-2 h-7 w-7 items-center justify-center rounded-lg" style={{ backgroundColor: theme.surfaceMuted }}>
              <MaterialIcons name="schedule" size={16} color={theme.icon} />
            </View>
            <View>
              <Text className="text-xs font-semibold" style={{ color: theme.text }}>
                Posting
              </Text>
              <Text className="text-[10px]" style={{ color: theme.textSoft }}>
                We’ll update this once it’s live.
              </Text>
            </View>
          </View>
        </View>
      )}

      <View
        className="relative flex flex-1 rounded-lg"
        pointerEvents={isPending ? "none" : "auto"}
        style={{ opacity: isPending ? 0.55 : 1, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
      >
        {/* Post Header */}
        <View className="flex flex-row items-center justify-center px-4 py-2">
          <View className="mr-2">
            <TouchableOpacity onPress={handleProfilePress} activeOpacity={0.7}>
              <FastImage
                source={{ uri: item.postOwner.avatar, priority: FastImage.priority.high }}
                style={{ height: 35, width: 35, borderRadius: 5, backgroundColor: theme.surfaceStrong }}
                resizeMode={FastImage.resizeMode.cover}
                className="mt-1"
              />
            </TouchableOpacity>
          </View>

          <View className="flex-1">
            <View className="flex flex-row items-center justify-between">
              <View>
                <TouchableOpacity onPress={handleProfilePress} activeOpacity={0.7}>
                  <View className="flex-row items-center">
                    <Text className="text-base font-bold" style={{ color: theme.text }}>
                      {item.postOwner.username}
                    </Text>
                    <UserRoleBadgeIcons user={item.postOwner} size={18} />
                  </View>
                </TouchableOpacity>
                <Text className="text-xs" style={{ color: theme.textSoft }}>
                  {TimeAgo(item.$createdAt)}
                </Text>
              </View>

              <TouchableOpacity
                hitSlop={{ left: 15, bottom: 15, top: 10, right: 10 }}
                onPress={toggleDropdown}
                style={{ marginTop: -5, opacity: 0.8 }}
              >
                <Entypo name="dots-three-horizontal" size={18} color={theme.iconMuted} />
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <View className="px-4 py-1">
          {item.post && (
            <Text style={{ fontSize: 15, color: theme.text }} className="text-sm" numberOfLines={expanded ? undefined : 3} ellipsizeMode="tail">
              {item.post.split(/(https?:\/\/[^\s]+)/g).map((part, idx) => {
                if (part.match(/https?:\/\/[^\s]+/)) {
                  return (
                    <Text key={idx} style={{ color: theme.primary, textDecorationLine: "underline" }} onPress={() => handleAppLink(part)}>
                      {part}
                    </Text>
                  );
                }
                return part;
              })}
            </Text>
          )}

          {(item.post?.length > 130 || lineCount > 3) && (
            <TouchableOpacity onPress={toggleExpanded}>
              <Text style={{ fontSize: 15, color: theme.primary }} className="mt-1">
                {expanded ? "See less" : "See more"}
              </Text>
            </TouchableOpacity>
          )}

          {/* URL Preview */}
          {firstUrl && resolvedPostUrls.length === 0 && (
            <View className="-mx-4 mt-3 self-center" style={{ width: screenWidth }}>
              <LinkPreviewCard url={firstUrl} />
            </View>
          )}
        </View>

        {/* Post Images */}
        {resolvedPostUrls.length > 0 && (
          <View className="mb-3 self-center mt-3" style={{ width: screenWidth }}>
            <FlatList
              ref={flatListImageRef}
              horizontal
              pagingEnabled
              data={resolvedPostUrls}
              keyExtractor={(item, index) => item || index.toString()}
              renderItem={renderPostUrls}
              showsHorizontalScrollIndicator={false}
              onScroll={handleScroll}
              scrollEventThrottle={16}
              scrollEnabled={resolvedPostUrls.length > 1}
              snapToInterval={screenWidth}
              decelerationRate="fast"
            />
            {/* Floating Page Indicator */}
            {resolvedPostUrls.length > 1 && (
              <View
                style={{
                  position: "absolute",
                  bottom: 15,
                  right: 10,
                  backgroundColor: theme.overlayStrong,
                  borderRadius: 12,
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                }}
              >
                <Text className="text-sm" style={{ color: theme.primaryContrast }}>
                  {currentIndex + 1} / {resolvedPostUrls.length}
                </Text>
              </View>
            )}
          </View>
        )}

        <PostInformation
          item={item}
          handleLikesPress={handleLikesPress}
          handleCommentPress={handleCommentPress}
          handleSharePress={handleSharePress}
          onLikeChange={onLikeChange}
        />

        {/* Absolute Positioned Dropdown on Top */}
        {isExpandedMenu && isLoggedInUser && (
          <TouchableWithoutFeedback onPress={toggleDropdown}>
            <Animated.View
              style={{
                position: "absolute",
                top: 30,
                right: 0,
                paddingVertical: 6,
                paddingHorizontal: 10,
                borderRadius: 6,
                zIndex: 9999,
                elevation: 20,
                opacity: dropdownOpacity,
                transform: [{ translateY: dropdownTranslateY }],
                backgroundColor: theme.surfaceElevated,
                borderWidth: 1,
                borderColor: theme.border,
              }}
              className="w-20 rounded-xl p-3 shadow-md"
            >
              <TouchableOpacity onPress={handleEditPost} style={{ paddingVertical: 4, marginBottom: 4 }}>
                <Text className="text-sm font-medium" style={{ color: theme.textMuted }}>
                  Edit
                </Text>
              </TouchableOpacity>
              <StyledDivider color={theme.divider} />
              <TouchableOpacity onPress={handleDeletePost} style={{ paddingVertical: 4 }}>
                <Text className="text-sm font-medium" style={{ color: theme.danger }}>
                  Delete
                </Text>
              </TouchableOpacity>
            </Animated.View>
          </TouchableWithoutFeedback>
        )}
      </View>
    </View>
  );
};

export default memo(PostCard);
