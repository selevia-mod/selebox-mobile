import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Share from "react-native-share";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { BookService } from "../lib/books";
import secrets from "../private/secrets";
import BookChapterCommentModal from "./BookChapterCommentModal";

const BookChapterFooter = ({ chapter, bookReadingTheme, pageColor, openComments = false, focusCommentId = null, focusReplyId = null }) => {
  const { theme } = useAppTheme();
  const { user } = useGlobalContext();
  const [likeData, setLikeData] = useState();
  const [liked, setLiked] = useState(false);
  const [commentCount, setCommentCount] = useState(0);
  const [isCommentModalVisible, setCommentModalVisible] = useState(false);
  const [commentModalFocus, setCommentModalFocus] = useState({ focusCommentId: null, focusReplyId: null });
  const openedCommentModalKeyRef = useRef(null);

  const bookService = new BookService();
  const currentPageTheme = bookReadingTheme[pageColor];

  useEffect(() => {
    const fetchData = async () => {
      try {
        setCommentCount(0);
        await Promise.all([fetchIsBookChapterLiked(), fetchBookChapterComments()]);
      } catch (error) {
        console.log("fetchData error", error);
      }
    };
    fetchData();
  }, [chapter?.$id]);

  const fetchIsBookChapterLiked = async () => {
    try {
      const isLikedData = await bookService.getBookChapterLikeByOwner({ bookChapterId: chapter.$id, likeOwner: user?.$id });
      if (isLikedData?.documents?.length > 0) {
        setLikeData(isLikedData.documents[0]);
        setLiked(true);
      } else {
        setLikeData(null);
        setLiked(false);
      }
    } catch (error) {
      console.log("fetchIsBookLiked: error", error);
    }
  };

  const fetchBookChapterComments = async () => {
    try {
      if (!chapter?.$id) {
        setCommentCount(0);
        return;
      }

      const bookChapterComments = await bookService.getBookChapterComments({ bookChapterId: chapter.$id });
      setCommentCount(bookChapterComments?.total ?? 0);
    } catch (error) {
      setCommentCount(0);
      console.log("fetchBookChapterComments: error", error);
    }
  };

  const handleLike = async () => {
    try {
      if (liked) {
        setLiked(false);
        setLikeData(null);
        await bookService.deleteBookChapterLike({ bookChapterLikeId: likeData?.$id });
      } else {
        // Recheck if a like already exists to prevent duplicates
        const existingLike = await bookService.getBookChapterLikeByOwner({ bookChapterId: chapter?.$id, likeOwner: user?.$id });
        if (existingLike?.documents?.length > 0) {
          // Already liked; skip creation
          setLiked(true);
          setLikeData(existingLike.documents[0]);
          return;
        }
        setLiked(true);
        const likeData = await bookService.createBookChapterLike({ bookChapterId: chapter?.$id, likeOwner: user?.$id });
        setLikeData(likeData);
      }
    } catch (error) {
      console.log("handleLike error", error);
    }
  };

  const updateBookCommentCount = (_newCommentTotal) => {
    setCommentCount(Math.max(0, Number(_newCommentTotal) || 0));
  };

  useEffect(() => {
    const shouldOpenComments = openComments || Boolean(focusCommentId || focusReplyId);
    if (!chapter?.$id || !shouldOpenComments) return;

    const openKey = `${chapter.$id}:${focusCommentId || ""}:${focusReplyId || ""}:${openComments ? "1" : "0"}`;
    if (openedCommentModalKeyRef.current === openKey) return;

    openedCommentModalKeyRef.current = openKey;
    setCommentModalFocus({
      focusCommentId: focusCommentId || null,
      focusReplyId: focusReplyId || null,
    });
    setCommentModalVisible(true);
  }, [chapter?.$id, focusCommentId, focusReplyId, openComments]);

  const handleShare = async () => {
    await Share.open({
      message: `Check out this book!`,
      url: `${secrets.WEBSITE}/books/${chapter?.book?.$id}`,
      title: `${chapter?.book.title}`,
      type: "url",
    });
  };

  return (
    <SafeAreaView edges={["bottom"]} style={{ backgroundColor: currentPageTheme.backgroundColor }}>
      <View
        className="flex-row"
        style={{ backgroundColor: currentPageTheme.backgroundColor, borderTopWidth: 1, borderTopColor: currentPageTheme.divider }}
      >
        <TouchableOpacity onPress={handleLike} className="flex-1 items-center justify-center py-3">
          <Ionicons name={liked ? "heart" : "heart-outline"} size={24} color={theme.primary} />
          <Text className="mt-1 text-xs" style={{ color: currentPageTheme.fontColor }}>
            Vote
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => {
            setCommentModalFocus({ focusCommentId: null, focusReplyId: null });
            setCommentModalVisible(true);
          }}
          className="flex-1 items-center justify-center py-3"
        >
          <Ionicons name="chatbubble-outline" size={24} color={theme.primary} />
          <Text className="mt-1 text-xs" style={{ color: currentPageTheme.fontColor }}>
            {`Comments (${commentCount})`}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleShare} className="flex-1 items-center justify-center py-3">
          <Ionicons name="share-outline" size={24} color={theme.primary} />
          <Text className="mt-1 text-xs" style={{ color: currentPageTheme.fontColor }}>
            Share
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.push("/store")} className="flex-1 items-center justify-center py-3">
          <Ionicons name="cash-outline" size={24} color={theme.primary} />
          <Text className="mt-1 text-xs" style={{ color: currentPageTheme.fontColor }}>
            Coin Shop
          </Text>
        </TouchableOpacity>
      </View>
      <BookChapterCommentModal
        isVisible={isCommentModalVisible}
        chapter={chapter}
        onClose={() => {
          setCommentModalVisible(false);
          setCommentModalFocus({ focusCommentId: null, focusReplyId: null });
        }}
        onCommentPosted={(newCount) => updateBookCommentCount(newCount)}
        focusCommentId={commentModalFocus.focusCommentId}
        focusReplyId={commentModalFocus.focusReplyId}
      />
    </SafeAreaView>
  );
};

export default BookChapterFooter;
