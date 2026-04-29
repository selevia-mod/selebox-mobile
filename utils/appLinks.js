import * as Linking from "expo-linking";
import { router } from "expo-router";
import { Platform } from "react-native";

export const handleAppLink = (url) => {
  try {
    const cleanUrl = url.trim();

    // Match patterns for books or videos
    const match = cleanUrl.match(/^https?:\/\/(?:www\.)?selebox\.com\/(books|videos)\/([\w-]+)$/);

    if (match) {
      const type = match[1]; // 'books' or 'videos'
      const id = match[2];

      if (type === "videos") {
        router.push({
          pathname: "/video-player",
          params: { id, docId: id, view: "RECOMMENDED" },
        });
      } else if (type === "books" && Platform.OS === "ios") {
        router.push({
          pathname: "book-info",
          params: { bookId: id },
        });
      } else {
        Linking.openURL(url);
      }
    } else {
      // Not a recognized app link — open externally
      Linking.openURL(url);
    }
  } catch (error) {
    console.warn("Error handling app link:", error);
    Linking.openURL(url);
  }
};
