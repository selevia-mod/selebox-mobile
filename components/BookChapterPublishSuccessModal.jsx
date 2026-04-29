import { Feather, Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import FastImage from "react-native-fast-image";
import Modal from "react-native-modal";
import Share from "react-native-share";
import useAppTheme from "../hooks/useAppTheme";
import { getBookChapterSectionLabel } from "../lib/books";
import secrets from "../private/secrets";

const BookChapterPublishSuccessModal = ({ visible, onClose, onViewBook, book, chapter, isIntroductionEntry = false }) => {
  const { theme } = useAppTheme();
  const [copied, setCopied] = useState(false);
  const { height: windowHeight } = useWindowDimensions();

  const shareUrl = useMemo(() => {
    if (!book?.$id) return "";
    return `${secrets.WEBSITE}/books/${book.$id}`;
  }, [book?.$id]);

  const coverUri = useMemo(
    () => chapter?.thumbnail?.uri || chapter?.thumbnail || book?.thumbnail?.uri || book?.thumbnail || "",
    [book?.thumbnail, chapter?.thumbnail],
  );

  const chapterLabel = useMemo(() => {
    if (chapter) return getBookChapterSectionLabel(chapter);
    return isIntroductionEntry ? "Introduction" : "Chapter";
  }, [chapter, isIntroductionEntry]);

  const tags = useMemo(() => (Array.isArray(book?.tags) ? book.tags.filter(Boolean) : []), [book?.tags]);
  const publishedUnit = isIntroductionEntry ? "introduction" : "chapter";

  useEffect(() => {
    if (!visible) setCopied(false);
  }, [visible]);

  const handleCopyLink = async () => {
    if (!shareUrl) return;
    await Clipboard.setStringAsync(shareUrl);
    setCopied(true);
  };

  const handleShare = async () => {
    if (!shareUrl) return;
    await Share.open({
      message: `Check out "${book?.title}" on Selebox.`,
      url: shareUrl,
      title: book?.title || "Published book",
      type: "url",
    });
  };

  return (
    <Modal
      isVisible={visible}
      onBackdropPress={onClose}
      onBackButtonPress={onClose}
      backdropOpacity={0.68}
      propagateSwipe={(event, gestureState) => {
        return Math.abs(gestureState?.dy || 0) > 0 || Math.abs(gestureState?.moveY || 0) > 0;
      }}
      style={{ margin: 0, justifyContent: "flex-end" }}
    >
      <View
        className="overflow-hidden rounded-t-[32px] px-5 pb-6 pt-4"
        style={{ height: windowHeight * 0.88, borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.background }}
      >
        <View pointerEvents="none" style={[styles.topGlow, { backgroundColor: theme.accentPurpleSoft }]} />
        <View pointerEvents="none" style={[styles.sideGlow, { backgroundColor: theme.primarySoft }]} />

        <View className="mb-4 items-center">
          <View className="h-1.5 w-14 rounded-full" style={{ backgroundColor: theme.handle }} />
        </View>

        <View className="mb-5 flex-row items-center justify-between">
          <View>
            <Text className="text-[11px] font-semibold uppercase tracking-[3px]" style={{ color: theme.primary }}>
              Published
            </Text>
            <Text className="mt-1 text-[22px] font-bold" style={{ color: theme.text }}>
              Congratulations
            </Text>
          </View>
          <TouchableOpacity onPress={onClose} className="rounded-full px-4 py-2" style={{ backgroundColor: theme.surfaceMuted }}>
            <Text className="text-xs font-semibold uppercase tracking-[2px]" style={{ color: theme.textMuted }}>
              Done
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={{ flex: 1 }} nestedScrollEnabled showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 12 }}>
          <View
            className="overflow-hidden rounded-[28px] px-4 py-5"
            style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}
          >
            <View
              className="self-start rounded-full px-3 py-1"
              style={{ borderWidth: 1, borderColor: theme.accentGreen, backgroundColor: theme.accentGreenSoft }}
            >
              <Text className="text-[11px] font-semibold uppercase tracking-[2px]" style={{ color: theme.accentGreen }}>
                Now live
              </Text>
            </View>

            <Text className="mt-4 text-center text-[24px] font-bold" style={{ color: theme.text }}>{`Your ${publishedUnit} is published`}</Text>
            <Text className="mt-2 text-center text-sm leading-5" style={{ color: theme.textSoft }}>
              Readers can now discover it from your book page and across the tags you picked.
            </Text>

            <View className="mt-6 items-center">
              <View
                className="overflow-hidden rounded-[20px] p-2"
                style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted }}
              >
                {coverUri ? (
                  <FastImage
                    source={{ uri: coverUri, priority: FastImage.priority.high }}
                    className="h-40 w-28 rounded-[14px]"
                    resizeMode={FastImage.resizeMode.cover}
                  />
                ) : (
                  <View
                    className="h-40 w-28 items-center justify-center rounded-[14px] border border-dashed"
                    style={{ borderColor: theme.borderStrong, backgroundColor: theme.surface }}
                  >
                    <Ionicons name="book-outline" size={28} color={theme.textSoft} />
                  </View>
                )}
              </View>

              <Text className="mt-4 text-[11px] font-semibold uppercase tracking-[2px]" style={{ color: theme.primary }}>
                {chapterLabel}
              </Text>
              <Text className="mt-2 text-center text-lg font-bold" style={{ color: theme.text }}>
                {chapter?.title || (isIntroductionEntry ? "Untitled Introduction" : "Untitled Chapter")}
              </Text>
              <Text className="mt-1 text-center text-sm" style={{ color: theme.textSoft }}>
                {book?.title || "Your book"}
              </Text>
            </View>
          </View>

          <View className="mt-4 rounded-[24px] px-4 py-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
            <Text className="mb-2 text-[11px] font-semibold uppercase tracking-[2px]" style={{ color: theme.textSubtle }}>
              Found under
            </Text>
            {tags.length ? (
              <View className="mt-3 flex-row flex-wrap gap-2">
                {tags.map((tag) => (
                  <View key={tag} className="rounded-full px-3 py-2" style={{ backgroundColor: theme.surfaceMuted }}>
                    <Text className="text-xs font-medium" style={{ color: theme.textMuted }}>
                      {tag}
                    </Text>
                  </View>
                ))}
              </View>
            ) : (
              <Text className="mt-3 text-sm" style={{ color: theme.textSoft }}>
                This book does not have tags yet, but the chapter is already live.
              </Text>
            )}
          </View>

          <View className="mt-4 rounded-[24px] px-4 py-4" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
            <Text className="text-[11px] font-semibold uppercase tracking-[2px]" style={{ color: theme.textSubtle }}>
              Share and grow
            </Text>
            <View className="mt-4 flex-row space-x-3">
              <TouchableOpacity
                onPress={handleCopyLink}
                disabled={!shareUrl}
                className="flex-1 rounded-[18px] px-3 py-4"
                style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted }}
              >
                <View className="items-center">
                  <Feather name={copied ? "check" : "copy"} size={20} color={theme.icon} />
                  <Text className="mt-2 text-xs font-semibold" style={{ color: theme.text }}>
                    {copied ? "Copied" : "Copy link"}
                  </Text>
                </View>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={onViewBook}
                disabled={!book?.$id}
                className="flex-1 rounded-[18px] px-3 py-4"
                style={{ backgroundColor: theme.primary }}
              >
                <View className="items-center">
                  <Ionicons name="book-outline" size={20} color={theme.primaryContrast} />
                  <Text className="mt-2 text-xs font-semibold" style={{ color: theme.primaryContrast }}>
                    View book
                  </Text>
                </View>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleShare}
                disabled={!shareUrl}
                className="flex-1 rounded-[18px] px-3 py-4"
                style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted }}
              >
                <View className="items-center">
                  <MaterialCommunityIcons name="share-variant-outline" size={22} color={theme.icon} />
                  <Text className="mt-2 text-xs font-semibold" style={{ color: theme.text }}>
                    Share
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  topGlow: {
    position: "absolute",
    top: 300,
    left: -60,
    width: 180,
    height: 180,
    borderRadius: 999,
  },
  sideGlow: {
    position: "absolute",
    top: 140,
    right: -60,
    width: 180,
    height: 180,
    borderRadius: 999,
  },
});

export default BookChapterPublishSuccessModal;
