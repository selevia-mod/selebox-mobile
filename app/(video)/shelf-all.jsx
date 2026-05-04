// shelf-all — unified See All screen for the 15 video shelves.
//
// Why this exists:
//   The shelves on /(tabs)/videos render 15-30 cards each in a
//   horizontal carousel with a "See All" affordance in the top-right.
//   Tapping that previously routed to /category?category=<title>,
//   which does a tag-based search — useless for non-tag shelves like
//   "Rising Creators" or "Continue Watching" (the user saw "No
//   Results Found"). This screen replaces that route for all 15
//   shelves: it calls the matching fetcher with a larger limit (60),
//   renders the results as a 2-column grid, and persists the result
//   in redux so re-opening the screen is instant.
//
// Routing contract:
//   /(video)/shelf-all?type=<shelfType>
//   shelfType ∈ { continueWatching, risingCreators, becauseYouWatched,
//                 fromYourFollowers, quickPicks, hiddenGems,
//                 underratedForYou, bingeWorthy, trendingWeek,
//                 youMightLike, popularInYourArea, latest,
//                 mostPeopleWant, suggestedForYou, fromFollowing }
//
// The screen reads the corresponding bucket from the persisted
// videosCache for the instant-paint, then optionally re-fetches
// fresh server data with a bigger page size for the server-driven
// shelves. Client-derived shelves (TrendingWeek, QuickPicks, etc.)
// just paint the cached bucket — no extra fetch needed since they
// were already shuffled / filtered on the videos.jsx side.

import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import { useSelector } from "react-redux";
import { MaterialIcons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import VideoCardNew from "../../components/VideoCardNew";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import {
  fetchBecauseYouWatched,
  fetchContinueWatching,
  fetchFromYourFollowers,
  fetchRisingCreators,
} from "../../lib/video";

// Target row count for every See All grid. If the shelf's primary
// data source returns fewer than this, we top it up with random
// low-engagement videos from the persisted baseVideos pool so the
// grid always feels populated. Each tile is 2-up, so 50 ≈ 25 visible
// rows — enough scroll depth without going so deep the bottom rows
// stop feeling relevant.
const TARGET_GRID_SIZE = 50;

// Title + cache-key + optional server-fetch resolver per shelf.
// For client-derived shelves (no fetcher), we just rely on the
// videosCache bucket. For server-driven ones, we re-fetch with a
// bigger limit on mount to get more rows than the home shelf shows.
const SHELF_CONFIG = {
  continueWatching: {
    title: "Continue Watching",
    bucket: "continueWatching",
    refetch: ({ userId }) => fetchContinueWatching({ userId, limit: TARGET_GRID_SIZE }),
  },
  risingCreators: {
    title: "Rising Creators",
    bucket: "risingCreators",
    refetch: ({ userId }) => fetchRisingCreators({ userId, limit: TARGET_GRID_SIZE }),
  },
  becauseYouWatched: {
    title: "Because You Watched",
    bucket: "becauseYouWatched",
    refetch: async ({ userId }) => {
      const res = await fetchBecauseYouWatched({ userId, limit: TARGET_GRID_SIZE });
      return res?.recommendations || [];
    },
  },
  fromYourFollowers: {
    title: "From Your Followers",
    bucket: "fromYourFollowers",
    refetch: ({ userId }) => fetchFromYourFollowers({ userId, limit: TARGET_GRID_SIZE }),
  },
  // Client-derived shelves — no server refetch; the persisted bucket
  // is already shuffled/filtered on videos.jsx side.
  quickPicks:        { title: "Quick Picks",        bucket: "quickPicks" },
  hiddenGems:        { title: "Hidden Gems",        bucket: "hiddenGems" },
  underratedForYou:  { title: "Underrated For You", bucket: "underratedForYou" },
  bingeWorthy:       { title: "Binge-Worthy",       bucket: "bingeWorthy" },
  trendingWeek:      { title: "Trending This Week", bucket: "trendingWeek" },
  youMightLike:      { title: "Videos You Might Like", bucket: "youMightLike" },
  popularInYourArea: { title: "Popular In Your Area",  bucket: "popularInYourArea" },
  latest:            { title: "Latest Videos",      bucket: "latestVideos" },
  mostPeopleWant:    { title: "Most People Want",   bucket: "mostPeopleWant" },
  // suggestedForYou is stored as a 2D column-chunked array (chunks of
  // 2 to drive the home shelf's column carousel — see
  // utils/audiobookVideoSections.js:92). For the See All grid we need
  // a flat list of videos, so we flatten one level when reading.
  suggestedForYou:   { title: "Suggested For You",  bucket: "suggestedForYou", flatten: true },
  fromFollowing:     { title: "From Creators You Follow", bucket: "fromFollowing" },
};

// Pick up to `count` low-engagement videos from `pool` that aren't in
// `excludeIds`. "Low engagement" defined as views_count < 500 — same
// threshold buildHiddenGems uses on the home tab. Falls back to the
// full eligible pool when the strict band is too thin (e.g., catalog
// hasn't accumulated enough low-view rows yet) so we still hit the
// target row count. Random shuffle so the filler reshuffles between
// opens of the same shelf — the user perceives a fresh tail.
const pickLowEngagementFiller = (pool, excludeIds, count) => {
  if (count <= 0 || !Array.isArray(pool) || pool.length === 0) return [];
  const exclude = new Set(excludeIds);
  const eligible = pool.filter((v) => {
    const id = v?.$id || v?.id;
    return id && !exclude.has(id);
  });
  if (eligible.length === 0) return [];
  const lowView = eligible.filter((v) => {
    const views = Number(v?.totalViews ?? v?.views ?? v?.views_count ?? 0);
    return views >= 0 && views < 500;
  });
  // Strict band first; if it can't satisfy `count`, fall back to the
  // full eligible pool so the grid still fills.
  const source = lowView.length >= count ? lowView : eligible;
  // Fisher–Yates-ish shuffle (cheap, fine for ~200 rows).
  const shuffled = source.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
};

// Layout constants — 5pt outer padding on each side and a 4pt gap
// between columns. Centralized here so the cardWidth math, the
// columnWrapperStyle, and the skeleton all stay in sync. Tight
// values to maximize thumbnail size on the See All grid.
const HORIZONTAL_PADDING = 5;
const COLUMN_GAP = 4;

// Skeleton card — fixed-aspect placeholder that matches VideoCardNew's
// thumbnail dimensions so the grid doesn't reflow when real data
// lands. Background pulse-animates via opacity for a "loading" feel
// without bringing in a heavy shimmer library.
const SkeletonCard = ({ width, height, theme }) => (
  <View
    style={{
      width,
      marginBottom: 16,
    }}
  >
    <View
      style={{
        width: "100%",
        height,
        borderRadius: 8,
        backgroundColor: theme.surfaceMuted,
        opacity: 0.6,
      }}
    />
    <View
      style={{
        marginTop: 8,
        height: 12,
        width: "85%",
        borderRadius: 4,
        backgroundColor: theme.surfaceMuted,
        opacity: 0.5,
      }}
    />
    <View
      style={{
        marginTop: 6,
        height: 10,
        width: "55%",
        borderRadius: 4,
        backgroundColor: theme.surfaceMuted,
        opacity: 0.4,
      }}
    />
  </View>
);

const ShelfAllScreen = () => {
  const { theme } = useAppTheme();
  const { user } = useGlobalContext();
  const params = useLocalSearchParams();
  const shelfType = typeof params.type === "string" ? params.type : null;
  const config = shelfType ? SHELF_CONFIG[shelfType] : null;

  const { width } = useWindowDimensions();
  // 2-column grid: outer padding HORIZONTAL_PADDING on each side plus a
  // COLUMN_GAP gutter between the two cards. Both come from the
  // constants above so the FlatList columnWrapperStyle below uses the
  // exact same numbers.
  const cardWidth = useMemo(
    () => Math.floor((width - HORIZONTAL_PADDING * 2 - COLUMN_GAP) / 2),
    [width],
  );
  // Thumbnail aspect — 0.56 targets a ~182×102pt thumbnail on the
  // 393pt-wide iPhone class (iPhone 14/15/16 Pro). With the current
  // 5pt edge + 4pt center padding the actual cardWidth lands at
  // ~189pt, so the rendered thumbnail is ~189×106pt.
  const cardHeight = useMemo(() => Math.floor(cardWidth * 0.56), [cardWidth]);

  // Pull the persisted bucket from Redux for the instant paint. Even
  // if the user landed on this screen cold, the bucket is hydrated
  // from MMKV by redux-persist before first render. `flatten` handles
  // shelves whose persisted shape is a 2D column-chunked array
  // (currently just suggestedForYou).
  const cachedItems = useSelector((state) => {
    if (!config?.bucket) return [];
    const arr = state?.videos?.[config.bucket];
    if (!Array.isArray(arr)) return [];
    return config.flatten ? arr.flat() : arr;
  });

  // Pool for the low-engagement filler — the persisted baseVideos
  // pool that videos.jsx already builds on cache hydrate. Up to ~200
  // unique videos, refreshed every 12h or on pull-to-refresh.
  const baseVideos = useSelector((state) => state?.videos?.baseVideos);

  const [items, setItems] = useState(cachedItems);
  // Loading is only true on FIRST mount when we have NOTHING cached
  // AND there's a refetch to attempt. The cached path paints
  // instantly; the refetch happens in the background.
  const [loading, setLoading] = useState(cachedItems.length === 0 && Boolean(config?.refetch));

  // Background re-fetch for server-driven shelves — gets a bigger
  // page than the home shelf cached. Failures fall back to the
  // cached bucket so the user always sees something.
  useEffect(() => {
    if (!config?.refetch) return;
    if (!user?.$id) return;
    let cancelled = false;
    (async () => {
      try {
        const fresh = await config.refetch({ userId: user.$id });
        if (cancelled) return;
        if (Array.isArray(fresh) && fresh.length > 0) {
          setItems(fresh);
        }
      } catch (err) {
        if (__DEV__) console.log("[shelf-all] refetch error:", err?.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, user?.$id]);

  // Top the grid up to TARGET_GRID_SIZE with low-engagement filler
  // when the primary source returns less. Memoized on items + the
  // baseVideos identity so the filler only re-rolls when data
  // actually changes (not on every render). The slice() at the end
  // hard-caps at TARGET_GRID_SIZE — guards against a refetch that
  // somehow over-delivers (shouldn't happen but cheap to enforce).
  const displayItems = useMemo(() => {
    const safe = Array.isArray(items) ? items : [];
    if (safe.length >= TARGET_GRID_SIZE) return safe.slice(0, TARGET_GRID_SIZE);
    const need = TARGET_GRID_SIZE - safe.length;
    const ids = safe.map((v) => v?.$id || v?.id).filter(Boolean);
    const filler = pickLowEngagementFiller(baseVideos || [], ids, need);
    return [...safe, ...filler].slice(0, TARGET_GRID_SIZE);
  }, [items, baseVideos]);

  const renderItem = useCallback(
    ({ item }) => (
      <View style={{ width: cardWidth, marginBottom: 16 }}>
        <VideoCardNew item={item} customWidth={cardWidth} customHeight={cardHeight} customAvatarSize={28} customFontSize={12} />
      </View>
    ),
    [cardWidth, cardHeight],
  );

  const keyExtractor = useCallback((item, index) => item?.$id || item?.id || `v-${index}`, []);

  // ── Header ────────────────────────────────────────────────────────
  const renderHeader = () => (
    <View
      className="flex-row items-center px-4 pb-3 pt-2"
      style={{ borderBottomWidth: 0.5, borderBottomColor: theme.divider, backgroundColor: theme.background }}
    >
      <TouchableOpacity
        onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/videos"))}
        className="h-10 w-10 items-center justify-center rounded-full"
        style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
      >
        <MaterialIcons name="arrow-back" size={20} color={theme.icon} />
      </TouchableOpacity>
      <Text className="ml-3 flex-1 font-pbold text-lg" style={{ color: theme.text }} numberOfLines={1}>
        {config?.title || "Videos"}
      </Text>
    </View>
  );

  // ── Bad type — bail with a clear message rather than a blank ──────
  if (!config) {
    return (
      <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
        {renderHeader()}
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-base" style={{ color: theme.textSoft }}>
            Unknown shelf type.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Skeleton state — only when truly empty + first load ───────────
  if (loading && displayItems.length === 0) {
    return (
      <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
        {renderHeader()}
        <FlatList
          data={[0, 1, 2, 3, 4, 5, 6, 7]}
          numColumns={2}
          keyExtractor={(n) => `skel-${n}`}
          columnWrapperStyle={{ paddingHorizontal: HORIZONTAL_PADDING, gap: COLUMN_GAP }}
          contentContainerStyle={{ paddingTop: 12, paddingBottom: 60 }}
          renderItem={() => <SkeletonCard width={cardWidth} height={cardHeight} theme={theme} />}
        />
      </SafeAreaView>
    );
  }

  // ── Empty state ───────────────────────────────────────────────────
  // Genuinely empty = nothing in the primary source AND no filler
  // available from baseVideos. Should be very rare in practice (the
  // base pool is built on every videos-tab cache hydrate).
  if (displayItems.length === 0) {
    return (
      <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
        {renderHeader()}
        <View className="flex-1 items-center justify-center px-6">
          <MaterialIcons name="video-library" size={48} color={theme.iconMuted} />
          <Text className="mt-3 text-center text-base font-pbold" style={{ color: theme.text }}>
            Nothing here yet
          </Text>
          <Text className="mt-1 text-center text-sm" style={{ color: theme.textSoft }}>
            New videos will appear in this shelf as they meet the criteria.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Loaded grid ───────────────────────────────────────────────────
  return (
    <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
      {renderHeader()}
      <FlatList
        data={displayItems}
        numColumns={2}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        columnWrapperStyle={{ paddingHorizontal: HORIZONTAL_PADDING, gap: COLUMN_GAP }}
        contentContainerStyle={{ paddingTop: 12, paddingBottom: 60 }}
        showsVerticalScrollIndicator={false}
        ListFooterComponent={
          loading ? (
            <View style={{ paddingVertical: 16, alignItems: "center" }}>
              <ActivityIndicator color={theme.primary} />
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
};

export default ShelfAllScreen;
