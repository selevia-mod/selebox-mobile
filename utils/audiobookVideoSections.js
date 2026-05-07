import { ShuffleVideos } from "../lib/appwrite";

// Bumped to 4 (May 2026) — view-count backfill from videos-views landed
// (37,460 historical view rows imported) and AUDIOBOOK_VIEW_THRESHOLD
// moved from 0 → 50 to start curating "Most People Want." Cache version
// bump invalidates payloads cached under the old 0-threshold so the new
// MPW/SFY split shows up on the next launch instead of waiting for the
// 12h TTL.
export const AUDIOBOOK_SECTIONS_CACHE_VERSION = 4;
export const AUDIOBOOK_TAG = "Audiobook";
// Threshold for the "Most People Want" shelf. Audiobooks at or above this
// many unique viewers (videos.views_count) land in MPW; the rest fall
// into "Suggested For You." With the Appwrite → Supabase view-count
// backfill complete (37,460 rows), the catalog distribution at the time
// of cutover was: 47 audiobooks at 100+ views, 130 at 50+, 232 at 20+,
// 270 at 10+, out of 309 total. 50 was chosen as the sweet spot — gives
// ~130 items in MPW and ~179 in SFY, balanced enough that neither shelf
// dominates. Adjust upward (more strict) once the catalog grows and the
// long tail thickens.
export const AUDIOBOOK_VIEW_THRESHOLD = 50;
export const AUDIOBOOK_VIDEOS_LIMIT = 100;

const chunkArray = (array, chunkSize) => {
  const result = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    result.push(array.slice(i, i + chunkSize));
  }
  return result;
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

const normalizeTag = (tag) =>
  String(tag || "")
    .trim()
    .toLowerCase();

export const hasAudiobookTag = (video) => {
  if (!Array.isArray(video?.tags)) return false;
  return video.tags.some((tag) => normalizeTag(tag) === normalizeTag(AUDIOBOOK_TAG));
};

export const getVideoViewCount = (video) => {
  const count = video?.videoStats?.totalViews ?? video?.views ?? video?.totalViews ?? 0;
  const number = Number(count);
  return Number.isFinite(number) ? number : 0;
};

export const getAudiobookVideoGroups = (videos = []) => {
  const audiobookVideos = mergeUniqueVideos(videos).filter(hasAudiobookTag);

  // When the threshold is 0 (post-migration / no view data yet), every
  // audiobook video lands in `mostPeopleWant` and `suggestedForYou`
  // would otherwise be empty (filter: views < 0 matches nothing). Show
  // the full list in BOTH buckets in that case — the consuming sections
  // shuffle + chunk independently, so the user still sees variety
  // between the two shelves. Once view-count backfill lands and the
  // threshold goes back to 100, the original split (popular vs less
  // popular) returns automatically.
  const noThreshold = AUDIOBOOK_VIEW_THRESHOLD <= 0;
  return {
    mostPeopleWant: audiobookVideos
      .filter((video) => getVideoViewCount(video) >= AUDIOBOOK_VIEW_THRESHOLD)
      .sort((a, b) => getVideoViewCount(b) - getVideoViewCount(a)),
    suggestedForYou: noThreshold
      ? audiobookVideos
      : audiobookVideos.filter((video) => getVideoViewCount(video) < AUDIOBOOK_VIEW_THRESHOLD),
  };
};

const resolveLimit = (limit, fallback = AUDIOBOOK_VIDEOS_LIMIT) => {
  const numericLimit = Number(limit);
  return Number.isFinite(numericLimit) && numericLimit > 0 ? numericLimit : fallback;
};

export const getAudiobookSections = (videos = [], limit = AUDIOBOOK_VIDEOS_LIMIT) => {
  const groups = getAudiobookVideoGroups(videos);
  const resolvedLimit = resolveLimit(limit);

  return {
    mostPeopleWant: groups.mostPeopleWant.slice(0, resolvedLimit),
    suggestedForYou: chunkArray(ShuffleVideos(groups.suggestedForYou).slice(0, resolvedLimit), 2),
  };
};

// Hard cap on pagination — protects against catalogs where lots of
// audiobook-tagged videos exist but the per-call `filterVideos` (e.g.,
// safety blocks, hidden content) trims most of them. Without the cap we'd
// keep fanning out 50-row pages until offset > total even though neither
// shelf will ever fill, burning 10-15 wasted RPCs on Videos tab open.
// 6 pages × 50 = 300 candidates is plenty for a 30-row shelf even after
// aggressive filtering.
const MAX_AUDIOBOOK_PAGES = 6;

export const fetchAudiobookVideosForSectionLimit = async ({ videosService, sectionLimit = AUDIOBOOK_VIDEOS_LIMIT, filterVideos } = {}) => {
  if (!videosService?.fetchVideos) return [];

  const resolvedSectionLimit = resolveLimit(sectionLimit);
  const collectedVideos = [];
  let offset = 0;
  let total = null;
  let pagesFetched = 0;

  while ((total === null || offset < total) && pagesFetched < MAX_AUDIOBOOK_PAGES) {
    const response = await videosService.fetchVideos({
      category: AUDIOBOOK_TAG,
      limit: AUDIOBOOK_VIDEOS_LIMIT,
      status: "published",
      offset,
    });
    pagesFetched += 1;
    const pageVideos = Array.isArray(response?.documents) ? response.documents : [];
    if (pageVideos.length === 0) break;

    collectedVideos.push(...pageVideos);

    const uniqueVideos = mergeUniqueVideos(collectedVideos);
    const visibleVideos = typeof filterVideos === "function" ? filterVideos(uniqueVideos) : uniqueVideos;
    const groups = getAudiobookVideoGroups(visibleVideos);
    if (groups.mostPeopleWant.length >= resolvedSectionLimit && groups.suggestedForYou.length >= resolvedSectionLimit) {
      return visibleVideos;
    }

    const responseTotal = Number(response?.total);
    total = Number.isFinite(responseTotal) ? responseTotal : null;
    offset += pageVideos.length;
  }

  const uniqueVideos = mergeUniqueVideos(collectedVideos);
  return typeof filterVideos === "function" ? filterVideos(uniqueVideos) : uniqueVideos;
};
