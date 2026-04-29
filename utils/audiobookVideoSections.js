import { ShuffleVideos } from "../lib/appwrite";

export const AUDIOBOOK_SECTIONS_CACHE_VERSION = 2;
export const AUDIOBOOK_TAG = "Audiobook";
export const AUDIOBOOK_VIEW_THRESHOLD = 100;
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

  return {
    mostPeopleWant: audiobookVideos
      .filter((video) => getVideoViewCount(video) > AUDIOBOOK_VIEW_THRESHOLD)
      .sort((a, b) => getVideoViewCount(b) - getVideoViewCount(a)),
    suggestedForYou: audiobookVideos.filter((video) => getVideoViewCount(video) < AUDIOBOOK_VIEW_THRESHOLD),
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

export const fetchAudiobookVideosForSectionLimit = async ({ videosService, sectionLimit = AUDIOBOOK_VIDEOS_LIMIT, filterVideos } = {}) => {
  if (!videosService?.fetchVideos) return [];

  const resolvedSectionLimit = resolveLimit(sectionLimit);
  const collectedVideos = [];
  let offset = 0;
  let total = null;

  while (total === null || offset < total) {
    const response = await videosService.fetchVideos({
      category: AUDIOBOOK_TAG,
      limit: AUDIOBOOK_VIDEOS_LIMIT,
      status: "published",
      offset,
    });
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
