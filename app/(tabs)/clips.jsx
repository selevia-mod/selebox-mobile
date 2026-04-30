// TEMPORARY MAINTENANCE MODE - All original code commented out below

import { FontAwesome6, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import React from "react";
import { Alert, Animated, Easing, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ClipsIcon } from "../../assets/svgs";
import { StyledSafeAreaView, StyledTitle } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import useIsOffline from "../../hooks/useIsOffline";

const Clips = () => {
  const { theme } = useAppTheme();
  const { user } = useGlobalContext();
  const isOffline = useIsOffline();
  const insets = useSafeAreaInsets();
  const rotateValue = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(rotateValue, {
          toValue: 1,
          duration: 2000,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.timing(rotateValue, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    ).start();
  }, []);

  const rotate = rotateValue.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  return (
    <StyledSafeAreaView style={{ backgroundColor: theme.background }}>
      {/* Header */}
      <View className="absolute left-0 right-0 top-4 z-10 px-4" style={{ top: insets.top }}>
        <View className="flex-row items-center justify-between">
          <StyledTitle icon={<ClipsIcon width={24} height={20} color={theme.icon} />} title="Clips" titleStyle={{ color: theme.text }} />
          <View className="flex-row items-center space-x-4">
            <TouchableOpacity
              onPress={() => {
                if (isOffline) return Alert.alert("You're Offline", "Please connect to the internet to access your profile.");
                router.push("/profile");
              }}
            >
              <FastImage
                style={{ height: 35, width: 35, borderRadius: 5, backgroundColor: theme.surfaceMuted }}
                source={{ uri: user?.avatar, priority: FastImage.priority.normal }}
              />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Maintenance Mode Content */}
      <View className="flex-1 items-center justify-center px-6">
        <View className="items-center">
          {/* Maintenance Icon */}
          <FontAwesome6 name="screwdriver-wrench" size={80} color={theme.accentAmber} />

          {/* Maintenance Text */}
          <Text className="mt-8 text-center font-pextrabold text-4xl font-bold" style={{ color: theme.text }}>
            MAINTENANCE MODE
          </Text>

          {/* Subtitle */}
          <View className="mt-6 flex-row items-center space-x-2">
            <MaterialCommunityIcons name="clock-outline" size={20} color={theme.textSubtle} />
            <Text className="text-center text-base" style={{ color: theme.textSoft }}>
              We'll be back soon
            </Text>
          </View>
        </View>
      </View>
    </StyledSafeAreaView>
  );
};

export default Clips;

{
  /* ========== ORIGINAL CODE COMMENTED OUT BELOW ========== */
}
{
  /* 
      import { useFocusEffect } from "@react-navigation/native";
      import { FlashList } from "@shopify/flash-list";
      import { router, useLocalSearchParams } from "expo-router";
      import React, { useCallback, useEffect, useRef, useState } from "react";
      import { Dimensions, Platform, TouchableOpacity, View } from "react-native";
      import FastImage from "react-native-fast-image";
      import { NativeAd, TestIds } from "react-native-google-mobile-ads";
      import { useSafeAreaInsets } from "react-native-safe-area-context";
      import Share from "react-native-share";
      import { ClipsIcon } from "../../assets/svgs";
      import { ClipCommentModal, ClipItem, Loader, StyledSafeAreaView, StyledTitle } from "../../components";
      import ClipNativeAd from "../../components/ClipNativeAd";
      import { useGlobalContext } from "../../context/global-provider";
      import { fetchRandomClips } from "../../lib/clips";
      import secrets from "../../private/secrets";

      const { height: SCREEN_HEIGHT } = Dimensions.get("window");

      const Clips = () => {
        const { showClip, showClipTrigger } = useLocalSearchParams();
        const { user, globalSettings, allClipsLength } = useGlobalContext();
        const [clips, setClips] = useState([]);
        const [clipsLoading, setClipsLoading] = useState(true);
        const [currentIndex, setCurrentIndex] = useState(0);
        const [isCommentModalVisible, setCommentModalVisible] = useState(false);
        const playerRefs = useRef([]);
        const currentIndexRef = useRef(0);
        const insets = useSafeAreaInsets();
        const viewableTimeout = useRef(null);
        const fetchedIdsRef = useRef(new Set());
        const CLIPS_BEFORE_AD_LIMIT = Number(globalSettings["CLIPS_BEFORE_AD_LIMIT"] || 5);
        const listRef = useRef(null);
        const productionID = Platform.OS === "android" ? globalSettings["ANDROID_NATIVE_AD_PROD_ID"] : globalSettings["IOS_NATIVE_AD_PROD_ID"];
        const adUnitID = __DEV__ ? TestIds.NATIVE : productionID;

        const fetchNativeAd = async () => {
          try {
            const ad = await NativeAd.createForAdRequest(adUnitID);
            if (ad?.headline) return ad;
          } catch (e) {
            console.warn("Ad failed to load:", e);
          }
          return null;
        };

        const insertAdPlaceholders = async (clips) => {
          const result = [];

          for (let index = 0; index < clips.length; index++) {
            const clip = clips[index];
            result.push(clip);

            if ((index + 1) % CLIPS_BEFORE_AD_LIMIT === 0) {
              const ad = await fetchNativeAd();
              if (ad) {
                result.push({
                  type: "ad",
                  key: `ad-${clip.$id || index}`,
                  nativeAd: ad,
                });
              }
            }
          }

          return result;
        };

        const loadRandomClips = useCallback(async () => {
          if (!allClipsLength || fetchedIdsRef.current.size >= allClipsLength) return;

          try {
            const limit = 5;
            let newClips = [];

            for (let attempts = 0; attempts < 10 && newClips.length < limit; attempts++) {
              const remaining = allClipsLength - fetchedIdsRef.current.size;
              if (remaining <= 0) break;

              const result = await fetchRandomClips({ limit, allClipsLength });
              const filtered = result.documents.filter((clip) => !fetchedIdsRef.current.has(clip.$id));

              for (const clip of filtered) {
                if (!fetchedIdsRef.current.has(clip.$id)) {
                  newClips.push(clip);
                  fetchedIdsRef.current.add(clip.$id);
                }

                if (newClips.length >= limit) break;
              }
            }

            if (newClips.length) {
              // const insertedNewClips = await insertAdPlaceholders(newClips);
              setClips((prev) => [...prev, ...newClips]);
            }
          } catch (err) {
            console.error("loadRandomClips failed:", err);
          } finally {
            setClipsLoading(false);
          }
        }, [allClipsLength]);

        const handleCommentPress = () => setCommentModalVisible(true);

        const handleSharePress = async (item) => {
          await Share.open({
            message: `Check out this clip!`,
            url: `${secrets.WEBSITE}/clips/${item?.$id}`,
            title: `${item?.title}`,
            type: "url",
          });
        };

        const fetchMoreClips = async () => {
          try {
            loadRandomClips();
          } catch (error) {
            console.error("Failed to fetch more clips:", error);
          }
        };

        useEffect(() => {
          loadRandomClips();
        }, [allClipsLength]);

        useEffect(() => {
          if (!showClip) return;

          const clip = JSON.parse(showClip);
          if (!clip?.$id) return;

          const existingIndex = clips.findIndex((c) => c?.$id === clip.$id);
          const updatedClips = existingIndex !== -1 ? [clips[existingIndex]] : [clip];

          setClips(updatedClips);
          setCurrentIndex(0);
          currentIndexRef.current = 0;

          // Scroll after state update
          setTimeout(() => {
            listRef.current?.scrollToIndex({ index: 0, animated: true });
          }, 0);
        }, [showClip, showClipTrigger]);

        useEffect(() => {
          return () => {
            playerRefs.current = [];
          };
        }, []);

        useFocusEffect(
          useCallback(() => {
            playerRefs.current[currentIndex]?.play?.();
            return () => playerRefs.current.forEach((ref) => ref?.pause?.());
          }, [currentIndex]),
        );

        const onViewableItemsChanged = useCallback(({ viewableItems }) => {
          if (!viewableItems?.length) return;

          const newIndex = viewableItems[0]?.index ?? 0;
          const prevIndex = currentIndexRef.current;

          if (newIndex === prevIndex && playerRefs.current[newIndex]?.play) {
            // This ensures the first video plays even if index hasn't changed
            playerRefs.current[newIndex].play();
            return;
          }

          currentIndexRef.current = newIndex;
          setCurrentIndex(newIndex);

          // Immediately pause all videos that aren't in view
          playerRefs.current.forEach((ref, idx) => {
            if (ref && idx !== newIndex) {
              ref?.pause?.();
            }
          });

          // Debounce logic: clear previous timeout for play
          if (viewableTimeout.current) {
            clearTimeout(viewableTimeout.current);
          }

          // Delay play for the new index
          viewableTimeout.current = setTimeout(() => {
            const refToPlay = playerRefs.current[newIndex];
            refToPlay?.play?.();
          }, 80); // Delay just the play, adjust as needed
        }, []);

        const viewabilityConfigCallbackPairs = useRef([
          {
            viewabilityConfig: { itemVisiblePercentThreshold: 80, minimumViewTime: 200 },
            onViewableItemsChanged,
          },
        ]);

        const updateClipCommentCount = (clipId, newCount) => {
          setClips((prevClips) => prevClips.map((clip) => (clip.$id === clipId ? { ...clip, clipComments: newCount } : clip)));
        };

        const renderItem = ({ item, index }) => {
          if (!item) return null;
          if (item.type === "ad") {
            return <ClipNativeAd index={index} nativeAd={item.nativeAd} />;
          }

          return (
            <ClipItem
              isVisible={index === currentIndexRef?.current}
              ref={(ref) => (playerRefs.current[index] = ref)}
              item={item}
              onCommentPress={handleCommentPress}
              onSharePress={handleSharePress}
            />
          );
        };

        return (
          <StyledSafeAreaView className="bg-black">
            <Loader isLoading={clipsLoading} />

            <View className="absolute left-0 right-0 top-4 z-10 px-4" style={{ top: insets.top }}>
              <View className="flex-row items-center justify-between">
                <StyledTitle icon={<ClipsIcon width={24} height={20} color="#fff" />} title="Clips" />
                <View className="flex-row items-center space-x-4">
                  <TouchableOpacity onPress={() => router.push("/profile")}>
                    <FastImage
                      style={{ height: 35, width: 35, borderRadius: 5, backgroundColor: "#fff" }}
                      source={{ uri: user?.avatar, priority: FastImage.priority.normal }}
                    />
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            <View className="h-full w-full">
              <FlashList
                ref={listRef}
                data={clips}
                keyExtractor={(item, index) => item?.$id || index.toString()}
                renderItem={renderItem}
                scrollEventThrottle={16}
                decelerationRate="fast"
                bounces={false}
                showsVerticalScrollIndicator={false}
                snapToInterval={SCREEN_HEIGHT}
                snapToAlignment="start"
                getItemLayout={(_, index) => ({
                  length: SCREEN_HEIGHT,
                  offset: SCREEN_HEIGHT * index,
                  index,
                })}
                estimatedItemSize={SCREEN_HEIGHT}
                viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs.current}
                onEndReached={fetchMoreClips}
                onEndReachedThreshold={0.6}
              />
            </View>

            <ClipCommentModal
              isVisible={isCommentModalVisible}
              onClose={() => setCommentModalVisible(false)}
              item={clips[currentIndex]}
              onCommentPosted={(newCount) => updateClipCommentCount(clips[currentIndex].$id, newCount)}
            />
          </StyledSafeAreaView>
        );
      };
      */
}
