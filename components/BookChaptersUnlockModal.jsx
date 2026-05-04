import { Entypo, Feather, FontAwesome5, Ionicons } from "@expo/vector-icons";
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

// Balance pill: rounded card showing a label (e.g. "My Coins") with the
// currency icon in a soft tinted backdrop on the left and the numeric
// balance prominent on the right. Subtle purple-leaning border keeps it
// cohesive with the rest of the modal without competing with the unlock
// CTAs below.
const BalanceItem = ({ label, icon, value, theme }) => (
  <View
    className="mx-4 mt-2 flex-row items-center justify-between rounded-2xl px-3.5 py-2.5"
    style={{
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: "rgba(124, 58, 237, 0.12)",
    }}
  >
    <View className="flex-row items-center">
      <View
        className="mr-3 h-9 w-9 items-center justify-center rounded-full"
        style={{ backgroundColor: "rgba(245, 158, 11, 0.12)" }}
      >
        {icon}
      </View>
      <Text className="text-[15px] font-semibold" style={{ color: theme.text }}>
        {label}
      </Text>
    </View>
    <Text className="text-base font-bold" style={{ color: theme.text }}>
      {value ?? 0}
    </Text>
  </View>
);

// Unlock option card. Two visual tiers selected by `premium`:
//
//   • Standard (default) — clean surface card with a soft purple-tinted
//     border, currency-type micro-label, and chevron. Used for the
//     single-chapter "Unlock next part" rows.
//
//   • Premium (premium=true) — solid purple background with white text,
//     a soft inner highlight at the top for sheen, and a high-contrast
//     "Save 15%" badge. Used for the bulk "Unlock whole story" rows so
//     they read as the aspirational/best-value choice at a glance.
//
// `currencyLabel` is rendered as a small uppercase chip so the two
// next-part cards (coins vs stars) aren't visually identical.
const UnlockOption = ({
  label,
  subLabel,
  icon,
  cost,
  onPress,
  badge,
  loading = false,
  premium = false,
  currencyLabel,
  theme,
}) => {
  // Color tokens — premium uses inverted text on a purple field; standard
  // uses theme.text on the surface card.
  const titleColor = premium ? "#FFFFFF" : theme.text;
  const subLabelColor = premium ? "rgba(255,255,255,0.78)" : theme.textSoft;
  const chipBg = premium ? "rgba(255,255,255,0.18)" : "rgba(124, 58, 237, 0.10)";
  const chipText = premium ? "#FFFFFF" : theme.primary;
  const costText = premium ? "#FFFFFF" : theme.text;
  const chevronColor = premium ? "rgba(255,255,255,0.85)" : theme.textSubtle;
  const cardBg = premium ? theme.primary : theme.surface;
  const borderColor = premium ? "transparent" : "rgba(124, 58, 237, 0.18)";

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={loading}
      activeOpacity={0.85}
      className={`mx-4 my-1 flex-row items-center justify-between overflow-hidden rounded-2xl px-4 py-3.5 ${loading ? "opacity-60" : ""}`}
      style={{
        backgroundColor: cardBg,
        borderWidth: 1,
        borderColor,
        // Soft purple-tinted shadow on the premium tier for depth.
        ...(premium && {
          shadowColor: theme.primary,
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.28,
          shadowRadius: 12,
          elevation: 5,
        }),
      }}
    >
      {/* Subtle inner sheen for the premium tier — a translucent white
          band along the top edge that suggests a gradient without
          adding the expo-linear-gradient dependency. */}
      {premium && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            height: 18,
            backgroundColor: "rgba(255,255,255,0.10)",
          }}
        />
      )}

      <View className="flex-1 pr-3">
        <View className="mb-1 flex-row items-center" style={{ gap: 6 }}>
          {currencyLabel && (
            <View
              className="rounded-full px-2 py-0.5"
              style={{ backgroundColor: chipBg }}
            >
              <Text
                className="text-[10px] font-bold"
                style={{ color: chipText, letterSpacing: 0.5 }}
              >
                {currencyLabel}
              </Text>
            </View>
          )}
          {badge && (
            <View
              className="rounded-full px-2 py-0.5"
              style={{ backgroundColor: "#FCD34D" }}
            >
              <Text
                className="text-[10px] font-bold"
                style={{ color: "#78350F", letterSpacing: 0.4 }}
              >
                {badge}
              </Text>
            </View>
          )}
        </View>
        <Text className="text-[15px] font-semibold" style={{ color: titleColor }}>
          {label}
        </Text>
        {subLabel && (
          <Text className="mt-0.5 text-xs" style={{ color: subLabelColor }}>
            {subLabel}
          </Text>
        )}
      </View>

      <View className="flex-row items-center" style={{ gap: 6 }}>
        {loading ? (
          <ActivityIndicator size="small" color={premium ? "#FFFFFF" : theme.primary} />
        ) : (
          <>
            <View
              className="h-7 w-7 items-center justify-center rounded-full"
              style={{
                backgroundColor: premium ? "rgba(255,255,255,0.18)" : "rgba(245, 158, 11, 0.14)",
              }}
            >
              {icon}
            </View>
            <Text className="text-base font-bold" style={{ color: costText }}>
              {cost}
            </Text>
            <Ionicons name="chevron-forward" size={18} color={chevronColor} />
          </>
        )}
      </View>
    </TouchableOpacity>
  );
};

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

  // Prefer the per-book threshold over the global setting — same flicker
  // protection as the rest of the unlock surfaces. Used here only to
  // compute totalLockedParts for the price math; isChapterLocked itself
  // is enforced server-side and in the static helper.
  const bookChapterLockStart = Number(book?.bookChapterLockStart ?? globalSettings?.["BOOKS_CHAPTER_LOCK_START"]);
  const bookChapterCoinPrice = Number(globalSettings["BOOKS_CHAPTER_COIN_PRICE"]);
  const bookChapterStarPrice = Number(globalSettings["BOOKS_CHAPTER_STAR_PRICE"]);
  const bookUnlockWholeDiscount = Number(globalSettings["BOOKS_UNLOCK_WHOLE_DISCOUNT"]);
  const discountMultiplier = (100 - bookUnlockWholeDiscount) / 100;

  // Per-chapter override resolution. Authors can set
  // `chapters.unlock_cost_coins` / `unlock_cost_stars` (1-10 each) to
  // override the global default for an individual chapter — written via
  // chapter-editor's "Unlock Cost" section. NULL on the chapter row
  // means "inherit the platform default" (BOOKS_CHAPTER_*_PRICE).
  // We expose two helpers:
  //   resolveChapterCost(chapter, currency) → the effective price for
  //     unlocking a single chapter (override OR global default).
  //   sumLockedChaptersCost(currency) → the sum of effective prices
  //     across every locked chapter that the user hasn't unlocked yet,
  //     used for the bulk "unlock whole story" calculation.
  // Mirrors the web client's per-chapter-override behavior so prices
  // stay consistent across surfaces.
  const resolveChapterCost = (ch, currency) => {
    const fallback = currency === "coins" ? bookChapterCoinPrice : bookChapterStarPrice;
    if (!ch) return fallback;
    const override = currency === "coins"
      ? (ch.unlock_cost_coins ?? ch.unlockCostCoins)
      : (ch.unlock_cost_stars ?? ch.unlockCostStars);
    const n = Number(override);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

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

  // Build the set of still-locked chapters so we can sum their actual
  // costs. Falls back to (defaultPrice * remainingLockedParts) if we
  // don't have the chapter list (legacy callers / partial loads).
  //
  // We route through `BookUnlocksService.isChapterLockedForDisplay` here
  // — the SAME helper BookChaptersModal uses to decide whether to render
  // the lock icon on each row — so the bulk-cost CTA count and the
  // per-row icon count CANNOT diverge by construction. Previously this
  // filter only checked the book-level threshold, missing per-chapter
  // `is_locked=true` overrides; a chapter at order < threshold but with
  // is_locked=true would show a lock icon yet not contribute to the
  // bulk-unlock cost. With one shared helper, that's no longer possible.
  const stillLockedChapters = (Array.isArray(chapters) ? chapters : []).filter((ch, idx) =>
    BookUnlocksService.isChapterLockedForDisplay({
      book,
      bookChapterLockStart,
      chapter: ch,
      index: idx,
      unlocks,
    })
  );
  const sumLockedChaptersCost = (currency) => {
    // If we have NO locked chapters in the prop, fall back to (default
    // price × remaining count). Hits when the modal opens for a brand-
    // new reader before any chapter rows have arrived.
    if (!stillLockedChapters.length) {
      const fallback = currency === "coins" ? bookChapterCoinPrice : bookChapterStarPrice;
      return fallback * remainingLockedParts;
    }

    // If we have SOME locked chapters but the prop is incomplete (e.g.
    // book-info.jsx caps the prop at previewChaptersLimit=5 chapters
    // but the book has more locked parts), we'd otherwise sum a strict
    // subset and display a price way below what the server actually
    // charges. The user taps "3 coins" and gets billed 16. Bad UX.
    //
    // Heuristic: extrapolate the average resolved cost across the
    // locked chapters we DO have, and multiply by the true count. This
    // matches the server's behavior closely when chapters share the
    // same per-chapter override (the common case), and degrades
    // gracefully when costs vary (worst case: a few coins off, never
    // an order-of-magnitude wrong).
    const summed = stillLockedChapters.reduce((s, ch) => s + resolveChapterCost(ch, currency), 0);
    if (stillLockedChapters.length < remainingLockedParts) {
      const avg = summed / stillLockedChapters.length;
      return avg * remainingLockedParts;
    }
    return summed;
  };

  const selectedChapterCoinCost = resolveChapterCost(selectedChapter, "coins");
  const selectedChapterStarCost = resolveChapterCost(selectedChapter, "stars");
  const wholeStoryCoinsRaw = sumLockedChaptersCost("coins");
  const wholeStoryStarsRaw = sumLockedChaptersCost("stars");
  const COSTS = {
    coins: selectedChapterCoinCost,
    stars: selectedChapterStarCost,
    wholeStoryCoins: Math.ceil(wholeStoryCoinsRaw * discountMultiplier),
    wholeStoryStars: Math.ceil(wholeStoryStarsRaw * discountMultiplier),
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
        // Route through BookUnlocksService.unlockChapter /
        // unlockBookAllChapters (the wrappers in book-unlocks-supabase.js)
        // rather than calling the wallet-supabase RPC functions directly.
        // The wrappers do TWO important things we'd otherwise drop:
        //
        //   1. Resolve legacy_appwrite_id → uuid up front, so a passed-in
        //      hex string still hits the Supabase RPC instead of failing
        //      the UUID regex (the bug that produced the previous
        //      "unlockBook is not a function" crash).
        //   2. Fire the gamification goal hooks (tickGoalUnique) so a
        //      reader's chapter/book unlocks count toward their daily
        //      quests. The web ticks from a different code path; mobile
        //      previously skipped it because we called the raw RPCs.
        //
        // We still pass `.id` first (the UUID) so the wrapper's
        // resolve step short-circuits — but the wrapper handles the
        // legacy hex case if anything ever passes one.
        const currency = type === EarningType.coins ? "coin" : "star";
        const targetId = unlockAll
          ? (book?.id || book?.$id)
          : (selectedChapter?.id || selectedChapter?.$id);
        if (!targetId) {
          throw new Error(
            `Unlock unavailable: missing ID for this ${unlockAll ? "book" : "chapter"}. Please refresh and try again.`
          );
        }

        let rpc;
        try {
          rpc = unlockAll
            ? await bookUnlockService.unlockBookAllChapters({ bookId: targetId, currency })
            : await bookUnlockService.unlockChapter({ chapterId: targetId, currency });
        } catch (rpcError) {
          console.log("Chapter/book unlock RPC threw:", rpcError?.message);
          showMessage(rpcError?.message || "Unlock failed — please try again.");
          setUnlockLoading(undefined);
          return;
        }
        if (!rpc?.ok) {
          const reason =
            rpc?.error === "insufficient_balance"
              ? `Insufficient ${type}`
              : rpc?.error === "kyc_not_approved"
                ? "KYC must be approved first."
                : rpc?.error || "Unlock failed";
          showMessage(reason);
          setUnlockLoading(undefined);
          return;
        }
        // Realtime wallet subscription will push the new balance.
        // refetchBalance also updates star_balance from the same wallet
        // row, so refetchStars would be redundant on Supabase — skip it.
        await refetchBalance(user.$id);
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
        // Surface the actual error message instead of the generic
        // "Something went wrong!" — that catch-all hid useful info from
        // both the user and us during debugging. We still keep a
        // human-readable fallback for the rare case where err.message is
        // missing/unhelpful.
        const reason = (err && (err.message || err.error || err.reason || "")).toString().trim();
        showMessage(
          reason
            ? `Couldn't unlock: ${reason}`
            : "Couldn't unlock — please try again or contact admin."
        );
        // console.error so it shows up in the "Errors only" filter in dev
        // tools / Metro / production crash reporting.
        console.error("handleUnlockNextPart error:", err);
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
              <Text className="text-lg font-semibold" style={{ color: theme.text }}>
                {selectedChapter?.title}
              </Text>
              <Text style={{ color: theme.textSoft }}>{remainingLockedParts} parts remaining</Text>
            </View>
            <TouchableOpacity disabled={unlockLoading !== undefined} onPress={onClose}>
              <Entypo name="cross" size={25} color={theme.icon} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 }}>
            {/* Selebox Originals banner — purple soft bg with the brand
                logo. Slight elevation via shadow for premium feel. */}
            <View
              className="mx-4 mt-4 items-center overflow-hidden rounded-2xl px-4 py-3"
              style={{
                backgroundColor: theme.accentPurpleSoft,
                borderWidth: 1,
                borderColor: theme.accentPurple,
                shadowColor: theme.primary,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.12,
                shadowRadius: 10,
                elevation: 2,
              }}
            >
              <FastImage
                style={{ height: 56, width: 56 }}
                source={images.logo}
                resizeMode={FastImage.resizeMode.contain}
              />
              <Text className="mt-1 text-center text-[15px] font-bold" style={{ color: theme.text, letterSpacing: 0.2 }}>
                Selebox Originals
              </Text>
            </View>

            {/* Divider with lock icon — wrapped in a soft purple circle so
                it feels intentional, not orphaned. The hairlines on either
                side keep the visual break. */}
            <View className="mx-4 my-4 flex-row items-center">
              <View className="flex-1 border-t" style={{ borderColor: theme.divider }} />
              <View
                className="mx-3 h-10 w-10 items-center justify-center rounded-full"
                style={{
                  backgroundColor: theme.accentPurpleSoft,
                  borderWidth: 1,
                  borderColor: "rgba(124, 58, 237, 0.25)",
                }}
              >
                <Feather name="lock" size={18} color={theme.primary} />
              </View>
              <View className="flex-1 border-t" style={{ borderColor: theme.divider }} />
            </View>

            {/* Balances — soft purple-bordered pills. The currency icon
                gets a tinted backdrop so it reads as part of the brand
                language, not a stray glyph. */}
            <BalanceItem
              label="My Coins"
              value={balance}
              theme={theme}
              icon={<FontAwesome5 name="coins" size={16} color={theme.coin} />}
            />
            <BalanceItem
              label="My Stars"
              value={starsData?.stars}
              theme={theme}
              icon={<StarIcon size={16} color={theme.coin} />}
            />

            {/* Friendly top-up nudge — recolored from a hard red warning to
                a brand-purple invitation so it reads as a helpful next step
                ("here's where to get more") rather than an error state.
                Matches the modal's overall purple language. */}
            <TouchableOpacity
              onPress={handleGoToStore}
              activeOpacity={0.85}
              className="mx-4 mt-3 mb-2 flex-row items-center rounded-2xl px-3.5 py-3"
              style={{
                backgroundColor: theme.accentPurpleSoft,
                borderWidth: 1,
                borderColor: "rgba(124, 58, 237, 0.22)",
              }}
            >
              <View
                className="mr-3 h-9 w-9 items-center justify-center rounded-full"
                style={{ backgroundColor: "rgba(124, 58, 237, 0.14)" }}
              >
                <Feather name="plus-circle" size={18} color={theme.primary} />
              </View>
              <View className="flex-1">
                <Text className="text-[14px] font-semibold" style={{ color: theme.primary }}>
                  Need more Coins or Stars?
                </Text>
                <Text className="mt-0.5 text-xs" style={{ color: theme.primary, opacity: 0.78 }}>
                  Tap to earn or buy more
                </Text>
              </View>
              <Feather name="chevron-right" size={18} color={theme.primary} />
            </TouchableOpacity>

            {/* Section label — "Unlock options" so the buttons below feel
                grouped, not loose. Slim and dimmed so it doesn't compete. */}
            <Text
              className="mx-4 mt-3 mb-1 text-[10px] font-bold"
              style={{ color: theme.textSoft, letterSpacing: 1.2 }}
            >
              UNLOCK OPTIONS
            </Text>

            {/* Standard tier — single chapter, two currencies. The
                currencyLabel chip differentiates the otherwise-identical
                rows at a glance. */}
            <UnlockOption
              label="Unlock next part"
              currencyLabel="COINS"
              icon={<FontAwesome5 name="coins" size={14} color={theme.coin} />}
              cost={COSTS.coins}
              loading={unlockLoading === "coins"}
              theme={theme}
              onPress={() => handleUnlockNextPart("coins")}
            />
            <UnlockOption
              label="Unlock next part"
              currencyLabel="STARS"
              icon={<StarIcon size={14} color={theme.coin} />}
              cost={COSTS.stars}
              loading={unlockLoading === "stars"}
              theme={theme}
              onPress={() => handleUnlockNextPart("stars")}
            />

            {/* Bulk-tier separator — subtle "Best value" hint above the
                premium cards. */}
            <Text
              className="mx-4 mt-4 mb-1 text-[10px] font-bold"
              style={{ color: theme.primary, letterSpacing: 1.2 }}
            >
              BEST VALUE · WHOLE STORY
            </Text>

            {/* Premium tier — solid purple field, white text, prominent
                Save 15% badge. Reads as the aspirational choice. */}
            <UnlockOption
              label="Unlock whole story"
              subLabel={`${remainingLockedParts} locked parts`}
              currencyLabel="COINS"
              icon={<FontAwesome5 name="coins" size={14} color="#FFFFFF" />}
              cost={COSTS.wholeStoryCoins}
              badge="Save 15%"
              premium
              onPress={() => handleUnlockNextPart("coins", true)}
              loading={unlockLoading === "wholeStoryCoins"}
              theme={theme}
            />
            <UnlockOption
              label="Unlock whole story"
              subLabel={`${remainingLockedParts} locked parts`}
              currencyLabel="STARS"
              icon={<StarIcon size={14} color="#FFFFFF" />}
              cost={COSTS.wholeStoryStars}
              badge="Save 15%"
              premium
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
