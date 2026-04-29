import axios from "axios";
import * as FileSystem from "expo-file-system";
import secrets from "../private/secrets";

const BUNNY_STORAGE_ZONE_NAME = secrets.BUNNY_STORIES_STORAGE_ZONE_NAME;
const BUNNY_STORAGE_API_KEY = secrets.BUNNY_STORIES_STORAGE_API_KEY;
const BUNNY_STORAGE_CDN_URL = secrets.BUNNY_STORAGE_CDN_URL;

const BUNNY_STREAM_LIBRARY_ID = secrets.BUNNY_STREAM_STORIES_LIBRARY_ID;
const BUNNY_STREAM_API_KEY = secrets.BUNNY_STREAM_STORIES_API_KEY;
const BUNNY_STREAM_CDN_URL = secrets.BUNNY_STREAM_STORIES_CDN_URL;

export const BunnyService = {
  /**
   * Upload image to Bunny Storage Zone
   */
  async uploadImageToBunnyStorage(fileUri, fileName, { onProgress, signal } = {}) {
    try {
      const uploadUrl = `https://sg.storage.bunnycdn.com/${BUNNY_STORAGE_ZONE_NAME}/stories/${fileName}`;

      const uploadTask = FileSystem.createUploadTask(
        uploadUrl,
        fileUri,
        {
          httpMethod: "PUT",
          headers: {
            AccessKey: BUNNY_STORAGE_API_KEY,
            "Content-Type": "application/octet-stream",
          },
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        },
        (data) => {
          if (!data?.totalBytesExpectedToSend) return;
          const pct = Math.min(100, Math.round((data.totalBytesSent / data.totalBytesExpectedToSend) * 100));
          onProgress?.(pct);
        },
      );

      const abortHandler = () => uploadTask.cancelAsync();
      if (signal) signal.addEventListener("abort", abortHandler);

      try {
        const result = await uploadTask.uploadAsync();
        if (!result || result.status >= 400) {
          throw new Error(`Image upload failed with status ${result?.status ?? "unknown"}`);
        }
      } finally {
        if (signal) signal.removeEventListener("abort", abortHandler);
      }

      onProgress?.(100);
      return `${BUNNY_STORAGE_CDN_URL}/stories/${fileName}`;
    } catch (error) {
      console.error("Error uploading image to Bunny Storage:", error.response?.data || error.message);
      throw error;
    }
  },

  /**
   * Upload video to Bunny Stream
   */
  async uploadVideoToBunnyStream(fileUri, title, { onProgress, signal } = {}) {
    try {
      // Create a new video object
      const createRes = await axios.post(
        `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos`,
        { title },
        {
          headers: { AccessKey: BUNNY_STREAM_API_KEY, "Content-Type": "application/json" },
        },
      );

      const videoId = createRes.data.guid;

      // Upload video file
      const uploadUrl = `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos/${videoId}`;
      const uploadTask = FileSystem.createUploadTask(
        uploadUrl,
        fileUri,
        {
          httpMethod: "PUT",
          headers: { AccessKey: BUNNY_STREAM_API_KEY, "Content-Type": "application/octet-stream" },
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        },
        (data) => {
          if (!data?.totalBytesExpectedToSend) return;
          const pct = Math.min(100, Math.round((data.totalBytesSent / data.totalBytesExpectedToSend) * 100));
          onProgress?.(pct);
        },
      );

      const abortHandler = () => uploadTask.cancelAsync();
      if (signal) signal.addEventListener("abort", abortHandler);

      try {
        const uploadResult = await uploadTask.uploadAsync();
        if (!uploadResult || uploadResult.status >= 400) {
          throw new Error(`Video upload failed with status ${uploadResult?.status ?? "unknown"}`);
        }
      } finally {
        if (signal) signal.removeEventListener("abort", abortHandler);
      }

      onProgress?.(100);

      // Return video info including thumbnails
      return {
        videoId,
        url: `${BUNNY_STREAM_CDN_URL}/${videoId}/playlist.m3u8`,
        thumbnail: `${BUNNY_STREAM_CDN_URL}/${videoId}/thumbnail.jpg`,
      };
    } catch (error) {
      console.error("Error uploading video to Bunny Stream:", error.response?.data || error.message);
      throw error;
    }
  },

  /**
   * Delete image from Bunny Storage Zone
   */
  async deleteImageFromStorage(fileName) {
    try {
      const deleteUrl = `https://sg.storage.bunnycdn.com/${BUNNY_STORAGE_ZONE_NAME}/stories/${fileName}`;

      await axios.delete(deleteUrl, {
        headers: { AccessKey: BUNNY_STORAGE_API_KEY },
      });

      return true;
    } catch (error) {
      console.error("Error deleting image from Bunny Storage:", error.response?.data || error.message);
      return false;
    }
  },

  /**
   * Delete video from Bunny Stream
   */
  async deleteVideoFromStream(videoId) {
    try {
      const deleteUrl = `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos/${videoId}`;

      await axios.delete(deleteUrl, {
        headers: { AccessKey: BUNNY_STREAM_API_KEY },
      });

      return true;
    } catch (error) {
      console.error("Error deleting video from Bunny Stream:", error.response?.data || error.message);
      return false;
    }
  },

  /**
   * Check if Bunny Stream video is fully processed (transcoded)
   * Returns: true = still processing, false = ready to play
   */
  async checkVideoProcessing(videoId) {
    try {
      const url = `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos/${videoId}`;
      const res = await axios.get(url, {
        headers: { AccessKey: BUNNY_STREAM_API_KEY },
      });

      const json = res.data;

      let stillProcessing = true;
      if (json.status === 4) {
        stillProcessing = false;
      } else if (json.status === 2 || json.status === 3) {
        stillProcessing = true;
      }
      return stillProcessing;
    } catch (err) {
      console.error("Error checking Bunny processing:", err.message);
      // If API fails, assume it's ready so UI doesn't block
      return false;
    }
  },

  getVideoIdFromUrl(mediaUrl) {
    if (!mediaUrl) return null;
    const parts = mediaUrl.split("/");
    // URL format: cdn/{videoId}/playlist.m3u8
    return parts[parts.length - 2];
  },
};
