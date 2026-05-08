import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { router, useGlobalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Dimensions, FlatList, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import Svg, { Circle } from "react-native-svg";
import AnimatedSkeleton from "../components/AnimatedSkeleton";
import { useSetMomentRings } from "../context/moment-rings-provider";
import useAppTheme from "../hooks/useAppTheme";
import storyEvents from "../lib/story-events";
import { StoryService } from "../lib/story-service";
// Phase E.9 — tier-aware image transforms for the horizontal story
// strip. Story tiles are 112dp wide × 176dp tall and we render up to
// ~10 of them at the top of the home feed, so any per-tile decode
// savings multiply.
import { optimizedImageUri } from "../lib/utils/image-source";
import createTtlCache from "../lib/utils/createTtlCache";

const STORY_TILE_WIDTH = 112;
const STORY_AVATAR_WIDTH = 32;

// Per-user feed cache for the home strip. 5-minute TTL — Moments are
// 24h-ephemeral but the *composition* of the strip changes as friends
// post throughout the day, so we don't want to freeze it for too long.
// Stored shape: { myStories, followingStories, fallbackStories }.
// Stale-while-revalidate: loadStories paints from this cache on first
// open (no spinner), then refreshes in the background.
const STORY_FEED_CACHE = createTtlCache({ ttlMs: 5 * 60_000, maxEntries: 20 });

const ProgressRing = ({ progress = 0, size = 56, strokeWidth = 6 }) => {
  const { theme } = useAppTheme();
  const clamped = Math.max(0, Math.min(100, progress || 0));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (clamped / 100) * circumference;

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Circle cx={size / 2} cy={size / 2} r={radius} stroke={theme.primaryContrast} strokeOpacity={0.35} strokeWidth={strokeWidth} fill="none" />
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke={theme.primaryContrast}
        strokeWidth={strokeWidth}
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={strokeDashoffset}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
};

const { width, height } = Dimensions.get("window");

const StoryBar = ({ user, forceUpdate }) => {
  const { theme } = useAppTheme();
  const [stories, setStories] = useState([]);
  const [userStories, setUserStories] = useState([]);
  const [initialized, setInitialized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(0);
  // Bumped from 10 → 20 so the strip surfaces a meaningful spread of
  // recent activity (Facebook / IG show ~15-20 in their tray). The
  // cache keeps the cost cheap on subsequent opens.
  const limit = 20;
  const params = useGlobalSearchParams();

  // Publishes "user IDs whose avatar should glow purple" to the
  // MomentRingsProvider. Only includes followings + own (not the
  // discover section) so the visibility rule per the spec stays
  // true: ring is for users the viewer FOLLOWS who have a Moment.
  const setMomentRings = useSetMomentRings();

  useEffect(() => {
    if (!initialized) {
      loadStories(true).then(() => setInitialized(true));
    } else {
      loadStories(false);
    }
  }, [forceUpdate]);

  useEffect(() => {
    if (params?.newStory) {
      try {
        const { storyId, mediaUrl, thumbnail, type } = JSON.parse(params.newStory);
        const newStory = {
          id: storyId,
          mediaUrl,
          thumbnail,
          type,
          user: { id: user.$id, avatar: user?.avatar },
          uploading: false,
          failed: false,
          status: "ready",
          progress: 100,
        };
        setUserStories((prev) => [newStory, ...prev.filter((s) => s.id !== newStory.id)]);
      } catch (err) {
        console.warn("Failed to parse newStory params:", err);
      }
    }
  }, [params?.newStory]);

  useEffect(() => {
    const handleStoryShared = async (data) => {
      const tempId = `tmp_${Date.now()}`;
      const isVideo = data.type === "video";
      const placeholder = {
        id: tempId,
        type: data.type,
        mediaUrl: data.uri,
        thumbnail: data.thumbnail || data.uri,
        user: { id: user.$id, avatar: user?.avatar, name: user?.name },
        uploading: true,
        failed: false,
        status: isVideo ? "processing" : "ready",
        progress: 0,
      };

      setUserStories((prev) => [placeholder, ...prev]);

      const updateProgress = (pct) => {
        setUserStories((prev) => prev.map((s) => (s.id === tempId ? { ...s, progress: pct } : s)));
      };

      try {
        const result = await StoryService.createStory({
          userId: user.$id,
          fileUri: data.uri,
          fileType: data.type,
          overlayTexts:
            isVideo && Array.isArray(data.texts)
              ? data.texts.map((t) => ({
                  text: t.text,
                  color: t.color,
                  xPercent: (t.pan.x._value + width / 2) / width,
                  yPercent: (t.pan.y._value + height / 2) / height,
                }))
              : [],
          thumbnail: data.thumbnail,
          musicId: data.musicId,
          // Forward the optional link attachment from story-preview.
          // `data.link` is { url, resourceType, resourceId } | null —
          // createStory writes the three pieces into stories.link_url /
          // stories.link_resource_type / stories.link_resource_id so
          // the viewer can deep-link in-app on swipe-up. Null when the
          // user didn't attach a link, in which case createStory leaves
          // those columns NULL (default).
          link: data.link || null,
          onProgress: updateProgress,
        });

        setUserStories((prev) => {
          const prevPlaceholder = prev.find((s) => s.id === tempId);
          const status = result.status || (isVideo ? "processing" : "ready");
          const merged = {
            ...result,
            thumbnail: result.thumbnail || prevPlaceholder?.thumbnail,
            mediaUrl: result.mediaUrl || prevPlaceholder?.mediaUrl,
            uploading: false,
            failed: false,
            status,
            progress: 100,
          };
          return [merged, ...prev.filter((s) => s.id !== tempId)];
        });
      } catch (err) {
        console.log("Upload failed:", err);
        setUserStories((prev) => prev.map((s) => (s.id === tempId ? { ...s, uploading: false, failed: true } : s)));
      }
    };

    storyEvents.on("storyShared", handleStoryShared);

    return () => {
      storyEvents.off("storyShared", handleStoryShared);
    };
  }, [user]);

  // Ref to maintain stable reference to loadStories
  const loadStoriesRef = useRef(loadStories);

  useEffect(() => {
    loadStoriesRef.current = loadStories;
  }, [loadStories]);

  useEffect(() => {
    const handleStoryDeleted = ({ storyId, uploaderId }) => {
      setUserStories((prev) => prev.filter((s) => s.id !== storyId));

      setStories((prev) => prev.filter((s) => s.user.id !== uploaderId));

      loadStoriesRef.current(true);
    };

    storyEvents.on("storyDeleted", handleStoryDeleted);

    return () => {
      storyEvents.off("storyDeleted", handleStoryDeleted);
    };
  }, [user?.$id]);

  const loadStories = useCallback(
    async (reset = false) => {
      // Bail if we don't have a user yet. This effect can fire on focus/refresh during
      // sign-out, pre-bootstrap hydration, or mid-session expiry, when `user` is null.
      // Without this guard, `user.$id` below throws "Cannot read property '$id' of null".
      if (!user?.$id) {
        setLoading(false);
        setLoadingMore(false);
        return;
      }

      // ── 1. Stale-while-revalidate: paint cache instantly on first
      //      load (reset=true, page 0). Subsequent paginations skip
      //      the cache and go straight to network.
      const isFirstLoad = reset && page === 0;
      if (isFirstLoad) {
        const cached = STORY_FEED_CACHE.get(user.$id);
        if (cached) {
          setUserStories((prev) => {
            // Preserve any in-flight optimistic uploads on top of the
            // cached list so a refresh during upload doesn't wipe them.
            const optimistic = prev.filter((s) => s.uploading || s.status === "processing");
            const cachedMap = new Map((cached.myStories || []).map((s) => [s.id, s]));
            for (const o of optimistic) if (!cachedMap.has(o.id)) cachedMap.set(o.id, o);
            return Array.from(cachedMap.values());
          });
          // Reconstruct the strip order: followings first, discover
          // after — matches what loadStories writes to setStories on
          // a fresh fetch.
          const cachedFollowing = cached.followingStories || [];
          const cachedDiscover = cached.discoverStories || [];
          setStories([...cachedFollowing, ...cachedDiscover]);
          setLoading(false); // cached paint — no spinner needed

          // Publish glow set from cache so avatars across the app
          // get the purple ring instantly on warm opens, not after
          // the network refresh resolves.
          const ringIds = cachedFollowing.map((s) => s.user?.id).filter(Boolean);
          if ((cached.myStories || []).length > 0) ringIds.push(user.$id);
          setMomentRings(ringIds);
        }
      }

      try {
        if (reset && !isFirstLoad) {
          setLoading(true);
          setPage(0);
        } else if (!reset) {
          setLoadingMore(true);
        }

        const offset = reset ? 0 : page * limit;

        // Fetch following users' stories only
        const followingStories = await StoryService.fetchStoriesFromFollowing({
          userId: user.$id,
          limit,
          offset,
        });

        // Fetch your own stories (always included)
        const myStoriesRaw = await StoryService.fetchUserStories(user.$id);

        // Filter 24-hour expiration for BOTH
        const now = Date.now();
        const DAY_MS = 24 * 60 * 60 * 1000;

        const isActive = (s) => {
          if (s.expiresAt) return new Date(s.expiresAt) > now;
          return now - new Date(s.createdAt).getTime() <= DAY_MS;
        };

        const activeMyStories = myStoriesRaw.filter(isActive).map((s) => ({
          ...s,
          user: {
            id: user.$id,
            name: user.name,
            avatar: user.avatar,
          },
        }));

        // Use functional updates to avoid dependency on userStories
        setUserStories((prevUserStories) => {
          const optimisticMyStories = prevUserStories.filter((s) => s.uploading || s.status === "processing");
          const myStoryMap = new Map(activeMyStories.map((s) => [s.id, s]));
          for (const optimistic of optimisticMyStories) {
            if (!myStoryMap.has(optimistic.id)) {
              myStoryMap.set(optimistic.id, optimistic);
            }
          }
          return Array.from(myStoryMap.values());
        });

        const activeFollowing = followingStories.filter(isActive);

        // ── Discover stories — ALWAYS appended after followings on
        //    the first page (not just as a fallback). Order goal:
        //      [Own] [Following...newest first] [Discover...newest first]
        //
        //    When a followed user posts a new Moment, the per-user
        //    dedup picks the new (latest) story for their tile and
        //    the createdAt-desc sort floats them to the top of the
        //    Following section automatically. Discover sits below.
        //
        //    Dedup against followings + own so a discover row whose
        //    author the viewer already follows doesn't render twice.
        //    Only fired on reset/page-0 — pagination past the first
        //    page only extends followings, not discover.
        let discoverStories = [];
        if (reset && offset === 0) {
          try {
            const discover = await StoryService.fetchStories({ limit, offset: 0 });
            const followingUserIds = new Set(activeFollowing.map((s) => s.user?.id).filter(Boolean));
            discoverStories = (discover || [])
              .filter(isActive)
              .filter((s) => {
                const uid = s.user?.id;
                if (!uid) return false;
                if (uid === user.$id) return false; // skip own — already in userStories
                if (followingUserIds.has(uid)) return false; // already in following section
                return true;
              });
          } catch (discoverErr) {
            console.log("Discover fetch failed:", discoverErr?.message);
          }
        }

        // Reusable per-user dedup + recency sort. Keeps only the
        // latest story per user (one tile per user, FB/IG style).
        const dedupAndSort = (list) => {
          const map = list.reduce((acc, s) => {
            if (!acc[s.user.id] || new Date(acc[s.user.id].createdAt) < new Date(s.createdAt)) {
              acc[s.user.id] = s;
            }
            return acc;
          }, {});
          return Object.values(map).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        };

        const followingTiles = dedupAndSort(activeFollowing);
        const discoverTiles = dedupAndSort(discoverStories);

        // Use functional update to avoid dependency on stories
        setStories((prevStories) => {
          if (reset) {
            // First page — followings first, discover after.
            return [...followingTiles, ...discoverTiles];
          }
          // Pagination — append fresh followings to whatever's already
          // displayed (discover is page-0-only, so don't re-append).
          const merged = [...prevStories, ...activeFollowing];
          return dedupAndSort(merged);
        });

        // Persist the fresh result to the SWR cache so the next mount
        // can paint instantly. Cache the post-dedup tile lists since
        // that's what setStories actually writes.
        if (reset) {
          STORY_FEED_CACHE.set(user.$id, {
            myStories: activeMyStories,
            followingStories: followingTiles,
            discoverStories: discoverTiles,
          });

          // Refresh the global "ring this avatar" set with the fresh
          // followings (not discover — per spec, ring is followings-
          // only) plus own when the viewer has an active Moment.
          const ringIds = followingTiles.map((s) => s.user?.id).filter(Boolean);
          if (activeMyStories.length > 0) ringIds.push(user.$id);
          setMomentRings(ringIds);
        }

        setHasMore(activeFollowing.length === limit);
      } catch (error) {
        console.log("Error loading stories:", error);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [page, user?.$id, limit],
  );

  const handleAddStory = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsEditing: false,
        quality: 0.5,
      });

      // Some Android galleries expose a "Preview" action that returns no assets even though it is not marked cancelled.
      if (result.canceled || !result.assets?.length) {
        console.warn("Image picker returned no selection (preview/empty).");
        return;
      }

      const file = result.assets.find((asset) => asset?.uri);
      if (!file?.uri) {
        console.warn("No usable media URI returned from picker.");
        return;
      }
      const fileType = file.type === "video" ? "video" : "image";

      router.push({ pathname: "/story-preview", params: { uri: file.uri, type: fileType } });
    } catch (error) {
      console.log("Error picking media:", error);
    }
  };

  const handlePressStory = (item) => {
    const isOwnStory = item.user.id === user.$id;

    router.push({
      pathname: "/story-viewer",
      params: {
        uploaderId: item.user.id,
        viewerId: user.$id,
        startAtOwnStories: isOwnStory ? "1" : "0",
      },
    });
  };

  const renderSkeletonCards = (count = 3) =>
    Array.from({ length: count }).map((_, idx) => (
      <TouchableOpacity disabled key={`skeleton-${idx}`} className="mr-2" activeOpacity={1}>
        <AnimatedSkeleton style={{ width: 112, height: 176, borderRadius: 12 }} />
        <View className="mt-2 items-center">
          <AnimatedSkeleton style={{ width: 50, height: 10, borderRadius: 6 }} />
        </View>
      </TouchableOpacity>
    ));

  const renderSkeleton = () => (
    <FlatList
      horizontal
      data={[1, 2, 3, 4]}
      keyExtractor={(item) => item.toString()}
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="px-3"
      renderItem={() => (
        <TouchableOpacity disabled className="mr-2" activeOpacity={1}>
          <AnimatedSkeleton style={{ width: 112, height: 176, borderRadius: 12 }} />
          <View className="mt-2 items-center">
            <AnimatedSkeleton style={{ width: 50, height: 10, borderRadius: 6 }} />
          </View>
        </TouchableOpacity>
      )}
    />
  );

  const StoryCard = ({ item }) => {
    const placeholderImage = item.type === "image" ? item.mediaUrl : item.thumbnail;
    return (
      <TouchableOpacity activeOpacity={0.8} onPress={() => handlePressStory(item)} className="mr-2">
        <View className="relative h-44 w-28 overflow-hidden rounded-xl" style={{ backgroundColor: theme.surfaceMuted }}>
          <FastImage
            source={{ uri: optimizedImageUri(placeholderImage, { width: STORY_TILE_WIDTH }) }}
            className="h-full w-full"
            resizeMode="cover"
          />
          <View className="absolute inset-0" style={{ backgroundColor: theme.mediaOverlay }} />

          {item.user?.avatar && (
            <View className="absolute bottom-3 left-0 right-0 items-center">
              <FastImage
                source={{ uri: optimizedImageUri(item.user.avatar, { width: STORY_AVATAR_WIDTH }) }}
                className="h-8 w-8 rounded-full border-2"
                style={{ borderColor: theme.accentPurple }}
                resizeMode="cover"
              />
              <Text className="text-center text-[13px] font-semibold shadow-lg" style={{ color: theme.primaryContrast }}>
                {item.user.name}
              </Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const AddStoryCard = () => (
    <TouchableOpacity activeOpacity={0.8} onPress={handleAddStory} className="mr-2">
      <View className="relative h-44 w-28 items-center justify-center overflow-hidden rounded-xl" style={{ backgroundColor: theme.surfaceMuted }}>
        {/* Background image */}
        <FastImage
          source={{ uri: optimizedImageUri(user?.avatar, { width: STORY_TILE_WIDTH }) }}
          className="absolute h-full w-full opacity-40"
          resizeMode="cover"
        />
        <View className="absolute inset-0" style={{ backgroundColor: theme.mediaOverlayStrong }} />

        {/* Bottom purple section */}
        <View className="absolute bottom-0 w-full items-center">
          <View className="w-full items-center rounded-b-xl p-2 pt-4" style={{ backgroundColor: theme.accentPurple }}>
            <Text className="text-center text-[12px] font-semibold shadow-lg" style={{ color: theme.primaryContrast }}>
              Post a moment on Selebox
            </Text>
          </View>

          {/* Overlapping add icon */}
          <View className="absolute -top-[18px] rounded-full" style={{ backgroundColor: theme.mediaOverlayStrong }}>
            <Ionicons name="add-outline" size={34} color={theme.primaryContrast} />
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );

  // Facebook-style: when the user has a Moment, this tile REPLACES
  // the "Post a moment" CTA at the head of the strip. A small "+"
  // badge in the bottom-right lets the user post another without
  // losing the slot — tapping the rest of the tile opens the viewer.
  const YourStoryCard = () => {
    const story = userStories[0];
    if (!story) return null;
    const isUploading = story.uploading;
    const isFailed = story.failed;
    const isProcessing = story.status === "processing" && !isUploading && !isFailed;
    const progress = Math.round(story.progress ?? 0);
    const placeholderImage = story.type === "image" ? story.mediaUrl : story.thumbnail;
    return (
      <TouchableOpacity activeOpacity={0.8} onPress={() => handlePressStory(story)} className="mr-2">
        <View className="relative h-44 w-28 overflow-hidden rounded-xl" style={{ backgroundColor: theme.surfaceMuted }}>
          <FastImage
            source={{ uri: optimizedImageUri(placeholderImage, { width: STORY_TILE_WIDTH }) }}
            className="h-full w-full"
            resizeMode="cover"
          />
          <View className="absolute inset-0" style={{ backgroundColor: theme.mediaOverlay }} />

          {(isUploading || isFailed || isProcessing) && <View className="absolute inset-0" style={{ backgroundColor: theme.mediaOverlayStrong }} />}

          {isUploading && (
            <View className="absolute inset-0 h-full w-full items-center justify-center">
              <ProgressRing progress={progress} />
              <Text className="mt-2 text-center text-xs" style={{ color: theme.primaryContrast }}>
                Uploading
              </Text>
            </View>
          )}

          {isProcessing && (
            <View className="absolute inset-0 h-full w-full items-center justify-center">
              <ActivityIndicator size="large" color={theme.primaryContrast} />
              <Text className="mt-2 text-center text-xs" style={{ color: theme.primaryContrast }}>
                Processing…
              </Text>
            </View>
          )}

          {isFailed && (
            <View className="absolute inset-0 flex-1 items-center justify-center">
              <Ionicons name="warning-outline" size={30} color={theme.danger} />
              <Text className="mt-2 text-center text-xs" style={{ color: theme.danger }}>
                Upload failed
              </Text>
            </View>
          )}

          <View className="absolute bottom-2 left-0 right-0 items-center">
            <Text className="font-psemibold text-[13px] shadow-lg" style={{ color: theme.primaryContrast }}>
              Your Moment
            </Text>
          </View>

          {/* "+" badge — Facebook-style. Lets the user post another
              Moment from the same tile instead of needing a separate
              "Post a moment" slot. We use a TouchableOpacity nested
              inside the parent and stop propagation via the dedicated
              onPress (the parent's onPress only fires if the tap
              doesn't hit a child touchable). 28dp circle in the
              bottom-right with an accent ring for affordance. */}
          {!isUploading && !isFailed && !isProcessing ? (
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={handleAddStory}
              hitSlop={6}
              className="absolute right-1.5 top-1.5 h-7 w-7 items-center justify-center rounded-full"
              style={{
                backgroundColor: theme.accentPurple,
                borderWidth: 2,
                borderColor: theme.primaryContrast,
              }}
              accessibilityRole="button"
              accessibilityLabel="Post another moment"
            >
              <Ionicons name="add" size={16} color={theme.primaryContrast} />
            </TouchableOpacity>
          ) : null}
        </View>
      </TouchableOpacity>
    );
  };

  // Head of the strip: if the user has any active Moments (including
  // an in-flight optimistic upload), their story tile takes the first
  // slot — Facebook-style — and carries a "+" badge for posting more.
  // Otherwise we fall back to the standalone "Post a moment" CTA so
  // first-time posters know where to start.
  const data = userStories.length
    ? [{ id: "your_story", type: "your" }, ...stories]
    : [{ id: "add_story", type: "add" }, ...stories];

  const renderItem = ({ item }) => {
    if (item.type === "add") return <AddStoryCard />;
    if (item.type === "your") return <YourStoryCard />;
    return <StoryCard item={item} />;
  };

  return (
    <View className="w-full pb-1">
      {loading && !initialized ? (
        renderSkeleton()
      ) : (
        <FlatList
          data={data}
          horizontal
          showsHorizontalScrollIndicator={false}
          directionalLockEnabled={true}
          nestedScrollEnabled={true}
          keyExtractor={(item, i) => item.id?.toString() || `story_${i}`}
          contentContainerClassName="px-3"
          renderItem={renderItem}
          onEndReached={hasMore ? loadStories : null}
          onEndReachedThreshold={0.3}
          ListFooterComponent={loadingMore ? <View className="flex-row">{renderSkeletonCards(3)}</View> : null}
        />
      )}
    </View>
  );
};

export default StoryBar;
