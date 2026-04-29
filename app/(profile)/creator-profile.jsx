import { Feather, MaterialIcons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { Profile, StyledSafeAreaView, StyledTitle } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { filterVideosByOwner } from "../../lib/appwrite";
import { listBlockedUsers, unblockUser } from "../../lib/safety";
import { getUserByID } from "../../lib/users";
import { VideosService } from "../../lib/video";

const CreatorProfile = () => {
  const { userId } = useLocalSearchParams();
  const { allVideos, user: viewer } = useGlobalContext();
  const { theme } = useAppTheme();
  const [user, setUser] = useState();
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);
  const videosService = useRef(new VideosService()).current;
  const hasLoadedOnce = useRef(false);

  const hydrateCachedVideos = useCallback(() => {
    if (!allVideos?.length || !userId) return [];
    const cachedVideos = filterVideosByOwner(allVideos, userId);
    if (cachedVideos.length) {
      setVideos(cachedVideos);
    }
    return cachedVideos;
  }, [allVideos, userId]);

  const fetchUserAndVideos = useCallback(async () => {
    if (!userId) return;
    const cachedVideos = hydrateCachedVideos();
    if (!hasLoadedOnce.current) setLoading(!cachedVideos.length);
    setIsRefreshing(true);

    try {
      const [userData, videosData] = await Promise.all([
        getUserByID({ ID: userId }),
        videosService.fetchVideos({ userId, limit: 50, status: "published" }),
      ]);

      setUser(userData);
      setVideos(videosData?.documents?.length ? videosData.documents : cachedVideos);
    } catch (error) {
      console.log("fetchUserAndVideos: error", error);
      if (!videos.length) {
        setVideos(cachedVideos);
      }
    } finally {
      setLoading(false);
      setIsRefreshing(false);
      hasLoadedOnce.current = true;
    }
  }, [hydrateCachedVideos, userId, videos.length, videosService]);

  useFocusEffect(
    useCallback(() => {
      fetchUserAndVideos();

      const checkBlocked = async () => {
        if (!viewer?.$id || !userId) return;
        try {
          const blocked = await listBlockedUsers({ blockerId: viewer.$id });
          setIsBlocked(blocked.includes(userId));
        } catch (err) {
          setIsBlocked(false);
        }
      };

      checkBlocked();
    }, [fetchUserAndVideos, userId, viewer?.$id]),
  );

  return (
    <StyledSafeAreaView>
      <View className="h-full w-full px-4 pb-5">
        <View className="align-start h-[50px] flex-row items-center justify-between">
          <TouchableOpacity
            activeOpacity={0.7}
            className="h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.surfaceMuted }}
            onPress={() => {
              router.back();
            }}
          >
            <MaterialIcons name="arrow-back" size={24} color={theme.icon} />
          </TouchableOpacity>
          <View className="flex-row items-center space-x-2">
            <StyledTitle className="py-0" icon={<MaterialIcons name="person" size={24} color={theme.icon} />} title={"Creator Profile"} />
          </View>
          <TouchableOpacity disabled style={{ opacity: 0 }} activeOpacity={0.7} onPress={() => router.push("/edit-profile")}>
            <Feather name="settings" size={22} color={theme.icon} />
          </TouchableOpacity>
        </View>
        {isBlocked ? (
          <View className="mt-10 items-center">
            <MaterialIcons name="block" size={56} color="#ef4444" />
            <View className="mt-3 items-center">
              <StyledTitle className="py-0" title="You blocked this user" />
              <TouchableOpacity
                className="mt-3 rounded-full px-4 py-2"
                style={{ backgroundColor: theme.surfaceMuted }}
                onPress={async () => {
                  try {
                    await unblockUser({ blockerId: viewer.$id, blockedUserId: userId });
                    setIsBlocked(false);
                    fetchUserAndVideos();
                  } catch (err) {
                    console.log("unblock error", err);
                  }
                }}
              >
                <Text className="text-base font-semibold" style={{ color: theme.text }}>
                  Unblock
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <Profile user={user} videos={videos} isLoadingProfile={loading || !user} />
        )}
      </View>
    </StyledSafeAreaView>
  );
};

export default CreatorProfile;
