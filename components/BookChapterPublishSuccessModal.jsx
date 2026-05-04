// BookChapterPublishSuccessModal — premium purple post-publish celebration.
//
// Shown right after a chapter (or introduction) successfully publishes. The
// goal is the moment-of-pride feeling Wattpad gets right: cover prominent,
// "now live" badge, the chapter / book context, share-and-grow surface,
// "where readers will find this" tag list, and a soft "keep going" CTA.
//
// The previous implementation rendered correctly on Android but on iOS its
// react-native-modal `propagateSwipe` config swallowed taps without the
// inner panel being visible — looked frozen to the user. This rewrite
// drops `propagateSwipe` entirely (we don't need swipe-to-dismiss inside
// a fixed-height modal) and uses simpler entrance animations driven by
// React Native's built-in Animated.

import { Feather, Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import FastImage from "react-native-fast-image";
import Modal from "react-native-modal";
import Share from "react-native-share";
import useAppTheme from "../hooks/useAppTheme";
import { getBookChapterSectionLabel } from "../lib/books";
import secrets from "../private/secrets";

// Shared brand purple — pinned to the canonical system value so the
// modal stays in sync with theme.primary (violet-500) used by every
// other primary CTA across the app.
const BRAND_PURPLE = "#8b5cf6"; // theme.primary — violet-500
const BRAND_PURPLE_SOFT = "rgba(139, 92, 246, 0.16)"; // theme.primarySoft

const BookChapterPublishSuccessModal = ({ visible, onClose, onViewBook, book, chapter, isIntroductionEntry = false }) => {
  const { theme } = useAppTheme();
  const [copied, setCopied] = useState(false);
  const { height: windowHeight } = useWindowDimensions();

  // Entrance animations — cover scales up + sparkle pulses in. Both
  // start at 0 and run on visible=true. react-native-modal handles the
  // outer slide-up; these add the inner "celebrate" feel without a
  // dependency on lottie / reanimated.
  const coverScale = useRef(new Animated.Value(0.8)).current;
  const coverOpacity = useRef(new Animated.Value(0)).current;
  const sparkleOpacity = useRef(new Animated.Value(0)).current;
  const sparkleScale = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    if (!visible) {
      coverScale.setValue(0.8);
      coverOpacity.setValue(0);
      sparkleOpacity.setValue(0);
      sparkleScale.setValue(0.6);
      setCopied(false);
      return;
    }
    Animated.parallel([
      Animated.spring(coverScale, { toValue: 1, friction: 6, tension: 80, useNativeDriver: true }),
      Animated.timing(coverOpacity, { toValue: 1, duration: 320, easing: Easing.out(Easing.ease), useNativeDriver: true }),
      Animated.sequence([
        Animated.delay(180),
        Animated.parallel([
          Animated.spring(sparkleScale, { toValue: 1, friction: 5, tension: 90, useNativeDriver: true }),
          Animated.timing(sparkleOpacity, { toValue: 1, duration: 280, useNativeDriver: true }),
        ]),
      ]),
    ]).start();
  }, [visible, coverScale, coverOpacity, sparkleOpacity, sparkleScale]);

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

  const handleCopyLink = async () => {
    if (!shareUrl) return;
    await Clipboard.setStringAsync(shareUrl);
    setCopied(true);
  };

  const handleShare = async () => {
    if (!shareUrl) return;
    try {
      await Share.open({
        message: `Check out "${book?.title}" on Selebox.`,
        url: shareUrl,
        title: book?.title || "Published book",
        type: "url",
      });
    } catch {
      // User cancelled the share sheet — react-native-share rejects on
      // cancel. Swallow silently; nothing to recover from.
    }
  };

  return (
    <Modal
      isVisible={visible}
      onBackdropPress={onClose}
      onBackButtonPress={onClose}
      backdropOpacity={0.72}
      backdropColor="#0B0A1A"
      animationIn="slideInUp"
      animationOut="slideOutDown"
      animationInTiming={360}
      animationOutTiming={260}
      useNativeDriverForBackdrop
      hideModalContentWhileAnimating
      style={styles.modalShell}
    >
      <View
        style={[
          styles.sheet,
          {
            // Use a fixed height (not maxHeight) so the inner ScrollView's
            // flex:1 has a definite container to fill. With only maxHeight,
            // the sheet sizes to its 0-height ScrollView and collapses to
            // a sliver at the bottom of the screen.
            height: windowHeight * 0.85,
            backgroundColor: theme.background,
            borderColor: theme.border,
          },
        ]}
      >
        {/* Soft purple glow rings — pure decoration, pointer-events off. */}
        <View pointerEvents="none" style={[styles.glowTop, { backgroundColor: BRAND_PURPLE_SOFT }]} />
        <View pointerEvents="none" style={[styles.glowSide, { backgroundColor: BRAND_PURPLE_SOFT }]} />

        {/* Drag handle for affordance even though we don't actually swipe. */}
        <View style={styles.handleWrap}>
          <View style={[styles.handle, { backgroundColor: theme.handle || "rgba(255,255,255,0.18)" }]} />
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 28, paddingTop: 4 }}
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          {/* Top bar: NOW LIVE pill on the left, Done dismissal on the right */}
          <View style={styles.topBar}>
            <View style={styles.livePill}>
              <View style={styles.liveDot} />
              <Text style={styles.livePillText}>NOW LIVE</Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              activeOpacity={0.75}
              style={[styles.doneBtn, { backgroundColor: theme.surfaceMuted, borderColor: theme.border }]}
            >
              <Text style={[styles.doneBtnText, { color: theme.text }]}>Done</Text>
            </TouchableOpacity>
          </View>

          {/* Hero — animated cover + sparkle */}
          <View style={styles.heroWrap}>
            <Animated.Text style={[styles.sparkle, { opacity: sparkleOpacity, transform: [{ scale: sparkleScale }] }]}>
              ✨
            </Animated.Text>

            <Animated.View
              style={[
                styles.coverCard,
                {
                  opacity: coverOpacity,
                  transform: [{ scale: coverScale }],
                  backgroundColor: theme.surfaceMuted,
                  borderColor: BRAND_PURPLE_SOFT,
                  shadowColor: BRAND_PURPLE,
                },
              ]}
            >
              {coverUri ? (
                <FastImage
                  source={{ uri: coverUri, priority: FastImage.priority.high }}
                  style={styles.coverImg}
                  resizeMode={FastImage.resizeMode.cover}
                />
              ) : (
                <View style={[styles.coverPlaceholder, { backgroundColor: theme.surface, borderColor: theme.borderStrong }]}>
                  <Ionicons name="book-outline" size={32} color={theme.textSoft} />
                </View>
              )}
            </Animated.View>

            <Text style={[styles.headline, { color: theme.text }]}>
              Your {publishedUnit} is live
            </Text>
            <Text style={[styles.subhead, { color: theme.textSoft }]}>
              Readers can discover it from your book page and the tags you picked.
            </Text>

            {/* Chapter + book context strip */}
            <View style={styles.contextStrip}>
              <Text style={styles.contextLabel}>{chapterLabel}</Text>
              <Text style={[styles.chapterTitle, { color: theme.text }]} numberOfLines={2}>
                {chapter?.title || (isIntroductionEntry ? "Untitled Introduction" : "Untitled Chapter")}
              </Text>
              <Text style={[styles.bookTitle, { color: theme.textSoft }]} numberOfLines={1}>
                {book?.title || "Your book"}
              </Text>
            </View>
          </View>

          {/* Primary action — full-width purple Share */}
          <TouchableOpacity
            onPress={handleShare}
            disabled={!shareUrl}
            activeOpacity={0.88}
            style={[styles.primaryShare, { opacity: shareUrl ? 1 : 0.5 }]}
          >
            <MaterialCommunityIcons name="share-variant" size={18} color="#FFFFFF" />
            <Text style={styles.primaryShareText}>Share with readers</Text>
          </TouchableOpacity>

          {/* Secondary actions — copy + view book side-by-side */}
          <View style={styles.secondaryRow}>
            <TouchableOpacity
              onPress={handleCopyLink}
              disabled={!shareUrl}
              activeOpacity={0.85}
              style={[
                styles.secondaryBtn,
                {
                  backgroundColor: theme.surfaceMuted,
                  borderColor: copied ? BRAND_PURPLE : theme.border,
                  opacity: shareUrl ? 1 : 0.5,
                },
              ]}
            >
              <Feather name={copied ? "check" : "link-2"} size={16} color={copied ? BRAND_PURPLE : theme.icon} />
              <Text style={[styles.secondaryBtnText, { color: copied ? BRAND_PURPLE : theme.text }]}>
                {copied ? "Copied" : "Copy link"}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={onViewBook}
              disabled={!book?.$id}
              activeOpacity={0.85}
              style={[
                styles.secondaryBtn,
                {
                  backgroundColor: theme.surfaceMuted,
                  borderColor: theme.border,
                  opacity: book?.$id ? 1 : 0.5,
                },
              ]}
            >
              <Ionicons name="book-outline" size={16} color={theme.icon} />
              <Text style={[styles.secondaryBtnText, { color: theme.text }]}>View book</Text>
            </TouchableOpacity>
          </View>

          {/* "Found under" — discovery tags */}
          <View style={[styles.section, { borderColor: theme.border, backgroundColor: theme.card }]}>
            <Text style={[styles.sectionLabel, { color: theme.textSubtle }]}>FOUND UNDER</Text>
            {tags.length ? (
              <View style={styles.tagRow}>
                {tags.map((tag) => (
                  <View key={tag} style={[styles.tag, { backgroundColor: BRAND_PURPLE_SOFT, borderColor: BRAND_PURPLE_SOFT }]}>
                    <Text style={[styles.tagText, { color: BRAND_PURPLE }]}>{tag}</Text>
                  </View>
                ))}
              </View>
            ) : (
              <Text style={[styles.sectionBody, { color: theme.textSoft }]}>
                No tags on this book yet — add some so readers can find it through search and category screens.
              </Text>
            )}
          </View>

          {/* Soft "keep going" footer — encourages the next action */}
          <View style={styles.keepGoingWrap}>
            <View style={[styles.keepGoingDivider, { backgroundColor: theme.border }]} />
            <Text style={[styles.keepGoingText, { color: theme.textSoft }]}>Keep the momentum going ✨</Text>
            <View style={[styles.keepGoingDivider, { backgroundColor: theme.border }]} />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalShell: {
    margin: 0,
    justifyContent: "flex-end",
  },
  sheet: {
    width: "100%",
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderTopWidth: 1,
    overflow: "hidden",
  },
  glowTop: {
    position: "absolute",
    top: -120,
    left: -80,
    width: 280,
    height: 280,
    borderRadius: 999,
  },
  glowSide: {
    position: "absolute",
    top: 80,
    right: -100,
    width: 240,
    height: 240,
    borderRadius: 999,
  },
  handleWrap: {
    paddingTop: 10,
    paddingBottom: 6,
    alignItems: "center",
  },
  handle: {
    width: 44,
    height: 4,
    borderRadius: 999,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 6,
    marginBottom: 14,
  },
  livePill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: BRAND_PURPLE,
    shadowColor: BRAND_PURPLE,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 6,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: "#FFFFFF",
    marginRight: 7,
  },
  livePillText: {
    fontSize: 11,
    fontWeight: "800",
    color: "#FFFFFF",
    letterSpacing: 1.2,
  },
  doneBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  doneBtnText: {
    fontSize: 13,
    fontWeight: "600",
  },
  heroWrap: {
    alignItems: "center",
    paddingTop: 12,
    paddingBottom: 22,
  },
  sparkle: {
    fontSize: 28,
    marginBottom: 6,
  },
  coverCard: {
    width: 132,
    height: 192,
    borderRadius: 18,
    borderWidth: 2,
    overflow: "hidden",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.32,
    shadowRadius: 18,
    elevation: 8,
    marginBottom: 18,
  },
  coverImg: {
    width: "100%",
    height: "100%",
  },
  coverPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: "dashed",
  },
  headline: {
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.3,
    textAlign: "center",
  },
  subhead: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    marginTop: 6,
    paddingHorizontal: 14,
  },
  contextStrip: {
    marginTop: 18,
    alignItems: "center",
  },
  contextLabel: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.4,
    color: BRAND_PURPLE,
  },
  chapterTitle: {
    marginTop: 6,
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
    paddingHorizontal: 12,
  },
  bookTitle: {
    marginTop: 4,
    fontSize: 13,
    fontWeight: "500",
  },
  primaryShare: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: BRAND_PURPLE,
    paddingVertical: 16,
    borderRadius: 18,
    shadowColor: BRAND_PURPLE,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 14,
    elevation: 7,
  },
  primaryShareText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.3,
    marginLeft: 8,
  },
  secondaryRow: {
    flexDirection: "row",
    marginTop: 10,
  },
  secondaryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 13,
    borderRadius: 14,
    borderWidth: 1,
    marginHorizontal: 5,
  },
  secondaryBtnText: {
    fontSize: 13,
    fontWeight: "600",
    marginLeft: 6,
  },
  section: {
    marginTop: 18,
    padding: 16,
    borderRadius: 20,
    borderWidth: 1,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.4,
  },
  sectionBody: {
    marginTop: 10,
    fontSize: 13,
    lineHeight: 19,
  },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 10,
    marginHorizontal: -4,
  },
  tag: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    marginHorizontal: 4,
    marginVertical: 4,
  },
  tagText: {
    fontSize: 12,
    fontWeight: "700",
  },
  keepGoingWrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 22,
  },
  keepGoingDivider: {
    flex: 1,
    height: 1,
    marginHorizontal: 10,
  },
  keepGoingText: {
    fontSize: 12,
    fontWeight: "500",
  },
});

export default BookChapterPublishSuccessModal;
