import { Entypo } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useEffect, useState } from "react";
import { Image, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import LoaderKit from "react-native-loader-kit";
import Share from "react-native-share";
import { useBookStats } from "../context/book-stats-provider";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import secrets from "../private/secrets";
import AnimatedSkeleton from "./AnimatedSkeleton";
import PostBookStats from "./PostBookStats";
import UserRoleBadgeIcons from "./UserRoleBadgeIcons";

const PostBook = ({ item, forceUpdate, onOpenSafetySheet }) => {
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const { loadBookStats } = useBookStats();
  const [book, setBook] = useState(item);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [coverAspectRatio, setCoverAspectRatio] = useState(2 / 3);
  const isLoggedInUser = user?.$id === book?.uploader?.$id;
  const statusValue = (book?.status || "").toLowerCase();
  const statusColor = statusValue === "ongoing" ? theme.accentAmber : statusValue === "completed" ? theme.accentGreen : theme.textMuted;

  useEffect(() => {
    const loadBook = async () => {
      setLoading(true);
      setError(false);
      try {
        setBook(item);
      } catch (err) {
        console.error("Failed to fetch random book:", err);
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    loadBook();
  }, [item, forceUpdate]);

  // Load book stats when book appears in feed
  useEffect(() => {
    if (book?.$id && user?.$id) {
      loadBookStats(book.$id, user.$id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book?.$id, user?.$id]);

  const handleBookPress = () => {
    if (!book) return;
    router.push({
      pathname: "book-info",
      params: { bookId: book.$id },
    });
  };

  const handleSharePress = async () => {
    await Share.open({
      message: `Check out this book!`,
      url: `${secrets.WEBSITE}/books/${book?.$id}`,
      title: `${book.title}`,
      type: "url",
    });
  };

  const handleProfilePress = () => {
    if (isLoggedInUser) router.push("/profile");
    else router.push({ pathname: "/creator-profile", params: { userId: book?.uploader?.$id } });
  };

  if (loading) {
    return (
      <View className="mt-3 rounded-lg p-3" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
        <AnimatedSkeleton style={{ width: "100%", height: 300, borderRadius: 10 }} />
        <AnimatedSkeleton className="mt-2" style={{ width: "60%", height: 20, borderRadius: 5 }} />
      </View>
    );
  }

  if (error || !book) {
    return (
      <View
        className="mt-3 items-center justify-center rounded-lg p-4"
        style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
      >
        <Text className="text-sm" style={{ color: theme.textMuted }}>
          Failed to load book.
        </Text>
      </View>
    );
  }

  return (
    <View
      className="mt-1.5 overflow-hidden rounded-lg"
      style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
      key={book?.$id}
    >
      {/* Post Header */}
      <View className="flex flex-row items-center justify-center px-4 py-2">
        <View className="mr-2">
          <TouchableOpacity onPress={handleProfilePress} activeOpacity={0.7}>
            <FastImage
              source={{ uri: book.uploader.avatar, priority: FastImage.priority.high }}
              style={{ height: 35, width: 35, borderRadius: 5, backgroundColor: theme.surfaceStrong }}
              resizeMode={FastImage.resizeMode.cover}
              className="mt-1"
            />
          </TouchableOpacity>
        </View>

        <View className="flex-1">
          <View className="flex flex-row items-center justify-between">
            <View>
              <TouchableOpacity onPress={handleProfilePress} activeOpacity={0.7}>
                <View className="flex-row items-center">
                  <Text className="text-base font-bold" style={{ color: theme.text }}>
                    {book.uploader.username}
                  </Text>
                  <UserRoleBadgeIcons user={book.uploader} size={18} />
                </View>
              </TouchableOpacity>
              <Text className="text-xs" style={{ color: theme.textSoft }}>
                Featured
              </Text>
            </View>

            {!isLoggedInUser && (
              <TouchableOpacity onPress={onOpenSafetySheet} hitSlop={{ left: 15, bottom: 15, top: 10, right: 10 }}>
                <Entypo name="dots-three-horizontal" size={18} color={theme.iconMuted} />
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>

      <TouchableOpacity activeOpacity={0.7} onPress={handleBookPress} className="mt-3 overflow-hidden rounded-lg px-2">
        {/* Cover */}
        <View className="relative w-full">
          {book.thumbnail ? (
            <>
              <Image
                source={{ uri: book.thumbnail }}
                resizeMode="contain"
                onLoad={(event) => {
                  const { width, height } = event.nativeEvent.source || {};
                  if (width && height) setCoverAspectRatio(width / height);
                }}
                style={{ width: "100%", aspectRatio: coverAspectRatio }}
                className="rounded-lg"
              />
              <View className="absolute bottom-3 left-0 right-0 items-center">
                <View className="rounded-[8px] px-4 py-2" style={{ backgroundColor: theme.primary }}>
                  <Text className="text-sm font-semibold" style={{ color: theme.primaryContrast }}>
                    Read Now
                  </Text>
                </View>
              </View>
            </>
          ) : (
            <View className="h-[300px] w-full items-center justify-center">
              <LoaderKit style={{ width: 40, height: 40 }} name="LineScalePulseOutRapid" color={theme.primaryContrast} />
            </View>
          )}
        </View>

        {/* Info Section */}
        <View className="px-4 py-3">
          <View className="flex flex-wrap items-center">
            <Text className="text-[16px] font-bold" style={{ color: theme.text }}>
              {book.title}
            </Text>
          </View>
          {!!book?.status && (
            <Text className="text-xs font-semibold" style={{ color: statusColor }}>
              {book.status}
            </Text>
          )}
          {book?.tags?.length > 0 && (
            <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
              {book.tags.join(" • ")}
            </Text>
          )}
          {book.synopsis ? (
            <Text className="mt-1 text-sm" style={{ color: theme.textMuted }} numberOfLines={2}>
              {book.synopsis}
            </Text>
          ) : null}
        </View>
        <PostBookStats book={book} variant="feed" onSharePress={handleSharePress} />
      </TouchableOpacity>
    </View>
  );
};

export default React.memo(PostBook);
