import { Audio } from "expo-av";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, Dimensions, PanResponder, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { useDispatch, useSelector } from "react-redux";

import { CustomAlertModal, StoryBottomBar, StoryCubeFaces, StoryHeader, StyledSafeAreaView } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import storyEvents from "../../lib/story-events";
import { StoryService } from "../../lib/story-service";
import { useModalMessage } from "../../hooks/useModalMessage";
import { isViewerStoryCacheFresh, selectViewerStoryCacheEntry, setViewerStories } from "../../store/reducers/story";

// --------------------------------------------------
// Constants
// --------------------------------------------------
const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
const MAX_VIDEO_DURATION = 30000;
const LONG_PRESS_THRESHOLD = 300;
const READY_VIDEO_STATUSES = new Set(["ready", "published"]);

// --------------------------------------------------
// Component
// --------------------------------------------------
const StoryViewer = () => {
  const { globalSettings } = useGlobalContext();
  let imageDurationMs = (globalSettings["STORY_IMAGE_DURATION"] || 10) * 1000 || 10000;

  const dispatch = useDispatch();

  // Params
  const { uploaderId, startAtOwnStories, viewerId } = useLocalSearchParams();
  const viewerUserId = viewerId ?? null;

  const clickedOwnStory = startAtOwnStories === "1" && uploaderId && viewerUserId && uploaderId === viewerUserId;

  const cacheKey = viewerUserId || "anonymous";
  const cacheEntry = useSelector((state) => selectViewerStoryCacheEntry(state, cacheKey));

  const { message, messageOpen, showMessage, closeMessage } = useModalMessage();

  // --------------------------------------------------
  // State
  // --------------------------------------------------
  const [users, setUsers] = useState([]);
  const [currentUserIndex, setCurrentUserIndex] = useState(0);
  const [currentStoryIndex, setCurrentStoryIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [storyMusic, setStoryMusic] = useState(null);
  const musicRef = useRef(null);
  const musicLoadIdRef = useRef(0);

  // NEW: Prevent music creation when viewer is closing
  const closingRef = useRef(false);

  const [storyStats, setStoryStats] = useState({
    totalLikes: 0,
    totalViews: 0,
  });
  const [hasLiked, setHasLiked] = useState(false);
  const [hasViewed, setHasViewed] = useState(false);

  // --------------------------------------------------
  // Refs
  // --------------------------------------------------
  const usersRef = useRef([]);
  const currentUserIndexRef = useRef(0);
  const pausedRef = useRef(false);
  const lastStoryIndexRef = useRef({});
  const videoLoadedRef = useRef(false);
  const cacheEntryRef = useRef(cacheEntry);

  const [paused, setPaused] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const progressValueRef = useRef(0);
  const currentDurationRef = useRef(imageDurationMs);
  const progressAnimRef = useRef(null);

  const cubeAnim = useRef(new Animated.Value(0)).current;
  const [availabilityChecked, setAvailabilityChecked] = useState(false);

  const longPressTimeout = useRef(null);
  const gestureRef = useRef({
    startX: 0,
    startY: 0,
    isLongPress: false,
    isSwipe: false,
  });

  // Helper is hoisted (function) so it can be used before declaration
  function isVideoReady(story) {
    if (!story || story.type !== "video") return true;
    return READY_VIDEO_STATUSES.has(story.status);
  }

  // --------------------------------------------------
  // Memos
  // --------------------------------------------------
  const currentUser = useMemo(() => (users.length ? users[currentUserIndex] : null), [users, currentUserIndex]);

  const currentStory = useMemo(() => {
    if (!currentUser) return null;
    return currentUser.stories[currentStoryIndex] ?? null;
  }, [currentUser, currentStoryIndex]);

  const prevUser = useMemo(() => (currentUserIndex > 0 ? users[currentUserIndex - 1] : null), [users, currentUserIndex]);
  const nextUser = useMemo(() => (currentUserIndex < users.length - 1 ? users[currentUserIndex + 1] : null), [users, currentUserIndex]);

  // --------------------------------------------------
  // Track last opened story index per user
  // --------------------------------------------------
  useEffect(() => {
    if (currentUser?.userId) {
      lastStoryIndexRef.current[currentUser.userId] = currentStoryIndex;
    }
  }, [currentUser?.userId, currentStoryIndex]);

  useEffect(() => {
    usersRef.current = users;
  }, [users]);

  useEffect(() => {
    currentUserIndexRef.current = currentUserIndex;
  }, [currentUserIndex]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    cacheEntryRef.current = cacheEntry;
  }, [cacheEntry]);

  // --------------------------------------------------
  // Audio helpers
  // --------------------------------------------------
  const stopAndUnloadSound = useCallback(async (sound) => {
    if (!sound) return;

    try {
      await sound.stopAsync?.();
    } catch {}

    try {
      await sound.unloadAsync?.();
    } catch {}
  }, []);

  const stopAndUnloadCurrentMusic = useCallback(async () => {
    const activeSound = musicRef.current;
    musicRef.current = null;

    await stopAndUnloadSound(activeSound);
  }, [stopAndUnloadSound]);

  // --------------------------------------------------
  // SAFE CLOSE — Blocks music creation & unloads audio
  // --------------------------------------------------
  const safeClose = useCallback(() => {
    closingRef.current = true;
    musicLoadIdRef.current += 1;

    void stopAndUnloadCurrentMusic();

    router.back();
  }, [stopAndUnloadCurrentMusic]);

  // --------------------------------------------------
  // Cleanup on unmount
  // --------------------------------------------------
  useEffect(() => {
    return () => {
      musicLoadIdRef.current += 1;
      void stopAndUnloadCurrentMusic();
    };
  }, [stopAndUnloadCurrentMusic]);

  // Cleanup on blur (Expo Router keeps components mounted)
  useFocusEffect(
    useCallback(() => {
      return () => {
        musicLoadIdRef.current += 1;
        void stopAndUnloadCurrentMusic();
      };
    }, [stopAndUnloadCurrentMusic]),
  );

  // --------------------------------------------------
  // Video setup
  // --------------------------------------------------
  const videoPlayer = useVideoPlayer(currentStory?.type === "video" && isVideoReady(currentStory) ? currentStory.mediaUrl : null, (player) => {
    videoLoadedRef.current = false;

    if (currentStory?.type === "video" && isVideoReady(currentStory)) {
      player.loop = false;
      player.controls = false;

      player.addListener("statusChange", (status) => {
        if (status.status === "readyToPlay" && !videoLoadedRef.current) {
          if (!pausedRef.current && !gestureRef.current.isLongPress) {
            videoLoadedRef.current = true;
            currentDurationRef.current = player.duration;
            player.play();
            startProgressAnimation();
          }
        }
      });
    }
  });

  useEffect(() => {
    if (!videoPlayer) return;

    if (paused) {
      videoPlayer.pause?.();
    } else {
      videoPlayer.play?.();
    }

    if (videoLoadedRef.current && !pausedRef.current && !gestureRef.current.isLongPress) {
      try {
        videoPlayer.replay();
        videoPlayer.play();
      } catch (e) {}
    }
  }, [paused, videoPlayer, currentStory?.id]);

  // --------------------------------------------------
  // Helpers
  // --------------------------------------------------
  const isActiveStory = (story) => {
    const now = new Date();
    if (story.expiresAt) return new Date(story.expiresAt) > now;

    return now - new Date(story.createdAt) <= 24 * 60 * 60 * 1000;
  };

  const getSavedIndex = (user) => (user ? (lastStoryIndexRef.current[user.userId] ?? 0) : 0);

  const sanitizeGroupedStories = (grouped) => {
    if (!grouped) return {};
    const result = {};
    Object.entries(grouped).forEach(([userId, storiesForUser]) => {
      const cleaned = (storiesForUser || []).filter((s) => {
        if (!s || !s.user?.id) return false;
        if (!isActiveStory(s)) return false;
        if (s.status === "deleted") return false;
        if (s.type === "video" && !READY_VIDEO_STATUSES.has(s.status)) return false;
        return true;
      });
      if (cleaned.length) {
        result[userId] = cleaned;
      }
    });
    return result;
  };

  // --------------------------------------------------
  // Like toggle
  // --------------------------------------------------
  const toggleLike = async () => {
    if (!currentStory || !viewerUserId) return;

    if (hasLiked) {
      const likedDoc = await StoryService.checkIfUserLiked(currentStory.id, viewerUserId);
      if (likedDoc) {
        setHasLiked(false);
        await StoryService.unlikeStory(likedDoc.$id);
        setStoryStats((prev) => ({ ...prev, totalLikes: prev.totalLikes - 1 }));
      }
    } else {
      setHasLiked(true);
      await StoryService.likeStory(currentStory.id, viewerUserId);
      setStoryStats((prev) => ({ ...prev, totalLikes: prev.totalLikes + 1 }));
    }
  };

  // --------------------------------------------------
  // Load all stories
  // --------------------------------------------------
  const loadAllStories = useCallback(
    async ({ forceNetwork = false } = {}) => {
      if (!viewerUserId) {
        setUsers([]);
        setLoading(false);
        return;
      }

      try {
        setLoading(true);

        // Always try network first to avoid stale/deleted stories
        let groupedObj = null;
        try {
          const grouped = await StoryService.fetchViewerStories({
            viewerId: viewerUserId,
            limit: 200,
            offset: 0,
          });
          groupedObj = sanitizeGroupedStories(grouped) || {};
          dispatch(
            setViewerStories({
              viewerId: cacheKey,
              grouped: groupedObj,
            }),
          );
        } catch (networkErr) {
          console.log("Network fetch failed, falling back to cache", networkErr);
          if (!forceNetwork && cacheEntryRef.current && isViewerStoryCacheFresh(cacheEntryRef.current)) {
            groupedObj = sanitizeGroupedStories(cacheEntryRef.current.grouped);
          }
        }

        if (!groupedObj) groupedObj = {};

        let userGroups = Object.values(groupedObj)
          .map((storiesForUser) => {
            const activeStories = (storiesForUser || []).filter(isActiveStory);
            if (!activeStories.length) return null;

            activeStories.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            const first = activeStories[0];
            return {
              userId: first.user?.id,
              name: first.user?.name || "Unknown User",
              avatar: first.user?.avatar ?? null,
              stories: activeStories,
            };
          })
          .filter(Boolean);

        userGroups.sort((a, b) => {
          const lastA = a.stories[a.stories.length - 1];
          const lastB = b.stories[b.stories.length - 1];
          return new Date(lastB.createdAt) - new Date(lastA.createdAt);
        });

        if (clickedOwnStory && viewerUserId) {
          const idx = userGroups.findIndex((u) => u.userId === viewerUserId);
          if (idx > 0) {
            const [ownGroup] = userGroups.splice(idx, 1);
            userGroups.unshift(ownGroup);
          }
        } else if (uploaderId) {
          const idx = userGroups.findIndex((u) => u.userId === uploaderId);
          if (idx > 0) {
            const [clickedGroup] = userGroups.splice(idx, 1);
            userGroups.unshift(clickedGroup);
          }
        }

        setUsers(userGroups);
        setCurrentUserIndex(0);
        setCurrentStoryIndex(0);
      } catch (err) {
        console.log("loadAllStories error:", err);
      } finally {
        setLoading(false);
      }
    },
    [cacheKey, clickedOwnStory, dispatch, uploaderId, viewerUserId],
  );

  // Load stories when dependencies change (but not when cacheEntry changes, since it's now a ref)
  useEffect(() => {
    loadAllStories();
  }, [loadAllStories]);

  // Re-check availability once if story becomes missing
  useEffect(() => {
    if (loading) return;
    const missing = !currentUser || !currentStory;
    if (missing && !availabilityChecked) {
      setAvailabilityChecked(true);
      loadAllStories({ forceNetwork: true });
    } else if (!missing && availabilityChecked) {
      setAvailabilityChecked(false);
    }
  }, [loading, currentUser, currentStory, availabilityChecked, loadAllStories]);

  // --------------------------------------------------
  // Stats + Music
  // --------------------------------------------------
  useEffect(() => {
    if (!currentStory || !viewerUserId || closingRef.current) return;
    const loadId = ++musicLoadIdRef.current;
    let disposed = false;

    const fetchStats = async () => {
      try {
        const _hasViewed = await StoryService.checkIfUserViewed(currentStory.id, viewerUserId);
        if (disposed || closingRef.current || loadId !== musicLoadIdRef.current) return;
        setHasViewed(_hasViewed);

        const likedDoc = await StoryService.checkIfUserLiked(currentStory.id, viewerUserId);
        if (disposed || closingRef.current || loadId !== musicLoadIdRef.current) return;
        setHasLiked(!!likedDoc);

        if (!_hasViewed && currentStory.user.id !== viewerUserId) {
          await StoryService.createView(currentStory.id, viewerUserId);
          if (disposed || closingRef.current || loadId !== musicLoadIdRef.current) return;
          setHasViewed(true);

          setStoryStats((prev) => ({
            ...prev,
            totalViews: prev.totalViews + 1,
          }));
        }
      } catch (error) {
        console.log("fetchStats error:", error);
      }
    };

    const loadMusic = async () => {
      let createdSound = null;

      try {
        if (closingRef.current) return;

        await stopAndUnloadCurrentMusic();
        if (disposed || closingRef.current || loadId !== musicLoadIdRef.current) return;

        if (!currentStory?.musicId) {
          setStoryMusic(null);
          return;
        }

        const musicDoc = await StoryService.fetchMusic(currentStory.musicId);
        if (disposed || closingRef.current || loadId !== musicLoadIdRef.current) return;

        setStoryMusic(musicDoc);

        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        if (disposed || closingRef.current || loadId !== musicLoadIdRef.current) return;

        const { sound } = await Audio.Sound.createAsync(
          { uri: musicDoc.fileUrl },
          { shouldPlay: !pausedRef.current && !closingRef.current, isLooping: true },
        );
        createdSound = sound;

        if (disposed || closingRef.current || loadId !== musicLoadIdRef.current) return;

        musicRef.current = sound;
      } catch (error) {
        console.log("loadMusic error:", error);
      } finally {
        if (createdSound && (disposed || closingRef.current || loadId !== musicLoadIdRef.current)) {
          await stopAndUnloadSound(createdSound);
        }
      }
    };

    fetchStats();
    void loadMusic();

    return () => {
      disposed = true;

      if (loadId === musicLoadIdRef.current) {
        musicLoadIdRef.current += 1;
      }

      void stopAndUnloadCurrentMusic();
    };
  }, [currentStory?.id, currentStory?.musicId, currentStory?.user?.id, viewerUserId, stopAndUnloadCurrentMusic, stopAndUnloadSound]);

  // --------------------------------------------------
  // Pause / Resume
  // --------------------------------------------------
  const pauseStory = useCallback(() => {
    if (pausedRef.current) return;
    setPaused(true);

    musicRef.current?.pauseAsync();

    if (currentStory?.type === "video" && isVideoReady(currentStory)) {
      videoPlayer?.pause();
    }

    progress.stopAnimation((v) => (progressValueRef.current = v ?? 0));
  }, [currentStory?.type, currentStory?.status, videoPlayer, progress]);

  const resumeStory = useCallback(() => {
    if (!pausedRef.current) return;
    setPaused(false);

    musicRef.current?.playAsync();

    if (videoLoadedRef.current && currentStory?.type === "video" && isVideoReady(currentStory)) {
      try {
        videoPlayer.play();
      } catch (e) {}
    }

    const remaining = 1 - progressValueRef.current;
    const remainingMs = remaining * currentDurationRef.current;

    if (remaining <= 0) return handleNextStory();

    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: remainingMs,
      useNativeDriver: false,
    });

    progressAnimRef.current = anim;

    anim.start(({ finished }) => {
      if (finished && !pausedRef.current) handleNextStory();
    });
  }, [currentStory?.type, currentStory?.status]);

  // --------------------------------------------------
  // Story Navigation
  // --------------------------------------------------
  const handleNextStory = useCallback(() => {
    if (closingRef.current) return;

    const userIdx = currentUserIndexRef.current;
    const usersLocal = usersRef.current;
    const user = usersLocal[userIdx];
    if (!user) return;

    setCurrentStoryIndex((prev) => {
      const nextIndex = prev + 1;

      if (nextIndex < user.stories.length) return nextIndex;

      const nextUserIndex = userIdx + 1;
      if (nextUserIndex < usersLocal.length) {
        setCurrentUserIndex(nextUserIndex);
        return 0; // FIXED: Always start at first story when auto-advancing to next user
      }

      safeClose();
      return prev;
    });
  }, []);

  const handlePrevStory = useCallback(() => {
    if (closingRef.current) return;

    const userIdx = currentUserIndexRef.current;
    const usersLocal = usersRef.current;
    const user = usersLocal[userIdx];
    if (!user) return;

    setCurrentStoryIndex((prev) => {
      const prevIndex = prev - 1;

      if (prevIndex >= 0) return prevIndex;

      const prevUserIndex = userIdx - 1;
      if (prevUserIndex >= 0) {
        const prevUser = usersLocal[prevUserIndex];
        setCurrentUserIndex(prevUserIndex);
        return prevUser.stories.length - 1; // FIXED: Always go to last story when tapping back to previous user
      }

      safeClose();
      return prev;
    });
  }, []);

  const handleTap = (x) => {
    if (closingRef.current) return;
    if (pausedRef.current || gestureRef.current.isLongPress) return;

    if (x < screenWidth / 2) handlePrevStory();
    else handleNextStory();
  };

  // --------------------------------------------------
  // Progress animation
  // --------------------------------------------------
  const startProgressAnimation = useCallback(() => {
    if (!currentStory || closingRef.current) return;

    let durationMs = imageDurationMs;

    if (currentStory.type === "video" && isVideoReady(currentStory)) {
      const backendMs = currentDurationRef.current * 1000 || MAX_VIDEO_DURATION;
      durationMs = Math.min(backendMs, MAX_VIDEO_DURATION);
    }

    currentDurationRef.current = durationMs;

    progressValueRef.current = 0;
    progress.setValue(0);

    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: durationMs,
      useNativeDriver: false,
    });

    progressAnimRef.current = anim;

    anim.start(({ finished }) => {
      if (finished && !pausedRef.current && !closingRef.current) handleNextStory();
    });
  }, [currentStory, imageDurationMs, handleNextStory]);

  useEffect(() => {
    if (!users.length || !currentStory || closingRef.current) return;

    if (currentStory.type === "video" && !isVideoReady(currentStory)) return;

    startProgressAnimation();
  }, [currentStory?.id, users.length]);

  // --------------------------------------------------
  // Gestures
  // --------------------------------------------------
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !closingRef.current,

      onPanResponderGrant: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;

        gestureRef.current = {
          startX: locationX,
          startY: locationY,
          isLongPress: false,
          isSwipe: false,
        };

        if (closingRef.current) return;

        longPressTimeout.current = setTimeout(() => {
          gestureRef.current.isLongPress = true;
          pauseStory();
        }, LONG_PRESS_THRESHOLD);
      },

      onPanResponderMove: (_, { dx, dy }) => {
        if (closingRef.current) return;

        if ((Math.abs(dx) > 10 || Math.abs(dy) > 10) && longPressTimeout.current) {
          clearTimeout(longPressTimeout.current);
          longPressTimeout.current = null;
        }

        if (!gestureRef.current.isSwipe && Math.abs(dx) > 35 && Math.abs(dy) < 40) {
          gestureRef.current.isSwipe = true;
        }

        if (gestureRef.current.isSwipe) {
          const t = Math.max(-1, Math.min(1, dx / screenWidth));
          cubeAnim.setValue(t);
        }
      },

      onPanResponderRelease: (_, { dx, dy, vx }) => {
        if (closingRef.current) return;

        if (longPressTimeout.current) {
          clearTimeout(longPressTimeout.current);
          longPressTimeout.current = null;
        }

        const { startX, isLongPress, isSwipe } = gestureRef.current;

        if (isLongPress) {
          resumeStory();
          return;
        }

        // Vertical swipe close
        if (!isSwipe) {
          const verticalThreshold = screenHeight * 0.18;
          const horizontalLimit = screenWidth * 0.2;

          if (Math.abs(dy) > verticalThreshold && Math.abs(dx) < horizontalLimit) {
            closingRef.current = true;
            safeClose();
            return;
          }
        }

        if (isSwipe) {
          const threshold = screenWidth * 0.25;
          const movedLeft = dx < -threshold || vx < -0.3;
          const movedRight = dx > threshold || vx > 0.3;

          const animateTo = (value, cb) => {
            Animated.timing(cubeAnim, {
              toValue: value,
              duration: 220,
              useNativeDriver: true,
            }).start(() => {
              cubeAnim.setValue(0);

              if (closingRef.current) return;

              if (cb) cb();
              else resumeStory();
            });
          };

          const userIdx = currentUserIndexRef.current;
          const usersLocal = usersRef.current;

          // Next user
          if (movedLeft) {
            if (userIdx < usersLocal.length - 1) {
              animateTo(-1, () => {
                if (closingRef.current) return;

                const nextUserIndex = userIdx + 1;
                const nextUser = usersLocal[nextUserIndex];
                const lastIndex = getSavedIndex(nextUser);

                setCurrentUserIndex(nextUserIndex);
                setCurrentStoryIndex(lastIndex);
              });
            } else {
              Animated.spring(cubeAnim, {
                toValue: 0,
                friction: 6,
                useNativeDriver: true,
              }).start(() => resumeStory());
            }
            return;
          }

          // Previous user
          if (movedRight) {
            if (userIdx > 0) {
              animateTo(1, () => {
                if (closingRef.current) return;

                const prevUserIndex = userIdx - 1;
                const prevUser = usersLocal[prevUserIndex];
                const lastIndex = getSavedIndex(prevUser) ?? prevUser.stories.length - 1;

                setCurrentUserIndex(prevUserIndex);
                setCurrentStoryIndex(lastIndex);
              });
            } else {
              Animated.spring(cubeAnim, {
                toValue: 0,
                friction: 6,
                useNativeDriver: true,
              }).start(() => resumeStory());
            }
            return;
          }

          Animated.spring(cubeAnim, {
            toValue: 0,
            friction: 7,
            useNativeDriver: true,
          }).start(() => resumeStory());

          return;
        }

        // TAP
        handleTap(startX);
      },
    }),
  ).current;

  // --------------------------------------------------
  // Render media
  // --------------------------------------------------
  const renderStoryMedia = (story, isCurrent) => {
    if (!story) return null;

    const mediaStyle = { width: "100%", height: "100%" };

    if (story.type === "image") {
      return <FastImage source={{ uri: story.mediaUrl }} style={mediaStyle} resizeMode="contain" />;
    }

    if (story.type === "video" && !isVideoReady(story)) {
      return <FastImage source={{ uri: story.thumbnail || story.mediaUrl }} style={mediaStyle} resizeMode="contain" />;
    }

    if (isCurrent) {
      return (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <VideoView
            style={styles.media}
            player={videoPlayer}
            nativeControls={false}
            allowsFullscreen={false}
            allowsPictureInPicture={false}
            contentFit="contain"
          />
        </View>
      );
    }

    return <FastImage source={{ uri: story.thumbnail || story.mediaUrl }} style={mediaStyle} resizeMode="contain" />;
  };

  // --------------------------------------------------
  // Delete story
  // --------------------------------------------------
  const doDeleteStory = async () => {
    if (!currentStory?.id) return;

    const storyToDelete = currentStory;
    const uploaderIdLocal = storyToDelete.user?.id;

    // Optimistic UI removal to avoid UI freeze while backend processes
    setUsers((prev) => {
      const next = prev
        .map((u) => ({
          ...u,
          stories: (u.stories || []).filter((s) => s.id !== storyToDelete.id),
        }))
        .filter((u) => u.stories.length > 0);
      return next;
    });

    storyEvents.emit("storyDeleted", {
      storyId: storyToDelete.id,
      uploaderId: uploaderIdLocal,
    });

    // Decide next story/user after optimistic removal
    const usersLocal = usersRef.current;
    const userIdx = currentUserIndexRef.current;
    const user = usersLocal[userIdx];
    if (!user || user.stories.length <= 1) {
      if (usersLocal.length <= 1) {
        safeClose();
      } else {
        const nextIdx = Math.min(userIdx, usersLocal.length - 2);
        setCurrentUserIndex(nextIdx);
        setCurrentStoryIndex(0);
      }
    } else {
      handleNextStory();
    }

    // Run backend cleanup in background
    (async () => {
      try {
        await Promise.allSettled([StoryService.deleteStoryMedia(storyToDelete), StoryService.deleteStory(storyToDelete.id)]);
      } catch (err) {
        console.log("Failed to delete story:", err);
      } finally {
        await loadAllStories({ forceNetwork: true });
      }
    })();
  };

  const askDelete = () => showMessage("Delete this story?", 0, doDeleteStory);

  // --------------------------------------------------
  // Render
  // --------------------------------------------------
  const handleUnavailableClose = () => {
    storyEvents.emit("storyDeleted", { storyId: null, uploaderId: null });
    loadAllStories({ forceNetwork: true });
    safeClose();
  };

  const missingStory = !currentUser || !currentStory;

  if (loading && missingStory) {
    return (
      <StyledSafeAreaView className="flex-1 items-center justify-center bg-black">
        <Text className="text-white">Loading stories…</Text>
      </StyledSafeAreaView>
    );
  }

  if (missingStory) {
    return (
      <StyledSafeAreaView className="flex-1 items-center justify-center bg-black">
        <Text className="text-white">Story not available.</Text>
        <TouchableOpacity className="mt-4 rounded-full bg-purple-600 px-4 py-2" onPress={handleUnavailableClose}>
          <Text className="font-semibold text-white">Go back</Text>
        </TouchableOpacity>
      </StyledSafeAreaView>
    );
  }

  const progressWidth = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  const prevStory = prevUser ? prevUser.stories[getSavedIndex(prevUser)] : null;
  const nextStory = nextUser ? nextUser.stories[getSavedIndex(nextUser)] : null;

  // CURRENT
  const currentFace = (
    <View style={styles.faceInner}>
      <View style={styles.headerArea}>
        <StoryHeader
          user={currentUser}
          story={currentStory}
          storyMusic={storyMusic}
          stories={currentUser.stories}
          currentStoryIndex={currentStoryIndex}
          progressWidth={progressWidth}
          onClose={safeClose}
          onDelete={askDelete}
          viewerUserId={viewerUserId}
        />
      </View>

      <View style={styles.mediaArea} {...panResponder.panHandlers}>
        <View style={styles.mediaFrame}>{renderStoryMedia(currentStory, true)}</View>
      </View>

      <View style={styles.bottomArea}>
        <StoryBottomBar
          isOwnStory={currentStory.user.id === viewerUserId}
          totalViews={currentStory?.storiesStats?.totalViews}
          totalLikes={currentStory?.storiesStats?.totalLikes}
          hasLiked={hasLiked}
          onToggleLike={toggleLike}
        />
      </View>

      {currentStory.type === "video" && !isVideoReady(currentStory) && currentStory.user.id === viewerUserId && (
        <View style={styles.processingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.processingText}>Video is still processing…</Text>
        </View>
      )}
    </View>
  );

  // PREVIOUS
  const prevFace =
    prevUser && prevStory ? (
      <View style={styles.faceInner}>
        <View style={styles.headerArea}>
          <StoryHeader
            user={currentUser}
            story={currentStory}
            storyMusic={storyMusic}
            stories={currentUser.stories}
            currentStoryIndex={currentStoryIndex}
            progressWidth={progressWidth}
            onClose={safeClose}
            onDelete={askDelete}
            viewerUserId={viewerUserId}
          />
        </View>

        <View style={styles.mediaArea}>
          <View style={styles.mediaFrame}>{renderStoryMedia(prevStory, false)}</View>
        </View>

        <View style={styles.bottomArea}>
          <StoryBottomBar
            isOwnStory={prevStory.user.id === viewerUserId}
            totalViews={prevStory?.storiesStats?.totalViews}
            totalLikes={prevStory?.storiesStats?.totalLikes}
            hasLiked={false}
            onToggleLike={() => {}}
          />
        </View>
      </View>
    ) : null;

  // NEXT
  const nextFace =
    nextUser && nextStory ? (
      <View style={styles.faceInner}>
        <View style={styles.headerArea}>
          <StoryHeader
            user={currentUser}
            story={currentStory}
            storyMusic={storyMusic}
            stories={currentUser.stories}
            currentStoryIndex={currentStoryIndex}
            progressWidth={progressWidth}
            onClose={safeClose}
            onDelete={askDelete}
            viewerUserId={viewerUserId}
          />
        </View>

        <View style={styles.mediaArea}>
          <View style={styles.mediaFrame}>{renderStoryMedia(nextStory, false)}</View>
        </View>

        <View style={styles.bottomArea}>
          <StoryBottomBar
            isOwnStory={nextStory.user.id === viewerUserId}
            totalViews={nextStory?.storiesStats?.totalViews}
            totalLikes={nextStory?.storiesStats?.totalLikes}
            hasLiked={false}
            onToggleLike={() => {}}
          />
        </View>
      </View>
    ) : null;

  return (
    <StyledSafeAreaView className="flex-1 bg-black">
      <View style={styles.root}>
        <StoryCubeFaces cubeAnim={cubeAnim} currentFace={currentFace} prevFace={prevFace} nextFace={nextFace} />
      </View>
      <CustomAlertModal message={message} iconName="trash" iconColor="#f87171" messageOpen={messageOpen} closeMessage={closeMessage} />
    </StyledSafeAreaView>
  );
};

// --------------------------------------------------
// Styles
// --------------------------------------------------
const styles = StyleSheet.create({
  root: {
    flex: 1,
    width: screenWidth,
    backgroundColor: "#020617",
  },

  faceInner: {
    flex: 1,
    backgroundColor: "#020617",
  },

  headerArea: {
    flex: 0.1,
  },

  mediaArea: {
    flex: 0.78,
    justifyContent: "center",
    alignItems: "center",
    marginTop: -20,
  },

  bottomArea: {
    flex: 0.12,
    justifyContent: "center",
    alignItems: "center",
    paddingBottom: 30,
  },

  mediaFrame: {
    width: "100%",
    height: "100%",
    justifyContent: "center",
    alignItems: "center",
  },

  media: {
    width: "100%",
    height: "100%",
    backgroundColor: "#020617",
  },

  processingOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 999,
  },

  processingText: {
    color: "#fff",
    marginTop: 8,
    fontSize: 14,
  },
});

export default StoryViewer;
