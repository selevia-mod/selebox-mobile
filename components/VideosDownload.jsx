import { MaterialIcons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useDispatch, useSelector } from "react-redux";
import useAppTheme from "../hooks/useAppTheme";
import {
  cancelVideoOfflineDownload,
  getVideoDownloadProgressSnapshot,
  removeDownloadedVideoFiles,
  subscribeVideoDownloadProgress,
} from "../lib/video-downloads";
import { removeVideoDownload, upsertVideoDownload } from "../store/reducers/videos";
import VideoDownloadCard from "./VideoDownloadCard";

const VideosDownload = () => {
  const { theme } = useAppTheme();
  const dispatch = useDispatch();
  const { videoDownloads, downloadedVideos } = useSelector((state) => state.videos);
  const [progressById, setProgressById] = useState(() => getVideoDownloadProgressSnapshot());

  useEffect(() => {
    const unsubscribe = subscribeVideoDownloadProgress((snapshot) => {
      setProgressById(snapshot);
    });
    setProgressById(getVideoDownloadProgressSnapshot());
    return unsubscribe;
  }, []);

  const entries = useMemo(() => {
    const normalizedPersistedEntries = (downloadedVideos || []).map((item) =>
      item?.video
        ? item
        : {
            id: item?.$id || item?.uri,
            status: "completed",
            progress: 1,
            video: item,
          },
    );

    const mergedEntries = new Map();

    for (const entry of normalizedPersistedEntries) {
      const id = entry?.id || entry?.videoId || entry?.video?.$id || entry?.video?.uri;
      if (!id) continue;
      mergedEntries.set(id, { ...entry, id });
    }

    for (const entry of videoDownloads || []) {
      const id = entry?.id || entry?.videoId || entry?.video?.$id || entry?.video?.uri;
      if (!id) continue;
      mergedEntries.set(id, {
        ...mergedEntries.get(id),
        ...entry,
        id,
        video: entry?.video || mergedEntries.get(id)?.video,
      });
    }

    const baseEntries = Array.from(mergedEntries.values()).sort(
      (a, b) => (Number(b?.updatedAt || b?.createdAt || 0) || 0) - (Number(a?.updatedAt || a?.createdAt || 0) || 0),
    );

    return baseEntries.map((entry) => {
      const transient = progressById?.[entry?.id];
      if (!transient) return entry;
      return {
        ...entry,
        ...transient,
        video: entry?.video,
      };
    });
  }, [downloadedVideos, progressById, videoDownloads]);

  const renderItem = ({ item }) => {
    return (
      <VideoDownloadCard
        entry={item}
        onCancel={async (entry) => {
          if (!entry?.id) return;
          dispatch(upsertVideoDownload({ id: entry.id, status: "cancelling" }));
          await cancelVideoOfflineDownload(entry.id);
        }}
        onRemove={async (entry) => {
          if (!entry?.id) return;
          try {
            if (["preparing", "downloading", "cancelling"].includes(entry.status)) {
              await cancelVideoOfflineDownload(entry.id);
            }
            await removeDownloadedVideoFiles(entry);
          } catch (error) {
            console.log("remove download error", error);
          } finally {
            dispatch(removeVideoDownload(entry.id));
          }
        }}
      />
    );
  };

  return (
    <View className="flex-1">
      <Text className="mb-3 px-2 text-xs font-semibold" style={{ color: theme.textSoft }}>
        Your offline videos will appear here.
      </Text>
      <FlashList
        data={entries}
        renderItem={renderItem}
        estimatedItemSize={180}
        keyExtractor={(item, index) => `${item?.id || item?.video?.$id || index}`}
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center px-6 py-16">
            <MaterialIcons name="offline-bolt" size={46} color={theme.textSubtle} />
            <Text className="mt-3 text-center text-base font-semibold" style={{ color: theme.text }}>
              No video downloads yet
            </Text>
            <Text className="mt-1 text-center text-xs" style={{ color: theme.textSoft }}>
              Download a video from the player and it will appear here with progress and cancel controls.
            </Text>
          </View>
        }
      />
    </View>
  );
};

export default VideosDownload;
