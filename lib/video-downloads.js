import * as FileSystem from "expo-file-system";

const OFFLINE_VIDEO_DIR = `${FileSystem.documentDirectory || ""}offline-videos/`;
const CANCELLED_DOWNLOAD_CODE = "VIDEO_DOWNLOAD_CANCELLED";
const INSUFFICIENT_STORAGE_CODE = "VIDEO_DOWNLOAD_INSUFFICIENT_STORAGE";
export const SUPPORTED_VIDEO_DOWNLOAD_QUALITIES = [720, 480, 360];

const activeDownloads = new Map();
const videoDownloadProgressListeners = new Set();
const videoDownloadProgressMap = new Map();
const PROGRESS_EMIT_MIN_INTERVAL_MS = 300;
const PROGRESS_EMIT_MIN_DELTA = 0.01;

const notifyVideoDownloadProgressListeners = () => {
  const snapshot = Object.fromEntries(videoDownloadProgressMap);
  for (const listener of videoDownloadProgressListeners) {
    try {
      listener(snapshot);
    } catch (error) {
      console.log("video download progress listener error", error);
    }
  }
};

const setVideoDownloadProgress = (downloadId, payload) => {
  if (!downloadId) return;
  videoDownloadProgressMap.set(downloadId, {
    ...(videoDownloadProgressMap.get(downloadId) || {}),
    ...payload,
    updatedAt: Date.now(),
  });
  notifyVideoDownloadProgressListeners();
};

const clearVideoDownloadProgress = (downloadId) => {
  if (!downloadId) return;
  if (!videoDownloadProgressMap.has(downloadId)) return;
  videoDownloadProgressMap.delete(downloadId);
  notifyVideoDownloadProgressListeners();
};

export const subscribeVideoDownloadProgress = (listener) => {
  if (typeof listener !== "function") return () => {};
  videoDownloadProgressListeners.add(listener);
  return () => {
    videoDownloadProgressListeners.delete(listener);
  };
};

export const getVideoDownloadProgressSnapshot = () => Object.fromEntries(videoDownloadProgressMap);

const ensureOfflineBaseDir = async () => {
  if (!FileSystem.documentDirectory) {
    throw new Error("Local file storage is unavailable on this device.");
  }
  await FileSystem.makeDirectoryAsync(OFFLINE_VIDEO_DIR, { intermediates: true });
};

const safeNamePart = (value) => String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_");

const normalizeToSupportedQuality = (value, { preferHigherOnTie = true } = {}) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  let best = SUPPORTED_VIDEO_DOWNLOAD_QUALITIES[0];
  let bestDiff = Math.abs(best - numeric);

  for (const quality of SUPPORTED_VIDEO_DOWNLOAD_QUALITIES.slice(1)) {
    const diff = Math.abs(quality - numeric);
    if (diff < bestDiff) {
      best = quality;
      bestDiff = diff;
      continue;
    }
    if (diff === bestDiff && preferHigherOnTie && quality > best) {
      best = quality;
      bestDiff = diff;
    }
  }

  return best;
};

export const getVideoDownloadId = (video) => {
  if (!video) return null;
  return video.$id || video.id || video.uri || video.videoUrl || null;
};

export const getVideoDownloadFolderUri = ({ downloadId, quality }) => {
  const safeId = safeNamePart(downloadId);
  const safeQuality = safeNamePart(quality || "auto");
  return `${OFFLINE_VIDEO_DIR}${safeId}-${safeQuality}/`;
};

export const getPreferredDownloadHeight = (qualitySetting) => {
  if (!qualitySetting) return 720;
  const normalized = String(qualitySetting).toLowerCase();
  if (normalized.includes("720")) return 720;
  if (normalized.includes("480")) return 480;
  if (normalized.includes("360")) return 360;
  if (normalized.includes("240") || normalized.includes("144")) return 360;
  return 720;
};

export const formatBytes = (bytes) => {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
};

const fetchText = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch playlist (${response.status})`);
  }
  return response.text();
};

const parseAttributes = (line = "") => {
  const attrString = line.split(":").slice(1).join(":");
  const attrs = {};
  const regex = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi;
  let match;
  while ((match = regex.exec(attrString)) !== null) {
    const [, key, rawValue] = match;
    attrs[key] = rawValue?.startsWith('"') ? rawValue.slice(1, -1) : rawValue;
  }
  return attrs;
};

const parseMasterPlaylist = (playlistText, playlistUrl) => {
  const lines = String(playlistText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const variants = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

    const attrs = parseAttributes(line);
    const nextLine = lines[i + 1];
    if (!nextLine || nextLine.startsWith("#")) continue;

    const resolution = attrs.RESOLUTION || "";
    const [widthRaw, heightRaw] = resolution.split("x");
    const width = Number(widthRaw);
    const height = Number(heightRaw);
    const hasResolution = Number.isFinite(width) && Number.isFinite(height);
    const shortEdge = hasResolution ? Math.min(width, height) : null;
    const longEdge = hasResolution ? Math.max(width, height) : null;
    const bandwidth = Number(attrs["AVERAGE-BANDWIDTH"] || attrs.BANDWIDTH);
    const downloadHeight = normalizeToSupportedQuality(shortEdge);

    variants.push({
      url: new URL(nextLine, playlistUrl).toString(),
      height: Number.isFinite(height) ? height : null,
      width: Number.isFinite(width) ? width : null,
      shortEdge,
      longEdge,
      downloadHeight,
      bandwidth: Number.isFinite(bandwidth) ? bandwidth : null,
    });
  }

  return variants;
};

const getUniqueSupportedQualities = (variants = []) => {
  return [
    ...new Set(variants.map((variant) => variant?.downloadHeight).filter((height) => SUPPORTED_VIDEO_DOWNLOAD_QUALITIES.includes(height))),
  ].sort((a, b) => b - a);
};

const chooseVariant = ({ variants, preferredHeight }) => {
  const withMappedQuality = variants.filter((variant) => Number.isFinite(variant?.downloadHeight));
  const pool = withMappedQuality.length ? withMappedQuality : variants;
  if (!pool.length) return null;

  const exact = pool.find((variant) => variant.downloadHeight === preferredHeight);
  if (exact) return exact;

  const belowOrEqual = pool
    .filter((variant) => Number.isFinite(variant.downloadHeight) && variant.downloadHeight <= preferredHeight)
    .sort((a, b) => (b.downloadHeight || 0) - (a.downloadHeight || 0));
  if (belowOrEqual.length) return belowOrEqual[0];

  return [...pool].sort(
    (a, b) => Math.abs((a.downloadHeight || preferredHeight) - preferredHeight) - Math.abs((b.downloadHeight || preferredHeight) - preferredHeight),
  )[0];
};

const parseMediaPlaylistDurationSeconds = (playlistText) => {
  let totalSeconds = 0;
  const regex = /#EXTINF:([0-9.]+)/g;
  let match;
  while ((match = regex.exec(String(playlistText || ""))) !== null) {
    const secs = Number(match[1]);
    if (Number.isFinite(secs)) totalSeconds += secs;
  }
  return totalSeconds > 0 ? totalSeconds : null;
};

const fetchMasterVariants = async (videoUrl) => {
  const rootText = await fetchText(videoUrl);
  const variants = parseMasterPlaylist(rootText, videoUrl);
  return { rootText, variants };
};

const getBunnyMp4UrlForQuality = ({ videoUrl, quality }) => {
  if (!videoUrl || !quality) return null;
  const url = new URL(videoUrl);
  url.pathname = url.pathname.replace(/\/playlist\.m3u8$/i, `/play_${quality}p.mp4`);
  url.search = "";
  return url.toString();
};

const fetchRemoteFileSize = async (url) => {
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) return null;
    const rawLength = response.headers.get("content-length");
    const length = Number(rawLength);
    return Number.isFinite(length) && length > 0 ? length : null;
  } catch {
    return null;
  }
};

export const getAvailableVideoDownloadQualities = async (videoUrl) => {
  if (!videoUrl) return [];
  const { variants } = await fetchMasterVariants(videoUrl);
  return getUniqueSupportedQualities(variants);
};

export const cancelVideoOfflineDownload = async (downloadId) => {
  const active = activeDownloads.get(downloadId);
  if (!active) return false;
  active.cancelled = true;
  try {
    await active.currentTask?.pauseAsync?.();
  } catch {}
  return true;
};

export const isVideoDownloadCancelledError = (error) => error?.code === CANCELLED_DOWNLOAD_CODE;
export const isInsufficientVideoStorageError = (error) => error?.code === INSUFFICIENT_STORAGE_CODE;

const buildCancelledError = () => {
  const error = new Error("Download cancelled");
  error.code = CANCELLED_DOWNLOAD_CODE;
  return error;
};

const buildStorageError = ({ freeBytes, requiredBytes }) => {
  const error = new Error("Insufficient device storage");
  error.code = INSUFFICIENT_STORAGE_CODE;
  error.freeBytes = freeBytes;
  error.requiredBytes = requiredBytes;
  return error;
};

const assertNotCancelled = (controller) => {
  if (controller?.cancelled) throw buildCancelledError();
};

const estimateRequiredBytes = ({ bandwidthBitsPerSecond, durationSeconds, fallbackBytes }) => {
  if (Number.isFinite(bandwidthBitsPerSecond) && Number.isFinite(durationSeconds)) {
    const streamBytes = (bandwidthBitsPerSecond * durationSeconds) / 8;
    return Math.ceil(streamBytes * 1.15 + 5 * 1024 * 1024);
  }
  if (Number.isFinite(fallbackBytes) && fallbackBytes > 0) {
    return Math.ceil(fallbackBytes * 1.1);
  }
  return null;
};

const checkDeviceStorage = async (requiredBytes) => {
  if (!Number.isFinite(requiredBytes) || requiredBytes <= 0) {
    return { ok: true, freeBytes: null, requiredBytes: null };
  }
  if (typeof FileSystem.getFreeDiskStorageAsync !== "function") {
    return { ok: true, freeBytes: null, requiredBytes };
  }
  const freeBytes = await FileSystem.getFreeDiskStorageAsync();
  const minReserveBytes = 60 * 1024 * 1024;
  const ok = Number.isFinite(freeBytes) ? freeBytes - minReserveBytes >= requiredBytes : true;
  return { ok, freeBytes, requiredBytes };
};

export const removeDownloadedVideoFiles = async (entry) => {
  const folderUri = entry?.folderUri;
  const fileUri = entry?.localUri || entry?.fileUri || entry?.manifestUri;

  if (folderUri) {
    await FileSystem.deleteAsync(folderUri, { idempotent: true });
    return;
  }

  if (fileUri) {
    await FileSystem.deleteAsync(fileUri, { idempotent: true });
  }
};

export const clearAllDownloadedVideoFiles = async (entries = []) => {
  for (const entry of entries) {
    try {
      await removeDownloadedVideoFiles(entry);
    } catch (error) {
      console.log("clearAllDownloadedVideoFiles error", error);
    }
  }
};

export const downloadVideoOffline = async ({ video, qualitySetting, selectedHeight, onStatusChange, onProgress }) => {
  const downloadId = getVideoDownloadId(video);
  if (!downloadId) throw new Error("Missing video identifier");
  if (!video?.videoUrl) throw new Error("Missing video URL");

  const controller = { cancelled: false, currentTask: null };
  activeDownloads.set(downloadId, controller);
  let workingFolderUri = null;

  try {
    onStatusChange?.({ status: "preparing", progress: 0 });
    setVideoDownloadProgress(downloadId, { status: "preparing", progress: 0, bytesWritten: 0, totalBytes: null });

    const { variants } = await fetchMasterVariants(video.videoUrl);
    assertNotCancelled(controller);

    const availableQualities = getUniqueSupportedQualities(variants);
    const preferredHeight = Number.isFinite(selectedHeight) ? selectedHeight : getPreferredDownloadHeight(qualitySetting);
    const selectedVariant = chooseVariant({ variants, preferredHeight }) || {
      url: video.videoUrl,
      height: preferredHeight,
      width: null,
      shortEdge: preferredHeight,
      longEdge: preferredHeight,
      downloadHeight: preferredHeight,
      bandwidth: null,
    };

    const resolvedHeight = Number(selectedVariant?.downloadHeight || preferredHeight);
    const qualityTag = `${resolvedHeight}p`;
    const mp4Url = getBunnyMp4UrlForQuality({ videoUrl: video.videoUrl, quality: resolvedHeight });
    if (!mp4Url) throw new Error("Unable to resolve Bunny MP4 download URL.");

    const remoteFileSize = await fetchRemoteFileSize(mp4Url);
    assertNotCancelled(controller);

    let durationSeconds = null;
    if (!remoteFileSize && selectedVariant?.url && selectedVariant.url !== video.videoUrl) {
      try {
        const variantPlaylistText = await fetchText(selectedVariant.url);
        durationSeconds = parseMediaPlaylistDurationSeconds(variantPlaylistText);
      } catch {}
    }
    assertNotCancelled(controller);

    const estimatedRequiredBytes =
      remoteFileSize ||
      estimateRequiredBytes({
        bandwidthBitsPerSecond: selectedVariant?.bandwidth,
        durationSeconds,
        fallbackBytes: null,
      });

    const storage = await checkDeviceStorage(estimatedRequiredBytes);
    if (!storage.ok) throw buildStorageError(storage);

    await ensureOfflineBaseDir();
    const folderUri = getVideoDownloadFolderUri({ downloadId, quality: qualityTag });
    workingFolderUri = folderUri;
    await FileSystem.deleteAsync(folderUri, { idempotent: true }).catch(() => {});
    await FileSystem.makeDirectoryAsync(folderUri, { intermediates: true });
    const targetFileUri = `${folderUri}${safeNamePart(downloadId)}-${qualityTag}.mp4`;

    onStatusChange?.({
      status: "downloading",
      selectedQuality: qualityTag,
      availableQualities: availableQualities.map((height) => `${height}p`),
      estimatedSizeBytes: estimatedRequiredBytes,
      progress: 0,
    });
    setVideoDownloadProgress(downloadId, {
      status: "downloading",
      selectedQuality: qualityTag,
      availableQualities: availableQualities.map((height) => `${height}p`),
      estimatedSizeBytes: estimatedRequiredBytes,
      progress: 0,
      bytesWritten: 0,
      totalBytes: Number(remoteFileSize || estimatedRequiredBytes || 0) || null,
    });

    let lastBytesWritten = 0;
    let lastTotalBytes = Number(remoteFileSize || estimatedRequiredBytes || 0);
    let lastProgressEmitAt = 0;
    let lastProgressEmittedValue = 0;
    controller.currentTask = FileSystem.createDownloadResumable(mp4Url, targetFileUri, {}, (progressData) => {
      lastBytesWritten = Number(progressData?.totalBytesWritten || 0);
      lastTotalBytes = Number(progressData?.totalBytesExpectedToWrite || lastTotalBytes || 0);
      const progress = lastTotalBytes > 0 ? lastBytesWritten / lastTotalBytes : 0;
      const normalizedProgress = Math.max(0, Math.min(1, progress));
      const now = Date.now();
      const shouldEmitProgress =
        normalizedProgress >= 1 ||
        now - lastProgressEmitAt >= PROGRESS_EMIT_MIN_INTERVAL_MS ||
        Math.abs(normalizedProgress - lastProgressEmittedValue) >= PROGRESS_EMIT_MIN_DELTA;

      if (shouldEmitProgress) {
        lastProgressEmitAt = now;
        lastProgressEmittedValue = normalizedProgress;
        setVideoDownloadProgress(downloadId, {
          status: "downloading",
          progress: normalizedProgress,
          bytesWritten: lastBytesWritten,
          totalBytes: lastTotalBytes || null,
          selectedQuality: qualityTag,
        });
      }

      onProgress?.({
        status: "downloading",
        progress: normalizedProgress,
        bytesWritten: lastBytesWritten,
        totalBytes: lastTotalBytes || null,
        selectedQuality: qualityTag,
      });
    });

    try {
      const result = await controller.currentTask.downloadAsync();
      if (!result || (result.status && result.status >= 400)) {
        throw new Error(`Download failed with status ${result?.status ?? "unknown"}`);
      }
    } catch (error) {
      if (controller.cancelled) throw buildCancelledError();
      throw error;
    } finally {
      controller.currentTask = null;
    }

    assertNotCancelled(controller);

    const fileInfo = await FileSystem.getInfoAsync(targetFileUri, { size: true });
    const downloadedBytes = Number(fileInfo?.size || lastBytesWritten || 0);

    onProgress?.({
      status: "completed",
      progress: 1,
      bytesWritten: downloadedBytes,
      totalBytes: lastTotalBytes || downloadedBytes || null,
      selectedQuality: qualityTag,
    });
    setVideoDownloadProgress(downloadId, {
      status: "completed",
      progress: 1,
      bytesWritten: downloadedBytes,
      totalBytes: lastTotalBytes || downloadedBytes || null,
      selectedQuality: qualityTag,
    });

    return {
      videoId: downloadId,
      sourceVideoUrl: video.videoUrl,
      localUri: targetFileUri,
      fileUri: targetFileUri,
      folderUri,
      downloadUrl: mp4Url,
      quality: qualityTag,
      estimatedSizeBytes: estimatedRequiredBytes,
      downloadedBytes,
      durationSeconds,
      availableQualities: availableQualities.map((height) => `${height}p`),
    };
  } catch (error) {
    if (workingFolderUri) {
      await FileSystem.deleteAsync(workingFolderUri, { idempotent: true }).catch(() => {});
    }
    throw error;
  } finally {
    activeDownloads.delete(downloadId);
    setTimeout(() => {
      clearVideoDownloadProgress(downloadId);
    }, 1500);
  }
};
