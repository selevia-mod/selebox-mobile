// Library card for a saved book.
//
// Visual + interaction parity with the rest of the app:
//   • The 3-dot menu is a CENTERED MODAL SHEET — same shape as
//     StyledPlaylistButton (Video 3-dot), ProfileActionsMenu, and the
//     Post / Books action menus. Stacked rounded action rows with
//     icon + label + subtitle, Cancel at the bottom.
//   • Report opens the standard ReportModal and submits via the same
//     email-based admin flow used for video / user / book reports
//     (StyledPlaylistButton, ProfileActionsMenu, book-info).
//   • Stats row uses theme-aware icon colors instead of the prior random
//     rainbow hexes — reads as one cohesive system.
//   • Card itself carries a subtle violet shadow lift, consistent with
//     other premium surfaces.
//
// The card supports optional opt-outs (`hideRemove`, `hideSettings`,
// `hideStats`) so it can be reused outside the library list — same
// surface shape, different visibility.

import { Entypo, Ionicons, MaterialIcons } from "@expo/vector-icons";
import axios from "axios";
import { router } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import LoaderKit from "react-native-loader-kit";
import Modal from "react-native-modal";
import Share from "react-native-share";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { isBookDownloaded, removeDownloadedBook, saveDownloadedBook } from "../lib/book-downloads";
import { BookReadService } from "../lib/book-reads";
import { BookUnlocksService } from "../lib/book-unlocks";
import { BookService } from "../lib/books";
import FormatNumber from "../lib/utils/format-number";
import secrets from "../private/secrets";
import BookTag from "./BookTag";
import ReportModal from "./ReportModal";

const BookLibraryCard = React.memo(({ item, hideRemove, hideSettings, hideStats, handleRemoveFromLibrary, customStyle }) => {
  const { theme } = useAppTheme();
  const [sheetVisible, setSheetVisible] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportDetail, setReportDetail] = useState("");
  const [reportLoading, setReportLoading] = useState(false);

  const [likeTotal, setLikeTotal] = useState(0);
  const [bookmarkTotal, setBookmarkTotal] = useState(0);
  const [commentTotal, setCommentTotal] = useState(0);
  const [chaptersTotal, setChaptersTotal] = useState(0);
  const [readTotal, setReadTotal] = useState(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDownloaded, setIsDownloaded] = useState(false);

  const { user, globalSettings } = useGlobalContext();
  // Prefer the per-book threshold (mapped from `lock_from_chapter` on
  // the book row) over globalSettings — the latter sometimes hadn't
  // rehydrated yet, leaving bookChapterLockStart undefined and making
  // isChapterLocked short-circuit to false (paid chapters appearing
  // free for a render). The static helper has its own fallback now.
  const bookChapterLockStart = item?.bookChapterLockStart ?? globalSettings?.["BOOKS_CHAPTER_LOCK_START"];
  const bookService = new BookService();
  const bookUnlockService = useRef(new BookUnlocksService()).current;

  useEffect(() => {
    const fetchData = async () => {
      try {
        await Promise.all([fetchBookLikes(), fetchBookBookmarks(), fetchBookComments(), fetchBookChapters(), fetchBookReads()]);
      } catch (error) {
        console.log("fetchData error", error);
      }
    };
    fetchData();
  }, []);

  useEffect(() => {
    if (item?.$id) {
      setIsDownloaded(isBookDownloaded(item.$id));
    }
  }, [item?.$id]);

  const fetchBookLikes = async () => {
    try {
      const bookLikes = await bookService.getBookLikes({ bookId: item.$id });
      setLikeTotal(bookLikes.total);
    } catch (error) {
      console.log("fetchBookLikes: error", error);
    }
  };

  const fetchBookBookmarks = async () => {
    try {
      const bookBookmarks = await bookService.getBookLibraries({ bookId: item.$id });
      setBookmarkTotal(bookBookmarks.total);
    } catch (error) {
      console.log("fetchBookBookmarks: error", error);
    }
  };

  const fetchBookComments = async () => {
    try {
      const bookComments = await bookService.getBookComments({ bookId: item.$id });
      setCommentTotal(bookComments.total);
    } catch (error) {
      console.log("fetchBookComments: error", error);
    }
  };

  const fetchBookChapters = async () => {
    try {
      const bookChapters = await bookService.fetchBookChapters({ bookId: item.$id, status: "Publish" });
      setChaptersTotal(bookChapters.total);
    } catch (error) {
      console.log("fetchBookChapters: error", error);
    }
  };

  // See BookCatalogCard for the same change + rationale. Reads come
  // off the row directly; the previous per-card fetchBookRead call was
  // a redundant round-trip that also crashed on drafts (anon RLS
  // filters is_public=false rows → null → "Cannot read property
  // 'totalReads' of null").
  const fetchBookReads = async () => {
    setReadTotal(item?.totalReads ?? item?.views_count ?? 0);
  };

  const formattedDate = useMemo(() => {
    return new Date(item?.$createdAt)
      .toLocaleString("en-US", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
      .replace(",", "");
  }, [item?.$createdAt]);

  const handleBookPress = () => router.push({ pathname: "book-info", params: { bookId: item.$id } });

  const closeSheet = () => setSheetVisible(false);
  const openSheet = () => setSheetVisible(true);

  const handleShare = () => {
    closeSheet();
    setTimeout(async () => {
      try {
        await Share.open({
          message: `Check out this book!`,
          url: `${secrets.WEBSITE}/books/${item?.$id}`,
          title: `${item?.title || "Selebox book"}`,
          type: "url",
        });
      } catch (error) {
        if (error?.message && !/User did not share/i.test(error.message)) {
          console.log("BookLibraryCard share error:", error.message);
        }
      }
    }, 200);
  };

  const handleOpenReport = () => {
    closeSheet();
    setTimeout(() => setShowReportModal(true), 200);
  };

  const handleCloseReport = () => setShowReportModal(false);

  // Mirrors the email-based report flow used by StyledPlaylistButton
  // (videos), ProfileActionsMenu (users), and book-info (books). Until
  // Phase 5 unifies reports under contentReportsCollection, every report
  // type goes through the same admin inbox via this Appwrite Function.
  const handleSubmitReport = async (reportDetails) => {
    Alert.alert(
      "Report book",
      "Are you sure you want to report this book? Confirming will submit your report for review by our team.",
      [
        { text: "No", style: "cancel" },
        {
          text: "Yes",
          onPress: async () => {
            setReportLoading(true);
            try {
              const adminEmails = (() => {
                try {
                  return JSON.parse(globalSettings?.["ADMIN_EMAILS"] || "[]").join(",");
                } catch {
                  return "";
                }
              })();
              const bccEmails = (() => {
                try {
                  return JSON.parse(globalSettings?.["BCC_EMAILS"] || "[]").join(",");
                } catch {
                  return "";
                }
              })();
              const response = await axios.post("https://67e9284815c6fe834817.appwrite.global", {
                from: "selebox.dev@gmail.com",
                to: adminEmails,
                cc: user?.email,
                bcc: bccEmails,
                subject: `${user?.username} | Selebox | Reported Book`,
                html: `
                  <p><strong>Dear Selebox Team,</strong></p>
                  <p>I am writing to report this book <b><u>${secrets.WEBSITE}/books/${item?.$id}</u></b> ("${item?.title || "Untitled"}"). Please find this report for your review.</p>
                  <p><strong>Report Detail:</strong></p>
                  <p>${reportDetails}</p>
                  <p>Thank you for your time and consideration.</p>
                  <p>Best regards,<br>
                  ${user?.username}<br>
                  ${user?.accountId}<br>
                  ${user?.email}<br>
                  ${new Date(user?.$createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>`,
              });
              if (response.data?.success) {
                setReportDetail("");
                setShowReportModal(false);
                Alert.alert("Success", "Your report has been submitted for review.");
              } else {
                Alert.alert("Error", "There was an error submitting your report. Please try again.");
              }
            } catch (error) {
              Alert.alert("Error", error?.message || "Failed to submit report.");
            }
            setReportLoading(false);
          },
        },
      ],
      { cancelable: true },
    );
  };

  const handleRemove = () => {
    closeSheet();
    setTimeout(() => {
      handleRemoveFromLibrary?.();
    }, 200);
  };

  const fetchAllBookChapters = async () => {
    const response = await bookService.fetchAllBookChapters({
      bookId: item.$id,
      status: "Publish",
      limit: 50,
    });
    return { chapters: response.documents || [], total: response.total ?? response.documents?.length ?? 0 };
  };

  const ensureBookInLibrary = async () => {
    if (!user?.$id || !item?.$id) return null;
    try {
      const existing = await bookService.getBookLibrayByUser({ bookId: item.$id, userId: user.$id });
      if (existing?.documents?.length > 0) return existing.documents[0];
      return await bookService.createBookLibrary({ bookId: item.$id, userId: user.$id });
    } catch (error) {
      console.log("ensureBookInLibrary: error", error);
      return null;
    }
  };

  // Download path — fetch chapters and persist to MMKV. Wrapped so the
  // toggle handler below can call it cleanly when isDownloaded === false.
  const performDownload = async () => {
    if (item?.isLocked && (bookChapterLockStart === undefined || bookChapterLockStart === null)) {
      Alert.alert("Please wait", "Book settings are still loading. Try again in a moment.");
      return;
    }

    try {
      setIsDownloading(true);
      const unlocksData = await bookUnlockService.getBookUnlockByUser({ book: item.$id, unlockBy: user?.$id });
      const unlockDocument = unlocksData?.documents?.[0];
      const { chapters } = await fetchAllBookChapters();

      if (!chapters.length) {
        Alert.alert("No chapters available", "There are no published chapters to download yet.");
        return;
      }

      const readableChapters = [];
      chapters.forEach((chapter, index) => {
        const isLocked = BookUnlocksService.isChapterLocked({
          book: item,
          bookChapterLockStart,
          chapter,
          index,
          unlocks: unlockDocument,
          currentUserId: user?.$id,
        });
        if (!isLocked) readableChapters.push(chapter);
      });

      if (!readableChapters.length) {
        Alert.alert("Locked book", "Only locked chapters are available right now.");
        return;
      }

      saveDownloadedBook({ bookId: item.$id, book: item, chapters: readableChapters });
      setIsDownloaded(true);
      await ensureBookInLibrary();
    } catch (error) {
      console.log("performDownload: error", error);
      Alert.alert("Download failed", "We couldn't download this book. Please try again.");
    } finally {
      setIsDownloading(false);
    }
  };

  // Remove path — confirms before wiping the local copy from MMKV.
  const performRemoveDownload = () => {
    Alert.alert(
      "Remove download?",
      "This book will no longer be available offline. You can download it again anytime.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            try {
              removeDownloadedBook(item.$id);
              setIsDownloaded(false);
            } catch (error) {
              console.log("performRemoveDownload: error", error);
              Alert.alert("Couldn't remove", "Something went wrong. Please try again.");
            }
          },
        },
      ],
      { cancelable: true },
    );
  };

  // Toggle handler bound to the icon. When the book isn't downloaded we
  // start the download flow; when it is, we offer to remove it. This is
  // the YouTube-style "downloaded toggle" the user expected — the previous
  // version disabled the icon once downloaded, leaving no way back.
  const handleToggleDownload = () => {
    if (!item?.$id || isDownloading) return;
    if (isDownloaded) {
      performRemoveDownload();
    } else {
      performDownload();
    }
  };

  if (!item) return null;

  return (
    <>
      <View
        className="mb-3 overflow-hidden rounded-2xl"
        style={[
          customStyle,
          {
            position: "relative",
            backgroundColor: theme.card,
            borderWidth: 1,
            borderColor: theme.border,
            // Subtle violet shadow lift — reads as a deliberate card on
            // both light and dark surfaces.
            shadowColor: theme.primary,
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.1,
            shadowRadius: 10,
            elevation: 2,
            padding: 12,
          },
        ]}
      >
        {/* Downloading overlay — premium violet glass card centered over the
            book row. Replaces the previous flat `overlayStrong` backdrop with
            a deep-violet panel that matches the unlock modal's surface
            language so download feedback reads as part of the same system. */}
        {isDownloading && (
          <View
            pointerEvents="auto"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 20,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "rgba(22, 14, 42, 0.78)",
              borderRadius: 18,
            }}
          >
            <View
              className="flex-row items-center rounded-2xl"
              style={{
                paddingHorizontal: 14,
                paddingVertical: 10,
                backgroundColor: "rgba(22, 14, 42, 0.96)",
                borderWidth: 1,
                borderColor: theme.primary,
                shadowColor: theme.primary,
                shadowOffset: { width: 0, height: 6 },
                shadowOpacity: 0.5,
                shadowRadius: 12,
                elevation: 6,
              }}
            >
              <LoaderKit style={{ width: 18, height: 18, marginRight: 10 }} name="LineScalePulseOutRapid" color={theme.primary} />
              <View>
                <Text className="font-bold" style={{ color: "#FFFFFF", fontSize: 12, letterSpacing: 0.4, textTransform: "uppercase" }}>
                  Downloading
                </Text>
                <Text className="font-medium" style={{ color: "rgba(229, 231, 245, 0.7)", fontSize: 10, letterSpacing: 0.2, marginTop: 1 }}>
                  Saving for offline reading…
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Header Row — last updated label + download icon + 3-dots */}
        {!hideSettings && (
          <View className="mb-2.5 flex-row items-center justify-between">
            <Text className="text-[10px] font-semibold uppercase" style={{ color: theme.textSoft, letterSpacing: 0.6 }}>
              Updated {formattedDate}
            </Text>
            <View className="flex-row items-center" style={{ gap: 6 }}>
              <TouchableOpacity
                hitSlop={10}
                onPress={handleToggleDownload}
                disabled={isDownloading}
                activeOpacity={0.7}
                accessibilityLabel={isDownloaded ? "Downloaded — tap to remove from offline" : "Download for offline"}
                accessibilityHint={isDownloaded ? "Removes this book from your offline downloads" : "Saves this book for offline reading"}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 999,
                  alignItems: "center",
                  justifyContent: "center",
                  // When downloaded, the disc tints green-soft so it visually
                  // reads as "active / saved" — and tapping removes. When not
                  // downloaded, neutral surfaceMuted disc that invites a tap.
                  backgroundColor: isDownloaded ? `${theme.accentGreen}1F` : theme.surfaceMuted,
                  borderWidth: 1,
                  borderColor: isDownloaded ? theme.accentGreen : theme.border,
                  opacity: isDownloading ? 0.6 : 1,
                }}
              >
                <Ionicons
                  name={isDownloaded ? "checkmark-circle" : "download-outline"}
                  size={15}
                  color={isDownloaded ? theme.accentGreen : theme.iconMuted}
                />
              </TouchableOpacity>
              <TouchableOpacity
                hitSlop={10}
                onPress={openSheet}
                activeOpacity={0.7}
                accessibilityLabel="Book actions"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 999,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: theme.surfaceMuted,
                  borderWidth: 1,
                  borderColor: theme.border,
                }}
              >
                <Entypo name="dots-three-horizontal" size={14} color={theme.iconMuted} />
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Book Row */}
        <TouchableOpacity onPress={handleBookPress} activeOpacity={0.85} className="flex-row" style={{ gap: 12 }}>
          {/* Thumbnail */}
          <View
            style={{
              borderRadius: 10,
              overflow: "hidden",
              borderWidth: 1,
              borderColor: theme.border,
            }}
          >
            <FastImage
              source={{ uri: item?.thumbnail, priority: FastImage.priority.normal }}
              style={{ height: 116, width: 80, backgroundColor: theme.surfaceMuted }}
              resizeMode={FastImage.resizeMode.cover}
            />
          </View>

          {/* Book Details */}
          <View className="flex-1 justify-between">
            <View>
              <Text className="font-bold" style={{ color: theme.text, fontSize: 15, lineHeight: 19, letterSpacing: 0.1 }} numberOfLines={2}>
                {item?.title || "Untitled"}
              </Text>
              <Text className="mt-1 text-[12px]" style={{ color: theme.textMuted, lineHeight: 16 }} numberOfLines={2}>
                {item?.synopsis || "No synopsis available."}
              </Text>

              {/* Status + Downloaded chip */}
              <View className="mt-2 flex-row items-center" style={{ gap: 6 }}>
                <BookTag tagName={item?.status} />
                {isDownloaded && (
                  <View
                    className="flex-row items-center rounded-full"
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 2,
                      backgroundColor: `${theme.accentGreen}1F`,
                      borderWidth: 0.5,
                      borderColor: theme.accentGreen,
                    }}
                  >
                    <Ionicons name="download" size={10} color={theme.accentGreen} />
                    <Text className="ml-1 text-[9px] font-bold" style={{ color: theme.accentGreen, letterSpacing: 0.4, textTransform: "uppercase" }}>
                      Offline
                    </Text>
                  </View>
                )}
              </View>
            </View>

            {/* Stats Row — theme-aware icon color so the row reads as one
                cohesive system instead of the previous rainbow of hardcoded
                hexes. The numbers carry the meaning; the icons differentiate
                what each number is. */}
            {!hideStats && (
              <View className="mt-2.5 flex-row items-center" style={{ gap: 12 }}>
                <View className="flex-row items-center" style={{ gap: 3 }}>
                  <Ionicons name="eye-outline" size={12} color={theme.iconMuted} />
                  <Text className="text-[11px] font-semibold" style={{ color: theme.textSoft }}>
                    {FormatNumber(readTotal)}
                  </Text>
                </View>
                <View className="flex-row items-center" style={{ gap: 3 }}>
                  <Ionicons name="heart-outline" size={12} color={theme.iconMuted} />
                  <Text className="text-[11px] font-semibold" style={{ color: theme.textSoft }}>
                    {FormatNumber(likeTotal)}
                  </Text>
                </View>
                <View className="flex-row items-center" style={{ gap: 3 }}>
                  <Ionicons name="chatbubble-outline" size={12} color={theme.iconMuted} />
                  <Text className="text-[11px] font-semibold" style={{ color: theme.textSoft }}>
                    {FormatNumber(commentTotal)}
                  </Text>
                </View>
                <View className="flex-row items-center" style={{ gap: 3 }}>
                  <Ionicons name="bookmark-outline" size={12} color={theme.iconMuted} />
                  <Text className="text-[11px] font-semibold" style={{ color: theme.textSoft }}>
                    {FormatNumber(bookmarkTotal)}
                  </Text>
                </View>
                <View className="flex-row items-center" style={{ gap: 3 }}>
                  <Ionicons name="list-outline" size={12} color={theme.iconMuted} />
                  <Text className="text-[11px] font-semibold" style={{ color: theme.textSoft }}>
                    {chaptersTotal}
                  </Text>
                </View>
              </View>
            )}
          </View>
        </TouchableOpacity>
      </View>

      {/* Action sheet — same shape as ProfileActionsMenu / StyledPlaylistButton.
          Title + stacked rounded action rows + Cancel. */}
      <Modal isVisible={sheetVisible} onBackdropPress={closeSheet} onBackButtonPress={closeSheet} backdropOpacity={0.6} useNativeDriver>
        <View className="rounded-2xl px-5 py-5" style={{ backgroundColor: theme.surfaceElevated }}>
          <Text className="text-lg font-semibold" style={{ color: theme.text }}>
            Book actions
          </Text>

          <TouchableOpacity className="mt-4 rounded-xl px-4 py-3" style={{ backgroundColor: theme.surfaceMuted }} onPress={handleShare}>
            <View className="flex flex-row items-center">
              <MaterialIcons name="ios-share" size={22} color={theme.icon} style={{ marginRight: 12 }} />
              <View>
                <Text className="text-base font-semibold" style={{ color: theme.text }}>
                  Share book
                </Text>
                <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                  Send this book to a friend
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          <TouchableOpacity className="mt-2 rounded-xl px-4 py-3" style={{ backgroundColor: theme.surfaceMuted }} onPress={handleOpenReport}>
            <View className="flex flex-row items-center">
              <MaterialIcons name="flag" size={22} color={theme.icon} style={{ marginRight: 12 }} />
              <View>
                <Text className="text-base font-semibold" style={{ color: theme.text }}>
                  Report book
                </Text>
                <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                  Tell us what's wrong
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          {!hideRemove && (
            <TouchableOpacity className="mt-2 rounded-xl px-4 py-3" style={{ backgroundColor: theme.surfaceMuted }} onPress={handleRemove}>
              <View className="flex flex-row items-center">
                <MaterialIcons name="bookmark-remove" size={22} color={theme.iconDanger ?? "#ef4444"} style={{ marginRight: 12 }} />
                <View>
                  <Text className="text-base font-semibold" style={{ color: theme.iconDanger ?? "#ef4444" }}>
                    Remove from library
                  </Text>
                  <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                    Take this book out of your library
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          )}

          <TouchableOpacity className="mt-3 items-center" onPress={closeSheet}>
            <Text className="text-sm" style={{ color: theme.textMuted }}>
              Cancel
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>

      <ReportModal
        type="Book"
        isVisible={showReportModal}
        onClose={handleCloseReport}
        handleSubmitReport={handleSubmitReport}
        reportDetail={reportDetail}
        setReportDetail={setReportDetail}
        reportLoading={reportLoading}
      />
    </>
  );
});

export default BookLibraryCard;
