import { FlashList } from "@shopify/flash-list";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dimensions, RefreshControl, Text, TouchableOpacity, View } from "react-native";
import PagerView from "react-native-pager-view";
import { useDispatch, useSelector } from "react-redux";
import {
  MainScreensHeader,
  StyledSafeAreaView,
  VideoCardNew,
  VideosBecauseYouWatched,
  VideosBingeWorthy,
  VideosContinueWatching,
  VideosFromFollowing,
  VideosFromYourFollowers,
  VideosHiddenGems,
  VideosLatest,
  VideosMostPeopleWant,
  VideosPopularInYourArea,
  VideosQuickPicks,
  VideosRisingCreators,
  VideosSectionsSkeleton,
  VideosSuggestedForYou,
  VideosTrendingWeek,
  VideosUnderratedForYou,
  VideosYouMightLike,
} from "../../components";
import VideosDownload from "../../components/VideosDownload";
import VideosPlaylist from "../../components/VideosPlaylist";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
// Phase E.10 — tier-tuned FlashList window for the Videos tab.
import { getFlashListConfig } from "../../lib/device-tier";

const { height: VIDEOS_SCREEN_HEIGHT } = Dimensions.get("window");
import useResetOnBlur from "../../hooks/useResetOnBlur";
import { ShuffleVideos } from "../../lib/appwrite";
import { FollowService } from "../../lib/follows";
import { listBlockedUsers } from "../../lib/safety";
import tabNavigationEvents from "../../lib/tab-navigation-events";
import {
  VideosService,
  fetchBecauseYouWatched,
  fetchContinueWatching,
  fetchFromYourFollowers,
  fetchRisingCreators,
} from "../../lib/video";
import { setVideosCache } from "../../store/reducers/videos";
import {
  AUDIOBOOK_SECTIONS_CACHE_VERSION,
  AUDIOBOOK_VIDEOS_LIMIT,
  fetchAudiobookVideosForSectionLimit,
  getAudiobookSections,
} from "../../utils/audiobookVideoSections";

const FROM_FOLLOWING_CACHE_VERSION = 3;
const FROM_FOLLOWING_CREATORS_LIMIT = 60;
const FROM_FOLLOWING_TOTAL_LIMIT = 30;
// Hard kill-switch for the persisted videos cache. Bump this whenever a
// schema or data change makes existing cached objects misleading. Any
// previously-stored cache without a matching version is treated as stale
// and forces a refetch on the next mount.
//
// History:
//   1 — initial (implicit, never stamped)
//   2 — May 2026: monetization mapper expanded (is_monetized,
//       monetization_enabled, unlock_cost_coins/_stars) + duration
//       backfill from Bunny Stream populated 99.85% of the catalog.
//       Old cached objects had monetization_enabled undefined and
//       duration:0 — both invisible to the heuristic checks if the
//       first cached video happened to be the one healthy outlier.
// v3: bulk-flip of old library 541939 videos to is_monetized=true. Forces
// home-tab card cache to refresh so the lock pill / paid badge reflects
// the new monetization state without waiting on the 12h TTL.
// v4: 15-section expansion — added quickPicks / hiddenGems /
// underratedForYou / bingeWorthy buckets to the persisted cache shape.
// Pre-v4 caches don't have these fields; without the bump the new
// shelves would render empty until the 12h TTL elapsed.
// v5: cross-shelf dedup. Each shelf now claims its videos against a
// shared usedIds set so the same thumbnail can't appear in two
// shelves on the same screen. Pre-v5 caches stored buckets that
// overlap each other; bump forces a fresh fetch so the deduped
// slices land on user devices.
// v6: dedup goes from hard to soft. Audiobook sections (mostPeopleWant
// / suggestedForYou) can each claim up to 100 videos and they
// frequently overlap with the general baseVideos pool, leaving the
// bottom client shelves (YouMightLike, PopularInYourArea, Latest)
// empty. Soft fill prefers un-claimed videos but tops up from the
// full pool when un-claimed runs dry, so every shelf gets content.
// Bump forces re-fetch so v5-deduped (potentially empty) buckets
// don't linger.
// v7: 15-shelf rollout — adds risingCreators, becauseYouWatched
// (+ anchor), fromYourFollowers buckets backed by the
// migration_video_shelves_v4 RPCs, plus real Continue Watching.
// Pre-v7 caches don't have these fields; without the bump the new
// shelves render empty until the 12h TTL elapses.
// v8: profile hydration. The 4 v4 RPCs returned bare videos rows
// without joined uploader profiles, so cards rendered as "Unknown"
// with "?" avatar. Added hydrateUploaderProfiles bulk-fetch in the
// fetchers; bump invalidates pre-v8 caches that captured the
// Unknown-uploader rows.
const BASE_VIDEOS_DATA_VERSION = 8;
const SECTION_SPACING = 5;
const LIST_PADDING_BOTTOM = 60;
const LIST_PADDING_TOP = 12;
const TAB_TITLES = ["For You", "Playlist", "Downloads"];

// Section height estimate for FlashList. Most carousels render at ~330–360 px,
// Category sections (rows of 2) at ~600–700 px. 420 splits the difference and
// keeps FlashList's drawDistance budget honest. Wrong estimates here are the
// classic cause of "white-on-fast-scroll" because the recycler can't predict
// where the next cell will land.
const SECTION_ESTIMATED_HEIGHT = 420;
const SectionSeparator = () => <View style={{ height: SECTION_SPACING }} />;

const chunkArray = (array, chunkSize) => {
  const result = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    result.push(array.slice(i, i + chunkSize));
  }
  return result;
};

// Categorized video sections were removed pending the YouTube-style
// grouping rebuild. The previous SORTED_CATEGORIES app_config-driven
// flow was deleted along with VideosPerCategory + VideosPerCategory
// state. When the new grouping ships, restore here.
// ─── Section-derivation helpers ──────────────────────────────────────────
// All four pull from the same `baseVideos` pool the rest of the shelves
// use, so they're cheap to compute (no extra RPCs) and naturally rotate
// as the pool refreshes / reshuffles. Each returns `null` when the
// signal is too weak to populate a meaningful shelf — the section
// component bails early on empty arrays so an empty shelf never paints.

// Quick Picks: short videos under ~60s. Easy to finish in a doom-
// scroll session. The 90s upper bound gives buffer for slightly-over
// shorts (intro card etc.) without leaking 5-minute videos in.
const buildQuickPicks = (pool = []) => {
  const QUICK_MAX_SECONDS = 90;
  const candidates = pool.filter((v) => {
    const d = Number(v?.duration);
    return Number.isFinite(d) && d > 0 && d <= QUICK_MAX_SECONDS;
  });
  return ShuffleVideos(candidates).slice(0, 30);
};

// Hidden Gems: low-view-count videos with notable engagement signals.
// Two-tier filter so the shelf populates even with sparse engagement
// data on a small catalog:
//   1. Strict band — views < 500 AND (likes+comments)/views >= 5%.
//      Strong "underrated" signal, ideal once catalog matures.
//   2. Fallback band — same view ceiling, any engagement (or even
//      none). Used only when the strict band is too thin (<12 rows).
// On a fresh / sparse catalog the strict band typically returns 0
// rows because most videos have 0 likes; the fallback ensures the
// shelf still renders. As real engagement accumulates, strict
// dominates organically.
const buildHiddenGems = (pool = []) => {
  const VIEWS_MAX = 500;
  const ENGAGEMENT_MIN = 0.05;
  const lowView = pool.filter((v) => {
    const views = Number(v?.totalViews ?? v?.views ?? 0);
    return views >= 0 && views < VIEWS_MAX;
  });
  const strict = lowView.filter((v) => {
    const views = Number(v?.totalViews ?? v?.views ?? 0);
    const likes = Number(v?.totalLikes ?? v?.likes_count ?? 0);
    const comments = Number(v?.totalComments ?? v?.comments_count ?? 0);
    if (views === 0) return likes + comments > 0;
    return (likes + comments) / Math.max(views, 1) >= ENGAGEMENT_MIN;
  });
  const final = strict.length >= 12 ? strict : lowView;
  return ShuffleVideos(final).slice(0, 30);
};

// Underrated For You: low-view videos whose tags overlap with the
// user's recently watched content. Falls back to a random low-view
// slice when we don't yet have a watch profile (new users / cold
// cache) so the shelf isn't blank on first open.
const buildUnderratedForYou = (pool = [], recentTags = []) => {
  const VIEWS_MAX = 1000;
  const lowView = pool.filter((v) => {
    const views = Number(v?.totalViews ?? v?.views ?? 0);
    return views >= 0 && views <= VIEWS_MAX;
  });
  if (recentTags.length === 0) return ShuffleVideos(lowView).slice(0, 30);
  const tagSet = new Set(recentTags.map((t) => String(t).toLowerCase()));
  const tagged = lowView.filter((v) => {
    const tags = Array.isArray(v?.tags) ? v.tags : [];
    return tags.some((t) => tagSet.has(String(t).toLowerCase()));
  });
  // If the personalized cut is too thin, top up with random low-view
  // candidates so the shelf still fills.
  if (tagged.length >= 12) return ShuffleVideos(tagged).slice(0, 30);
  const fillerNeeded = 30 - tagged.length;
  const filler = ShuffleVideos(lowView.filter((v) => !tagged.includes(v))).slice(0, fillerNeeded);
  return [...tagged, ...filler];
};

// Binge-Worthy: groups videos by shared tags as a proxy for "series"
// or "parts" until a real `series_id` column lands. We score each
// video by how many other videos share its primary tag, then surface
// the densest clusters first. Single-tag videos don't qualify
// (a series implies at least one other entry).
const buildBingeWorthy = (pool = []) => {
  // Tag → count map, normalized to lowercase.
  const tagCounts = new Map();
  pool.forEach((v) => {
    const tags = Array.isArray(v?.tags) ? v.tags : [];
    tags.forEach((t) => {
      const key = String(t).toLowerCase();
      tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
    });
  });
  const candidates = pool.filter((v) => {
    const tags = Array.isArray(v?.tags) ? v.tags : [];
    return tags.some((t) => (tagCounts.get(String(t).toLowerCase()) || 0) >= 3);
  });
  return ShuffleVideos(candidates).slice(0, 30);
};

const getRandomOffset = (total, limit) => {
  if (!total || total <= limit) return 0;
  const maxOffset = Math.max(0, total - limit);
  return Math.floor(Math.random() * (maxOffset + 1));
};

const mergeUniqueVideos = (videos = []) => {
  const seen = new Set();
  const result = [];
  videos.forEach((video) => {
    const key = video?.$id || video?.id || video?.uri;
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(video);
  });
  return result;
};

const resolveOwnerId = (video) =>
  video?.uploader?.$id || video?.uploader?.id || video?.creatorId || video?.userId || video?.ownerId || video?.uploaderId || null;

const resolveFollowingId = (follow) => {
  const id =
    follow?.followingId?.$id ||
    follow?.followingId?.id ||
    follow?.followingId ||
    follow?.following?.$id ||
    follow?.following?.id ||
    follow?.following ||
    null;

  return typeof id === "string" ? id : null;
};

const getDocuments = (response) => {
  if (Array.isArray(response)) return response;
  return Array.isArray(response?.documents) ? response.documents : [];
};

const Videos = () => {
  const { theme } = useAppTheme();
  const { width } = Dimensions.get("window");
  const { allVideos, setAllVideos, user } = useGlobalContext();
  const dispatch = useDispatch();
  const { globalSettings } = useSelector((state) => state.app);
  const videosCache = useSelector((state) => state.videos);
  const videosServiceRef = useRef(new VideosService());
  const [videosLoading, setVideosLoading] = useState(true);
  const [videosSections, setVideosSections] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  // Phase E.10 — tier-tuned FlashList window. Memoized so prop identity
  // is stable across re-renders (FlashList re-lays-out on prop changes).
  const flashListConfig = useMemo(() => getFlashListConfig({ screenHeight: VIDEOS_SCREEN_HEIGHT }), []);
  useResetOnBlur(setRefreshing);
  const [mostPeopleWant, setMostPeopleWant] = useState([]);
  const [fromFollowing, setFromFollowing] = useState([]);
  const [suggestedForYou, setSuggestedForYou] = useState([]);
  const [continueWatching, setContinueWatching] = useState([]);
  const [trendingWeek, setTrendingWeek] = useState([]);
  const [youMightLike, setYouMightLike] = useState([]);
  const [popularInYourArea, setPopularInYourArea] = useState([]);
  const [latestVideos, setLatestVideos] = useState([]);
  // New shelves added for the 15-section expansion. The four
  // client-derived ones come from the baseVideos pool with custom
  // filters; the four server-driven ones below come from dedicated
  // RPCs (feed_continue_watching / feed_rising_creators /
  // feed_because_you_watched / feed_from_your_followers).
  const [quickPicks, setQuickPicks] = useState([]);
  const [hiddenGems, setHiddenGems] = useState([]);
  const [underratedForYou, setUnderratedForYou] = useState([]);
  const [bingeWorthy, setBingeWorthy] = useState([]);
  // Server-driven shelves
  const [risingCreators, setRisingCreators] = useState([]);
  const [becauseYouWatched, setBecauseYouWatched] = useState([]);
  const [becauseYouWatchedAnchor, setBecauseYouWatchedAnchor] = useState(null);
  const [fromYourFollowers, setFromYourFollowers] = useState([]);
  const [blockedUserIds, setBlockedUserIds] = useState([]);
  const [activePage, setActivePage] = useState(0);
  const flatListRef = useRef(null);
  const lastScrollY = useRef(0);
  const navHiddenRef = useRef(false);
  const pagerRef = useRef(null);
  const activePageRef = useRef(activePage);
  const filterBlocked = useCallback(
    (items = []) => {
      if (!blockedUserIds.length) return items;
      return items.filter((v) => !blockedUserIds.includes(resolveOwnerId(v)));
    },
    [blockedUserIds],
  );

  useEffect(() => {
    // Section ordering — fixed shelves with the v4 expansion (15
    // total when fully rolled out; the 4 newly-added shelves below
    // are interleaved between the existing eight to break up the
    // visual cadence rather than concatenated at the bottom).
    //
    // Server-side-only shelves Rising Creators / Because You
    // Watched X / From Your Followers are deferred — they need new
    // RPCs (follower velocity, watch-history co-occurrence, friend
    // graph fan-in respectively). Slot them in here when the RPCs
    // ship; the rest of the order stays unchanged.
    //
    // Each shelf bails to null at render-time when its candidate
    // pool is empty, so a sparse catalog doesn't paint a wall of
    // empty headers — the user just sees the shelves that have
    // content.
    //
    // Rotation: ordering is fixed but the videos *within* each
    // shelf are reshuffled on every cache hydrate (see useEffect
    // around line 444), so the user perceives a different feed on
    // every app open even when the same baseline is cached.
    const sections = [
      { type: "MostPeopleWant" },
      { type: "VideosFromFollowing" },
      { type: "SuggestedForYou" },
      { type: "ContinueWatching" },
      { type: "RisingCreators" },
      { type: "BecauseYouWatched" },
      { type: "FromYourFollowers" },
      { type: "TrendingWeek" },
      { type: "QuickPicks" },
      { type: "YouMightLike" },
      { type: "HiddenGems" },
      { type: "PopularInYourArea" },
      { type: "BingeWorthy" },
      { type: "UnderratedForYou" },
      { type: "Latest" },
    ];
    setVideosSections(sections);
  }, [globalSettings]);

  const loadVideosData = useCallback(
    async ({ showLoader = true } = {}) => {
      try {
        if (showLoader) setVideosLoading(true);
        const videoLimit = Number(globalSettings?.["LIMIT_VIDEOS_PER_CATEGORY"]);
        const resolvedSectionLimit = Number.isFinite(videoLimit) && videoLimit > 0 ? videoLimit : AUDIOBOOK_VIDEOS_LIMIT;
        const service = videosServiceRef.current;

        // Larger pool — 100 latest + up to 100 random offset = up to 200
        // unique videos. With 12 shelves capped at 15 videos each, the
        // dedup math works out: 12 × 15 = 180 ≤ 200. Without this bump
        // the early shelves consumed the entire pool and the bottom
        // ones (YouMightLike / PopularInYourArea / Latest) rendered
        // empty.
        const baseVideosPromise = service.fetchVideos({ limit: 100, status: "published" });
        const audiobookVideosPromise = fetchAudiobookVideosForSectionLimit({
          videosService: service,
          sectionLimit: resolvedSectionLimit,
          filterVideos: filterBlocked,
        });
        const fromFollowingPromise = (async () => {
          try {
            if (!user?.$id) return [];

            const followingResponse = await FollowService.getFollowing({ userId: user.$id, limit: FROM_FOLLOWING_CREATORS_LIMIT });
            const followingIds = [
              ...new Set(
                getDocuments(followingResponse)
                  .map(resolveFollowingId)
                  .filter(Boolean)
                  .filter((id) => id !== user.$id && !blockedUserIds.includes(id)),
              ),
            ];

            if (followingIds.length === 0) return [];

            const response = await service.fetchVideos({
              userId: followingIds,
              limit: FROM_FOLLOWING_TOTAL_LIMIT,
              status: "published",
            });
            return filterBlocked(response?.documents || []);
          } catch (error) {
            console.error("fromFollowing videos error", error);
            return [];
          }
        })();
        // Server-driven shelves added with v6/v7 — fired in parallel
        // with the existing fetches so they don't block first paint.
        // Each is best-effort: on failure or empty result, the shelf
        // bails to null at render-time and we skip the section.
        const continueWatchingRpcPromise = user?.$id
          ? fetchContinueWatching({ userId: user.$id, limit: 30 }).catch(() => [])
          : Promise.resolve([]);
        const risingCreatorsPromise = user?.$id
          ? fetchRisingCreators({ userId: user.$id, limit: 20 }).catch(() => [])
          : Promise.resolve([]);
        const becauseYouWatchedPromise = user?.$id
          ? fetchBecauseYouWatched({ userId: user.$id, limit: 20 }).catch(() => ({ anchor: null, recommendations: [] }))
          : Promise.resolve({ anchor: null, recommendations: [] });
        const fromYourFollowersPromise = user?.$id
          ? fetchFromYourFollowers({ userId: user.$id, limit: 20 }).catch(() => [])
          : Promise.resolve([]);

        const [
          baseVideosResponse,
          audiobookVideosResponse,
          fromFollowingVideos,
          continueWatchingFromRpc,
          risingCreatorsFromRpc,
          becauseYouWatchedFromRpc,
          fromYourFollowersFromRpc,
        ] = await Promise.all([
          baseVideosPromise,
          audiobookVideosPromise,
          fromFollowingPromise,
          continueWatchingRpcPromise,
          risingCreatorsPromise,
          becauseYouWatchedPromise,
          fromYourFollowersPromise,
        ]);
        const latestBaseVideos = baseVideosResponse?.documents || [];
        const baseTotal = baseVideosResponse?.total ?? 0;
        const baseOffset = getRandomOffset(baseTotal, 100);
        const randomBaseResponse = baseOffset > 0 ? await service.fetchVideos({ limit: 100, status: "published", offset: baseOffset }) : null;
        const mergedBase = mergeUniqueVideos([...(latestBaseVideos || []), ...(randomBaseResponse?.documents || [])]);
        const baseVideos = filterBlocked(mergedBase);
        const audiobookVideos = audiobookVideosResponse || [];
        const audiobookSections = getAudiobookSections(audiobookVideos, resolvedSectionLimit);
        const latestVideosFiltered = filterBlocked(latestBaseVideos || []);

        const searchableVideos = mergeUniqueVideos([...baseVideos, ...audiobookVideos, ...fromFollowingVideos]);

        // Recent-tag profile feeds the Underrated For You filter. We
        // approximate "what the user has been watching" with the
        // tag-set of the continueWatching slice (the most recent
        // chronological pool we have client-side without a dedicated
        // watch_history table). Empty profile is fine — the helper
        // falls back to a random low-view slice.
        const recentTagsForUnderrated = Array.from(
          new Set(
            baseVideos
              .slice(0, 30)
              .flatMap((v) => (Array.isArray(v?.tags) ? v.tags : []))
              .map((t) => String(t).toLowerCase())
              .filter(Boolean),
          ),
        );

        // ─── Cross-shelf dedup ──────────────────────────────────────
        // Without this, every client-derived shelf samples the same
        // baseVideos pool and ends up showing the same handful of
        // top-ranked videos in TrendingWeek + YouMightLike +
        // PopularInYourArea + Latest. The user perception is
        // "I'm seeing the same thumbnails everywhere."
        //
        // Strategy: process shelves in priority order, accumulate a
        // set of claimed ids, and have each subsequent shelf exclude
        // anything already claimed. Server-curated shelves
        // (mostPeopleWant, fromFollowing, suggestedForYou) get first
        // pick because they're the personalized signals; client
        // shuffles fill what's left.
        const usedIds = new Set();
        const claimVideos = (videos) => {
          if (Array.isArray(videos)) {
            for (const v of videos) {
              const id = v?.$id || v?.id;
              if (id) usedIds.add(id);
            }
          }
          return videos;
        };
        const excludeUsed = (videos) =>
          (videos || []).filter((v) => {
            const id = v?.$id || v?.id;
            return id && !usedIds.has(id);
          });

        // Per-shelf cap. Soft-dedup means each shelf prefers
        // un-claimed videos but can fall back to the full baseVideos
        // pool if exhaustion would otherwise leave the shelf empty.
        // The user's "no duplicates" rule is enforced as best-effort:
        // when the pool genuinely runs dry, showing a near-duplicate
        // beats showing an empty shelf.
        const PER_SHELF = 15;

        // Soft fill: take `size` from `unclaimedShuffled` if possible,
        // otherwise top up from `fullPoolShuffled` (which may include
        // already-claimed videos). Returns a deduped result against
        // its OWN list (no within-shelf duplicates) but allows
        // overlap with earlier shelves once the un-claimed pool runs
        // out. Always claims its result so subsequent shelves see
        // these as "used".
        const softFill = (size, unclaimedShuffled, fullPoolShuffled) => {
          const result = [];
          const seen = new Set();
          const push = (v) => {
            const id = v?.$id || v?.id;
            if (!id || seen.has(id)) return;
            seen.add(id);
            result.push(v);
          };
          for (const v of unclaimedShuffled) {
            if (result.length >= size) break;
            push(v);
          }
          if (result.length < size) {
            for (const v of fullPoolShuffled || []) {
              if (result.length >= size) break;
              push(v);
            }
          }
          return claimVideos(result);
        };

        // Tier 1: claim from server-curated / personalized shelves.
        // These pull from their own fetches (audiobook tag, follow
        // graph, dedicated RPCs) so their videos OFTEN overlap with
        // the general baseVideos pool. By claiming first, we ensure
        // the personalized shelves take precedence — a video tagged
        // "audiobook" that's also in baseVideos appears in
        // MostPeopleWant rather than TrendingWeek. Same precedence
        // logic applies to the four server-driven shelves.
        const mostPeopleWantSlice  = claimVideos(audiobookSections.mostPeopleWant);
        const fromFollowingSlice   = claimVideos(fromFollowingVideos);
        const suggestedForYouSlice = claimVideos(audiobookSections.suggestedForYou);
        // Continue Watching — real data from the v4 RPC. Empty array
        // is the right default for users with no watch progress yet;
        // the section component bails to null on empty.
        const continueWatchingSlice = claimVideos(filterBlocked(continueWatchingFromRpc || []));
        const risingCreatorsSlice = claimVideos(filterBlocked(risingCreatorsFromRpc || []));
        const becauseRecsSlice    = claimVideos(filterBlocked(becauseYouWatchedFromRpc?.recommendations || []));
        const becauseAnchor       = becauseYouWatchedFromRpc?.anchor || null;
        const fromYourFollowersSlice = claimVideos(filterBlocked(fromYourFollowersFromRpc || []));

        // Tier 2: client-derived shelves with soft dedup.
        const trendingWeekSlice    = softFill(PER_SHELF, ShuffleVideos(excludeUsed(baseVideos)), ShuffleVideos(baseVideos));
        const quickPicksSlice      = softFill(PER_SHELF, buildQuickPicks(excludeUsed(baseVideos)), buildQuickPicks(baseVideos));
        const youMightLikeSlice    = softFill(PER_SHELF, ShuffleVideos(excludeUsed(baseVideos)), ShuffleVideos(baseVideos));
        const hiddenGemsSlice      = softFill(PER_SHELF, buildHiddenGems(excludeUsed(baseVideos)), buildHiddenGems(baseVideos));
        const popularInAreaSlice   = softFill(PER_SHELF, ShuffleVideos(excludeUsed(baseVideos)), ShuffleVideos(baseVideos));
        const bingeWorthySlice     = softFill(PER_SHELF, buildBingeWorthy(excludeUsed(baseVideos)), buildBingeWorthy(baseVideos));
        const underratedSlice      = softFill(
          PER_SHELF,
          buildUnderratedForYou(excludeUsed(baseVideos), recentTagsForUnderrated),
          buildUnderratedForYou(baseVideos, recentTagsForUnderrated),
        );
        const latestSlice          = softFill(PER_SHELF, excludeUsed(latestVideosFiltered), latestVideosFiltered);

        const payload = {
          baseVideos: searchableVideos,
          baseVideosDataVersion: BASE_VIDEOS_DATA_VERSION,
          audiobookSectionsCacheVersion: AUDIOBOOK_SECTIONS_CACHE_VERSION,
          audiobookSectionsLimit: resolvedSectionLimit,
          mostPeopleWant: mostPeopleWantSlice,
          fromFollowing: fromFollowingSlice,
          fromFollowingCacheVersion: FROM_FOLLOWING_CACHE_VERSION,
          fromFollowingUserId: user?.$id || null,
          suggestedForYou: suggestedForYouSlice,
          continueWatching: continueWatchingSlice,
          trendingWeek: trendingWeekSlice,
          youMightLike: youMightLikeSlice,
          popularInYourArea: popularInAreaSlice,
          latestVideos: latestSlice,
          quickPicks: quickPicksSlice,
          hiddenGems: hiddenGemsSlice,
          underratedForYou: underratedSlice,
          bingeWorthy: bingeWorthySlice,
          // Server-driven shelves
          risingCreators: risingCreatorsSlice,
          becauseYouWatched: becauseRecsSlice,
          becauseYouWatchedAnchor: becauseAnchor,
          fromYourFollowers: fromYourFollowersSlice,
          lastFetchedAt: Date.now(),
        };

        setAllVideos(payload.baseVideos);
        setMostPeopleWant(payload.mostPeopleWant);
        setFromFollowing(payload.fromFollowing);
        setSuggestedForYou(payload.suggestedForYou);
        setContinueWatching(payload.continueWatching);
        setTrendingWeek(payload.trendingWeek);
        setYouMightLike(payload.youMightLike);
        setPopularInYourArea(payload.popularInYourArea);
        setLatestVideos(payload.latestVideos);
        setQuickPicks(payload.quickPicks);
        setHiddenGems(payload.hiddenGems);
        setUnderratedForYou(payload.underratedForYou);
        setBingeWorthy(payload.bingeWorthy);
        setRisingCreators(payload.risingCreators);
        setBecauseYouWatched(payload.becauseYouWatched);
        setBecauseYouWatchedAnchor(payload.becauseYouWatchedAnchor);
        setFromYourFollowers(payload.fromYourFollowers);
        dispatch(setVideosCache(payload));
      } catch (error) {
        console.error("loadVideosData error", error);
      } finally {
        setVideosLoading(false);
      }
    },
    [blockedUserIds, dispatch, filterBlocked, globalSettings, setAllVideos, user?.$id],
  );

  useEffect(() => {
    const now = Date.now();
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;
    const hasCache = (videosCache?.baseVideos || []).length > 0;
    const isStale = !videosCache?.lastFetchedAt || now - videosCache.lastFetchedAt > TWELVE_HOURS;
    // Cache-staleness check has three layers (any one triggers refetch):
    //
    //   1. HARD VERSION KILL-SWITCH — the most reliable. If the persisted
    //      cache's stored version doesn't match BASE_VIDEOS_DATA_VERSION
    //      defined at the top of this file, treat as stale unconditionally.
    //      Bump the constant whenever data shape/values change in a way
    //      that makes existing cached objects misleading.
    //
    //   2. Schema shape — first cached video missing `monetization_enabled`
    //      means the whole cache predates the mapper fix.
    //
    //   3. Duration data — after the duration backfill, cached objects with
    //      duration:0 are stale. Sample first 10; if >70% have duration:0,
    //      cache is from the pre-backfill era.
    //
    // Self-healing: once the refetch lands, the new cache is stamped with
    // the current version + has fresh shape + has real durations, and
    // serves normally for the rest of the session.
    const cachedVideos = videosCache?.baseVideos || [];
    const sampleCachedVideo = cachedVideos[0];
    const cacheVersionStale = videosCache?.baseVideosDataVersion !== BASE_VIDEOS_DATA_VERSION;
    const cacheShapeStale = sampleCachedVideo && sampleCachedVideo.monetization_enabled === undefined;
    const durationSamples = cachedVideos.slice(0, 10);
    const zeroDurationCount = durationSamples.filter(
      (v) => typeof v?.duration !== "number" || v.duration <= 0,
    ).length;
    const cacheDurationStale = durationSamples.length >= 5 && zeroDurationCount > durationSamples.length * 0.7;
    const cacheNeedsRefresh = cacheVersionStale || cacheShapeStale || cacheDurationStale;
    const videoLimit = Number(globalSettings?.["LIMIT_VIDEOS_PER_CATEGORY"]);
    const resolvedSectionLimit = Number.isFinite(videoLimit) && videoLimit > 0 ? videoLimit : AUDIOBOOK_VIDEOS_LIMIT;
    const needsFromFollowingCache =
      Boolean(user?.$id) &&
      (videosCache?.fromFollowingUserId !== user.$id || videosCache?.fromFollowingCacheVersion !== FROM_FOLLOWING_CACHE_VERSION);
    const needsAudiobookSectionsCache =
      videosCache?.audiobookSectionsCacheVersion !== AUDIOBOOK_SECTIONS_CACHE_VERSION || videosCache?.audiobookSectionsLimit !== resolvedSectionLimit;

    // Hydrate from cache whenever there's data — even when the
    // cache is version-stale. Without this, bumping
    // BASE_VIDEOS_DATA_VERSION leaves the screen blank for the
    // 1-3 seconds the network refetch takes, because the early
    // return below skips the hydrate. Showing slightly-stale
    // shelves for a beat is much better UX than empty shelves;
    // loadVideosData() below overwrites them as soon as the
    // fresh fetch lands.
    if (hasCache) {
      const cachedBase = filterBlocked(videosCache.baseVideos || []);
      setAllVideos(cachedBase);

      // Mirror the same dedup logic used on fetch so re-derivations
      // from `cachedBase` don't collide with the persisted shelves.
      // Without this, QuickPicks/HiddenGems/BingeWorthy could return
      // a video already shown by the personalized shelves above.
      const usedIds = new Set();
      const claim = (videos) => {
        if (Array.isArray(videos)) {
          for (const v of videos) {
            const id = v?.$id || v?.id;
            if (id) usedIds.add(id);
          }
        }
        return videos;
      };
      const excludeUsed = (videos) =>
        (videos || []).filter((v) => {
          const id = v?.$id || v?.id;
          return id && !usedIds.has(id);
        });

      // Tier 1 — server-curated / personalized first.
      const mpw = claim(getAudiobookSections(filterBlocked(videosCache.mostPeopleWant || []), resolvedSectionLimit).mostPeopleWant);
      const ff  = claim(
        videosCache.fromFollowingUserId === user?.$id
          ? filterBlocked(videosCache.fromFollowing || []).slice(0, FROM_FOLLOWING_TOTAL_LIMIT)
          : [],
      );
      const s4y = claim(getAudiobookSections(filterBlocked((videosCache.suggestedForYou || []).flat()), resolvedSectionLimit).suggestedForYou);
      const cw  = claim(filterBlocked(videosCache.continueWatching || []));

      setMostPeopleWant(mpw);
      setFromFollowing(ff);
      setSuggestedForYou(s4y);
      setContinueWatching(cw);

      // Tier 2 — re-shuffle the persisted client shelves AND filter
      // them through usedIds so they don't reintroduce duplicates
      // from the personalized shelves. Same "fresh every open" UX
      // as before, just dedup-aware. PER_SHELF capped at 15 to match
      // loadVideosData's cap and keep the pool big enough to fill all
      // 12 shelves on a small catalog.
      const PER_SHELF = 15;
      const trending = claim(ShuffleVideos(excludeUsed(filterBlocked(videosCache.trendingWeek || []))).slice(0, PER_SHELF));
      const ymlike  = claim(ShuffleVideos(excludeUsed(filterBlocked(videosCache.youMightLike || []))).slice(0, PER_SHELF));
      const popArea = claim(ShuffleVideos(excludeUsed(filterBlocked(videosCache.popularInYourArea || []))).slice(0, PER_SHELF));
      const latest  = claim(excludeUsed(filterBlocked(videosCache.latestVideos || [])).slice(0, PER_SHELF));

      setTrendingWeek(trending);
      setYouMightLike(ymlike);
      setPopularInYourArea(popArea);
      setLatestVideos(latest);

      // Tier 3 — v4 derived shelves. Re-derive from cachedBase with
      // usedIds excluded so they always pull from the leftover pool.
      // Falls back to the persisted bucket if cachedBase is empty.
      const qp  = claim(
        (cachedBase.length
          ? buildQuickPicks(excludeUsed(cachedBase))
          : excludeUsed(filterBlocked(videosCache.quickPicks || []))
        ).slice(0, PER_SHELF),
      );
      const hg  = claim(
        (cachedBase.length
          ? buildHiddenGems(excludeUsed(cachedBase))
          : excludeUsed(filterBlocked(videosCache.hiddenGems || []))
        ).slice(0, PER_SHELF),
      );
      const bw  = claim(
        (cachedBase.length
          ? buildBingeWorthy(excludeUsed(cachedBase))
          : excludeUsed(filterBlocked(videosCache.bingeWorthy || []))
        ).slice(0, PER_SHELF),
      );
      const uf  = claim(ShuffleVideos(excludeUsed(filterBlocked(videosCache.underratedForYou || []))).slice(0, PER_SHELF));

      setQuickPicks(qp);
      setHiddenGems(hg);
      setBingeWorthy(bw);
      setUnderratedForYou(uf);

      // Server-driven shelves — hydrate from cache; the next
      // loadVideosData call will refetch fresh data anyway. We
      // claim them so subsequent client-derived re-derivations
      // exclude their videos.
      const rc  = claim(filterBlocked(videosCache.risingCreators || []));
      const byw = claim(filterBlocked(videosCache.becauseYouWatched || []));
      const fyf = claim(filterBlocked(videosCache.fromYourFollowers || []));
      setRisingCreators(rc);
      setBecauseYouWatched(byw);
      setBecauseYouWatchedAnchor(videosCache.becauseYouWatchedAnchor || null);
      setFromYourFollowers(fyf);
      setVideosLoading(false);
    }

    if (!hasCache || cacheNeedsRefresh) {
      loadVideosData({ showLoader: !hasCache });
    } else if (isStale || needsFromFollowingCache || needsAudiobookSectionsCache) {
      loadVideosData({ showLoader: false });
    }
  }, [filterBlocked, globalSettings, loadVideosData, setAllVideos, user?.$id, videosCache]);

  const refreshVideos = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadVideosData({ showLoader: false });
    } finally {
      setRefreshing(false);
    }
  }, [loadVideosData]);

  const handleScroll = (event) => {
    const y = event?.nativeEvent?.contentOffset?.y ?? 0;
    const delta = y - lastScrollY.current;

    if (y <= 0) {
      if (navHiddenRef.current) {
        navHiddenRef.current = false;
        tabNavigationEvents.emit("tabBarVisibility", { visible: true });
      }
      lastScrollY.current = y;
      return;
    }

    if (Math.abs(delta) < 6) {
      lastScrollY.current = y;
      return;
    }

    if (delta > 12 && y > 60 && !navHiddenRef.current) {
      navHiddenRef.current = true;
      tabNavigationEvents.emit("tabBarVisibility", { visible: false });
    } else if (delta < -12 && navHiddenRef.current) {
      navHiddenRef.current = false;
      tabNavigationEvents.emit("tabBarVisibility", { visible: true });
    }

    lastScrollY.current = y;
  };

  useEffect(() => {
    if (!user?.$id) return;
    listBlockedUsers({ blockerId: user.$id })
      .then((ids) => setBlockedUserIds(ids || []))
      .catch(() => {});
  }, [user?.$id]);

  useFocusEffect(
    useCallback(() => {
      navHiddenRef.current = false;
      tabNavigationEvents.emit("tabBarVisibility", { visible: true });
      return () => {
        navHiddenRef.current = false;
        tabNavigationEvents.emit("tabBarVisibility", { visible: true });
      };
    }, []),
  );

  useEffect(() => {
    const handleScrollToTop = ({ tab }) => {
      if (tab !== "videos") return;
      lastScrollY.current = 0;
      flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true });
      if (navHiddenRef.current) {
        navHiddenRef.current = false;
        tabNavigationEvents.emit("tabBarVisibility", { visible: true });
      }
    };

    tabNavigationEvents.on("scrollToTop", handleScrollToTop);
    return () => {
      tabNavigationEvents.off("scrollToTop", handleScrollToTop);
    };
  }, []);

  // Memoized so FlashList can recycle cells. Without useCallback this is a
  // fresh fn ref every render and FlashList re-mounts visible cells on any
  // parent state change — that's the white-on-scroll-down bug. Closes over
  // the section data slices directly so we don't need extraData on the list.
  const renderSection = useCallback(
    ({ item }) => {
      switch (item.type) {
        case "MostPeopleWant":
          return <VideosMostPeopleWant videos={mostPeopleWant} />;
        case "VideosFromFollowing":
          return <VideosFromFollowing videos={fromFollowing} />;
        case "SuggestedForYou":
          return <VideosSuggestedForYou videos={suggestedForYou} />;
        case "ContinueWatching":
          return <VideosContinueWatching videos={continueWatching} />;
        case "TrendingWeek":
          return <VideosTrendingWeek videos={trendingWeek} />;
        case "YouMightLike":
          return <VideosYouMightLike videos={youMightLike} />;
        case "PopularInYourArea":
          return <VideosPopularInYourArea videos={popularInYourArea} />;
        case "QuickPicks":
          return <VideosQuickPicks videos={quickPicks} />;
        case "HiddenGems":
          return <VideosHiddenGems videos={hiddenGems} />;
        case "UnderratedForYou":
          return <VideosUnderratedForYou videos={underratedForYou} />;
        case "BingeWorthy":
          return <VideosBingeWorthy videos={bingeWorthy} />;
        case "RisingCreators":
          return <VideosRisingCreators videos={risingCreators} />;
        case "BecauseYouWatched":
          return <VideosBecauseYouWatched videos={becauseYouWatched} anchor={becauseYouWatchedAnchor} />;
        case "FromYourFollowers":
          return <VideosFromYourFollowers videos={fromYourFollowers} />;
        case "Latest":
          return <VideosLatest videos={latestVideos} />;
        default:
          return <VideoCardNew item={item} customWidth={width - 32} />;
      }
    },
    [
      mostPeopleWant,
      fromFollowing,
      suggestedForYou,
      continueWatching,
      trendingWeek,
      youMightLike,
      popularInYourArea,
      latestVideos,
      quickPicks,
      hiddenGems,
      underratedForYou,
      bingeWorthy,
      risingCreators,
      becauseYouWatched,
      becauseYouWatchedAnchor,
      fromYourFollowers,
      width,
    ],
  );

  // Tells FlashList to recycle each section type into its own pool. Without
  // this, FlashList may try to reuse a Category cell (tall) for a TrendingWeek
  // cell (short) and cause a measurement+layout pass that flashes blank.
  const getItemType = useCallback((item) => item.type, []);

  const handleTabPress = (index) => {
    pagerRef.current?.setPage(index);
    setActivePage(index);
  };

  const handlePageSelected = (e) => {
    const position = e.nativeEvent.position;
    activePageRef.current = position;
    setActivePage(position);
  };

  const keyExtractor = useCallback((item, index) => `${item.type}-${item.category ?? index}`, []);

  // Show the inline skeleton only on first cold load — once we have any
  // section data ready we drop the placeholder and render the real list,
  // even if a background refresh is still running. Mirrors how the home
  // feed handles PostCardSkeleton via FlashList's ListEmptyComponent.
  const hasAnyVideoSectionData =
    mostPeopleWant.length > 0 ||
    fromFollowing.length > 0 ||
    suggestedForYou.length > 0 ||
    continueWatching.length > 0 ||
    trendingWeek.length > 0 ||
    youMightLike.length > 0 ||
    popularInYourArea.length > 0 ||
    latestVideos.length > 0;
  const showVideosSkeleton = videosLoading && !hasAnyVideoSectionData;

  return (
    <StyledSafeAreaView edges={["top"]} style={{ backgroundColor: theme.background }}>
      <View className="w-full flex-1 pb-4">
        <View className="px-4 pb-2 pt-1.5">
          <MainScreensHeader title="videos" />
        </View>
        <View className="flex-1">
          {/* Premium violet pill tabs — matches the home feed and Books tab language. */}
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10 }}>
            {TAB_TITLES.map((title, index) => {
              const isActive = activePage === index;
              return (
                <TouchableOpacity
                  key={index}
                  onPress={() => handleTabPress(index)}
                  activeOpacity={0.85}
                  style={{
                    paddingVertical: 8,
                    paddingHorizontal: 16,
                    borderRadius: 999,
                    marginRight: 6,
                    backgroundColor: isActive ? theme.primary : "transparent",
                    shadowColor: theme.primary,
                    shadowOffset: { width: 0, height: 4 },
                    shadowOpacity: isActive ? 0.25 : 0,
                    shadowRadius: 8,
                    elevation: isActive ? 3 : 0,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: isActive ? "700" : "500",
                      letterSpacing: 0.1,
                      color: isActive ? (theme.primaryContrast ?? "#ffffff") : (theme.textMuted ?? theme.text),
                    }}
                  >
                    {title}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View className="flex-1">
            <PagerView className="flex-1" initialPage={0} ref={pagerRef} onPageSelected={handlePageSelected} scrollEnabled={false}>
              <View className="h-full flex-1">
                {showVideosSkeleton ? (
                  // Inline skeleton stack during cold load — same pattern as
                  // PostCardSkeleton on the home feed and EditProfileSkeleton
                  // on settings. Replaces the previous full-screen <Loader>
                  // modal so the loading state feels native to the screen
                  // instead of a blocking overlay.
                  <VideosSectionsSkeleton count={4} />
                ) : (
                  <FlashList
                    data={videosSections}
                    renderItem={renderSection}
                    keyExtractor={keyExtractor}
                    getItemType={getItemType}
                    contentContainerStyle={{ paddingHorizontal: 12 }}
                    estimatedItemSize={SECTION_ESTIMATED_HEIGHT}
                    drawDistance={flashListConfig.drawDistance}
                    removeClippedSubviews={flashListConfig.removeClippedSubviews}
                    onEndReachedThreshold={flashListConfig.onEndReachedThreshold}
                    ItemSeparatorComponent={SectionSeparator}
                    showsVerticalScrollIndicator={false}
                    onScroll={handleScroll}
                    scrollEventThrottle={16}
                    ref={flatListRef}
                    ListFooterComponent={SectionSeparator}
                    refreshControl={
                      <RefreshControl
                        tintColor={theme.primary}
                        titleColor={theme.primary}
                        progressBackgroundColor={theme.surface}
                        refreshing={refreshing}
                        onRefresh={refreshVideos}
                      />
                    }
                  />
                )}
              </View>
              <VideosPlaylist />
              <VideosDownload />
            </PagerView>
          </View>
        </View>
      </View>
    </StyledSafeAreaView>
  );
};

export default Videos;
