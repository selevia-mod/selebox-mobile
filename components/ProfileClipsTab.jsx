import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Dimensions, Text, View } from "react-native";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { fetchClips } from "../lib/clips";
import ClipCard from "./ClipCard";
import StyledFlatList from "./StyledFlatList";

const ProfileClipsTab = ({
  userId,
  nestedScrollEnabled = false,
  sectionTitle = "Clips",
  listRef,
  contentPaddingTop = 0,
  onScroll,
  onLoadingChange,
  suppressEmptyState = false,
  headerComponent = null,
}) => {
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const [clips, setClips] = useState([]);
  const [lastId, setLastId] = useState();
  const [hasMore, setHasMore] = useState(false);
  const { width } = Dimensions.get("window");
  const isLoggedInUser = user?.$id === userId;
  const internalListRef = useRef(null);
  const effectiveListRef = listRef || internalListRef;
  const hasLoadedRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      fetchUserClips();
    }, [userId]),
  );

  const fetchUserClips = async () => {
    if (!hasLoadedRef.current) onLoadingChange?.(true);
    try {
      if (userId) {
        const clipsData = await fetchClips({ limit: 25, userId: userId });
        if (clipsData.documents.length > 0) {
          setClips(clipsData.documents);
          setLastId(clipsData.documents[clipsData.documents.length - 1].$id);
          setHasMore(clipsData.documents.length < clipsData.total);
        }
      }
    } catch (error) {
      console.log("fetchClipsError", error);
    } finally {
      if (!hasLoadedRef.current) {
        hasLoadedRef.current = true;
        onLoadingChange?.(false);
      }
    }
  };

  const fetchMoreClips = async () => {
    if (!lastId || !hasMore) return;
    const clipsData = await fetchClips({ limit: 25, userId: userId, lastId: lastId });
    const uniqueClips = clipsData.documents.filter((clip) => !clips.some((existing) => existing.$id === clip.$id));
    if (uniqueClips.length === 0) {
      setHasMore(false);
      return;
    }
    const updatedFetchedClips = [...clips, ...uniqueClips];
    setClips(updatedFetchedClips);
    setLastId(clipsData.documents[clipsData.documents.length - 1].$id);
    if (updatedFetchedClips >= clipsData.total) setHasMore(false);
  };

  const handleScrollToIndexFailed = useCallback(({ averageItemLength, index }) => {
    const offset = Math.max(0, averageItemLength * index);
    effectiveListRef.current?.scrollToOffset?.({ offset, animated: true });
  }, []);

  const renderListHeader = () => (
    <View style={{ paddingTop: contentPaddingTop }}>
      {headerComponent}
      {sectionTitle ? (
        <Text className="mb-2 text-xl font-bold" style={{ color: theme.text }}>
          {sectionTitle}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View className="flex-1">
      <StyledFlatList
        ref={effectiveListRef}
        data={clips}
        numColumns={3}
        nestedScrollEnabled={nestedScrollEnabled}
        ListHeaderComponent={renderListHeader}
        columnWrapperStyle={{ gap: 8, paddingHorizontal: 4 }}
        onRefresh={fetchUserClips}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => (
          <ClipCard customHeight={270} customWidth={Math.max(width / 3) - 35} item={{ ...item, created_time: item.$createdAt }} key={item?.$id} />
        )}
        keyExtractor={(item, index) => item.$id ?? index.toString()}
        ListEmptyComponent={
          suppressEmptyState ? null : (
            <View className="flex-1 items-center justify-center px-4 py-12">
              <MaterialCommunityIcons name="movie-open-outline" size={48} color={theme.textSoft} />
              <Text className="mt-4 font-sans text-lg font-semibold" style={{ fontFamily: "Poppins-SemiBold", color: theme.text }}>
                No Clips Yet
              </Text>
              <Text className="mt-2 text-center font-sans text-sm" style={{ fontFamily: "Poppins-Regular", color: theme.textSoft }}>
                {isLoggedInUser
                  ? "You haven't created any clips yet.\nStart creating and share your first clip!"
                  : "This user hasn't created any clips yet."}
              </Text>
            </View>
          )
        }
        scrollToTopStyle={{ bottom: 5 }}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingBottom: 50 }}
        onScrollToIndexFailed={handleScrollToIndexFailed}
        ListFooterComponent={null}
        onEndReached={fetchMoreClips}
      />
    </View>
  );
};

export default ProfileClipsTab;
