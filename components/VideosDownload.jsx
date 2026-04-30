// "Downloads" tab on the Videos screen.
//
// Shows the user's offline video library — a merge of two stores:
//   • `state.videos.downloadedVideos` — entries that finished downloading
//     successfully (persisted via redux-persist + MMKV).
//   • `state.videos.videoDownloads` — in-flight entries (preparing,
//     downloading, cancelling, failed). Persisted too so a kill-and-relaunch
//     mid-download still lists the partial entry.
//
// Per-entry transient progress (bytesWritten / totalBytes / live %) comes
// from a session-level subscription against video-downloads.js. The merge
// in `entries` flattens persisted shape + transient progress for each
// matching id so VideoDownloadCard sees a single object regardless of which
// store the data lives in.
//
// Visual language matches the Library / Recommended / unlock-modal premium
// violet system.

import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
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

  // Section header matching Library / Recommended Videos: violet-soft chip
  // with shadow lift, uppercase letter-spaced label, count badge on the
  // right. Pinned at the top of the list as ListHeaderComponent so it
  // scrolls naturally with content.
  const completedCount = entries.filter((e) => e?.status === "completed").length;
  const renderHeader = () => (
    <View className="mb-3 flex-row items-center justify-between px-4 pt-2">
      <View className="flex-row items-center">
        <View
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.primarySoft,
            borderWidth: 1,
            borderColor: theme.primary,
            marginRight: 10,
            shadowColor: theme.primary,
            shadowOffset: { width: 0, height: 3 },
            shadowOpacity: 0.3,
            shadowRadius: 6,
            elevation: 2,
          }}
        >
          <Ionicons name="cloud-download" size={13} color={theme.primary} />
        </View>
        <Text className="font-psemibold" style={{ color: theme.text, fontSize: 13, letterSpacing: 1.6, textTransform: "uppercase" }}>
          Downloads
        </Text>
      </View>
      {completedCount > 0 ? (
        <View
          className="rounded-full"
          style={{
            paddingHorizontal: 8,
            paddingVertical: 2,
            backgroundColor: theme.surfaceMuted,
            borderWidth: 1,
            borderColor: theme.border,
          }}
        >
          <Text className="text-[10px] font-bold" style={{ color: theme.textMuted, letterSpacing: 0.4 }}>
            {completedCount} {completedCount === 1 ? "VIDEO" : "VIDEOS"}
          </Text>
        </View>
      ) : null}
    </View>
  );

  return (
    <View className="flex-1">
      <FlashList
        data={entries}
        renderItem={renderItem}
        estimatedItemSize={180}
        keyExtractor={(item, index) => `${item?.id || item?.video?.$id || index}`}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={
          // Premium empty state — violet chip + clear copy + nudge to
          // initiate a download from the player. Mirrors the Library and
          // CommentSection empty states.
          <View className="flex-1 items-center px-6 py-12">
            <View
              style={{
                height: 64,
                width: 64,
                borderRadius: 999,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: theme.primarySoft,
                borderWidth: 1,
                borderColor: theme.primary,
                marginBottom: 16,
              }}
            >
              <MaterialCommunityIcons name="cloud-download-outline" size={28} color={theme.primary} />
            </View>
            <Text className="text-base font-bold" style={{ color: theme.text, letterSpacing: 0.2 }}>
              No downloads yet
            </Text>
            <Text className="mt-1.5 max-w-[280px] text-center text-sm" style={{ color: theme.textSoft, lineHeight: 18 }}>
              Tap the download icon while watching a video and it'll show up here, ready to play offline.
            </Text>
          </View>
        }
      />
    </View>
  );
};

export default VideosDownload;
