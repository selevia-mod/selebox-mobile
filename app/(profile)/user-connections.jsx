import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Image, Text, TouchableOpacity, View } from "react-native";
import { StyledSafeAreaView } from "../../components";
import AnimatedSkeleton from "../../components/AnimatedSkeleton";
import UserRoleBadgeIcons from "../../components/UserRoleBadgeIcons";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { FollowService } from "../../lib/follows";
import { NotificationService } from "../../lib/notifications";

const PAGE_LIMIT = 15;
const CONNECTIONS_CACHE_TTL_MS = 45 * 1000;
const connectionsCache = new Map();

const getConnectionCacheKey = ({ viewerId, profileUserId, type }) => `${viewerId || "guest"}:${profileUserId}:${type}`;

const getFreshConnectionCache = (cacheKey) => {
  const cached = connectionsCache.get(cacheKey);

  if (!cached) return null;

  if (Date.now() - cached.cachedAt > CONNECTIONS_CACHE_TTL_MS) {
    connectionsCache.delete(cacheKey);
    return null;
  }

  return cached;
};

const setConnectionCache = (cacheKey, value) => {
  connectionsCache.set(cacheKey, {
    ...value,
    cachedAt: Date.now(),
  });
};

const clearConnectionCacheForViewer = (viewerId) => {
  if (!viewerId) return;

  for (const cacheKey of connectionsCache.keys()) {
    if (cacheKey.startsWith(`${viewerId}:`)) {
      connectionsCache.delete(cacheKey);
    }
  }
};

const UserConnectionsScreen = () => {
  const {
    followingCount: initialFollowingCount,
    followerCount: initialFollowerCount,
    initLoadContent,
    loggedInUser,
    username,
  } = useLocalSearchParams();
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();

  const isOwnProfile = user?.$id === loggedInUser;

  const notificationService = new NotificationService();
  const [activeTab, setActiveTab] = useState(initLoadContent);
  const [followers, setFollowers] = useState([]);
  const [following, setFollowing] = useState([]);

  const [followersHasMore, setFollowersHasMore] = useState(true);
  const [followingHasMore, setFollowingHasMore] = useState(true);

  const [followersCursor, setFollowersCursor] = useState(null);
  const [followingCursor, setFollowingCursor] = useState(null);

  const [loadingMore, setLoadingMore] = useState(false);
  const [followersLoading, setFollowersLoading] = useState(true);
  const [followingLoading, setFollowingLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [actionLoading, setActionLoading] = useState({});
  const [followBackStatus, setFollowBackStatus] = useState({});

  const [followingCount, setFollowingCount] = useState(Number(initialFollowingCount) || 0);
  const [followerCount, setFollowerCount] = useState(Number(initialFollowerCount) || 0);

  useFocusEffect(
    useCallback(() => {
      const loadInitial = async () => {
        if (user) {
          const requests = [];

          // Always refresh counts — the URL params come in formatted ("1.1K")
          // and Number("1.1K") = NaN, so without this the count tab badge
          // shows 0 when viewing someone else's profile. fetchCounts hits
          // FollowService.getFollowersCount which already merges with the
          // snapshot floor, so the badge displays correctly.
          requests.push(fetchCounts());
          if (activeTab === "followers" && followers.length === 0) {
            const usedCache = hydrateConnectionsFromCache("followers");
            requests.push(fetchFollowers({ silent: usedCache }));
          } else if (activeTab === "following" && following.length === 0) {
            const usedCache = hydrateConnectionsFromCache("following");
            requests.push(fetchFollowing({ silent: usedCache }));
          }

          await Promise.all(requests);
        }
      };

      loadInitial();
    }, [activeTab, user]),
  );

  const fetchCounts = async () => {
    try {
      const [followerCount, followingCount] = await Promise.all([
        FollowService.getFollowersCount({ userId: loggedInUser }),
        FollowService.getFollowingCount({ userId: loggedInUser }),
      ]);

      setFollowerCount(followerCount);
      setFollowingCount(followingCount);
    } catch (e) {
      console.error("Error fetching follow counts:", e);
    }
  };

  const hydrateConnectionsFromCache = (type) => {
    const cached = getFreshConnectionCache(
      getConnectionCacheKey({
        viewerId: user?.$id,
        profileUserId: loggedInUser,
        type,
      }),
    );

    if (!cached) return false;

    if (type === "followers") {
      setFollowers(cached.documents);
      setFollowersHasMore(cached.hasMore);
      setFollowersCursor(cached.cursor);
      setFollowersLoading(false);
    } else {
      setFollowing(cached.documents);
      setFollowingHasMore(cached.hasMore);
      setFollowingCursor(cached.cursor);
      setFollowingLoading(false);
    }

    setFollowBackStatus((prev) => ({ ...prev, ...(cached.followBackStatus || {}) }));
    return true;
  };

  // Extract the embedded user object from a follows-table row, regardless
  // of whether the row came back in Supabase shape (followerUser /
  // followedUser as nested profile objects, follower_id / following_id as
  // bare UUIDs) or legacy Appwrite shape (followerId / followingId as
  // full doc objects). Mirrors the same fallback that renderItem uses.
  const getRowUserItem = (item, type) =>
    type === "followers"
      ? (item.followerUser || item.followerId || {})
      : (item.followedUser || item.followingId || {});

  const fetchFollowRelations = async (list, type) => {
    try {
      // Was: item.followerId?.$id / item.followingId?.$id — those fields
      // exist on Appwrite shape only. Under Supabase the populated user
      // object lives at followerUser / followedUser, so the old access
      // path was always undefined → otherUserIds was always [] → the
      // followBackStatus map stayed empty → every row showed the default
      // "Follow" button (instead of "Following" / "Follow Back" /
      // "Mutual"). Use the shape-aware helper so both backends work.
      const otherUserIds = list.map((item) => getRowUserItem(item, type)?.$id).filter(Boolean);

      if (otherUserIds.length === 0) {
        return {};
      }

      const statusObj = await FollowService.getFollowRelations({
        currentUserId: user.$id,
        otherUserIds,
        knownIFollowIds: isOwnProfile && type === "following" ? otherUserIds : [],
        knownTheyFollowIds: isOwnProfile && type === "followers" ? otherUserIds : [],
      });

      setFollowBackStatus((prev) => ({ ...prev, ...statusObj }));
      return statusObj;
    } catch (error) {
      console.error("Error fetching follow relations:", error);
      return null;
    }
  };

  const fetchFollowers = async ({ silent = false, append = false } = {}) => {
    try {
      if (append) {
        // do nothing, keep list visible
      } else if (silent) {
        setRefreshing(true);
      } else {
        setFollowersLoading(true);
      }

      const res = await FollowService.getFollowers({
        userId: loggedInUser,
        limit: PAGE_LIMIT,
        cursor: append ? followersCursor : null,
      });

      // FollowService uses created_at for cursor pagination (q.lt("created_at", cursor)),
      // not a row id. The legacy code used .$id here which is now a synthetic
      // string `${follower_id}::${following_id}` and Postgres rejects it as not
      // a timestamp. Use $createdAt / created_at instead.
      const lastFollowerDoc = res.documents.length > 0 ? res.documents[res.documents.length - 1] : null;
      const nextCursor = lastFollowerDoc ? (lastFollowerDoc.created_at || lastFollowerDoc.$createdAt) : (append ? followersCursor : null);

      // Pre-populate the relation status with what we already know from
      // tab context so buttons render with the right label on first
      // paint instead of flashing "Follow" → "Follow Back". Viewing
      // your own followers list means every row is, by definition,
      // someone who follows YOU (theyFollow=true). The fetch below
      // fills in the unknown direction (whether you follow them back).
      // For other users' profiles we still wait for the fetch since we
      // don't know the relationship from context.
      if (isOwnProfile && res.documents.length > 0) {
        const inferred = {};
        res.documents.forEach((item) => {
          const id = getRowUserItem(item, "followers")?.$id;
          if (id) inferred[id] = { ...(followBackStatus[id] || {}), theyFollow: true };
        });
        setFollowBackStatus((prev) => ({ ...prev, ...inferred }));
      }

      setFollowers((prev) => (append ? [...prev, ...res.documents] : res.documents));
      setFollowersHasMore(res.hasMore);
      setFollowersCursor(nextCursor);

      const followBackStatus = await fetchFollowRelations(res.documents, "followers");

      if (!append && followBackStatus) {
        setConnectionCache(
          getConnectionCacheKey({
            viewerId: user?.$id,
            profileUserId: loggedInUser,
            type: "followers",
          }),
          {
            documents: res.documents,
            hasMore: res.hasMore,
            cursor: nextCursor,
            followBackStatus,
          },
        );
      }
    } catch (error) {
      console.error("Error fetching followers:", error);
    } finally {
      if (!silent) setFollowersLoading(false);
      else setRefreshing(false);
    }
  };

  const fetchFollowing = async ({ silent = false, append = false } = {}) => {
    try {
      if (append) {
        // skip skeletons for load-more
      } else if (silent) {
        setRefreshing(true);
      } else {
        setFollowingLoading(true);
      }

      const res = await FollowService.getFollowing({
        userId: loggedInUser,
        limit: PAGE_LIMIT,
        cursor: append ? followingCursor : null,
      });

      // Same created_at cursor fix as fetchFollowers above — synthetic $id
      // is not a timestamp Postgres can use for pagination.
      const lastFollowingDoc = res.documents.length > 0 ? res.documents[res.documents.length - 1] : null;
      const nextCursor = lastFollowingDoc ? (lastFollowingDoc.created_at || lastFollowingDoc.$createdAt) : (append ? followingCursor : null);

      // Pre-populate iFollow=true for own following list — by
      // definition every row here is someone YOU follow, so the button
      // can render "Following" immediately without waiting for the
      // relation fetch. Eliminates the "Follow" → "Following" flash.
      if (isOwnProfile && res.documents.length > 0) {
        const inferred = {};
        res.documents.forEach((item) => {
          const id = getRowUserItem(item, "following")?.$id;
          if (id) inferred[id] = { ...(followBackStatus[id] || {}), iFollow: true };
        });
        setFollowBackStatus((prev) => ({ ...prev, ...inferred }));
      }

      setFollowing((prev) => (append ? [...prev, ...res.documents] : res.documents));

      setFollowingHasMore(res.hasMore);
      setFollowingCursor(nextCursor);

      const followBackStatus = await fetchFollowRelations(res.documents, "following");

      if (!append && followBackStatus) {
        setConnectionCache(
          getConnectionCacheKey({
            viewerId: user?.$id,
            profileUserId: loggedInUser,
            type: "following",
          }),
          {
            documents: res.documents,
            hasMore: res.hasMore,
            cursor: nextCursor,
            followBackStatus,
          },
        );
      }
    } catch (error) {
      console.error("Error fetching following:", error);
    } finally {
      if (!silent) setFollowingLoading(false);
      else setRefreshing(false);
    }
  };

  const loadMore = useCallback(async () => {
    if (loadingMore || refreshing) return;

    if (activeTab === "followers" && followersHasMore) {
      setLoadingMore(true);
      await fetchFollowers({ append: true });
      setLoadingMore(false);
    }

    if (activeTab === "following" && followingHasMore) {
      setLoadingMore(true);
      await fetchFollowing({ append: true });
      setLoadingMore(false);
    }
  }, [activeTab, followersCursor, followingCursor, followersHasMore, followingHasMore, loadingMore, refreshing]);

  const handleFollow = async (otherUser) => {
    const otherUserId = otherUser.$id;

    try {
      setActionLoading((prev) => ({ ...prev, [otherUserId]: true }));
      await FollowService.followUser({ followerId: user.$id, followingId: otherUserId });
      // ABUSE DEFENSE: dedup by followingId so unfollow→refollow on
      // the same user can't farm the goal. See Profile.jsx for the
      // full rule.
      const { tickGoalUnique } = await import("../../lib/goals-store");
      tickGoalUnique("follow_user", `follow:${otherUserId}`);
      clearConnectionCacheForViewer(user.$id);
      setFollowBackStatus((prev) => ({
        ...prev,
        [otherUserId]: { ...(prev[otherUserId] || {}), iFollow: true },
      }));
      if (isOwnProfile) {
        setFollowingCount((prev) => prev + 1);

        if (activeTab === "followers") {
          setFollowing((prev) => {
            // Use shape-aware accessor — see getRowUserItem above. The old
            // .followingId.$id / .followerId.$id paths were Appwrite-only
            // and silently undefined on Supabase, so this whole optimistic
            // list-rebuild was a no-op under USE_SUPABASE_FOLLOWS=true.
            const alreadyInFollowing = prev.some((item) => getRowUserItem(item, "following")?.$id === otherUserId);
            if (alreadyInFollowing) return prev;

            const followerDoc = followers.find((f) => getRowUserItem(f, "followers")?.$id === otherUserId);
            if (!followerDoc) return prev;

            const followerProfile = getRowUserItem(followerDoc, "followers");
            const newRelation = {
              ...followerDoc,
              // Populate both shapes so cached/legacy consumers and
              // current renderItem fallbacks both resolve.
              followerUser: { ...user },
              followedUser: { ...followerProfile },
              followerId: { ...user },
              followingId: { ...followerProfile },
            };

            return [...prev, newRelation];
          });
        }
      }

      // Prevent duplicate follow notifications on the same day
      const alreadyNotified = await notificationService.checkFollowNotificationExists({
        senderId: user?.$id,
        recipientId: otherUserId,
      });

      if (!alreadyNotified) {
        notificationService.notifyUser({
          sender: user,
          recipient: otherUser,
          type: "follow",
          resourceId: user?.$id,
          message: `started following you`,
        });
      }
    } catch (error) {
      alert("Unable to follow user.");
    } finally {
      setActionLoading((prev) => ({ ...prev, [otherUserId]: false }));
    }
  };

  const handleUnfollow = async (otherUserId) => {
    try {
      setActionLoading((prev) => ({ ...prev, [otherUserId]: true }));
      await FollowService.unfollowUser({ followerId: user.$id, followingId: otherUserId });
      clearConnectionCacheForViewer(user.$id);
      setFollowBackStatus((prev) => ({
        ...prev,
        [otherUserId]: { ...(prev[otherUserId] || {}), iFollow: false },
      }));
      if (isOwnProfile) {
        setFollowingCount((prev) => (prev > 0 ? prev - 1 : 0));
        // Shape-aware filter — Supabase rows expose the user at
        // followedUser, legacy Appwrite rows at followingId. The old
        // .followingId.$id-only filter silently kept the row in state
        // under USE_SUPABASE_FOLLOWS=true (predicate always truthy
        // because undefined !== otherUserId), so optimistic removal
        // never happened until a full refetch.
        setFollowing((prev) => prev.filter((item) => getRowUserItem(item, "following")?.$id !== otherUserId));
      }
    } catch (error) {
      console.error("Unfollow error:", error);
      alert("Unable to unfollow user.");
    } finally {
      setActionLoading((prev) => ({ ...prev, [otherUserId]: false }));
    }
  };

  const getFollowButton = (iFollow, theyFollow) => {
    if (iFollow)
      return {
        text: "Following",
        backgroundColor: theme.surfaceMuted,
        borderColor: theme.borderStrong,
        textColor: theme.textSoft,
        icon: "checkmark-circle",
        iconColor: theme.iconMuted,
      };
    if (theyFollow)
      return {
        text: "Follow Back",
        backgroundColor: theme.accentTeal,
        borderColor: theme.accentTeal,
        textColor: theme.primaryContrast,
        icon: "people",
        iconColor: theme.primaryContrast,
      };
    return {
      text: "Follow",
      backgroundColor: theme.primary,
      borderColor: theme.primary,
      textColor: theme.primaryContrast,
      icon: "person-add",
      iconColor: theme.primaryContrast,
    };
  };

  const renderItem = ({ item }) => {
    // Migrated from Appwrite-populated relation objects (followerId/followingId
    // came back as full doc objects under Appwrite) to Supabase, where
    // follower_id/following_id are bare UUID strings and the embedded profile
    // lives in `followerUser` / `followedUser` per follows-supabase.js's mapping.
    // Fall back to the legacy fields for any cached data still in Appwrite shape.
    const userItem = activeTab === "followers"
      ? (item.followerUser || item.followerId || {})
      : (item.followedUser || item.followingId || {});
    const relation = followBackStatus[userItem.$id] || {};
    const { iFollow, theyFollow } = relation;
    const isMutual = iFollow && theyFollow;
    const btn = getFollowButton(iFollow, theyFollow);
    const isOwnRecord = userItem.$id === user.$id;

    return (
      <View
        className="mx-1 mb-2 flex-row items-center rounded-2xl px-3 py-3"
        style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
      >
        <TouchableOpacity
          className="flex-1 flex-row items-center"
          onPress={() =>
            router.push({
              pathname: "/creator-profile",
              params: { userId: userItem.$id },
            })
          }
        >
          <View className="rounded-full p-0.5" style={isMutual ? { borderWidth: 2, borderColor: theme.accentTeal } : undefined}>
            <Image source={{ uri: userItem.avatar }} className="h-11 w-11 rounded-full" style={{ backgroundColor: theme.surfaceStrong }} />
          </View>
          <View className="ml-3 flex-1">
            <View className="flex-row items-center">
              <Text className="text-[15px] font-semibold" style={{ color: theme.text }} numberOfLines={1} ellipsizeMode="tail">
                {userItem.username}
              </Text>
              <UserRoleBadgeIcons user={userItem} size={14} />
            </View>
            {isMutual && (
              <Text className="mt-0.5 text-xs" style={{ color: theme.accentTeal }}>
                Mutual
              </Text>
            )}
          </View>
        </TouchableOpacity>

        {!isOwnRecord && (
          <TouchableOpacity
            className="ml-3 flex-row items-center rounded-full px-4 py-2"
            style={{
              backgroundColor: btn.backgroundColor,
              borderColor: btn.borderColor,
              borderWidth: iFollow ? 1 : 0,
              opacity: actionLoading[userItem.$id] ? 0.72 : 1,
            }}
            disabled={actionLoading[userItem.$id]}
            onPress={() => (iFollow ? handleUnfollow(userItem.$id) : handleFollow(userItem))}
          >
            {actionLoading[userItem.$id] ? (
              <ActivityIndicator size="small" color={btn.iconColor} />
            ) : (
              <>
                <Ionicons name={btn.icon} size={14} color={btn.iconColor} style={{ marginRight: 4 }} />
                <Text className="text-[13px] font-semibold" style={{ color: btn.textColor }}>
                  {btn.text}
                </Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const data = activeTab === "followers" ? followers : following;

  const tabs = [
    { key: "following", count: followingCount || 0, label: "Following", icon: "people-outline" },
    { key: "followers", count: followerCount || 0, label: "Followers", icon: "heart-outline" },
  ];

  return (
    <StyledSafeAreaView>
      <View className="h-full w-full px-4 pb-5">
        {/* Header */}
        <View className="flex-row items-center py-4">
          <TouchableOpacity onPress={() => router.back()} className="mr-3 rounded-full p-2" style={{ backgroundColor: theme.surfaceMuted }}>
            <MaterialIcons name="arrow-back" size={20} color={theme.icon} />
          </TouchableOpacity>
          <Text className="text-lg font-bold" style={{ color: theme.text }}>
            {username}
          </Text>
        </View>

        {/* Tabs */}
        <View className="mb-3 flex-row gap-2">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <TouchableOpacity
                key={tab.key}
                className="flex-1 flex-row items-center justify-center rounded-xl py-3"
                style={{
                  backgroundColor: isActive ? theme.primary : theme.surfaceMuted,
                  borderWidth: 1,
                  borderColor: isActive ? theme.primary : theme.border,
                }}
                onPress={() => setActiveTab(tab.key)}
              >
                <Ionicons name={tab.icon} size={16} color={isActive ? theme.primaryContrast : theme.iconMuted} style={{ marginRight: 6 }} />
                <Text className="text-[14px] font-semibold" style={{ color: isActive ? theme.primaryContrast : theme.textSoft }}>
                  {tab.label}
                </Text>
                <View className="ml-2 rounded-full px-2 py-0.5" style={{ backgroundColor: isActive ? "rgba(255,255,255,0.2)" : theme.surfaceStrong }}>
                  <Text className="text-xs font-bold" style={{ color: isActive ? theme.primaryContrast : theme.textSoft }}>
                    {tab.count}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        {(activeTab === "followers" ? followersLoading : followingLoading) ? (
          <FlatList
            data={[...Array(8)]}
            keyExtractor={(_, index) => `skeleton-${index}`}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingTop: 4 }}
            renderItem={() => (
              <View
                className="mx-1 mb-2 flex-row items-center rounded-2xl px-3 py-3"
                style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
              >
                <AnimatedSkeleton style={{ width: 44, height: 44, borderRadius: 999 }} />
                <View className="ml-3 flex-1">
                  <AnimatedSkeleton style={{ width: "60%", height: 16, borderRadius: 8 }} />
                  <AnimatedSkeleton style={{ width: "30%", height: 12, borderRadius: 6, marginTop: 6 }} />
                </View>
                <AnimatedSkeleton style={{ width: 90, height: 34, borderRadius: 999 }} />
              </View>
            )}
          />
        ) : data.length === 0 ? (
          <View className="flex-1 items-center justify-center">
            <View className="mb-4 rounded-full p-5" style={{ backgroundColor: theme.surfaceMuted }}>
              <Ionicons name={activeTab === "followers" ? "heart-outline" : "people-outline"} size={40} color={theme.iconMuted} />
            </View>
            <Text className="text-base font-semibold" style={{ color: theme.textMuted }}>
              {activeTab === "followers" ? "No followers yet" : "Not following anyone yet"}
            </Text>
            <Text className="mt-1 text-sm" style={{ color: theme.textSoft }}>
              {activeTab === "followers" ? "Followers will appear here" : "People you follow will appear here"}
            </Text>
          </View>
        ) : (
          <FlatList
            data={data}
            keyExtractor={(item) => item.$id}
            renderItem={renderItem}
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingTop: 4 }}
            ListFooterComponent={
              loadingMore || refreshing ? (
                <View className="py-4">
                  <ActivityIndicator size="small" color={theme.icon} />
                </View>
              ) : null
            }
          />
        )}
      </View>
    </StyledSafeAreaView>
  );
};

export default UserConnectionsScreen;
