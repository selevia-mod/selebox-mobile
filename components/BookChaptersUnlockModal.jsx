import { Entypo, Feather, FontAwesome, FontAwesome5, Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import Modal from "react-native-modal";
import images from "../assets/images";
import { EarningType } from "../constants/app";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { isBookDownloaded, upsertDownloadedChapter } from "../lib/book-downloads";
import { BookUnlocksService } from "../lib/book-unlocks";
import { BookService, isIntroductionChapter } from "../lib/books";
import { useModalMessage } from "../hooks/useModalMessage";
import CustomAlertModal from "./CustomAlertModal";
import StarIcon from "./StarIcon";

const BalanceItem = ({ label, icon, value, theme }) => (
  <View className="mx-4 mt-4 flex-row items-center justify-between">
    <Text className="text-base font-bold" style={{ color: theme.text }}>{label}</Text>
    <View className="flex-row items-center space-x-2 rounded-full border px-3 py-1" style={{ borderColor: theme.borderStrong, backgroundColor: theme.surfaceMuted }}>
      {icon}
      <Text className="text-base font-bold" style={{ color: theme.text }}>{value}</Text>
    </View>
  </View>
);

const UnlockOption = ({ label, subLabel, icon, cost, onPress, badge, loading = false, theme }) => (
  <TouchableOpacity
    onPress={onPress}
    disabled={loading}
    className={`mx-4 my-2 flex-row items-center justify-between rounded-xl border px-4 py-4 ${loading ? "opacity-60" : ""}`}
    style={{ borderColor: theme.border, backgroundColor: theme.card }}
  >
    <View>
      <View className="mb-1 flex-row items-center space-x-2">
        {badge && (
          <View className="rounded-full px-2 py-0.5" style={{ backgroundColor: theme.primaryContrast }}>
            <Text className="text-xs font-bold" style={{ color: theme.textInverse }}>{badge}</Text>
          </View>
        )}
        <Text className="text-base font-semibold" style={{ color: theme.text }}>{label}</Text>
      </View>
      {subLabel && <Text className="text-sm" style={{ color: theme.textSoft }}>{subLabel}</Text>}
    </View>

    <View className="flex-row items-center space-x-2">
      {loading ? (
        <ActivityIndicator size="small" color={theme.coin} />
      ) : (
        <>
          {icon}
          <Text className="text-base font-semibold" style={{ color: theme.coin }}>{cost}</Text>
          <Ionicons name="chevron-forward" size={18} color={theme.textSubtle} />
        </>
      )}
    </View>
  </TouchableOpacity>
);

const BookChaptersUnlockModal = ({
  isVisible,
  onClose,
  chapters = [],
  chaptersTotal,
  selectedChapter,
  book,
  unlocks,
  handleGoToStore,
  onSuccessUnlock,
}) => {
  const { theme } = useAppTheme();
  const { user, globalSettings, balance, refetchBalance, refetchStars, starsData } = useGlobalContext();
  const [unlockLoading, setUnlockLoading] = useState();
  const { message, messageOpen, showMessage, closeMessage } = useModalMessage();

  const bookChapterLockStart = Number(globalSettings["BOOKS_CHAPTER_LOCK_START"]);
  const bookChapterCoinPrice = Number(globalSettings["BOOKS_CHAPTER_COIN_PRICE"]);
  const bookChapterStarPrice = Number(globalSettings["BOOKS_CHAPTER_STAR_PRICE"]);
  const bookUnlockWholeDiscount = Number(globalSettings["BOOKS_UNLOCK_WHOLE_DISCOUNT"]);
  const discountMultiplier = (100 - bookUnlockWholeDiscount) / 100;

  const bookUnlockService = new BookUnlocksService();
  const bookService = new BookService();
  const hasIntroduction = Array.isArray(chapters) && chapters.some((chapter, index) => isIntroductionChapter(chapter, index));

  // Locked parts count
  const totalChaptersCount = Number.isFinite(chaptersTotal) && chaptersTotal > 0 ? chaptersTotal : Array.isArray(chapters) ? chapters.length : 0;
  const chapterPartsCount = Math.max(totalChaptersCount - (hasIntroduction ? 1 : 0), 0);
  const lockStart = Number.isFinite(bookChapterLockStart) && bookChapterLockStart > 0 ? bookChapterLockStart : null;
  const totalLockedParts = book?.isLocked && lockStart ? Math.max(chapterPartsCount - (lockStart - 1), 0) : 0;
  const fullyUnlocked = unlocks?.isFullyUnlocked || unlocks?.isFullyLocked;
  const unlockedCount = fullyUnlocked ? totalLockedParts : unlocks?.chapters?.length || 0;
  const remainingLockedParts = Math.max(totalLockedParts - unlockedCount, 0);
  const COSTS = {
    coins: bookChapterCoinPrice,
    stars: bookChapterStarPrice,
    wholeStoryCoins: Math.ceil(bookChapterCoinPrice * remainingLockedParts * discountMultiplier),
    wholeStoryStars: Math.ceil(bookChapterStarPrice * remainingLockedParts * discountMultiplier),
  };

  // Shared unlock handler
  const confirmUnlock = (type, label, cost, callback) => {
    Alert.alert(
      `Confirm Unlock ${label}`,
      `Are you sure you want to unlock this ${label}? This will cost you ${cost} ${type}!`,
      [
        { text: "No", style: "cancel" },
        { text: "Yes", onPress: callback, style: "default" },
      ],
      { cancelable: true },
    );
  };

  const handleUnlockNextPart = async (type, unlockAll = false) => {
    const cost = unlockAll ? (type === "coins" ? COSTS.wholeStoryCoins : COSTS.wholeStoryStars) : COSTS[type];
    const tempType = unlockAll ? (type === "coins" ? "wholeStoryCoins" : "wholeStoryStars") : type;
    if (balance < cost && type === EarningType.coins) {
      showMessage(`You don't have sufficient coins to unlock this chapter`);
      return;
    }
    if (starsData?.stars < cost && type === EarningType.stars) {
      showMessage(`You don't have sufficient stars to unlock this chapter`);
      return;
    }
    confirmUnlock(type, unlockAll ? "Book" : "Chapter", cost, async () => {
      try {
        setUnlockLoading(tempType);
        await bookUnlockService.unlockBook({
          bookId: book.$id,
          chapterId: selectedChapter.$id,
          userId: user.$id,
          type: type,
          contentOwnerId: book.uploader,
          unlockAll,
        });
        await refetchBalance(user.$id);
        await refetchStars();
        if (isBookDownloaded(book?.$id)) {
          let chapterToSave = selectedChapter;
          if (!chapterToSave?.content) {
            try {
              chapterToSave = await bookService.fetchBookChapter({ chapterId: selectedChapter?.$id });
            } catch (error) {
              console.log("download-unlocked: error", error);
            }
          }
          if (chapterToSave?.$id) {
            upsertDownloadedChapter({ bookId: book.$id, chapter: chapterToSave, book });
          }
        }
        setUnlockLoading(undefined);
        onSuccessUnlock();
      } catch (err) {
        showMessage("Something went wrong! Please contact admin.");
        console.log("handleUnlockNextPart error:", err);
      } finally {
        setUnlockLoading(undefined);
      }
    });
  };

  const handleShowCommingSoon = () => {
    showMessage("Feature will be available once book is completed.");
  };

  return (
    <>
      <Modal
        isVisible={isVisible}
        onBackButtonPress={unlockLoading !== undefined ? undefined : onClose}
        onBackdropPress={unlockLoading !== undefined ? undefined : onClose}
        style={{ margin: 0, justifyContent: "flex-end" }}
      >
        <View className="max-h-[85%] min-h-[85%] rounded-t-2xl" style={{ backgroundColor: theme.surfaceElevated }}>
          {/* Header */}
          <View className="flex-row items-center justify-between border-b px-4 py-3" style={{ borderColor: theme.border }}>
            <View>
              <Text className="text-lg font-semibold" style={{ color: theme.text }}>{selectedChapter?.title}</Text>
              <Text style={{ color: theme.textSoft }}>{remainingLockedParts} parts remaining</Text>
            </View>
            <TouchableOpacity disabled={unlockLoading !== undefined} onPress={onClose}>
              <Entypo name="cross" size={25} color={theme.icon} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 30 }}>
            {/* Banner */}
            <View className="m-4 items-center rounded-xl px-4 py-2" style={{ backgroundColor: theme.accentPurpleSoft, borderWidth: 1, borderColor: theme.accentPurple }}>
              <FastImage className="mt-[-10] h-20 w-20" source={images.logo} resizeMode={FastImage.resizeMode.stretch} />
              <Text className="mt-[-10] text-center text-base font-bold" style={{ color: theme.text }}>Selebox Originals</Text>
            </View>

            {/* Divider */}
            <View className="mx-4 flex-row items-center">
              <View className="flex-1 border-t" style={{ borderColor: theme.divider }} />
              <View className="mx-3">
                <Feather name="lock" size={25} color={theme.icon} />
              </View>
              <View className="flex-1 border-t" style={{ borderColor: theme.divider }} />
            </View>

            {/* Balances */}
            <BalanceItem label="My Coins" value={balance} theme={theme} icon={<FontAwesome5 name="coins" size={20} color={theme.coin} />} />
            <BalanceItem label="My Stars" value={starsData?.stars} theme={theme} icon={<StarIcon size={20} color={theme.coin} />} />

            {/* Store CTA */}
            <TouchableOpacity
              onPress={handleGoToStore}
              className="m-4 flex-row items-center justify-between rounded-lg px-4 py-3"
              style={{ backgroundColor: theme.dangerSoft, borderWidth: 1, borderColor: theme.danger }}
            >
              <View>
                <Text className="font-semibold" style={{ color: theme.danger }}>Not enough Coins or Stars.</Text>
                <Text className="mt-1 text-sm" style={{ color: theme.danger }}>Tap to earn or buy more.</Text>
              </View>
              <FontAwesome name="chevron-right" size={20} color={theme.icon} />
            </TouchableOpacity>

            {/* Unlock Options */}
            <UnlockOption
              label="Unlock next part"
              icon={<FontAwesome5 name="coins" size={20} color={theme.coin} />}
              cost={COSTS.coins}
              loading={unlockLoading === "coins"}
              theme={theme}
              onPress={() => handleUnlockNextPart("coins")}
            />
            <UnlockOption
              label="Unlock next part"
              icon={<StarIcon size={20} color={theme.coin} />}
              cost={COSTS.stars}
              loading={unlockLoading === "stars"}
              theme={theme}
              onPress={() => handleUnlockNextPart("stars")}
            />
            <UnlockOption
              label="Unlock whole story"
              subLabel={`${remainingLockedParts} locked parts`}
              icon={<FontAwesome5 name="coins" size={20} color={theme.coin} />}
              cost={COSTS.wholeStoryCoins}
              badge="Save 15%"
              onPress={() => handleUnlockNextPart("coins", true)}
              loading={unlockLoading === "wholeStoryCoins"}
              theme={theme}
            />
            <UnlockOption
              label="Unlock whole story"
              subLabel={`${remainingLockedParts} locked parts`}
              icon={<StarIcon size={20} color={theme.coin} />}
              cost={COSTS.wholeStoryStars}
              badge="Save 15%"
              onPress={() => handleUnlockNextPart("stars", true)}
              loading={unlockLoading === "wholeStoryStars"}
              theme={theme}
            />
          </ScrollView>
        </View>
      </Modal>
      <CustomAlertModal message={message} iconName="message" messageOpen={messageOpen} closeMessage={closeMessage} />
    </>
  );
};

export default BookChaptersUnlockModal;
