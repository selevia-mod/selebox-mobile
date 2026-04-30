import { Feather, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { SafeAreaView } from "react-native-safe-area-context";
import UserAvatar from "../../components/UserAvatar";
import useAppTheme from "../../hooks/useAppTheme";
import { addRecentSearch, clearRecentSearches, getRecentSearches, removeRecentSearch } from "../../lib/recent-searches";
import { searchAll } from "../../lib/search";

const SECTION_LIMIT = 5;

const SearchScreen = () => {
  const { theme } = useAppTheme();
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState(() => getRecentSearches());
  const [results, setResults] = useState({ users: [], posts: [], books: [], videos: [] });
  const [searching, setSearching] = useState(false);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    // Auto-focus the input after the screen mounts (push animation finishes).
    const t = setTimeout(() => inputRef.current?.focus(), 220);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const q = query.trim();
    clearTimeout(debounceRef.current);
    if (!q) {
      setResults({ users: [], posts: [], books: [], videos: [] });
      setSearching(false);
      return;
    }
    setSearching(true);
    const requestId = ++requestIdRef.current;
    debounceRef.current = setTimeout(async () => {
      const res = await searchAll({ query: q, limit: SECTION_LIMIT });
      // Discard out-of-order responses (user typed faster than the server replied).
      if (requestId !== requestIdRef.current) return;
      setResults(res);
      setSearching(false);
    }, 280);
  }, [query]);

  const refreshRecents = () => setRecents(getRecentSearches());

  const persistAndExecute = (q) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    addRecentSearch(trimmed);
    refreshRecents();
  };

  const handleSubmit = () => {
    persistAndExecute(query);
  };

  const handleRecentTap = (q) => {
    setQuery(q);
    inputRef.current?.focus();
  };

  const handleRecentRemove = (q) => {
    removeRecentSearch(q);
    refreshRecents();
  };

  const handleClearAll = () => {
    clearRecentSearches();
    refreshRecents();
  };

  const goToContent = (type, item) => {
    persistAndExecute(query);
    Keyboard.dismiss();
    if (type === "user") {
      router.push({ pathname: "/creator-profile", params: { userId: item.$id } });
    } else if (type === "book") {
      router.push({ pathname: "/book-info", params: { bookId: item.$id } });
    } else if (type === "video") {
      router.push({ pathname: "/video-player", params: { videoId: item.$id, videoUri: item?.uri || "" } });
    } else if (type === "post") {
      router.push({ pathname: "/(tabs)/home", params: { focusPostId: item.$id } });
    }
  };

  const trimmed = query.trim();
  const hasQuery = trimmed.length > 0;
  const hasResults =
    results.users.length > 0 || results.posts.length > 0 || results.books.length > 0 || results.videos.length > 0;
  const showEmptyResults = hasQuery && !searching && !hasResults;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}>
      {/* Top bar */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 8,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: theme.divider,
        }}
      >
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={{ height: 40, width: 40, alignItems: "center", justifyContent: "center" }}
        >
          <MaterialIcons name="arrow-back" size={22} color={theme.icon} />
        </TouchableOpacity>

        <View
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: theme.surfaceMuted,
            borderRadius: 999,
            paddingHorizontal: 14,
            paddingVertical: 4,
          }}
        >
          <Feather name="search" size={16} color={theme.iconMuted ?? theme.icon} style={{ marginRight: 8 }} />
          <TextInput
            ref={inputRef}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={handleSubmit}
            placeholder="Search Selebox"
            placeholderTextColor={theme.searchPlaceholder ?? theme.textSoft}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            style={{ flex: 1, fontSize: 14, color: theme.searchText ?? theme.text, paddingVertical: 8 }}
          />
          {hasQuery ? (
            <TouchableOpacity
              onPress={() => setQuery("")}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={{ padding: 4 }}
            >
              <Feather name="x" size={16} color={theme.iconMuted ?? theme.icon} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Empty state — recent searches */}
        {!hasQuery && recents.length > 0 && (
          <View>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: 16,
                paddingTop: 16,
                paddingBottom: 8,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.textMuted ?? theme.text }}>
                Recent searches
              </Text>
              <TouchableOpacity onPress={handleClearAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={{ fontSize: 12, fontWeight: "600", color: theme.primary }}>Clear all</Text>
              </TouchableOpacity>
            </View>

            {recents.map((q) => (
              <TouchableOpacity
                key={q}
                onPress={() => handleRecentTap(q)}
                onLongPress={() => handleRecentRemove(q)}
                activeOpacity={0.7}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                }}
              >
                <MaterialIcons name="history" size={20} color={theme.iconMuted ?? theme.icon} style={{ marginRight: 12 }} />
                <Text style={{ flex: 1, fontSize: 14, color: theme.text }} numberOfLines={1}>
                  {q}
                </Text>
                <TouchableOpacity
                  onPress={() => handleRecentRemove(q)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={{ padding: 4 }}
                >
                  <Feather name="x" size={16} color={theme.iconMuted ?? theme.icon} />
                </TouchableOpacity>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Empty state — first-time, no recents */}
        {!hasQuery && recents.length === 0 && (
          <View style={{ alignItems: "center", paddingTop: 80, paddingHorizontal: 24 }}>
            <Feather name="search" size={48} color={theme.iconMuted ?? theme.icon} />
            <Text style={{ marginTop: 16, fontSize: 15, fontWeight: "600", color: theme.text }}>
              Search Selebox
            </Text>
            <Text
              style={{ marginTop: 6, fontSize: 13, color: theme.textSoft, textAlign: "center" }}
            >
              Find people, books, videos, and posts.
            </Text>
          </View>
        )}

        {/* Searching indicator */}
        {hasQuery && searching && !hasResults && (
          <View style={{ alignItems: "center", paddingTop: 40 }}>
            <ActivityIndicator size="small" color={theme.primary} />
          </View>
        )}

        {/* Results — People */}
        {results.users.length > 0 && (
          <View style={{ marginTop: 12 }}>
            <SectionHeader label="People" theme={theme} />
            {results.users.map((user) => (
              <TouchableOpacity
                key={user.$id}
                onPress={() => goToContent("user", user)}
                activeOpacity={0.7}
                style={resultRowStyle}
              >
                <UserAvatar name={user?.username} avatarUri={user?.avatar} size={40} borderRadius={20} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.text }} numberOfLines={1}>
                    {user?.username || "Unknown"}
                  </Text>
                  {user?.bio ? (
                    <Text style={{ marginTop: 2, fontSize: 12, color: theme.textSoft }} numberOfLines={1}>
                      {user.bio}
                    </Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Results — Books */}
        {results.books.length > 0 && (
          <View style={{ marginTop: 8 }}>
            <SectionHeader label="Books" theme={theme} />
            {results.books.map((book) => (
              <TouchableOpacity
                key={book.$id}
                onPress={() => goToContent("book", book)}
                activeOpacity={0.7}
                style={resultRowStyle}
              >
                <View
                  style={{
                    width: 40,
                    height: 56,
                    borderRadius: 6,
                    overflow: "hidden",
                    backgroundColor: theme.surfaceMuted,
                  }}
                >
                  {book?.thumbnail ? (
                    <FastImage
                      source={{ uri: book.thumbnail, priority: FastImage.priority.normal }}
                      style={{ width: "100%", height: "100%" }}
                      resizeMode={FastImage.resizeMode.cover}
                    />
                  ) : null}
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.text }} numberOfLines={1}>
                    {book?.title || "Untitled"}
                  </Text>
                  {book?.bookOwner?.username ? (
                    <Text style={{ marginTop: 2, fontSize: 12, color: theme.textSoft }} numberOfLines={1}>
                      by {book.bookOwner.username}
                    </Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Results — Videos */}
        {results.videos.length > 0 && (
          <View style={{ marginTop: 8 }}>
            <SectionHeader label="Videos" theme={theme} />
            {results.videos.map((video) => (
              <TouchableOpacity
                key={video.$id}
                onPress={() => goToContent("video", video)}
                activeOpacity={0.7}
                style={resultRowStyle}
              >
                <View
                  style={{
                    width: 64,
                    height: 40,
                    borderRadius: 6,
                    overflow: "hidden",
                    backgroundColor: theme.surfaceMuted,
                  }}
                >
                  {video?.thumbnail ? (
                    <FastImage
                      source={{ uri: video.thumbnail, priority: FastImage.priority.normal }}
                      style={{ width: "100%", height: "100%" }}
                      resizeMode={FastImage.resizeMode.cover}
                    />
                  ) : null}
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.text }} numberOfLines={1}>
                    {video?.title || "Untitled video"}
                  </Text>
                  {video?.uploader?.username ? (
                    <Text style={{ marginTop: 2, fontSize: 12, color: theme.textSoft }} numberOfLines={1}>
                      {video.uploader.username}
                    </Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Results — Posts */}
        {results.posts.length > 0 && (
          <View style={{ marginTop: 8 }}>
            <SectionHeader label="Posts" theme={theme} />
            {results.posts.map((post) => {
              const owner = post?.postOwner;
              const snippet = (post?.post || "").trim().slice(0, 80);
              return (
                <TouchableOpacity
                  key={post.$id}
                  onPress={() => goToContent("post", post)}
                  activeOpacity={0.7}
                  style={resultRowStyle}
                >
                  <UserAvatar name={owner?.username} avatarUri={owner?.avatar} size={40} borderRadius={20} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.text }} numberOfLines={1}>
                      {owner?.username || "Someone"}
                    </Text>
                    {snippet ? (
                      <Text style={{ marginTop: 2, fontSize: 12, color: theme.textSoft }} numberOfLines={2}>
                        {snippet}
                        {post?.post?.length > 80 ? "…" : ""}
                      </Text>
                    ) : null}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* No results */}
        {showEmptyResults && (
          <View style={{ alignItems: "center", paddingTop: 60, paddingHorizontal: 24 }}>
            <Feather name="search" size={40} color={theme.iconMuted ?? theme.icon} />
            <Text style={{ marginTop: 12, fontSize: 14, fontWeight: "600", color: theme.text }}>
              No results for "{trimmed}"
            </Text>
            <Text style={{ marginTop: 4, fontSize: 12, color: theme.textSoft, textAlign: "center" }}>
              Try a different keyword or check spelling.
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
};

const SectionHeader = ({ label, theme }) => (
  <Text
    style={{
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 6,
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 0.6,
      textTransform: "uppercase",
      color: theme.textSoft ?? theme.textMuted,
    }}
  >
    {label}
  </Text>
);

const resultRowStyle = {
  flexDirection: "row",
  alignItems: "center",
  paddingHorizontal: 16,
  paddingVertical: 10,
};

export default SearchScreen;
