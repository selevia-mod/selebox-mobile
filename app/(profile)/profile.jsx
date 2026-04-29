import { Feather, MaterialIcons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { TouchableOpacity, View } from "react-native";
import { Profile as ProfileComponent, StyledSafeAreaView, StyledTitle } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { VideosService } from "../../lib/video";

const Profile = () => {
  const { user, allVideos } = useGlobalContext();
  const { theme } = useAppTheme();
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const videosService = useRef(new VideosService()).current;
  const hasLoadedOnce = useRef(false);

  const hydrateCachedVideos = useCallback(() => {
    if (!user?.$id || !allVideos?.length) return [];
    const cachedVideos = allVideos.filter((video) => video?.uploader === user.$id || video?.uploader?.uid === user.$id);
    if (cachedVideos.length) {
      setVideos(cachedVideos);
    }
    return cachedVideos;
  }, [allVideos, user?.$id]);

  const fetchUserVideos = useCallback(async () => {
    if (!user?.$id) {
      setLoading(false);
      return;
    }
    const cachedVideos = hydrateCachedVideos();
    if (!hasLoadedOnce.current) setLoading(!cachedVideos.length);
    setIsRefreshing(true);

    try {
      const videosData = await videosService.fetchVideos({ userId: user?.$id, limit: 100, status: "published" });
      setVideos(videosData.documents);
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
  }, [hydrateCachedVideos, user?.$id, videos.length, videosService]);

  useEffect(() => {
    hydrateCachedVideos();
  }, [hydrateCachedVideos]);

  useFocusEffect(
    useCallback(() => {
      fetchUserVideos();
    }, [fetchUserVideos]),
  );

  return (
    <StyledSafeAreaView>
      <View className="h-full w-full">
        <View className="flex-row items-center justify-between px-4 pb-2 pt-2">
          <TouchableOpacity
            activeOpacity={0.7}
            className="h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.surfaceMuted }}
            onPress={() => {
              router.back();
            }}
          >
            <MaterialIcons name="arrow-back" size={22} color={theme.icon} />
          </TouchableOpacity>
          <View className="flex-row items-center space-x-2">
            <StyledTitle className="py-0" icon={<MaterialIcons name="person" size={22} color={theme.icon} />} title={"My Profile"} />
          </View>
          <TouchableOpacity
            activeOpacity={0.7}
            className="h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.surfaceMuted }}
            onPress={() => router.push("/edit-profile")}
          >
            <Feather name="settings" size={20} color={theme.icon} />
          </TouchableOpacity>
        </View>
        <View className="flex-1 px-4 pb-5">
          <ProfileComponent user={user} videos={videos} isLoadingProfile={loading || !user} />
        </View>
      </View>
    </StyledSafeAreaView>
  );
};

export default Profile;
