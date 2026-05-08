import * as Linking from "expo-linking";
import { router } from "expo-router";

// Match the trailing slug from any of the Selebox URL shapes we accept:
//   https://selebox.com/books/<uuid|hex>
//   https://www.selebox.com/books/<uuid|hex>
//   https://selebox.com/videos/<uuid|hex>
// The `[\w-]+` slug is intentionally permissive — covers UUIDs (with
// hyphens) AND legacy 24-char Appwrite hex IDs. Trailing query/fragment
// is allowed (drop the `$` anchor) so that `?ref=…` or `#chapter/3`
// suffixes still deep-link cleanly instead of falling through to web.
const SELEBOX_LINK_REGEX = /^https?:\/\/(?:www\.)?selebox\.com\/(books|videos)\/([\w-]+)/i;

export const handleAppLink = (url) => {
  try {
    const cleanUrl = (url || "").trim();
    const match = cleanUrl.match(SELEBOX_LINK_REGEX);

    if (match) {
      const type = match[1]; // 'books' or 'videos'
      const id = match[2];

      if (type === "videos") {
        router.push({
          pathname: "/video-player",
          params: { id, docId: id, view: "RECOMMENDED" },
        });
        return;
      }

      if (type === "books") {
        // Was: `Platform.OS === "ios"` gate → Android fell through to
        // Linking.openURL and opened the browser instead of the app.
        // Stale workaround from an old expo-router bug that's long
        // since fixed. Both platforms route in-app now.
        router.push({
          pathname: "/(book)/book-info",
          params: { bookId: id },
        });
        return;
      }
    }

    // Not a recognized Selebox link — open externally.
    Linking.openURL(url);
  } catch (error) {
    console.warn("Error handling app link:", error);
    Linking.openURL(url);
  }
};
