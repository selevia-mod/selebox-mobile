// components/LinkPreviewCard.js
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getLinkPreview } from "link-preview-js";
import { useEffect, useRef, useState } from "react";
import { Image, Text, TouchableOpacity, View } from "react-native";
import LoaderKit from "react-native-loader-kit";
import useAppTheme from "../hooks/useAppTheme";
import { BookService } from "../lib/books";
import { VideosService } from "../lib/video";
import { handleAppLink } from "../utils/appLinks";
import AnimatedSkeleton from "./AnimatedSkeleton";

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const BOOK_ID_REGEX = /\/books\/([\w-]+)/i;
const VIDEO_ID_REGEX = /\/videos\/([\w-]+)/i;

const getBookIdFromUrl = (link) => {
  if (!link || typeof link !== "string") return null;
  const match = link.match(BOOK_ID_REGEX);
  return match?.[1] || null;
};

const getVideoIdFromUrl = (link) => {
  if (!link || typeof link !== "string") return null;
  const match = link.match(VIDEO_ID_REGEX);
  return match?.[1] || null;
};

const getUploader = (video) => {
  if (!video?.uploader) return null;
  if (Array.isArray(video.uploader)) return video.uploader[0] || null;
  if (typeof video.uploader === "object") return video.uploader;
  return null;
};

const getHostnameFromUrl = (link) => {
  if (!link || typeof link !== "string") return "";
  try {
    return new URL(link).hostname.replace("www.", "");
  } catch (error) {
    const sanitized = link.replace(/^https?:\/\//i, "");
    return sanitized.split("/")[0] || link;
  }
};

const buildVideoPreview = (video, videoId) => {
  if (!video) return null;

  const uploader = getUploader(video);
  const uploaderName = uploader?.username || "Selebox Creator";
  const title = video.title || "Video";
  const description = video.description || `Watch ${title} by ${uploaderName} on Selebox.`;
  const image = video.thumbnail || "https://www.selebox.com/logo/icon.png";
  const tags = Array.isArray(video.tags) ? video.tags.filter(Boolean) : [];

  return {
    url: `https://www.selebox.com/videos/${videoId || video.$id}`,
    title,
    description,
    images: [image],
    siteName: "Selebox",
    mediaType: "video.other",
    source: "selebox-video",
    video,
    uploaderName,
    tags,
  };
};

const LinkPreviewCard = ({ url, imageOnly = false }) => {
  const { theme } = useAppTheme();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [coverAspectRatio, setCoverAspectRatio] = useState(2 / 3);
  const [bookMeta, setBookMeta] = useState(null);
  const bookService = useRef(new BookService()).current;
  const videosService = useRef(new VideosService()).current;
  const bookId = getBookIdFromUrl(url);
  const videoId = getVideoIdFromUrl(url);
  const cacheKey = videoId ? `preview:video:${url}` : `preview:${url}`;
  const statusValue = (bookMeta?.status || "").toLowerCase();
  const statusColor = statusValue === "ongoing" ? theme.accentAmber : statusValue === "completed" ? theme.accentGreen : theme.textMuted;

  const getCachedPreview = async () => {
    const cached = await AsyncStorage.getItem(cacheKey);
    if (cached) {
      const { data, timestamp } = JSON.parse(cached);
      if (Date.now() - timestamp < CACHE_TTL) return data;
    }
    return null;
  };

  const fetchVideoPreview = async () => {
    if (!videoId) return null;

    try {
      const byId = await videosService.getVideo({ id: videoId });
      const preview = buildVideoPreview(byId, videoId);
      if (preview) return preview;
    } catch (_) {}

    try {
      const byUri = await videosService.searchVideo({ uri: `/videos/${videoId}` });
      return buildVideoPreview(byUri?.documents?.[0], videoId);
    } catch (err) {
      console.log("Failed to fetch video meta:", err);
      return null;
    }
  };

  const fetchPreview = async () => {
    setLoading(true);
    setError(false);
    try {
      const cachedData = await getCachedPreview();
      if (cachedData) {
        setData(cachedData);
        setLoading(false);
        return;
      }

      const preview = (await fetchVideoPreview()) || (await getLinkPreview(url));
      setData(preview);
      await AsyncStorage.setItem(cacheKey, JSON.stringify({ data: preview, timestamp: Date.now() }));
    } catch (err) {
      console.log("Preview error:", err);
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPreview();
  }, [url]);

  useEffect(() => {
    let isActive = true;

    if (!bookId) {
      setBookMeta(null);
      return () => {
        isActive = false;
      };
    }

    const fetchBookMeta = async () => {
      setBookMeta(null);
      try {
        const bookDoc = await bookService.fetchBook({ bookId });
        if (!isActive) return;
        setBookMeta(bookDoc);
      } catch (err) {
        console.log("Failed to fetch book meta:", err);
        if (!isActive) return;
      }
    };

    fetchBookMeta();

    return () => {
      isActive = false;
    };
  }, [bookId, bookService]);

  if (loading)
    return (
      <View className="mt-3 rounded-lg p-3" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
        <AnimatedSkeleton style={{ width: "100%", height: 240, borderRadius: 10 }} />
        {!imageOnly && (
          <>
            <AnimatedSkeleton className="mt-2" style={{ width: "60%", height: 20, borderRadius: 5 }} />
            <AnimatedSkeleton className="mt-2" style={{ width: "80%", height: 14, borderRadius: 5 }} />
          </>
        )}
      </View>
    );

  if (error || !data) {
    return (
      <View
        className="mt-3 items-center justify-center rounded-lg p-4"
        style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
      >
        <Text className="text-sm" style={{ color: theme.textMuted }}>
          Failed to load preview.
        </Text>
      </View>
    );
  }

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={() => handleAppLink(url)}
      className={imageOnly ? "mt-1.5 overflow-hidden rounded-lg" : "mt-1.5 overflow-hidden rounded-lg px-2"}
      style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
    >
      <View className="relative w-full">
        {data.images?.[0] ? (
          <>
            <Image
              source={{ uri: data.images[0] }}
              resizeMode="contain"
              onLoad={(event) => {
                const { width, height } = event.nativeEvent.source || {};
                if (width && height) setCoverAspectRatio(width / height);
              }}
              style={{ width: "100%", aspectRatio: coverAspectRatio }}
              className="rounded-lg"
            />
            {!imageOnly && (
              <View className="absolute bottom-3 left-0 right-0 items-center">
                <View className="rounded-[8px] px-4 py-2" style={{ backgroundColor: theme.primary }}>
                  <Text className="text-sm font-semibold" style={{ color: theme.primaryContrast }}>
                    {videoId ? "Watch Now" : "Read Now"}
                  </Text>
                </View>
              </View>
            )}
          </>
        ) : (
          <View className="h-[220px] w-full items-center justify-center">
            <LoaderKit style={{ width: 40, height: 40 }} name="LineScalePulseOutRapid" color={theme.primary} />
          </View>
        )}
      </View>

      {!imageOnly && (
        <View className="px-4 py-3">
          <View className="flex-wrap items-center">
            <Text numberOfLines={2} className="text-[16px] font-bold" style={{ color: theme.text }}>
              {data.title || bookMeta?.title || url}
            </Text>
          </View>

          {!!bookMeta?.status && (
            <Text className="text-xs font-semibold" style={{ color: statusColor }}>
              {bookMeta.status}
            </Text>
          )}

          {bookMeta?.tags?.length > 0 && (
            <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
              {bookMeta.tags.join(" • ")}
            </Text>
          )}

          {videoId && data.tags?.length > 0 && (
            <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
              {data.tags.join(" • ")}
            </Text>
          )}

          {data.description ? (
            <Text numberOfLines={2} className="mt-1 text-sm" style={{ color: theme.textMuted }}>
              {data.description}
            </Text>
          ) : null}

          <Text numberOfLines={1} className="mt-2 text-xs" style={{ color: theme.textSoft }}>
            {getHostnameFromUrl(url)}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
};

export default LinkPreviewCard;
