import { Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  InteractionManager,
  Modal,
  Platform,
  Pressable,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import FastImage from "react-native-fast-image";
import RenderHTML from "react-native-render-html";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useSelector } from "react-redux";
import { BookChapterFooter, BookChaptersModal, BookChapterStats, BookChaptersUnlockModal } from "../../components";
import AnimatedSkeleton from "../../components/AnimatedSkeleton";
import BookInlineCommentModal from "../../components/BookInlineCommentModal";
import useAppTheme from "../../hooks/useAppTheme";
import useIsOffline from "../../hooks/useIsOffline";
import { findDownloadedBookByChapterId } from "../../lib/book-downloads";
import { normalizeBookContentToHtml } from "../../lib/book-content";
import { createInlineCommentDomVisitors, INLINE_COMMENT_ATTRS } from "../../lib/book-inline-comment-anchors";
import { BookInlineCommentsService } from "../../lib/book-inline-comments";
import { BookReadService } from "../../lib/book-reads";
import { invalidateBookProgress } from "../../hooks/useBookProgress";
import { tickGoalUnique } from "../../lib/goals-store";
import { BookUnlocksService } from "../../lib/book-unlocks";
import { BOOK_CHAPTER_LIST_SELECT, BookService, getBookChapterOrder } from "../../lib/books";
import { THEME_MODES, themeColors } from "../../theme/colors";

const sanitizeImageTag = (tag = "") => {
  const srcMatch = tag.match(/\ssrc=(["'])(.*?)\1/i);
  const src = srcMatch?.[2]?.trim();
  if (!src || !/^https?:\/\//i.test(src)) return "";
  return tag;
};
const stripBackgroundStyles = (html = "") => {
  if (!html) return html;
  const cleanStyle = (styleText = "") => {
    const cleaned = styleText
      .split(";")
      .map((rule) => rule.trim())
      .filter(
        (rule) =>
          rule &&
          !rule.toLowerCase().startsWith("background") &&
          !rule.toLowerCase().startsWith("font-size") &&
          !rule.toLowerCase().startsWith("font-family") &&
          !rule.toLowerCase().startsWith("color"),
      )
      .join("; ");
    return cleaned;
  };

  const stripStyleAttribute = (match, styleText) => {
    const cleaned = cleanStyle(styleText);
    return cleaned ? `style="${cleaned}"` : "";
  };

  return html
    .replace(/<font\b[^>]*>/gi, "<span>")
    .replace(/<\/font>/gi, "</span>")
    .replace(/<img\b[^>]*>/gi, sanitizeImageTag)
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/style="([^"]*)"/gi, stripStyleAttribute)
    .replace(/style='([^']*)'/gi, (match, styleText) => {
      const cleaned = cleanStyle(styleText);
      return cleaned ? `style='${cleaned}'` : "";
    })
    .replace(/\sstyle=(["'])(\s*)\1/gi, "");
};
const normalizeRouteParam = (value) => {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
};

const PAGE_CHAPTER_SWIPE_DISTANCE = 36;
const PAGE_CHAPTER_SWIPE_AXIS_RATIO = 0.85;

// Module-level snapshot cache for the book-reading screen (May 2026
// — perf fix). Same stale-while-revalidate idea as BOOK_INFO_CACHE,
// scoped to per-book reader state.
//
// What it caches per bookId:
//   - allChapters list (the table-of-contents the swipe nav uses)
//   - unlocks document (the user's per-chapter / fully-unlocked state)
//   - book object (with isLocked / bookChapterLockStart for the gate)
//
// What it does NOT cache:
//   - The CURRENT chapter's content. That's a per-chapter resource
//     and lives in BOOK_CHAPTER_CACHE (lib/books-supabase.js, 30s
//     TTL). Skipping content here keeps the snapshot small AND
//     avoids stale-content risk if the writer edits chapter 5.
//
// Cache key = bookId. TTL = 5 minutes (matches BOOK_INFO_CACHE).
// Why per-book and not per-chapter: navigating chapter 1 → 2 → 3 in
// the same book hits the SAME (allChapters, unlocks) values. Caching
// per-chapter would be a wasted indirection.
//
// Refresh policy: snapshot is read on screen mount; the existing
// fetch always still runs and overwrites the snapshot when fresh
// data arrives. So a stale entry only ever shows for a single
// frame before being replaced — the user sees instant paint, then
// data refreshes seamlessly.
const READING_SCREEN_CACHE = new Map();
const READING_SCREEN_CACHE_TTL_MS = 5 * 60 * 1000;

const readReadingCache = (bookId) => {
  if (!bookId) return null;
  const entry = READING_SCREEN_CACHE.get(bookId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > READING_SCREEN_CACHE_TTL_MS) {
    READING_SCREEN_CACHE.delete(bookId);
    return null;
  }
  return entry.snapshot;
};

const writeReadingCache = (bookId, snapshot) => {
  if (!bookId || !snapshot) return;
  READING_SCREEN_CACHE.set(bookId, { snapshot, cachedAt: Date.now() });
};

export default function ReadingScreen() {
  const { user } = useSelector((state) => state.auth);
  const { globalSettings } = useSelector((state) => state.app);
  const { theme, isDarkMode } = useAppTheme();
  const isOffline = useIsOffline();
  const navigation = useNavigation();
  const { chapterId, inlineCommentAnchorKey, inlineCommentOpen } = useLocalSearchParams();
  const resolvedInlineCommentAnchorKey = Array.isArray(inlineCommentAnchorKey) ? inlineCommentAnchorKey[0] : inlineCommentAnchorKey;
  const resolvedInlineCommentOpen = Array.isArray(inlineCommentOpen) ? inlineCommentOpen[0] : inlineCommentOpen;
  const params = useLocalSearchParams();
  const resolvedChapterId = normalizeRouteParam(params.chapterId);
  const focusCommentIdParam = normalizeRouteParam(params.focusCommentId || params.commentId || params.comment);
  const focusReplyIdParam = normalizeRouteParam(params.focusReplyId || params.replyId);
  const openCommentsParam = useMemo(() => {
    const raw = normalizeRouteParam(params.openComments);
    return raw === "1" || raw === "true";
  }, [params.openComments]);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [chapter, setChapter] = useState();
  const [book, setBook] = useState();
  const [allChapters, setAllChapters] = useState([]);
  const [unlocks, setUnlocks] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uiVisible, setUiVisible] = useState(true);
  const [chaptersVisible, setChaptersVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [chapterUnlockVisible, setChapterUnlockVisible] = useState(false);
  const [selectedChapter, setSelectedChapter] = useState(null);
  const [inlineCommentThreads, setInlineCommentThreads] = useState({});
  const [inlineCommentVisible, setInlineCommentVisible] = useState(false);
  const [selectedInlineAnchor, setSelectedInlineAnchor] = useState(null);
  const [isBookInLibrary, setIsBookInLibrary] = useState(null);
  const [exitPromptVisible, setExitPromptVisible] = useState(false);
  const [savingToLibrary, setSavingToLibrary] = useState(false);
  const [exitGuardBypassed, setExitGuardBypassed] = useState(false);
  // Tracks whether the chapter-4 prompt has already been shown today for
  // this (user, book). Hydrated from AsyncStorage on mount; if today's
  // YYYY-MM-DD already lives under the key, the exit guard stays
  // disengaged and back navigates straight away.
  const [promptThrottledForToday, setPromptThrottledForToday] = useState(false);

  const [pageColor, setPageColor] = useState(isDarkMode ? "dark" : "light");
  const [readingMode, setReadingMode] = useState("scroll");
  const [fontSize, setFontSize] = useState(18);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [transitioning, setTransitioning] = useState(false);
  const [showBottomSwipeIndicator, setShowBottomSwipeIndicator] = useState(false);

  const bookService = useRef(new BookService()).current;
  const bookUnlockService = useRef(new BookUnlocksService()).current;
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const scrollRef = useRef(null);
  const headerAnim = useRef(new Animated.Value(0)).current;
  const footerAnim = useRef(new Animated.Value(0)).current;
  const swipeIndicatorAnim = useRef(new Animated.Value(0)).current;
  const touchStartRef = useRef({ x: 0, y: 0 });
  const scrollMetricsRef = useRef({ contentHeight: 0, viewportHeight: 0 });
  const handledInlineNotificationRef = useRef("");
  const activeInlineThreadChapterIdRef = useRef("");
  // Holds the pending navigation action that triggered the exit prompt
  // so we can replay it once the user picks Save / Don't Save.
  const pendingNavigationActionRef = useRef(null);
  // Wattpad-style scroll persistence:
  //   • scrollPositionRef.current.pct — fraction of contentHeight (0-1)
  //     where the reader currently is. Updated cheaply on every scroll
  //     tick; the actual write to book_reads is debounced.
  //   • scrollPositionRef.current.dirty — true when there's an unsaved
  //     position waiting to be flushed. Set on scroll, cleared on flush.
  //   • scrollPositionRef.current.chapterId — which chapter the position
  //     belongs to. Captured at scroll time so a flush that fires after
  //     a chapter change still writes to the correct chapter row.
  //   • scrollPersistTimerRef — the debounce handle. Reset on each scroll
  //     event so the write fires once the reader has been still for ~1.5s.
  const scrollPositionRef = useRef({ pct: 0, dirty: false, chapterId: null });
  const scrollPersistTimerRef = useRef(null);
  const SCROLL_PERSIST_DEBOUNCE_MS = 1500;
  // Holds a pending Wattpad-style resume — the saved scroll pct for the
  // chapter currently mounting. Set asynchronously when the user opens
  // a book/chapter that matches their saved last_chapter_id; consumed
  // by onContentSizeChange once the chapter HTML has laid out and we
  // know the final contentHeight to multiply against. Cleared after
  // the scrollTo so a re-render of the same chapter doesn't replay
  // the seek (which would be jarring if the user had scrolled away).
  const pendingScrollRestoreRef = useRef({ chapterId: null, pct: 0 });
  const minimumFont = 16;
  const maximumFont = 20;
  const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = Dimensions.get("window");
  // Prefer the per-book threshold (mapped from `lock_from_chapter`).
  // Falling through to globalSettings only if the book row hasn't set
  // its own. Avoids the Paid → Free flicker we hit when globalSettings
  // hadn't rehydrated and the gate trivially evaluated to false.
  const bookChapterLockStart = book?.bookChapterLockStart ?? globalSettings?.["BOOKS_CHAPTER_LOCK_START"];
  const isPagingMode = readingMode === "page";
  const showPagingSwipeIndicator = isPagingMode && allChapters.length > 1;
  const currentPageTheme = bookReadingTheme[pageColor];
  const skeletonBaseColor = currentPageTheme.skeletonBase;
  const lineHeight = Math.round(fontSize * 1.6);
  // Memoized RenderHTML props. Without these the prop refs change on
  // EVERY render — including each scroll tick (handleScroll calls
  // setState multiple times per second) — which forces RenderHTML to
  // re-parse and re-flatten the entire chapter HTML each time. On a
  // 100KB chapter that's ~20-40ms of synchronous work per scroll
  // event, which is exactly what made scrolling feel "laggy."
  const htmlBaseStyle = useMemo(
    () => ({ color: currentPageTheme.fontColor, fontSize, lineHeight }),
    [currentPageTheme.fontColor, fontSize, lineHeight],
  );
  const htmlTagsStyles = useMemo(
    () => ({
      p: { marginTop: 0, marginBottom: 12 },
      h1: { color: currentPageTheme.fontColor, fontSize: fontSize + 10, marginTop: 12, marginBottom: 8 },
      h2: { color: currentPageTheme.fontColor, fontSize: fontSize + 6, marginTop: 12, marginBottom: 8 },
      h3: { color: currentPageTheme.fontColor, fontSize: fontSize + 3, marginTop: 12, marginBottom: 6 },
      strong: { color: currentPageTheme.fontColor },
      em: { color: currentPageTheme.fontColor },
      u: { textDecorationLine: "underline" },
      s: { textDecorationLine: "underline" },
      span: { color: currentPageTheme.fontColor },
      // Clamp embedded chapter images to the reader column width and let
      // height auto-scale so aspect ratio is preserved. tagsStyles wins
      // over the inline `max-width:100%` in the HTML, so without an
      // explicit width here intrinsic-sized images blow past the screen
      // and push body text off-screen.
      img: {
        width: "100%",
        height: "auto",
        maxWidth: "100%",
        alignSelf: "center",
        marginTop: 10,
        marginBottom: 16,
        borderRadius: 12,
      },
    }),
    [currentPageTheme.fontColor, fontSize],
  );

  // Pre-process the chapter HTML once per chapter, not once per render.
  // sanitizeImageTag + stripBackgroundStyles + normalizeBookContentToHtml
  // are all regex-heavy on long chapters; running them inside the JSX
  // source prop meant they fired on every parent re-render. Keyed on
  // chapter $id + a length sentinel so a writer's edit (rare during a
  // user's reading session) still triggers a re-process if the screen
  // happens to be open.
  const processedChapterHtml = useMemo(() => {
    if (!chapter?.content) return "";
    return stripBackgroundStyles(normalizeBookContentToHtml(chapter.content));
  }, [chapter?.$id, chapter?.content]);

  useEffect(() => {
    const fetchChapter = async () => {
      try {
        setLoading(true);
        // Pass actorUserId so authors reading their own draft chapter
        // get a real result. Readers fall through to the public path.
        const doc = await bookService.fetchBookChapter({ chapterId: resolvedChapterId, actorUserId: user?.$id });
        if (!doc) throw new Error("Unable to load chapter");

        const chapterBookId = doc?.book?.$id || doc?.book;

        // Fetch the FULL book in parallel with the rest below.
        // The chapter's embedded `books` join (CHAPTER_SELECT) only
        // returns lock_from_chapter + cover + title + author_id —
        // missing the uploader profile (username, avatar, role) the
        // BookChaptersModal header needs to render "By <author>" and
        // the cover. Pulling the full book row here keeps that
        // surface populated. Cached at lib level (BOOK_CACHE, 30s
        // TTL) so repeat calls within a session are cheap.
        const fullBookPromise = chapterBookId
          ? bookService.fetchBook({ bookId: chapterBookId, actorUserId: user?.$id })
          : Promise.resolve(null);

        // Snapshot cache check (May 2026 perf fix). If the user just
        // navigated chapter→chapter inside the same book, allChapters
        // + unlocks + book are unchanged from the previous load —
        // skip the parallel network fetches and hydrate from the
        // module cache. A background refresh runs after to catch any
        // drift (writer added a chapter, user paid in another tab),
        // so the next render still has fresh data.
        const snapshot = chapterBookId ? readReadingCache(chapterBookId) : null;
        const haveSnapshot = !!(snapshot && snapshot.bookId === chapterBookId);

        const [{ documents: chapterDocs = [] } = {}, unlocksData = { documents: [] }] = haveSnapshot
          ? [
              { documents: snapshot.allChapters },
              { documents: snapshot.unlocks ? [snapshot.unlocks] : [] },
            ]
          : await Promise.all([
              bookService.fetchAllBookChapters({ bookId: chapterBookId, status: "Publish", select: BOOK_CHAPTER_LIST_SELECT }),
              bookUnlockService.getBookUnlockByUser({ book: chapterBookId, unlockBy: user?.$id }),
            ]);

        const unlockDocument = unlocksData.documents?.[0];
        const idx = chapterDocs.findIndex((c) => c.$id === resolvedChapterId);
        const safeIndex = idx >= 0 ? idx : 0;

        // Resolve the full book (started in parallel above). Falls
        // back to the chapter's embedded book if the full fetch
        // returned null — at minimum the lock fields + title are
        // still present.
        const fullBook = (await fullBookPromise) || doc?.book;

        setChapterIndex(safeIndex);
        if (unlockDocument) setUnlocks(unlockDocument);
        setAllChapters(chapterDocs);
        setChapter(doc);
        setBook(fullBook);

        // Snapshot the surrounding state into the per-book cache so
        // the next chapter open in this book skips the parallel
        // fetches above. bookId is captured on the entry so reads
        // can verify the snapshot matches the requested book.
        //
        // No background refresh on snapshot hits (May 2026 fix).
        // The previous version fired a second setAllChapters after
        // the network came back, which made BookChaptersModal's
        // chapters-dep useEffect re-fire and cascade into a "Maximum
        // update depth exceeded" loop. The snapshot's 5-min TTL is
        // tight enough that staleness windows are short — pull-to-
        // refresh in the TOC or closing+reopening the book picks up
        // any new chapters.
        writeReadingCache(chapterBookId, {
          bookId: chapterBookId,
          allChapters: chapterDocs,
          unlocks: unlockDocument || null,
          book: fullBook,
        });

        // Check if this chapter is locked
        const isLocked = BookUnlocksService.isChapterLocked({
          book: doc?.book,
          bookChapterLockStart,
          chapter: doc,
          index: safeIndex,
          unlocks: unlockDocument,
          currentUserId: user?.$id,
        });

        // If locked, show unlock modal immediately
        if (isLocked) {
          setSelectedChapter(doc);
          setChapterUnlockVisible(true);
        } else {
          BookReadService.readBookChapter({ userId: user?.$id, bookId: doc?.book?.$id, chapterId: doc?.$id });
          // Tick the read_chapters goal (deduped per chapter $id per
          // day so re-opening doesn't farm the counter).
          tickGoalUnique("read_chapters", doc?.$id);
        }
      } catch (err) {
        const offlineEntry = findDownloadedBookByChapterId(resolvedChapterId);
        if (!offlineEntry) {
          console.error(err);
          return;
        }

        const offlineChapters = (offlineEntry.chapters || []).map((chapter) => ({
          ...chapter,
          book: offlineEntry.book || chapter.book,
        }));
        const idx = offlineChapters.findIndex((chapter) => chapter.$id === resolvedChapterId);
        const safeIndex = idx >= 0 ? idx : 0;

        const offlineBook = offlineEntry.book || offlineChapters[0]?.book;
        setChapterIndex(safeIndex);
        setAllChapters(offlineChapters);
        setChapter(offlineChapters[safeIndex]);
        setBook(offlineBook);
        setUnlocks({ chapters: offlineEntry.chapterIds || offlineChapters.map((chapter) => chapter.$id) });
        BookReadService.readBookChapter({
          userId: user?.$id,
          bookId: offlineBook?.$id || offlineEntry.bookId,
          chapterId: offlineChapters[safeIndex]?.$id,
        });
        tickGoalUnique("read_chapters", offlineChapters[safeIndex]?.$id);
      } finally {
        setLoading(false);
      }
    };

    const fetchPersistedBookReadingThemeData = async () => {
      const keys = ["pageColor", "fontSize", "readingMode"];
      const result = await AsyncStorage.multiGet(keys);
      const bookTheme = Object.fromEntries(result);

      if (bookTheme.pageColor) setPageColor(bookTheme.pageColor);
      if (bookTheme.fontSize) setFontSize(Number(bookTheme.fontSize));
      if (bookTheme.readingMode) setReadingMode(bookTheme.readingMode);
    };

    // Theme hydration is fast (single AsyncStorage multiGet, no
    // network) so it stays on the synchronous mount path — needed for
    // the first render to honor the user's saved pageColor + fontSize.
    fetchPersistedBookReadingThemeData();
    // Defer the chapter fetch until after the screen-transition
    // animation settles. Without this, the network call (and downstream
    // setState fanout) shares the JS bridge with expo-router's
    // slide-in, which is exactly the "tap → reader feels laggy" the
    // user reported. The lib's BOOK_CHAPTER_CACHE has a 30s TTL so
    // resume-tap on a freshly-prefetched chapter still resolves
    // synchronously here. book-info.jsx uses the same pattern for the
    // same reason (its 7-fetch Promise.all was tanking transitions).
    const interactionHandle = InteractionManager.runAfterInteractions(() => {
      fetchChapter();
    });

    return () => {
      interactionHandle?.cancel?.();
      const { pageColor, fontSize, readingMode } = latestThemeRef.current;
      const bookReadingThemeData = [
        ["pageColor", pageColor],
        ["fontSize", fontSize.toString()],
        ["readingMode", readingMode],
      ];
      AsyncStorage.multiSet(bookReadingThemeData);
    };
  }, [resolvedChapterId]);

  const latestThemeRef = useRef({ pageColor, fontSize, readingMode });

  useEffect(() => {
    latestThemeRef.current = { pageColor, fontSize, readingMode };
  }, [pageColor, fontSize, readingMode]);

  useEffect(() => {
    activeInlineThreadChapterIdRef.current = String(chapter?.$id || "");
  }, [chapter?.$id]);

  useEffect(() => {
    Animated.timing(headerAnim, {
      toValue: uiVisible ? 0 : -130,
      duration: 250,
      useNativeDriver: true,
    }).start();

    Animated.timing(footerAnim, {
      toValue: uiVisible ? 0 : 130,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [uiVisible]);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(swipeIndicatorAnim, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(swipeIndicatorAnim, {
          toValue: 0,
          duration: 700,
          useNativeDriver: true,
        }),
      ]),
    );

    loop.start();
    return () => loop.stop();
  }, [swipeIndicatorAnim]);

  useEffect(() => {
    if (isPagingMode) {
      setShowBottomSwipeIndicator(false);
    }
  }, [isPagingMode]);

  useEffect(() => {
    let active = true;

    const checkBookLibraryStatus = async () => {
      if (!book?.$id || !user?.$id) {
        if (active) setIsBookInLibrary(null);
        return;
      }

      try {
        const existingBookLibrary = await bookService.getBookLibrayByUser({ bookId: book.$id, userId: user.$id });
        if (active) setIsBookInLibrary(existingBookLibrary?.documents?.length > 0);
      } catch (error) {
        if (active) setIsBookInLibrary(false);
        console.error("checkBookLibraryStatus: error", error);
      }
    };

    checkBookLibraryStatus();
    return () => {
      active = false;
    };
  }, [book?.$id, bookService, user?.$id]);

  // ── Save-to-library prompt on exit, gated to chapter 4+ + once-per-day ──
  //
  // History — three iterations of this UX:
  //   v1: prompt fired on EVERY exit from EVERY chapter regardless of how
  //       far the user had read. Users complained it was spam.
  //   v2: silent auto-save the moment the user reached chapter 4. Charles
  //       pushed back: forcing the book into the library means a user
  //       who's not interested has to take a manual action to remove it.
  //   v3 (this): explicit prompt on exit, but ONLY when (a) the user has
  //       made it to chapter order >= 4 (a real "committed reader" signal)
  //       AND (b) we haven't already shown the prompt for this (user, book)
  //       today. Picking either Save or Don't Save sets the daily key, so
  //       re-entering the same book in the same day exits silently.
  //
  // The reading-progress side of "remember where I left off" is handled
  // entirely outside this screen: every chapter open already calls
  // BookReadService.readBookChapter, which upserts book_reads with
  // last_chapter_id. The book-info screen reads from that table and
  // shows "Continue Reading: <chapter>" instead of "Start Reading", so
  // when the user returns they pick up at their last stop. No extra
  // resume bookkeeping needed in this file.
  const chapterOrder = chapter ? getBookChapterOrder(chapter, chapterIndex) : null;
  const hasReachedPromptThreshold = Number.isFinite(chapterOrder) && chapterOrder >= 4;

  // Hydrate the "already prompted today?" flag from AsyncStorage. Runs
  // when the (user, book) pair changes; if today's date already lives
  // under the throttle key we keep the guard disengaged for the rest of
  // the session on this book.
  useEffect(() => {
    if (!book?.$id || !user?.$id) return;
    let cancelled = false;
    const storageKey = `book_lib_prompt:${user.$id}:${book.$id}`;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    (async () => {
      try {
        const lastShown = await AsyncStorage.getItem(storageKey);
        if (cancelled) return;
        setPromptThrottledForToday(lastShown === today);
      } catch {
        // AsyncStorage hiccups shouldn't accidentally trap the user — if
        // we can't read the throttle key, default to "not throttled" and
        // let them see the prompt once. Picking either button will set
        // the key and silence it for the rest of the day.
        if (!cancelled) setPromptThrottledForToday(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [book?.$id, user?.$id]);

  const shouldPreventExit = Boolean(
    book?.$id &&
      user?.$id &&
      !isOffline &&
      isBookInLibrary === false && // explicit false — null still loading
      hasReachedPromptThreshold &&
      !promptThrottledForToday &&
      !exitGuardBypassed,
  );

  const markPromptShownForToday = useCallback(async () => {
    if (!book?.$id || !user?.$id) return;
    const storageKey = `book_lib_prompt:${user.$id}:${book.$id}`;
    const today = new Date().toISOString().slice(0, 10);
    try {
      await AsyncStorage.setItem(storageKey, today);
    } catch (error) {
      console.warn("[book-reading] could not persist prompt throttle:", error?.message);
    }
    setPromptThrottledForToday(true);
  }, [book?.$id, user?.$id]);

  const proceedPendingExit = useCallback(() => {
    setExitPromptVisible(false);
    setExitGuardBypassed(true);
  }, []);

  usePreventRemove(shouldPreventExit, ({ data }) => {
    pendingNavigationActionRef.current = data.action;
    setExitPromptVisible(true);
  });

  // Replays the deferred navigation action once the user has chosen Save
  // or Don't Save. Driven by exitGuardBypassed flipping true so the
  // <usePreventRemove> hook stops blocking before we redispatch.
  useEffect(() => {
    if (!exitGuardBypassed) return;

    const pendingAction = pendingNavigationActionRef.current;
    pendingNavigationActionRef.current = null;

    const frameId = requestAnimationFrame(() => {
      if (pendingAction) {
        navigation.dispatch(pendingAction);
        return;
      }

      navigation.goBack();
    });

    return () => cancelAnimationFrame(frameId);
  }, [exitGuardBypassed, navigation]);

  const handleDismissPrompt = useCallback(() => {
    pendingNavigationActionRef.current = null;
    setExitPromptVisible(false);
  }, []);

  const handleDontSaveAndExit = useCallback(async () => {
    await markPromptShownForToday();
    proceedPendingExit();
  }, [markPromptShownForToday, proceedPendingExit]);

  const handleSaveToLibraryAndExit = useCallback(async () => {
    if (!book?.$id || !user?.$id || savingToLibrary) return;
    try {
      setSavingToLibrary(true);
      const existing = await bookService.getBookLibrayByUser({ bookId: book.$id, userId: user.$id });
      if ((existing?.documents?.length ?? 0) === 0) {
        await bookService.createBookLibrary({ bookId: book.$id, userId: user.$id });
      }
      setIsBookInLibrary(true);
      await markPromptShownForToday();
      setSavingToLibrary(false);
      proceedPendingExit();
    } catch (error) {
      setSavingToLibrary(false);
      console.error("handleSaveToLibraryAndExit: error", error);
      Alert.alert("Error", "Unable to add this book to your library right now.");
    }
  }, [book?.$id, bookService, markPromptShownForToday, proceedPendingExit, savingToLibrary, user?.$id]);

  const loadInlineCommentThreads = useCallback(async (bookChapterId) => {
    const normalizedChapterId = String(bookChapterId || "");
    if (!normalizedChapterId) {
      setInlineCommentThreads({});
      return;
    }

    const threadDocuments = await BookInlineCommentsService.fetchAllChapterThreads({ bookChapterId: normalizedChapterId });
    if (activeInlineThreadChapterIdRef.current !== normalizedChapterId) return;

    const nextThreadMap = {};
    for (const threadDocument of threadDocuments) {
      if (!threadDocument?.anchorKey) continue;
      nextThreadMap[threadDocument.anchorKey] = threadDocument;
    }

    setInlineCommentThreads(nextThreadMap);
  }, []);

  useEffect(() => {
    setInlineCommentVisible(false);
    setSelectedInlineAnchor(null);
    setInlineCommentThreads({});
    void loadInlineCommentThreads(chapter?.$id);
  }, [chapter?.$id, loadInlineCommentThreads]);

  useEffect(() => {
    const targetAnchorKey = String(resolvedInlineCommentAnchorKey || "").trim();
    if (!chapter?.$id || !targetAnchorKey || chapter.$id !== resolvedChapterId) return;

    const openToken = String(resolvedInlineCommentOpen || "default");
    const notificationHandleKey = `${chapter.$id}:${targetAnchorKey}:${openToken}`;
    if (handledInlineNotificationRef.current === notificationHandleKey) return;

    handledInlineNotificationRef.current = notificationHandleKey;
    const threadDocument = inlineCommentThreads[targetAnchorKey];

    setSelectedInlineAnchor({
      anchorKey: targetAnchorKey,
      anchorVersion: threadDocument?.anchorVersion || "v1",
      ordinal: Number(threadDocument?.anchorOrdinal) || 0,
      path: threadDocument?.anchorPath || "",
      preview: threadDocument?.anchorText || "",
      tagName: threadDocument?.anchorTag || "p",
      textHash: threadDocument?.normalizedTextHash || "",
    });
    setInlineCommentVisible(true);
  }, [chapter?.$id, inlineCommentThreads, resolvedChapterId, resolvedInlineCommentAnchorKey, resolvedInlineCommentOpen]);

  // ── Scroll-position persistence (Wattpad-style resume) ──
  //
  // flushScrollPosition is the only thing that actually talks to the
  // backend. Called from:
  //   1. The 1.5s scroll-idle debounce (the common path — writes while
  //      the reader is still reading the same chapter).
  //   2. useFocusEffect cleanup when the screen blurs (so backgrounding
  //      / navigating away during active reading still flushes).
  //   3. Chapter-change cleanup before readBookChapter resets to 0 (so
  //      we don't drop a few seconds of unsaved scroll on transition).
  //
  // The `chapterId` snapshot in the ref protects against the case where
  // a flush queued for chapter A fires AFTER the reader has navigated
  // to chapter B — we still upsert against chapter A's id, which keeps
  // the row coherent even if the user is now on a different chapter.
  const flushScrollPosition = useCallback(async () => {
    if (scrollPersistTimerRef.current) {
      clearTimeout(scrollPersistTimerRef.current);
      scrollPersistTimerRef.current = null;
    }
    const snapshot = scrollPositionRef.current;
    if (!snapshot.dirty) return;
    if (!user?.$id || !book?.$id || !snapshot.chapterId) return;

    // Mark clean BEFORE the await so a fast follow-up scroll doesn't
    // duplicate this same write.
    scrollPositionRef.current = { ...snapshot, dirty: false };

    try {
      // Calls through the dispatcher so the Appwrite path silently
      // no-ops (its BookReadService doesn't expose upsertBookRead).
      await BookReadService.upsertBookRead?.({
        userId: user.$id,
        bookId: book.$id,
        chapterId: snapshot.chapterId,
        lastScrollPct: snapshot.pct,
      });
      // Bust the useBookProgress cache so book-info / library cards
      // pick up the new last_scroll_pct on next render. Without this
      // the SWR cache would happily serve the stale row for up to
      // 5min after the user closed the reader, making "Continue from
      // Chapter X" look like it forgot the scroll position.
      invalidateBookProgress({ userId: user.$id, bookId: book.$id });
    } catch (error) {
      console.warn("[book-reading] scroll-pct flush failed:", error?.message);
      // Don't re-mark dirty — a failed write isn't worth retry-storming.
      // Next scroll tick will mark dirty again and the next debounce
      // round will try fresh.
    }
  }, [book?.$id, user?.$id]);

  const handleScroll = (e) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    scrollMetricsRef.current = {
      contentHeight: contentSize.height,
      viewportHeight: layoutMeasurement.height,
    };

    const y = contentOffset.y;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);

    if (y > 50 && uiVisible) {
      setUiVisible(false);
      setSettingsVisible(false);
    } else if (y <= 0 && !uiVisible) {
      setUiVisible(true);
    }

    // Track the current scroll position for Wattpad-style resume. Cheap:
    // ref update + clamp, no React state churn. Only persisted when the
    // reader has been still for SCROLL_PERSIST_DEBOUNCE_MS.
    if (readingMode === "scroll" && chapter?.$id) {
      const scrollableRange = contentSize.height - layoutMeasurement.height;
      // Short content (chapter fits on a single screen) → there's
      // nothing to "resume" — keep pct at 0 and don't bother writing.
      if (scrollableRange > 0) {
        const pct = Math.max(0, Math.min(1, y / scrollableRange));
        scrollPositionRef.current = {
          pct,
          dirty: true,
          chapterId: chapter.$id,
        };
        if (scrollPersistTimerRef.current) {
          clearTimeout(scrollPersistTimerRef.current);
        }
        scrollPersistTimerRef.current = setTimeout(() => {
          flushScrollPosition();
        }, SCROLL_PERSIST_DEBOUNCE_MS);
      }
    }

    if (readingMode !== "scroll") {
      if (showBottomSwipeIndicator) setShowBottomSwipeIndicator(false);
      return;
    }

    const hasNextChapter = chapterIndex < allChapters.length - 1;
    const nearBottomThreshold = Math.max(SCREEN_HEIGHT * 0.35, 180);
    const shouldShowIndicator = hasNextChapter && distanceFromBottom <= nearBottomThreshold && distanceFromBottom > -SCREEN_HEIGHT * 0.08;

    setShowBottomSwipeIndicator(shouldShowIndicator);
  };

  // Flush on screen blur (back nav / tab switch / app background). Pairs
  // with the debounce-write so a reader who taps back mid-chapter still
  // gets their position saved before the screen unmounts.
  useFocusEffect(
    useCallback(() => {
      return () => {
        flushScrollPosition();
      };
    }, [flushScrollPosition]),
  );

  // Hard cleanup on unmount — kill any pending debounce timer so it
  // can't fire after the component is gone (would log a noisy warning
  // about setting state on an unmounted component, and worse, leak
  // a closure capture of the old book/chapter ids).
  useEffect(() => {
    return () => {
      if (scrollPersistTimerRef.current) {
        clearTimeout(scrollPersistTimerRef.current);
        scrollPersistTimerRef.current = null;
      }
    };
  }, []);

  // Flush on chapter change. readBookChapter then resets last_scroll_pct
  // to 0 for the new chapter; this ensures the OLD chapter's final
  // position lands in the row before that reset overwrites it.
  useEffect(() => {
    return () => {
      flushScrollPosition();
    };
  }, [chapter?.$id, flushScrollPosition]);

  // ── Wattpad-style resume: load saved scroll pct on chapter mount ──
  //
  // When the reader opens a chapter that matches their last_chapter_id,
  // fetch the saved last_scroll_pct and stash it in pendingScrollRestoreRef.
  // The actual scrollTo can't run yet — contentHeight isn't known until
  // the chapter HTML renders — so we defer it to onContentSizeChange.
  //
  // We only restore if pct > 0.05 (about 5% in). Below that the user
  // was effectively at the top, and forcing a tiny scroll seek makes
  // the restore feel buggy more than helpful.
  useEffect(() => {
    if (!chapter?.$id || !user?.$id || !book?.$id) return;
    let cancelled = false;
    (async () => {
      try {
        const saved = await BookReadService.getBookRead?.({ userId: user.$id, bookId: book.$id });
        if (cancelled) return;
        if (!saved) return;
        // The saved row's last_chapter_id is in UUID form; the mobile
        // chapter object's $id is `legacy_appwrite_id || id`. We can't
        // compare directly. Instead, match against `chapter.id`
        // (Supabase UUID) when present, falling back to $id.
        const savedChapterId = String(saved.last_chapter_id || "");
        const candidates = [String(chapter.id || ""), String(chapter.$id || "")].filter(Boolean);
        if (!candidates.includes(savedChapterId)) return;
        const pct = Number(saved.last_scroll_pct);
        if (!Number.isFinite(pct) || pct <= 0.05) return;
        pendingScrollRestoreRef.current = { chapterId: chapter.$id, pct };
      } catch (error) {
        console.warn("[book-reading] could not load saved scroll pct:", error?.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chapter?.$id, chapter?.id, book?.$id, user?.$id]);

  const animateChapterChange = (newChapter, newIndex) => {
    if (transitioning) return;
    setTransitioning(true);
    setShowBottomSwipeIndicator(false);

    Animated.timing(fadeAnim, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start(() => {
      setChapter(newChapter);
      setAllChapters((prev) => {
        const existingChapter = prev[newIndex];
        if (!newChapter?.$id || existingChapter?.$id !== newChapter.$id || Object.prototype.hasOwnProperty.call(existingChapter, "content"))
          return prev;
        const nextChapters = [...prev];
        nextChapters[newIndex] = { ...existingChapter, ...newChapter };
        return nextChapters;
      });
      setChapterIndex(newIndex);

      scrollRef.current?.scrollTo({ y: 0, animated: false });

      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start(() => setTransitioning(false));
    });
  };

  const fetchReadableChapter = async (nextChapter) => {
    if (!nextChapter?.$id || Object.prototype.hasOwnProperty.call(nextChapter, "content")) return nextChapter;
    return bookService.fetchBookChapter({ chapterId: nextChapter.$id, actorUserId: user?.$id });
  };

  // Defensive lock evaluator (May 2026 — book unlock-bypass on swipe).
  //
  // Writers reported that swiping past a paid chapter boundary skipped
  // the unlock prompt even though direct-link entry to the same chapter
  // gated correctly. Audit showed every nav path calls isChapterLocked
  // — but the input data could be stale: the top-level `book` state is
  // set ONCE on initial load and never refreshed when new chapters
  // join `allChapters`. If the writer toggled the lock while the
  // reader had the screen open, or if the embedded book object drifts
  // from the canonical book row, the gate evaluates against stale
  // values.
  //
  // This wrapper:
  //   1. Resolves the FRESHEST book reference — prefers the chapter's
  //      own embedded `chapter.book` (set during the `books!chapters_…`
  //      join in CHAPTER_SELECT), falls back to top-level `book` state.
  //      Whichever has lock_from_chapter wins.
  //   2. Logs the inputs + decision so we can see in Metro exactly why
  //      a chapter is being treated as unlocked. Strip after we've
  //      confirmed the fix.
  //   3. Returns the boolean lock decision.
  const _evaluateChapterLock = (chapter, index) => {
    const chapterBook = chapter?.book && typeof chapter.book === "object" ? chapter.book : null;
    const effectiveBook = chapterBook || book;
    const decision = BookUnlocksService.isChapterLocked({
      book: effectiveBook,
      bookChapterLockStart,
      chapter,
      index,
      unlocks,
      currentUserId: user?.$id,
    });
    console.log("[book-reading] lock check", {
      chapter_id: chapter?.$id,
      chapter_number: chapter?.chapter_number,
      chapter_is_locked: !!(chapter?.is_locked || chapter?.isLocked),
      effective_book_isLocked: !!effectiveBook?.isLocked,
      effective_book_lockStart:
        effectiveBook?.bookChapterLockStart ?? effectiveBook?.lock_from_chapter ?? null,
      bookChapterLockStartProp: bookChapterLockStart,
      unlocks_fully: !!unlocks?.isFullyUnlocked,
      unlocks_chapters_count: unlocks?.chapters?.length || 0,
      decision_locked: decision,
      source: chapterBook ? "chapter.book" : "screen.book",
    });
    return decision;
  };

  const loadNextChapter = async () => {
    if (transitioning) return;
    if (chapterIndex < allChapters.length - 1) {
      const nextIndex = chapterIndex + 1;
      const nextChapter = allChapters[nextIndex];
      const isChapterLocked = _evaluateChapterLock(nextChapter, nextIndex);

      if (isChapterLocked) {
        setSelectedChapter(nextChapter);
        setChapterUnlockVisible(true);
      } else {
        try {
          const readableChapter = await fetchReadableChapter(nextChapter);
          // Re-check using the freshly-fetched chapter (it carries its
          // own embedded book via the join — fresher than allChapters[]
          // which may have been served from cache). Catches the case
          // where the cached list said "free" but the live row says
          // "locked".
          if (_evaluateChapterLock(readableChapter, nextIndex)) {
            setSelectedChapter(readableChapter);
            setChapterUnlockVisible(true);
            return;
          }
          animateChapterChange(readableChapter, nextIndex);
          BookReadService.readBookChapter({ userId: user?.$id, bookId: book?.$id, chapterId: readableChapter?.$id });
          tickGoalUnique("read_chapters", readableChapter?.$id);
        } catch (error) {
          console.error("loadNextChapter: error", error);
          Alert.alert("Unable to load chapter", "Please try again.");
        }
      }
    }
  };

  const loadPreviousChapter = async () => {
    if (transitioning) return;
    if (chapterIndex > 0) {
      const prevIndex = chapterIndex - 1;
      const prevChapter = allChapters[prevIndex];
      const isChapterLocked = _evaluateChapterLock(prevChapter, prevIndex);

      if (isChapterLocked) {
        setSelectedChapter(prevChapter);
        setChapterUnlockVisible(true);
      } else {
        try {
          const readableChapter = await fetchReadableChapter(prevChapter);
          // Same fresh re-check as loadNextChapter — see comment above.
          if (_evaluateChapterLock(readableChapter, prevIndex)) {
            setSelectedChapter(readableChapter);
            setChapterUnlockVisible(true);
            return;
          }
          animateChapterChange(readableChapter, prevIndex);
          BookReadService.readBookChapter({ userId: user?.$id, bookId: book?.$id, chapterId: readableChapter?.$id });
        } catch (error) {
          console.error("loadPreviousChapter: error", error);
          Alert.alert("Unable to load chapter", "Please try again.");
        }
      }
    }
  };

  const handleScrollEndDrag = (e) => {
    if (readingMode !== "scroll") return;

    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;

    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const distanceFromTop = contentOffset.y;
    const androidEdgeTolerance = 1;
    const threshold = SCREEN_HEIGHT * 0.1; // 10% of screen height
    const isAndroidShortContent = Platform.OS === "android" && contentSize.height <= layoutMeasurement.height + androidEdgeTolerance;

    if (Platform.OS === "android") {
      if (isAndroidShortContent) return;
      if (distanceFromTop <= androidEdgeTolerance) {
        loadPreviousChapter();
      }
      if (distanceFromBottom <= androidEdgeTolerance) {
        loadNextChapter();
      }
    }

    if (distanceFromBottom < -threshold) {
      loadNextChapter();
    }
    if (distanceFromTop < -threshold) {
      loadPreviousChapter();
    }
  };

  const handleTouchStart = (e) => {
    if (readingMode !== "page" && !(Platform.OS === "android" && readingMode === "scroll")) return;
    const { pageX, pageY } = e.nativeEvent;
    touchStartRef.current = { x: pageX, y: pageY };
  };

  const handleTouchEnd = (e) => {
    if (transitioning || chapterUnlockVisible) return;

    const { pageX, pageY } = e.nativeEvent;
    const deltaX = pageX - touchStartRef.current.x;
    const deltaY = pageY - touchStartRef.current.y;

    if (readingMode === "page") {
      if (Math.abs(deltaX) < PAGE_CHAPTER_SWIPE_DISTANCE) return;
      if (Math.abs(deltaX) <= Math.abs(deltaY) * PAGE_CHAPTER_SWIPE_AXIS_RATIO) return;

      if (deltaX < 0) {
        loadNextChapter();
      } else {
        loadPreviousChapter();
      }
      return;
    }

    if (Platform.OS !== "android" || readingMode !== "scroll") return;

    const { contentHeight, viewportHeight } = scrollMetricsRef.current;
    const isShortContent = contentHeight > 0 && viewportHeight > 0 && contentHeight <= viewportHeight + 1;
    const minSwipeDistance = 48;

    if (!isShortContent) return;
    if (Math.abs(deltaY) < minSwipeDistance) return;
    if (Math.abs(deltaY) <= Math.abs(deltaX) * 1.15) return;

    if (deltaY < 0) {
      loadNextChapter();
    } else {
      loadPreviousChapter();
    }
  };

  const toggleUi = () => {
    setUiVisible((prev) => !prev);
    setSettingsVisible(false);
  };

  const toggleChaptersVisible = () => {
    setChaptersVisible((prev) => !prev);
  };

  const toggleChapterUnlockVisible = () => {
    // if no chapter yet, do nothing
    if (!chapter) return;

    const isLocked = BookUnlocksService.isChapterLocked({
      book,
      bookChapterLockStart,
      chapter,
      index: chapterIndex,
      unlocks,
      currentUserId: user?.$id,
    });

    // If chapter is locked, go back instead of showing modal
    if (isLocked) {
      router.back();
    } else {
      // Otherwise, just toggle modal visibility
      setChapterUnlockVisible((prev) => !prev);
    }
  };

  const toggleSettings = () => {
    setSettingsVisible((prev) => !prev);
  };

  const decreaseFontSize = () => {
    setFontSize((prev) => prev - 1);
  };

  const increaseFontSize = () => {
    setFontSize((prev) => prev + 1);
  };

  const onChapterSelect = async (chapter, index) => {
    const isChapterLocked = BookUnlocksService.isChapterLocked({
      book,
      bookChapterLockStart,
      chapter,
      index,
      unlocks,
      currentUserId: user?.$id,
    });

    if (isChapterLocked) {
      setSelectedChapter(chapter);
      setChapterUnlockVisible(true);
    } else {
      setChaptersVisible(false);
      try {
        const readableChapter = await fetchReadableChapter(chapter);
        animateChapterChange(readableChapter, index);
      } catch (error) {
        console.error("onChapterSelect: error", error);
        Alert.alert("Unable to load chapter", "Please try again.");
      }
    }
  };

  const handleGoToStore = () => {
    setChaptersVisible(false);
    setChapterUnlockVisible(false);
    router.push("/store");
  };

  const handleProceedToChapter = async () => {
    setChaptersVisible(false);
    setChapterUnlockVisible(false);
    const idx = allChapters.findIndex((c) => c.$id === selectedChapter.$id);
    const unlocksData = await bookUnlockService.getBookUnlockByUser({ book: book?.$id, unlockBy: user?.$id });
    if (unlocksData.documents.length > 0) setUnlocks(unlocksData.documents[0]);
    try {
      const readableChapter = await fetchReadableChapter(selectedChapter);
      animateChapterChange(readableChapter, idx);
    } catch (error) {
      console.error("handleProceedToChapter: error", error);
      Alert.alert("Unable to load chapter", "Please try again.");
    }
  };

  // Stable callback ref so renderInlineCommentableBlock's useCallback
  // dep set doesn't churn on every render.
  const handleOpenInlineCommentThread = useCallback((anchor, event) => {
    event?.stopPropagation?.();
    if (!anchor?.anchorKey) return;

    setSelectedInlineAnchor(anchor);
    setInlineCommentVisible(true);
  }, []);

  const handleCloseInlineCommentThread = () => {
    setInlineCommentVisible(false);
    void loadInlineCommentThreads(chapter?.$id);
  };

  const handleInlineThreadUpdated = (anchorKey, threadDocument) => {
    if (!anchorKey || !threadDocument) return;

    setInlineCommentThreads((prev) => {
      const previousThreadDocument = prev[anchorKey];
      const previousTopLevelCount = Math.max(previousThreadDocument?.commentsCount ?? 0, 0);
      const previousTotalCount = Math.max(previousThreadDocument?.totalCommentCount ?? previousTopLevelCount, 0);
      const preservedReplyCount = Math.max(previousTotalCount - previousTopLevelCount, 0);
      const nextTopLevelCount = Math.max(threadDocument?.commentsCount ?? previousTopLevelCount, 0);

      return {
        ...prev,
        [anchorKey]: {
          ...previousThreadDocument,
          ...threadDocument,
          totalCommentCount: Math.max(threadDocument?.totalCommentCount ?? nextTopLevelCount + preservedReplyCount, 0),
        },
      };
    });
  };

  // Memoized custom block renderer — called by RenderHTML for every
  // <p>, <h1>, <li>, etc. node. Without useCallback the function ref
  // changes every parent render, which (a) breaks RenderHTML's
  // internal memoization across renderers and (b) means every chapter
  // node re-resolves its renderer on each render. With the memo, only
  // changes to inlineCommentThreads or theme colors invalidate it.
  const renderInlineCommentableBlock = useCallback(
    ({ tnode, InternalRenderer, ...rendererProps }) => {
      const anchorKey = tnode.attributes?.[INLINE_COMMENT_ATTRS.key];
      const anchorPreview = tnode.attributes?.[INLINE_COMMENT_ATTRS.preview];
      const anchorPath = tnode.attributes?.[INLINE_COMMENT_ATTRS.path];
      const anchorTag = tnode.attributes?.[INLINE_COMMENT_ATTRS.tag] || tnode.tagName;
      const anchorOrdinal = Number(tnode.attributes?.[INLINE_COMMENT_ATTRS.ordinal] || 0);
      const anchorTextHash = tnode.attributes?.[INLINE_COMMENT_ATTRS.textHash];
      const anchorTrigger = tnode.attributes?.[INLINE_COMMENT_ATTRS.trigger] === "1";
      const anchorVersion = tnode.attributes?.[INLINE_COMMENT_ATTRS.version] || "v1";
      const threadDocument = anchorKey ? inlineCommentThreads[anchorKey] : null;
      const commentCount = Math.max(threadDocument?.totalCommentCount ?? threadDocument?.commentsCount ?? 0, 0);
      const shouldShowInlineComment = Boolean(anchorKey && (anchorTrigger || commentCount > 0));
      const iconColor = currentPageTheme.iconMuted;
      const countColor = currentPageTheme.textSoft;

      if (!shouldShowInlineComment) {
        return <InternalRenderer tnode={tnode} {...rendererProps} />;
      }

      return (
        <View>
          <InternalRenderer tnode={tnode} {...rendererProps} />
          <View className="mt-1 flex-row justify-end">
            <TouchableOpacity
              onPress={(event) =>
                handleOpenInlineCommentThread(
                  {
                    anchorKey,
                    anchorVersion,
                    ordinal: anchorOrdinal,
                    path: anchorPath,
                    preview: anchorPreview,
                    tagName: anchorTag,
                    textHash: anchorTextHash,
                  },
                  event,
                )
              }
              hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
              className="mr-[-6px] flex-row items-center"
            >
              <MaterialCommunityIcons name={commentCount > 0 ? "comment-outline" : "comment-plus-outline"} size={20} color={iconColor} />
              {commentCount > 0 ? (
                <Text className="ml-1 text-[11px] font-semibold" style={{ color: countColor }}>
                  {commentCount}
                </Text>
              ) : null}
            </TouchableOpacity>
          </View>
        </View>
      );
    },
    [inlineCommentThreads, currentPageTheme.iconMuted, currentPageTheme.textSoft, handleOpenInlineCommentThread],
  );

  // domVisitors only depends on globalSettings (specifically the inline-
  // comment ordinal config). Without memoization a new visitor object
  // every render → RenderHTML's source equality check fails → full re-
  // parse of the chapter HTML on every parent state change.
  const inlineCommentDomVisitors = useMemo(
    () => createInlineCommentDomVisitors({ globalSettings }),
    [globalSettings],
  );
  // Renderer map. The 11-key object was previously rebuilt every render
  // pointing at a fresh function ref, breaking RenderHTML's renderer
  // resolution cache. Now: renderer ref stable until inline-comment
  // state actually changes.
  const inlineCommentRenderers = useMemo(
    () => ({
      p: renderInlineCommentableBlock,
      h1: renderInlineCommentableBlock,
      h2: renderInlineCommentableBlock,
      h3: renderInlineCommentableBlock,
      h4: renderInlineCommentableBlock,
      h5: renderInlineCommentableBlock,
      h6: renderInlineCommentableBlock,
      blockquote: renderInlineCommentableBlock,
      pre: renderInlineCommentableBlock,
      li: renderInlineCommentableBlock,
      div: renderInlineCommentableBlock,
    }),
    [renderInlineCommentableBlock],
  );

  if (loading) {
    return (
      <View className="flex-1" style={{ backgroundColor: bookReadingTheme[pageColor].backgroundColor }}>
        <SafeAreaView
          edges={["top"]}
          className="px-4 py-3"
          style={{ borderBottomWidth: 1, borderBottomColor: theme.border, backgroundColor: theme.surfaceElevated }}
        >
          <View className="flex-row items-center justify-between">
            <AnimatedSkeleton style={{ width: 36, height: 36, borderRadius: 999, backgroundColor: skeletonBaseColor }} />
            <AnimatedSkeleton style={{ width: 140, height: 16, backgroundColor: skeletonBaseColor }} />
            <AnimatedSkeleton style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: skeletonBaseColor }} />
          </View>
        </SafeAreaView>

        <View className="flex-1 px-4 py-6">
          <AnimatedSkeleton style={{ width: "70%", height: 26, marginBottom: 10, backgroundColor: skeletonBaseColor }} />
          <AnimatedSkeleton style={{ width: "45%", height: 14, marginBottom: 20, backgroundColor: skeletonBaseColor }} />

          <AnimatedSkeleton style={{ width: "100%", height: 180, borderRadius: 12, marginBottom: 18, backgroundColor: skeletonBaseColor }} />

          {Array.from({ length: 8 }).map((_, idx) => (
            <AnimatedSkeleton
              key={idx}
              style={{
                width: idx % 3 === 0 ? "92%" : "100%",
                height: 14,
                marginBottom: 12,
                backgroundColor: skeletonBaseColor,
              }}
            />
          ))}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1" style={{ backgroundColor: bookReadingTheme[pageColor].backgroundColor }}>
      {/* HEADER */}
      <Animated.View
        style={{
          transform: [{ translateY: headerAnim }],
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
        }}
      >
        <SafeAreaView edges={["top"]} style={{ backgroundColor: theme.surfaceElevated }}>
          <View className="flex-row items-center justify-between px-4 py-3" style={{ borderBottomWidth: 1, borderBottomColor: theme.border }}>
            {/* LEFT */}
            <View className="w-12 items-start">
              <TouchableOpacity onPress={() => router.back()}>
                <Ionicons name="arrow-back" size={24} color={theme.icon} />
              </TouchableOpacity>
            </View>

            {/* CENTER */}
            <TouchableOpacity onPress={toggleChaptersVisible} className="flex-1 items-center">
              <Text className="text-base font-bold" style={{ color: theme.text }}>
                {chapter?.title}
              </Text>
              <Text className="text-xs" style={{ color: theme.textSoft }}>
                Table of Contents ▼
              </Text>
            </TouchableOpacity>

            {/* RIGHT */}
            <View className="w-12 flex-row justify-end space-x-4">
              <TouchableOpacity onPress={toggleSettings}>
                <MaterialIcons name="text-fields" size={22} color={theme.icon} />
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaView>
      </Animated.View>

      {settingsVisible && (
        <Animated.View
          style={{
            transform: [{ translateY: headerAnim }],
            position: "absolute",
            top: 65 + insets.top,
            left: 0,
            right: 0,
            height: 230,
            backgroundColor: theme.surfaceElevated,
            zIndex: 9,
          }}
          className="rounded-b-xl"
        >
          <View className="flex-1 px-4 py-3">
            <Text className="mb-2 text-sm font-semibold" style={{ color: theme.text }}>
              Page Color
            </Text>

            <View className="flex-row">
              <TouchableOpacity
                onPress={() => setPageColor("light")}
                className="mb-2 flex-1 rounded-bl-lg rounded-tl-lg px-3 py-2"
                style={{
                  borderRightWidth: 1,
                  borderRightColor: theme.border,
                  backgroundColor: pageColor === "light" ? theme.primary : theme.surfaceMuted,
                }}
              >
                <Text className="text-center" style={{ color: pageColor === "light" ? theme.primaryContrast : theme.text }}>
                  Light
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setPageColor("dark")}
                className="mb-2 flex-1 rounded-br-lg rounded-tr-lg px-3 py-2"
                style={{
                  borderLeftWidth: 1,
                  borderLeftColor: theme.border,
                  backgroundColor: pageColor === "dark" ? theme.primary : theme.surfaceMuted,
                }}
              >
                <Text className="text-center" style={{ color: pageColor === "dark" ? theme.primaryContrast : theme.text }}>
                  Dark
                </Text>
              </TouchableOpacity>
            </View>

            <Text className="mb-2 text-sm font-semibold" style={{ color: theme.text }}>
              Font
            </Text>

            <View className="flex-row">
              <TouchableOpacity
                disabled={fontSize <= minimumFont}
                onPress={decreaseFontSize}
                className={`mb-2 flex-1 rounded-bl-lg rounded-tl-lg px-3 py-2 ${fontSize <= minimumFont ? "opacity-50" : ""}`}
                style={{
                  borderRightWidth: 1,
                  borderRightColor: theme.border,
                  backgroundColor: fontSize <= minimumFont ? theme.surfaceStrong : theme.surfaceMuted,
                }}
              >
                <Text className="text-center" style={{ color: fontSize <= minimumFont ? theme.textSubtle : theme.text }}>
                  Decrease Font Size
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                disabled={fontSize >= maximumFont}
                onPress={increaseFontSize}
                className={`mb-2 flex-1 rounded-br-lg rounded-tr-lg px-3 py-2 ${fontSize >= maximumFont ? "opacity-50" : ""}`}
                style={{
                  borderLeftWidth: 1,
                  borderLeftColor: theme.border,
                  backgroundColor: fontSize >= maximumFont ? theme.surfaceStrong : theme.surfaceMuted,
                }}
              >
                <Text className="text-center" style={{ color: fontSize >= maximumFont ? theme.textSubtle : theme.text }}>
                  Increase Font Size
                </Text>
              </TouchableOpacity>
            </View>

            <Text className="mb-2 text-sm font-semibold" style={{ color: theme.text }}>
              Reading Mode
            </Text>

            <View className="flex-row">
              <TouchableOpacity
                onPress={() => setReadingMode("scroll")}
                className="mb-2 flex-1 rounded-bl-lg rounded-tl-lg px-3 py-2"
                style={{
                  borderRightWidth: 1,
                  borderRightColor: theme.border,
                  backgroundColor: readingMode === "scroll" ? theme.primary : theme.surfaceMuted,
                }}
              >
                <Text className="text-center" style={{ color: readingMode === "scroll" ? theme.primaryContrast : theme.text }}>
                  Scrolling
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => setReadingMode("page")}
                className="mb-2 flex-1 rounded-br-lg rounded-tr-lg px-3 py-2"
                style={{
                  borderLeftWidth: 1,
                  borderLeftColor: theme.border,
                  backgroundColor: readingMode === "page" ? theme.primary : theme.surfaceMuted,
                }}
              >
                <Text className="text-center" style={{ color: readingMode === "page" ? theme.primaryContrast : theme.text }}>
                  Paging
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </Animated.View>
      )}

      {/* CONTENT (uses full screen when UI hidden) */}
      <Animated.ScrollView
        ref={scrollRef}
        contentContainerStyle={{
          paddingLeft: 16,
          paddingRight: 13,
          paddingTop: uiVisible ? 130 : 20, // give room only when UI visible
          paddingBottom: insets.bottom === 0 ? 50 : insets.bottom + 25,
        }}
        onLayout={(event) => {
          scrollMetricsRef.current.viewportHeight = event.nativeEvent.layout.height;
        }}
        onContentSizeChange={(_, height) => {
          scrollMetricsRef.current.contentHeight = height;
          // Wattpad-style resume — apply the pending scroll restore now
          // that we know the final contentHeight. We multiply against
          // (height - viewportHeight) rather than (height) so a 100%
          // pct lands at the bottom of the chapter, not past it. The
          // restore fires once per chapter mount (cleared after seek)
          // so a layout reflow from a font-size change doesn't snap
          // the user back to their old position mid-read.
          const pending = pendingScrollRestoreRef.current;
          if (pending.chapterId && pending.chapterId === chapter?.$id && pending.pct > 0) {
            const viewport = scrollMetricsRef.current.viewportHeight || 0;
            const scrollableRange = Math.max(0, height - viewport);
            const targetY = Math.round(scrollableRange * pending.pct);
            if (targetY > 0 && scrollRef.current?.scrollTo) {
              // requestAnimationFrame defers the seek by one frame so the
              // ScrollView's internal layout pass has time to settle,
              // avoiding a no-op scrollTo on a still-laying-out child.
              requestAnimationFrame(() => {
                scrollRef.current?.scrollTo({ y: targetY, animated: false });
              });
            }
            pendingScrollRestoreRef.current = { chapterId: null, pct: 0 };
          }
        }}
        scrollEventThrottle={16}
        onScroll={handleScroll}
        onScrollEndDrag={isPagingMode ? undefined : handleScrollEndDrag}
        onTouchStart={isPagingMode || Platform.OS === "android" ? handleTouchStart : undefined}
        onTouchEnd={isPagingMode || Platform.OS === "android" ? handleTouchEnd : undefined}
      >
        <Pressable onPress={toggleUi}>
          {/* META INFO */}
          <Animated.View style={{ opacity: fadeAnim }}>
            <BookChapterStats chapter={chapter} bookReadingTheme={bookReadingTheme} pageColor={pageColor} />

            {/* THUMBNAIL */}
            {chapter?.thumbnail && (
              <FastImage
                source={{ uri: chapter.thumbnail, priority: FastImage.priority.high }}
                className="mb-4 h-48 w-full rounded-lg"
                resizeMode="cover"
              />
            )}

            {/* CONTENT — locked chapters NEVER hit RenderHTML.
                Previously the HTML was parsed and rendered into memory
                even when chapterUnlockVisible was true (the unlock
                modal merely overlaid the body), which meant the paid
                text was sitting one screenshot or DevTools tap away.
                We now feed an empty string into RenderHTML for the
                duration of the unlock modal so the paywalled body is
                literally not in the rendered tree until the user pays.
                Belt-and-suspenders with isChapterLocked as well — even
                if some future code path forgets to set
                chapterUnlockVisible, the gate still wins. */}
            <RenderHTML
              contentWidth={Math.max(SCREEN_WIDTH - 32, 0)}
              source={{
                html: chapterUnlockVisible ? "" : processedChapterHtml,
              }}
              baseStyle={htmlBaseStyle}
              domVisitors={inlineCommentDomVisitors}
              tagsStyles={htmlTagsStyles}
              renderers={inlineCommentRenderers}
              renderersProps={{
                img: {
                  enableExperimentalPercentWidth: true,
                  initialDimensions: { width: Math.max(SCREEN_WIDTH - 32, 0), height: 240 },
                },
              }}
            />
          </Animated.View>
        </Pressable>
      </Animated.ScrollView>

      {showBottomSwipeIndicator && !isPagingMode && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            alignSelf: "center",
            bottom: uiVisible ? 88 : 30,
            zIndex: 8,
            opacity: 0.95,
            transform: [
              {
                translateY: swipeIndicatorAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, 8],
                }),
              },
            ],
          }}
        >
          <View
            style={{
              backgroundColor: currentPageTheme.overlayBackground,
              borderColor: currentPageTheme.overlayBorder,
              borderWidth: 1,
            }}
            className="flex-row items-center rounded-full px-3 py-2"
          >
            <Ionicons name="chevron-down" size={16} color={currentPageTheme.overlayText} />
            <Text className="ml-1 text-xs font-semibold" style={{ color: currentPageTheme.overlayText }}>
              Swipe up for next chapter
            </Text>
          </View>
        </Animated.View>
      )}

      {showPagingSwipeIndicator && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            alignSelf: "center",
            bottom: uiVisible ? 88 : 30,
            zIndex: 8,
            opacity: 0.95,
            transform: [
              {
                translateX: swipeIndicatorAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-6, 6],
                }),
              },
            ],
          }}
        >
          <View
            style={{
              backgroundColor: currentPageTheme.overlayBackground,
              borderColor: currentPageTheme.overlayBorder,
              borderWidth: 1,
            }}
            className="flex-row items-center rounded-full px-3 py-2"
          >
            <Ionicons name="chevron-back" size={16} color={currentPageTheme.overlayText} />
            <Text className="mx-1 text-xs font-semibold" style={{ color: currentPageTheme.overlayText }}>
              Swipe left or right for chapters
            </Text>
            <Ionicons name="chevron-forward" size={16} color={currentPageTheme.overlayText} />
          </View>
        </Animated.View>
      )}

      {/* FOOTER */}
      <Animated.View
        style={{
          transform: [{ translateY: footerAnim }],
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
        }}
      >
        <BookChapterFooter
          chapter={chapter}
          bookReadingTheme={bookReadingTheme}
          pageColor={pageColor}
          openComments={openCommentsParam && String(chapter?.$id || "") === String(resolvedChapterId || "")}
          focusCommentId={focusCommentIdParam}
          focusReplyId={focusReplyIdParam}
        />
      </Animated.View>

      <BookChaptersModal
        isVisible={chaptersVisible}
        onClose={toggleChaptersVisible}
        chapters={allChapters}
        book={book}
        unlocks={unlocks}
        onSelect={onChapterSelect}
      />
      <BookChaptersUnlockModal
        isVisible={chapterUnlockVisible}
        onClose={toggleChapterUnlockVisible}
        chapters={allChapters}
        book={book}
        unlocks={unlocks}
        selectedChapter={selectedChapter}
        onSelect={onChapterSelect}
        handleGoToStore={handleGoToStore}
        onSuccessUnlock={handleProceedToChapter}
      />
      <BookInlineCommentModal
        anchor={selectedInlineAnchor}
        chapter={chapter}
        isVisible={inlineCommentVisible}
        onClose={handleCloseInlineCommentThread}
        onThreadUpdated={handleInlineThreadUpdated}
        bookReadingTheme={bookReadingTheme}
        pageColor={pageColor}
      />
      <Modal visible={exitPromptVisible} transparent animationType="fade" onRequestClose={savingToLibrary ? undefined : handleDismissPrompt}>
        <TouchableWithoutFeedback onPress={savingToLibrary ? undefined : handleDismissPrompt}>
          <View className="flex-1 items-center justify-end" style={{ backgroundColor: theme.backdrop }}>
            <TouchableWithoutFeedback onPress={() => {}}>
              <View
                className="w-full rounded-t-3xl px-5 pb-6 pt-5"
                style={{ backgroundColor: theme.surfaceElevated, borderTopWidth: 1, borderTopColor: theme.border }}
              >
                <Text className="text-center text-lg font-bold" style={{ color: theme.text }}>
                  Save this book to your library?
                </Text>
                <Text className="mt-2 text-center text-sm" style={{ color: theme.textSoft }}>
                  Looks like you're enjoying this one. Save it to your library so you can pick up right where you left off later.
                </Text>

                <TouchableOpacity
                  disabled={savingToLibrary}
                  onPress={handleSaveToLibraryAndExit}
                  className="mt-5 items-center rounded-2xl py-3"
                  style={{ backgroundColor: savingToLibrary ? theme.accentPurple : theme.primary }}
                >
                  {savingToLibrary ? (
                    <View className="flex-row items-center">
                      <ActivityIndicator size="small" color={theme.primaryContrast} />
                      <Text className="ml-2 text-base font-semibold" style={{ color: theme.primaryContrast }}>
                        Saving...
                      </Text>
                    </View>
                  ) : (
                    <Text className="text-base font-semibold" style={{ color: theme.primaryContrast }}>
                      Save to Library
                    </Text>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  disabled={savingToLibrary}
                  onPress={handleDontSaveAndExit}
                  className="mt-3 items-center rounded-2xl py-3"
                  style={{ backgroundColor: theme.surfaceMuted }}
                >
                  <Text className="text-base font-medium" style={{ color: theme.textSoft }}>
                    Don't Save
                  </Text>
                </TouchableOpacity>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </View>
  );
}

const bookReadingTheme = {
  light: {
    backgroundColor: themeColors[THEME_MODES.light].surfaceElevated,
    fontColor: themeColors[THEME_MODES.light].text,
    textSoft: themeColors[THEME_MODES.light].textSoft,
    iconMuted: themeColors[THEME_MODES.light].iconMuted,
    divider: themeColors[THEME_MODES.light].divider,
    skeletonBase: themeColors[THEME_MODES.light].skeletonBase,
    overlayBackground: themeColors[THEME_MODES.light].mediaBackground,
    overlayBorder: themeColors[THEME_MODES.light].border,
    overlayText: themeColors[THEME_MODES.light].primaryContrast,
  },
  dark: {
    backgroundColor: themeColors[THEME_MODES.dark].backgroundMuted,
    fontColor: themeColors[THEME_MODES.dark].text,
    textSoft: themeColors[THEME_MODES.dark].textMuted,
    iconMuted: themeColors[THEME_MODES.dark].iconMuted,
    divider: themeColors[THEME_MODES.dark].divider,
    skeletonBase: themeColors[THEME_MODES.dark].skeletonBase,
    overlayBackground: themeColors[THEME_MODES.dark].surfaceMuted,
    overlayBorder: themeColors[THEME_MODES.dark].borderStrong,
    overlayText: themeColors[THEME_MODES.dark].text,
  },
};
