import { Entypo, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { memo, useEffect, useRef, useState } from "react";
import { Alert, Animated, Dimensions, FlatList, InteractionManager, Text, TouchableOpacity, TouchableWithoutFeedback, View } from "react-native";
import FastImage from "react-native-fast-image";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { deletePost } from "../lib/posts";
import TimeAgo from "../lib/utils/time-ago";
import { handleAppLink } from "../utils/appLinks";
import LinkPreviewCard from "./LinkPreviewCard";
import PostInformation from "./PostInformation";
import StyledDivider from "./StyledDivider";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";

const { width: screenWidth } = Dimensions.get("window");
const DEFAULT_IMAGE_ASPECT_RATIO = 1;

// Module-level cache of measured image aspect ratios, keyed by URI. Survives
// remount within an app session (e.g., feed tab switch with cache rehydrate),
// so PostCard re-renders use the correct dimensions on first paint instead
// of flashing through DEFAULT_IMAGE_ASPECT_RATIO until onLoad fires again.
// Same pattern as LinkPreviewCard's PREVIEW_MEMORY_CACHE.
const IMAGE_ASPECT_RATIO_CACHE = new Map();

const buildInitialAspectMap = (urls = []) => {
  const initial = {};
  for (const url of urls) {
    if (typeof url !== "string" || !url) continue;
    const cached = IMAGE_ASPECT_RATIO_CACHE.get(url);
    if (typeof cached === "number") {
      initial[url] = cached;
    }
  }
  return initial;
};

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
  // Lazy initializer pulls measured aspect ratios out of the module cache so
  // the first render uses real dimensions instead of DEFAULT_IMAGE_ASPECT_RATIO.
  // Without this, switching feed tabs flashed every post through a square
  // placeholder before onLoad re-measured.
  const [imageAspectRatios, setImageAspectRatios] = useState(() =>
    buildInitialAspectMap(Array.isArray(item?.postUrls) ? item.postUrls : []),
  );
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
      onOpenSafetySheet?.(item);
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
    // Only accept strings that look like an actual URL or data URI. The old
    // `toString()` fallback produced "[object Object]" for malformed entries
    // (objects without uri/href), which then surfaced as broken images in
    // the feed — same visual outcome as a dead URL but caused by data, not
    // network.
    const looksLikeUrl = (s) => typeof s === "string" && /^(https?:|data:|file:|content:)/i.test(s.trim());
    if (looksLikeUrl(value)) return value.trim();
    if (looksLikeUrl(value?.uri)) return value.uri.trim();
    if (looksLikeUrl(value?.href)) return value.href.trim();
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

  // Single tile renderer — handles tap/long-press, aspect ratio caching,
  // and error fallback. Used by the Facebook-style grid below.
  const renderImageGridSlot = (imageUrl, imageIndex, slotStyle, resizeMode = "cover", overlay = null) => {
    const handleImagePress = () => {
      if (firstUrl) {
        handleAppLink(firstUrl);
        return;
      }
      openImageViewer(imageIndex);
    };
    const handleImageLongPress = () => openImageViewer(imageIndex);
    const hasError = imageErrors[imageUrl];
    const onImageLoad = (event) => {
      const { width, height } = event.nativeEvent?.source || event.nativeEvent || {};
      if (!width || !height) return;
      const nextRatio = width / height;
      // Persist to the module cache so future remounts of any PostCard with
      // this image URI start with the correct ratio.
      IMAGE_ASPECT_RATIO_CACHE.set(imageUrl, nextRatio);
      setImageAspectRatios((prev) => {
        if (prev[imageUrl] === nextRatio) return prev;
        return { ...prev, [imageUrl]: nextRatio };
      });
    };

    // Tap-to-retry — clears the error flag so FastImage tries again. Cheap
    // and effective for transient CDN / network blips that can happen when
    // a feed item scrolls back into view long after first failure.
    const handleRetry = () => {
      setImageErrors((prev) => {
        if (!prev[imageUrl]) return prev;
        const next = { ...prev };
        delete next[imageUrl];
        return next;
      });
    };

    // When an image fails to load, collapse the slot to a fixed 160 px tall
    // card instead of inheriting the slot's (often portrait) aspectRatio —
    // which used to leave 700+ px of empty space with a tiny icon centered
    // in it. We strip aspectRatio + height so the error pill is compact.
    const errorSlotStyle = {
      ...slotStyle,
      aspectRatio: undefined,
      height: 160,
    };

    if (hasError) {
      return (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={handleRetry}
          accessibilityLabel="Image failed to load. Tap to retry."
          style={errorSlotStyle}
        >
          <View
            style={{
              width: "100%",
              height: "100%",
              justifyContent: "center",
              alignItems: "center",
              backgroundColor: theme.primarySoft,
              borderWidth: 1,
              borderColor: theme.primary,
              borderStyle: "dashed",
            }}
          >
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: `${theme.primary}33`,
                marginBottom: 8,
              }}
            >
              <MaterialIcons name="image-not-supported" size={22} color={theme.primary} />
            </View>
            <Text
              style={{
                color: theme.text,
                fontSize: 13,
                fontWeight: "700",
                letterSpacing: 0.2,
              }}
            >
              Image unavailable
            </Text>
            <View className="mt-1.5 flex-row items-center" style={{ gap: 4 }}>
              <MaterialIcons name="refresh" size={11} color={theme.textSoft} />
              <Text
                style={{
                  color: theme.textSoft,
                  fontSize: 10,
                  fontWeight: "600",
                  letterSpacing: 0.3,
                  textTransform: "uppercase",
                }}
              >
                Tap to retry
              </Text>
            </View>
          </View>
          {overlay}
        </TouchableOpacity>
      );
    }

    return (
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={handleImagePress}
        onLongPress={handleImageLongPress}
        style={slotStyle}
      >
        <FastImage
          source={{ uri: imageUrl, priority: FastImage.priority.high }}
          style={{ width: "100%", height: "100%", backgroundColor: theme.mediaBackground }}
          resizeMode={FastImage.resizeMode[resizeMode] || FastImage.resizeMode.cover}
          onLoad={onImageLoad}
          onError={() => setImageErrors((prev) => ({ ...prev, [imageUrl]: true }))}
        />
        {overlay}
      </TouchableOpacity>
    );
  };

  // Facebook-style image grid:
  //   1 image  → full width, natural aspect (portrait or landscape)
  //   2 images → side-by-side squares
  //   3 images → 1 large left + 2 stacked squares right
  //   4 images → 2×2 grid of squares
  //   5+       → 2×2 grid with "+N more" overlay on the 4th tile
  const renderImageGrid = () => {
    const urls = resolvedPostUrls;
    const count = urls.length;
    if (count === 0) return null;

    const containerWidth = screenWidth;
    const gap = 2;

    if (count === 1) {
      const aspect = imageAspectRatios[urls[0]] || DEFAULT_IMAGE_ASPECT_RATIO;
      return (
        <View style={{ width: containerWidth }}>
          {renderImageGridSlot(urls[0], 0, { width: "100%", aspectRatio: aspect }, "contain")}
        </View>
      );
    }

    const halfWidth = (containerWidth - gap) / 2;

    if (count === 2) {
      return (
        <View style={{ flexDirection: "row", width: containerWidth }}>
          {renderImageGridSlot(urls[0], 0, { width: halfWidth, aspectRatio: 1 })}
          <View style={{ width: gap }} />
          {renderImageGridSlot(urls[1], 1, { width: halfWidth, aspectRatio: 1 })}
        </View>
      );
    }

    if (count === 3) {
      const rowHeight = halfWidth * 2 + gap;
      return (
        <View style={{ flexDirection: "row", width: containerWidth, height: rowHeight }}>
          {renderImageGridSlot(urls[0], 0, { width: halfWidth, height: rowHeight })}
          <View style={{ width: gap }} />
          <View style={{ width: halfWidth }}>
            {renderImageGridSlot(urls[1], 1, { width: halfWidth, height: halfWidth })}
            <View style={{ height: gap }} />
            {renderImageGridSlot(urls[2], 2, { width: halfWidth, height: halfWidth })}
          </View>
        </View>
      );
    }

    // 4 or more
    const visible = urls.slice(0, 4);
    const remaining = Math.max(0, count - 4);
    const moreOverlay =
      remaining > 0 ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.55)",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: "#ffffff", fontSize: 32, fontWeight: "700" }}>+{remaining}</Text>
        </View>
      ) : null;

    return (
      <View style={{ width: containerWidth }}>
        <View style={{ flexDirection: "row" }}>
          {renderImageGridSlot(visible[0], 0, { width: halfWidth, aspectRatio: 1 })}
          <View style={{ width: gap }} />
          {renderImageGridSlot(visible[1], 1, { width: halfWidth, aspectRatio: 1 })}
        </View>
        <View style={{ height: gap }} />
        <View style={{ flexDirection: "row" }}>
          {renderImageGridSlot(visible[2], 2, { width: halfWidth, aspectRatio: 1 })}
          <View style={{ width: gap }} />
          {renderImageGridSlot(visible[3], 3, { width: halfWidth, aspectRatio: 1 }, "cover", moreOverlay)}
        </View>
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
                source={{ uri: item.postOwner.avatar, priority: FastImage.priority.normal }}
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
          {item.post && (() => {
            const isExpandable = item.post?.length > 130 || lineCount > 3;
            return (
              <Text
                style={{ fontSize: 15, color: theme.text }}
                className="text-sm"
                numberOfLines={expanded ? undefined : 3}
                ellipsizeMode="tail"
                // Tap anywhere on the body to toggle expand/collapse — matches web.
                // Nested link Text elements have their own onPress and will short-circuit.
                onPress={isExpandable ? toggleExpanded : undefined}
                suppressHighlighting
              >
                {item.post.split(/(https?:\/\/[^\s]+)/g).map((part, idx) => {
                  if (part.match(/https?:\/\/[^\s]+/)) {
                    return (
                      <Text
                        key={idx}
                        style={{ color: theme.primary, textDecorationLine: "underline" }}
                        onPress={() => handleAppLink(part)}
                      >
                        {part}
                      </Text>
                    );
                  }
                  return part;
                })}
              </Text>
            );
          })()}

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

        {/* Post Images — Facebook-style adaptive grid */}
        {resolvedPostUrls.length > 0 && (
          <View className="mb-3 self-center mt-3" style={{ width: screenWidth }}>
            {renderImageGrid()}
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
