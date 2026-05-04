import { FontAwesome, Ionicons, MaterialIcons } from "@expo/vector-icons";
import * as FileSystem from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  InteractionManager,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import FastImage from "react-native-fast-image";
import { RichEditor, RichToolbar, actions } from "react-native-pell-rich-editor";
import RenderHTML from "react-native-render-html";
import { SafeAreaView } from "react-native-safe-area-context";
import { useDispatch, useSelector } from "react-redux";
import { BookChapterPublishSuccessModal, CustomAlertModal, StyledTitle } from "../../components";
import BannerCropModal from "../../components/BannerCropModal";
import BooksSavePromptModal from "../../components/BooksSavePromptModal";
import SegmentedNumberPicker from "../../components/SegmentedNumberPicker";
import { PROFILE_BANNER_ASPECT_RATIO, PROFILE_BANNER_CROP_ASPECT } from "../../constants/profile";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { normalizeBookContentToHtml } from "../../lib/book-content";
import {
  BookService,
  INTRODUCTION_ORDER,
  getBookChapterOrder,
  initialChapterForm,
  isIntroductionChapter,
  sortBookChaptersByOrder,
} from "../../lib/books";
import { cleanupTempFile, convertToWebP, persistImagePickerAsset } from "../../lib/utils/image-utils";
import { NotificationService } from "../../lib/notifications";
import { useModalMessage } from "../../hooks/useModalMessage";
import { removeLocalDraft, upsertLocalDraft } from "../../store/reducers/books";
// Pure helpers — extracted to lib/book-editor-helpers.js so the
// chapter-editor and book-introduction-editor share a single source of
// truth instead of byte-identical duplicates that drift over time.
import {
  createExistingBookDraftKey,
  createLocalDraftKey,
  escapeHtmlAttribute,
  getSanitizedChapterContent,
  hasInlineImage,
  INLINE_IMAGE_BASE_STYLE,
  INLINE_IMAGE_PENDING_STYLE,
  isChapterEntryFilled,
  pruneChapterFromDraft,
  resolveLocalChapterId,
  stripBackgroundStyles,
  stripHtml,
  stripPendingInlineImages,
} from "../../lib/book-editor-helpers";

const ChapterEditor = () => {
  const { book: bookParam, chapter: chapterParam, bookChapterTotal, draftKey: draftKeyParamRaw } = useLocalSearchParams();
  const draftKeyParam = Array.isArray(draftKeyParamRaw) ? draftKeyParamRaw[0] : draftKeyParamRaw;
  const localDrafts = useSelector((state) => state?.books?.localDrafts || {});
  const localDraftByParam = useSelector((state) => (draftKeyParam ? state?.books?.localDrafts?.[draftKeyParam] : null));
  const bookFromParam = bookParam ? JSON.parse(bookParam) : null;
  const chapterFromParam = chapterParam ? JSON.parse(chapterParam) : null;
  const bookData = bookFromParam || localDraftByParam?.bookSnapshot || null;
  const chapter = chapterFromParam || null;
  const { message, messageOpen, showMessage, closeMessage } = useModalMessage();
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const { globalSettings } = useSelector((state) => state.app);
  const dispatch = useDispatch();
  const isIntroductionEntry = false;
  const resolvedChapterTotal =
    [bookChapterTotal, localDraftByParam?.meta?.chapterOrder, chapter?.order]
      .map((value) => Number(value))
      .find((value) => Number.isFinite(value) && value > INTRODUCTION_ORDER) ?? 1;
  const initialChapterData = chapter
    ? { ...chapter, content: stripBackgroundStyles(normalizeBookContentToHtml(chapter.content)) }
    : { ...initialChapterForm, content: stripBackgroundStyles(normalizeBookContentToHtml(initialChapterForm?.content)) };
  const [chapterForm, setChapterForm] = useState(initialChapterData);
  // Per-chapter unlock cost overrides. NULL means "use the global
  // default" — chapter inherits BOOKS_CHAPTER_COIN_PRICE /
  // BOOKS_CHAPTER_STAR_PRICE at read time. Initialize from the
  // existing chapter row when editing an existing chapter, otherwise
  // null so new chapters start in "default" mode.
  const initialUnlockCostCoins = chapter?.unlock_cost_coins ?? chapter?.unlockCostCoins ?? null;
  const initialUnlockCostStars = chapter?.unlock_cost_stars ?? chapter?.unlockCostStars ?? null;
  const [chapterUnlockCostCoins, setChapterUnlockCostCoins] = useState(initialUnlockCostCoins);
  const [chapterUnlockCostStars, setChapterUnlockCostStars] = useState(initialUnlockCostStars);
  const [activeLocalDraftKey, setActiveLocalDraftKey] = useState(draftKeyParam || null);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [loadingLocalDraft, setLoadingLocalDraft] = useState(false);
  const [loadingServerDraft, setLoadingServerDraft] = useState(false);
  const [loadingPublish, setLoadingPublish] = useState(false);
  const [publishSuccessOpen, setPublishSuccessOpen] = useState(false);
  const [publishedContent, setPublishedContent] = useState(null);
  const [editorMode, setEditorMode] = useState("write");
  const isExistingServerChapter = Boolean(chapterForm?.$id);
  const richTextRef = useRef(null);
  const scrollViewRef = useRef(null);
  const editorReadyRef = useRef(false);
  const imageHeightSyncTimeoutsRef = useRef([]);
  const saveRequestInFlightRef = useRef(false);
  const chapterCoverCropOpenTimerRef = useRef(null);
  const chapterCoverCropOpenTaskRef = useRef(null);
  const { width: windowWidth } = useWindowDimensions();
  const [isChapterCoverCropOpen, setChapterCoverCropOpen] = useState(false);
  const [selectedChapterCoverAsset, setSelectedChapterCoverAsset] = useState(null);

  const notificationService = new NotificationService();
  const bookService = new BookService();
  const sizeLimitThumbnailUpload = globalSettings["BOOKS_COVER_MAX_SIZE_MB"] * 1024 * 1024;
  const sizeLimitInlineImageUpload =
    (Number(globalSettings["BOOKS_CHAPTER_IMAGE_MAX_SIZE_MB"]) || Number(globalSettings["BOOKS_COVER_MAX_SIZE_MB"])) * 1024 * 1024;
  const sizeLimitTitleChars = globalSettings["BOOKS_TITLE_MAX_CHAR_SIZE"];
  const sizeLimitContentWords = globalSettings["BOOKS_CHAPTER_MIN_CHAR_SIZE"];
  const sizeMaxContentWords = globalSettings["BOOKS_CHAPTER_MAX_CHAR_SIZE"];

  const handleChange = (key, value) => {
    setChapterForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleContentChange = (html) => {
    setChapterForm((prev) => ({ ...prev, content: html }));
    if (hasInlineImage(html)) {
      scheduleEditorHeightSync();
    }
  };

  const buildLocalInlinePreviewSrc = async (asset) => {
    const sourceUri = asset?.uri || "";
    if (!sourceUri) return "";
    if (/^https?:\/\//i.test(sourceUri) || /^data:/i.test(sourceUri)) return sourceUri;

    let previewUri = sourceUri;
    let previewMime = "image/webp";
    try {
      const converted = await convertToWebP(sourceUri, { maxWidth: 520, compress: 0.45 });
      if (converted?.uri) previewUri = converted.uri;
      if (asset?.mimeType?.startsWith("image/") && converted?.uri === sourceUri) {
        previewMime = asset.mimeType;
      }
    } catch (error) {
      console.error("buildLocalInlinePreviewSrc convert error", error);
    }

    try {
      const base64 = await FileSystem.readAsStringAsync(previewUri, { encoding: FileSystem.EncodingType.Base64 });
      if (!base64) return sourceUri;
      return `data:${previewMime};base64,${base64}`;
    } catch (error) {
      console.error("buildLocalInlinePreviewSrc read error", error);
      return sourceUri;
    } finally {
      cleanupTempFile(previewUri, sourceUri);
    }
  };

  // Both helpers are pure — defined in lib/book-editor-helpers.js. The
  // useCallback wrapper kept here is no longer needed since
  // isChapterEntryFilled has stable identity (module-level export).
  // hasFilledEntry stays as a local alias so existing call sites read
  // naturally without renaming.
  const hasFilledEntry = isChapterEntryFilled;

  const handleValidateData = () => {
    if (!chapterForm?.title?.length) {
      showMessage("Please enter a title.", 600);
      return true;
    }

    const contentWordCount = getWordCount(chapterForm.content);
    if (contentWordCount === 0) {
      showMessage("Please enter a content.", 600);
      return true;
    }

    if (contentWordCount < sizeLimitContentWords) {
      showMessage(`Please ensure your content word count is over ${sizeLimitContentWords}.`, 600);
      return true;
    }

    if (contentWordCount > sizeMaxContentWords) {
      showMessage(`Please ensure your content word count is under ${sizeMaxContentWords}.`, 600);
      return true;
    }
  };

  const getExistingDraftChapters = (existingDraft) =>
    Array.isArray(existingDraft?.chapters) ? [...existingDraft.chapters] : existingDraft?.chapterForm ? [{ ...existingDraft.chapterForm }] : [];

  const persistEntryToLocalDraft = async ({ showSuccessMessage = true, successMessage = "Draft saved offline on this device.", onSuccess } = {}) => {
    try {
      if (!user?.$id) {
        showMessage("Unable to save offline draft.", 600);
        return null;
      }

      const existingBookDraftKey = createExistingBookDraftKey({ userId: user.$id, bookId: bookData?.$id });
      const nextDraftKey = activeLocalDraftKey || existingBookDraftKey || createLocalDraftKey({ userId: user.$id });
      setActiveLocalDraftKey(nextDraftKey);

      const existingDraft = localDrafts?.[nextDraftKey] || {};
      const existingChapters = getExistingDraftChapters(existingDraft);
      const localChapterId = chapterForm?.localId || chapter?.localId || resolveLocalChapterId({ chapterForm, chapter });
      const normalizedChapter = {
        ...chapterForm,
        localId: localChapterId,
        status: "Draft",
        order: resolvedChapterTotal,
        content: getSanitizedChapterContent(chapterForm?.content ?? ""),
        updatedAt: Date.now(),
      };
      const chapterIndex = existingChapters.findIndex(
        (item) =>
          (item?.localId && item.localId === localChapterId) ||
          (normalizedChapter?.$id && item?.$id && item.$id === normalizedChapter.$id) ||
          (isIntroductionEntry && isIntroductionChapter(item)),
      );
      if (chapterIndex >= 0) {
        existingChapters[chapterIndex] = { ...existingChapters[chapterIndex], ...normalizedChapter };
      } else {
        existingChapters.push(normalizedChapter);
      }
      const sortedChapters = sortBookChaptersByOrder(existingChapters);
      setChapterForm((prev) => ({ ...prev, localId: localChapterId }));

      dispatch(
        upsertLocalDraft({
          key: nextDraftKey,
          draft: {
            chapterForm: normalizedChapter,
            chapters: sortedChapters,
            meta: {
              bookId: bookData?.$id || null,
              bookTitle: bookData?.title || null,
              chapterId: chapterForm?.$id || chapter?.$id || null,
              chapterOrder: resolvedChapterTotal,
              chaptersTotal: sortedChapters.length,
            },
            bookSnapshot: bookData ? { ...bookData } : null,
            updatedAt: Date.now(),
          },
        }),
      );

      if (showSuccessMessage) {
        showMessage(successMessage, 700, onSuccess);
      } else if (typeof onSuccess === "function") {
        onSuccess();
      }

      return nextDraftKey;
    } catch (error) {
      console.error("persistEntryToLocalDraft: error", error);
      return null;
    }
  };

  const handleSaveLocalDraft = async () => {
    if (saveRequestInFlightRef.current) return;
    saveRequestInFlightRef.current = true;
    try {
      setLoadingLocalDraft(true);
      await persistEntryToLocalDraft({
        successMessage: "Draft saved offline on this device.",
        onSuccess: () => router.back(),
      });
    } catch (error) {
      console.error("handleSaveLocalDraft: error", error);
    } finally {
      setLoadingLocalDraft(false);
      setSavePromptOpen(false);
      saveRequestInFlightRef.current = false;
    }
  };

  const handleSaveServerDraft = async () => {
    if (saveRequestInFlightRef.current) return;
    saveRequestInFlightRef.current = true;
    try {
      setLoadingServerDraft(true);
      await handleSave("Draft");
    } catch (error) {
      console.error("handleSaveServerDraft: error", error);
    } finally {
      setLoadingServerDraft(false);
      setSavePromptOpen(false);
      saveRequestInFlightRef.current = false;
    }
  };

  const handlePublish = async () => {
    if (saveRequestInFlightRef.current) return;
    saveRequestInFlightRef.current = true;
    try {
      setLoadingPublish(true);
      await handleSave("Publish");
    } catch (error) {
      console.error("handlePublish: error", error);
    } finally {
      setLoadingPublish(false);
      setSavePromptOpen(false);
      saveRequestInFlightRef.current = false;
    }
  };

  // Removes the local draft entry for the chapter we just saved online.
  // Matches by localId first (the explicit case), then falls back to a
  // (title, order) shadow match so a chapter the user is publishing for the
  // first time — which has a freshly minted localId that won't exist in any
  // older draft entry — still clears the stale draft sitting under the same
  // (title, order) slot. Without the shadow match, the same logical chapter
  // could appear twice in the table of contents (once from the new server
  // entry, once from the orphaned local draft) and "delete one delete all"
  // because the duplicates all point at the same server $id once tapped.
  // Removes this chapter's local-draft entry after a successful online
  // save. The matching/pruning logic lives in book-editor-helpers.js
  // (`pruneChapterFromDraft`) so the chapter-editor and book-introduction-
  // editor share a single source of truth — no more drift on the
  // introduction guard.
  const clearSavedLocalDraftChapter = () => {
    const localDraftKey = activeLocalDraftKey || draftKeyParam;
    if (!localDraftKey) return;
    const existingDraft = localDrafts?.[localDraftKey];
    const nextDraft = pruneChapterFromDraft({
      existingDraft,
      chapterForm,
      chapter,
      resolvedChapterTotal,
      isIntroductionEntry,
    });
    if (nextDraft === null) {
      dispatch(removeLocalDraft(localDraftKey));
      return;
    }
    dispatch(upsertLocalDraft({ key: localDraftKey, draft: nextDraft }));
  };

  const clearActiveLocalDraft = () => {
    const localDraftKey = activeLocalDraftKey || draftKeyParam;
    if (!localDraftKey) return;
    dispatch(removeLocalDraft(localDraftKey));
    setActiveLocalDraftKey(null);
  };

  const handleSave = async (status) => {
    try {
      if (!user?.$id) {
        showMessage("You need to be signed in to save this book.", 700);
        return;
      }
      if (!bookData?.title || !bookData?.synopsis) {
        showMessage("Book details are incomplete. Please go back to the book editor.", 700);
        return;
      }

      if (status === "Publish") {
        if (handleValidateData()) return;
      }

      // EDIT BOOK
      if (bookData?.$id) {
        let responseThumbnail = null;

        // only upload new if picking a file (uri exists)
        if (bookData?.thumbnail?.uri) {
          responseThumbnail = await bookService.uploadCover(bookData.thumbnail);
          if (!responseThumbnail) {
            showMessage("Unable to upload the book cover right now. Please try again.", 700);
            return;
          }
        }

        // build safe update payload
        const bookUpdatePayload = {
          title: bookData.title,
          synopsis: bookData.synopsis,
          tags: bookData.tags,
          status: bookData.status === "Ongoing" ? "Ongoing" : status === "Publish" ? "Ongoing" : "Draft",
          ...(responseThumbnail ? { thumbnail: responseThumbnail } : {}),
        };

        const responseBook = await bookService.updateBook({
          ID: bookData.$id,
          ...bookUpdatePayload,
          userId: user?.$id,
        });

        if (!responseBook?.$id) {
          showMessage("Unable to save this book right now. Please try again.", 700);
          return;
        }

        let responseChapterThumbnail = null;
        let savedChapter = null;
        if (chapterForm?.thumbnail?.uri) {
          responseChapterThumbnail = await bookService.uploadCover(chapterForm.thumbnail);
          if (!responseChapterThumbnail) {
            showMessage("Unable to upload the part cover right now. Please try again.", 700);
            return;
          }
        }

        // Per-chapter monetization: send the picker values through the
        // payload so updateBookChapter / createNewBookChapter can forward
        // them to submit_chapter_update. Translate the local-state
        // sentinel (null = "use default") into the RPC sentinel
        // (-1 = "explicitly clear"). 1-10 passes through unchanged.
        // We only send these fields when the book is locked — for free
        // books the columns stay null and inherit the global default.
        const resolveCostForRpc = (val) => {
          if (val === null || val === undefined) return -1; // clear / inherit default
          const n = Number(val);
          if (!Number.isFinite(n)) return -1;
          return n;
        };
        const monetizationPayload = bookData?.isLocked
          ? {
              unlockCostCoins: resolveCostForRpc(chapterUnlockCostCoins),
              unlockCostStars: resolveCostForRpc(chapterUnlockCostStars),
            }
          : {};

        const chapterPayload = {
          title: chapterForm.title,
          content: getSanitizedChapterContent(chapterForm.content),
          status: status,
          order: Number(resolvedChapterTotal),
          ...(responseChapterThumbnail ? { thumbnail: responseChapterThumbnail } : {}),
          ...monetizationPayload,
        };

        if (chapterForm.$id) {
          savedChapter = await bookService.updateBookChapter({
            ID: chapterForm.$id,
            ...chapterPayload,
            userId: user?.$id,
          });
        } else {
          const responseChapterData = await bookService.createNewBookChapter({
            ...chapterPayload,
            bookId: responseBook.$id,
            userId: user?.$id,
          });
          savedChapter = responseChapterData;

          // submit_chapter_create doesn't take per-chapter cost overrides;
          // when the author picked an explicit price (i.e. not Default)
          // for a brand-new chapter, apply it via a follow-up
          // updateBookChapter call. Skipped for free books and for the
          // Default-Default case (the columns stay NULL → reader unlock
          // modal falls back to BOOKS_CHAPTER_*_PRICE app_config).
          if (
            responseChapterData?.$id &&
            bookData?.isLocked &&
            (chapterUnlockCostCoins !== null || chapterUnlockCostStars !== null)
          ) {
            try {
              await bookService.updateBookChapter({
                ID: responseChapterData.$id,
                unlockCostCoins: monetizationPayload.unlockCostCoins,
                unlockCostStars: monetizationPayload.unlockCostStars,
                userId: user?.$id,
              });
            } catch (costErr) {
              console.error("chapter-editor: post-create cost write failed", costErr);
            }
          }

          if (responseChapterData?.$id && status === "Publish") {
            notificationService.notifyFollowers({
              sender: user,
              type: "book-chapter",
              resourceId: responseChapterData.$id,
              message: `just released a new part "${chapterForm.title}" for "${bookData.title}"!`,
            });
          }
        }

        clearSavedLocalDraftChapter();

        if (status === "Publish") {
          handleOpenPublishSuccess({
            publishedBook: responseBook,
            publishedChapter: {
              ...(chapterForm || {}),
              ...(savedChapter || {}),
              order: Number(resolvedChapterTotal),
              thumbnail: responseChapterThumbnail || savedChapter?.thumbnail || chapterForm?.thumbnail || responseBook?.thumbnail,
              book: responseBook,
            },
          });
        } else {
          showMessage("Part successfully saved as draft!", 1000, () => router.back());
        }
      } else {
        if (!bookData?.thumbnail) {
          showMessage("Please add a book cover before publishing.", 700);
          return;
        }
        const responseThumbnail = await bookService.uploadCover(bookData.thumbnail);
        if (!responseThumbnail) {
          showMessage("Unable to upload the book cover right now. Please try again.", 700);
          return;
        }

        const responseBook = await bookService.createNewBook({
          title: bookData.title,
          synopsis: bookData.synopsis,
          tags: bookData.tags,
          thumbnail: responseThumbnail,
          uploader: user?.$id,
          status: status === "Publish" ? "Ongoing" : "Draft",
        });

        if (!responseBook?.$id) {
          showMessage("Unable to create the book right now. Please try again.", 700);
          return;
        }

        const currentLocalId = chapterForm?.localId || chapter?.localId || resolveLocalChapterId({ chapterForm, chapter });
        const normalizedCurrentChapter = {
          ...chapterForm,
          localId: currentLocalId,
          order: resolvedChapterTotal,
          status,
          content: getSanitizedChapterContent(chapterForm.content),
        };
        const draftChapters = Array.isArray(localDraftByParam?.chapters) ? [...localDraftByParam.chapters] : [];
        const existingCurrentIndex = draftChapters.findIndex(
          (item) =>
            (item?.localId && item.localId === currentLocalId) ||
            (normalizedCurrentChapter?.$id && item?.$id && item.$id === normalizedCurrentChapter.$id) ||
            (Number(getBookChapterOrder(item)) === Number(resolvedChapterTotal) && !item?.$id),
        );
        if (existingCurrentIndex >= 0) {
          draftChapters[existingCurrentIndex] = {
            ...draftChapters[existingCurrentIndex],
            ...normalizedCurrentChapter,
          };
        } else {
          draftChapters.push(normalizedCurrentChapter);
        }

        const chaptersToCreate = sortBookChaptersByOrder(draftChapters).filter((draftChapter, index) => {
          if (isIntroductionChapter(draftChapter, index)) {
            return hasFilledEntry(draftChapter);
          }
          if (status !== "Publish") {
            return hasFilledEntry(draftChapter) || draftChapter?.localId === currentLocalId || draftChapter?.$id === chapterForm?.$id;
          }
          const sanitizedContent = getSanitizedChapterContent(draftChapter?.content ?? "");
          return Boolean(String(draftChapter?.title || "").trim().length && (stripHtml(sanitizedContent).length || hasInlineImage(sanitizedContent)));
        });

        let savedCurrentChapter = null;
        for (const draftChapter of chaptersToCreate) {
          let uploadedThumbnail = null;
          if (draftChapter?.thumbnail?.uri) {
            uploadedThumbnail = await bookService.uploadCover(draftChapter.thumbnail);
            if (!uploadedThumbnail) {
              showMessage("Unable to upload a part cover right now. Please try again.", 700);
              return;
            }
          } else if (typeof draftChapter?.thumbnail === "string") {
            uploadedThumbnail = draftChapter.thumbnail;
          }

          const createdChapter = await bookService.createNewBookChapter({
            title: draftChapter?.title || (isIntroductionChapter(draftChapter) ? "Introduction" : `Part ${getBookChapterOrder(draftChapter)}`),
            content: getSanitizedChapterContent(draftChapter?.content ?? ""),
            thumbnail: uploadedThumbnail,
            bookId: responseBook.$id,
            status,
            order: getBookChapterOrder(draftChapter),
            userId: user?.$id,
          });

          if (
            draftChapter?.localId === currentLocalId ||
            (draftChapter?.$id && chapterForm?.$id && draftChapter.$id === chapterForm.$id) ||
            getBookChapterOrder(draftChapter) === resolvedChapterTotal
          ) {
            savedCurrentChapter = {
              ...(draftChapter || {}),
              ...(createdChapter || {}),
              thumbnail: uploadedThumbnail || createdChapter?.thumbnail || draftChapter?.thumbnail || responseThumbnail,
            };
          }
        }

        clearActiveLocalDraft();

        if (status === "Publish") {
          handleOpenPublishSuccess({
            publishedBook: responseBook,
            publishedChapter: {
              ...(chapterForm || {}),
              ...(savedCurrentChapter || {}),
              order: Number(resolvedChapterTotal),
              thumbnail: savedCurrentChapter?.thumbnail || chapterForm?.thumbnail || responseThumbnail,
              book: responseBook,
            },
          });
        } else {
          showMessage("Chapter successfully saved as draft!", 1000, () => router.back());
        }

        if (status === "Publish" && responseBook?.$id && user?.$id) {
          notificationService.notifyFollowers({
            sender: user,
            type: "book",
            resourceId: responseBook.$id,
            message: `has released a new book titled "${bookData.title}"`,
          });
        }
      }
    } catch (error) {
      console.error("handleSave: error", error);
      showMessage("Unable to save this part right now. Please try again.", 700);
    }
  };

  const handleDeleteChapter = async () => {
    try {
      // Two delete modes — server-saved chapters call the SECURITY DEFINER
      // RPC; offline-only drafts (localId-only, no $id) just need to be
      // pulled out of Redux/MMKV via clearSavedLocalDraftChapter.
      // Without this branch, the previous handler called
      // `deleteBookChapter({ ID: undefined })` which threw "ID required"
      // and the user got a stuck spinner.
      const isServerChapter = Boolean(chapterForm?.$id);
      const isOfflineOnly = !isServerChapter && Boolean(chapterForm?.localId || chapter?.localId);

      // No-op guard — should never be reached because the button is now
      // hidden when neither id is present, but defensive in case the
      // visibility check drifts.
      if (!isServerChapter && !isOfflineOnly) return;

      const confirmMessage = isOfflineOnly
        ? "This part is saved offline only. Delete it from this device? (Other devices won't be affected.)"
        : "Are you sure you want to delete this part? There is no going back!";

      Alert.alert(
        "Confirm Deletion",
        confirmMessage,
        [
          {
            text: "No",
            style: "cancel",
          },
          {
            text: "Yes",
            onPress: async () => {
              try {
                if (isServerChapter) {
                  await bookService.deleteBookChapter({ ID: chapterForm.$id, userId: user?.$id });
                } else {
                  // Offline-only chapter — drop it from the local draft.
                  // clearSavedLocalDraftChapter handles the (1) "this is
                  // the last chapter, drop the whole draft" and (2)
                  // "remove just this chapter, keep the rest" cases.
                  clearSavedLocalDraftChapter();
                }
              } catch (innerErr) {
                console.error("handleDeleteChapter inner: error", innerErr);
              } finally {
                router.back();
              }
            },
            style: "destructive",
          },
        ],
        { cancelable: true },
      );
    } catch (error) {
      console.error("handleDeleteChapter: error", error);
    }
  };

  const pickImageAssetFromLibrary = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission Denied", "Please allow access to the photo library.");
      return null;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: "images",
    });

    if (result.canceled) return null;
    return result.assets?.[0] || null;
  };

  const closeChapterCoverCrop = () => {
    if (chapterCoverCropOpenTimerRef.current) {
      clearTimeout(chapterCoverCropOpenTimerRef.current);
      chapterCoverCropOpenTimerRef.current = null;
    }
    chapterCoverCropOpenTaskRef.current?.cancel?.();
    chapterCoverCropOpenTaskRef.current = null;
    setChapterCoverCropOpen(false);
    setSelectedChapterCoverAsset(null);
  };

  const scheduleChapterCoverCropOpen = (asset) => {
    if (!asset?.uri) return;

    if (chapterCoverCropOpenTimerRef.current) {
      clearTimeout(chapterCoverCropOpenTimerRef.current);
      chapterCoverCropOpenTimerRef.current = null;
    }
    chapterCoverCropOpenTaskRef.current?.cancel?.();
    chapterCoverCropOpenTaskRef.current = null;

    setChapterCoverCropOpen(false);
    setSelectedChapterCoverAsset(asset);

    const openDelay = Platform.OS === "ios" ? 450 : 50;
    chapterCoverCropOpenTaskRef.current = InteractionManager.runAfterInteractions(() => {
      chapterCoverCropOpenTimerRef.current = setTimeout(() => {
        setChapterCoverCropOpen(true);
        chapterCoverCropOpenTimerRef.current = null;
      }, openDelay);
    });
  };

  const openPicker = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission Denied", "Please allow access to the photo library.");
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: "Images",
        allowsEditing: true,
        aspect: PROFILE_BANNER_CROP_ASPECT,
        quality: 1,
      });

      if (result.canceled || !result.assets?.[0]) return;

      const rawAsset = result.assets[0];
      const asset = await persistImagePickerAsset(rawAsset, "chapter-cover");
      if (asset.fileSize && asset.fileSize > sizeLimitThumbnailUpload) {
        showMessage(`Please ensure your thumbnail upload size is under ${sizeLimitThumbnailUpload / 1024 / 1024}MB.`, 500);
        return;
      }
      scheduleChapterCoverCropOpen(asset);
    } catch (error) {
      console.error("openPicker: error", error);
    }
  };

  const handleChapterCoverCropComplete = async (croppedCover) => {
    setChapterCoverCropOpen(false);

    try {
      if (croppedCover?.fileSize && croppedCover.fileSize > sizeLimitThumbnailUpload) {
        showMessage(`Please ensure your thumbnail upload size is under ${sizeLimitThumbnailUpload / 1024 / 1024}MB.`, 500);
        setChapterCoverCropOpen(true);
        return;
      }
      setChapterForm((prev) => ({ ...prev, thumbnail: croppedCover }));
      setSelectedChapterCoverAsset(null);
    } catch (error) {
      console.error("handleChapterCoverCropComplete: error", error);
      showMessage("Unable to use this cover right now. Please try again.", 600);
      setChapterCoverCropOpen(true);
    }
  };

  const handleInsertInlineImage = async () => {
    const tempUploadId = `inline-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const asset = await pickImageAssetFromLibrary();
      if (!asset) return;
      if (asset.fileSize && asset.fileSize > sizeLimitInlineImageUpload) {
        showMessage(`Please ensure your inline image size is under ${sizeLimitInlineImageUpload / 1024 / 1024}MB.`, 500);
        return;
      }

      const localImageUri = asset?.uri || "";
      if (!localImageUri) {
        showMessage("Unable to use this image. Please pick another one.", 600);
        return;
      }
      const localPreviewSrc = await buildLocalInlinePreviewSrc(asset);
      const pendingSrc = localPreviewSrc || localImageUri;

      richTextRef.current?.insertHTML(
        `<img src="${escapeHtmlAttribute(pendingSrc)}" data-upload-id="${escapeHtmlAttribute(tempUploadId)}" style="${INLINE_IMAGE_PENDING_STYLE}" />`,
      );
      richTextRef.current?.insertHTML("<p><br/></p>");
      setTimeout(() => {
        richTextRef.current?.focusContentEditor?.();
      }, 60);
      scheduleEditorHeightSync();

      const uploadedImageUri = await bookService.uploadChapterInlineImage(asset);
      const imageUrl = typeof uploadedImageUri === "string" ? uploadedImageUri : uploadedImageUri?.toString?.();
      if (!imageUrl) {
        showMessage("Unable to insert image right now. Please try again.", 600);
        return;
      }

      richTextRef.current?.commandDOM(`(function () {
        var uploadId = ${JSON.stringify(tempUploadId)};
        var uploadedUrl = ${JSON.stringify(imageUrl)};
        var imgs = document.querySelectorAll("img[data-upload-id]");
        for (var i = 0; i < imgs.length; i += 1) {
          var img = imgs[i];
          if (img.getAttribute("data-upload-id") !== uploadId) continue;
          img.setAttribute("src", uploadedUrl);
          img.setAttribute("style", ${JSON.stringify(INLINE_IMAGE_BASE_STYLE)});
          img.removeAttribute("data-upload-id");
          break;
        }
        var content = document.getElementById("content");
        if (content) content.dispatchEvent(new Event("input", { bubbles: true }));
      })();`);
      scheduleEditorHeightSync();
    } catch (error) {
      console.error("handleInsertInlineImage: error", error);
      showMessage("Unable to upload image right now. Please try again.", 600);
      richTextRef.current?.commandDOM(`(function () {
        var uploadId = ${JSON.stringify(tempUploadId)};
        var imgs = document.querySelectorAll("img[data-upload-id]");
        for (var i = 0; i < imgs.length; i += 1) {
          var img = imgs[i];
          if (img.getAttribute("data-upload-id") !== uploadId) continue;
          if (img.parentNode) img.parentNode.removeChild(img);
          break;
        }
        var content = document.getElementById("content");
        if (content) content.dispatchEvent(new Event("input", { bubbles: true }));
      })();`);
      scheduleEditorHeightSync();
    }
  };

  const showSavePrompt = () => setSavePromptOpen(true);

  const handleCloseMessage = () => {
    closeMessage();
  };

  const handleOpenPublishSuccess = ({ publishedBook, publishedChapter }) => {
    // Stash the payload so the success modal has its book/chapter context
    // ready before it mounts. We don't flip publishSuccessOpen yet — the
    // BooksSavePromptModal that triggered this is built on RN's native
    // <Modal>, which on iOS presents above the JS view tree. If we open
    // the JS-based success modal in the same tick, it animates up while
    // still hidden behind the native overlay and the user never sees it
    // appear. Workaround: dismiss the native prompt first, wait for its
    // fade-out (~280ms) to finish, then flip the success modal on so its
    // slideInUp animation runs in front of the user.
    setPublishedContent({
      book: publishedBook,
      chapter: publishedChapter,
    });
    setSavePromptOpen(false);
    setTimeout(() => setPublishSuccessOpen(true), 320);
  };

  const handleClosePublishSuccess = () => {
    setPublishSuccessOpen(false);
    setPublishedContent(null);
    // If we navigated in via an existing book, just pop back to it.
    // Otherwise the chapter we just published belongs to a freshly-
    // created book — land on the author catalog so the new book is
    // visible alongside the rest.
    if (bookData?.$id) router.back();
    else router.replace("catalog");
  };

  const handleViewPublishedBook = () => {
    if (!publishedContent?.book?.$id) {
      handleClosePublishSuccess();
      return;
    }

    setPublishSuccessOpen(false);
    setPublishedContent(null);
    router.replace({
      pathname: "book-info",
      params: {
        bookId: publishedContent.book.$id,
      },
    });
  };

  const getWordCount = (text) => {
    if (!text) return 0;
    const plainText = stripHtml(text);
    if (!plainText) return 0;
    return plainText.split(/\s+/).length;
  };

  useEffect(() => {
    if (!draftKeyParam) return;
    setActiveLocalDraftKey(draftKeyParam);
  }, [draftKeyParam]);

  const editorBottomPadding = editorMode === "write" ? 30 : 56;
  const hasPreviewContent = Boolean(stripHtml(chapterForm.content)?.length || hasInlineImage(chapterForm.content));
  const sectionCardStyle = {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
  };
  const inputStyle = {
    backgroundColor: theme.inputBackground,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    color: theme.inputText,
  };
  const previewBaseStyle = { color: theme.text, fontSize: 16, lineHeight: 24 };
  const previewTagsStyles = {
    p: { marginTop: 0, marginBottom: 12 },
    h1: { fontSize: 26, marginTop: 12, marginBottom: 8, color: theme.text },
    h2: { fontSize: 22, marginTop: 12, marginBottom: 8, color: theme.text },
    h3: { fontSize: 18, marginTop: 12, marginBottom: 6, color: theme.text },
    strong: { color: theme.text },
    em: { color: theme.textMuted },
    u: { textDecorationLine: "underline" },
    s: { textDecorationLine: "underline" },
    span: { color: theme.textMuted },
    // Clamp inline images to the container width and let height auto-
    // scale so aspect ratio is preserved. react-native-render-html
    // ignores the CSS `max-width:100%` inlined into the <img> tag —
    // tagsStyles wins, and the previous shape (no width constraint)
    // let intrinsic-sized images blow past the screen edge and push
    // the surrounding text out of view.
    img: {
      width: "100%",
      height: "auto",
      maxWidth: "100%",
      alignSelf: "center",
      marginTop: 8,
      marginBottom: 14,
      borderRadius: 12,
    },
  };
  // Memoized so the RichEditor receives a stable `editorStyle` reference
  // across keystrokes. Previously these were re-created on every render —
  // every keystroke triggered setChapterForm → re-render → fresh editorStyle
  // object → react-native-pell-rich-editor re-injected CSS into the WebView,
  // which manifested as cursor jumps, dropped characters, and wobbly font
  // sizing while typing.
  const editorCssText = useMemo(
    () => `body { font-size: 14px; color: ${theme.inputText}; } * { background-color: transparent !important; }`,
    [theme.inputText],
  );
  const editorStyleProp = useMemo(
    () => ({
      backgroundColor: "transparent",
      color: theme.inputText,
      placeholderColor: theme.placeholder,
      contentCSSText: editorCssText,
    }),
    [editorCssText, theme.inputText, theme.placeholder],
  );

  const clearEditorHeightSyncTimeouts = () => {
    imageHeightSyncTimeoutsRef.current.forEach((timeoutId) => clearTimeout(timeoutId));
    imageHeightSyncTimeoutsRef.current = [];
  };

  const syncEditorHeightFromDom = () => {
    if (!editorReadyRef.current) return;
    richTextRef.current?.commandDOM(`(function () {
      var content = document.getElementById("content");
      if (!content) return;
      var postHeight = function () {
        var nextHeight = content.scrollHeight || 0;
        if (window.ReactNativeWebView && nextHeight) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: "OFFSET_HEIGHT", data: nextHeight }));
        }
      };
      var imgs = content.querySelectorAll("img");
      for (var i = 0; i < imgs.length; i += 1) {
        var img = imgs[i];
        if (img.getAttribute("data-rn-height-bound") === "1") continue;
        img.setAttribute("data-rn-height-bound", "1");
        img.addEventListener("load", postHeight);
        img.addEventListener("error", postHeight);
      }
      postHeight();
    })();`);
  };

  const scheduleEditorHeightSync = () => {
    clearEditorHeightSyncTimeouts();
    [0, 120, 320].forEach((delay) => {
      const timeoutId = setTimeout(syncEditorHeightFromDom, delay);
      imageHeightSyncTimeoutsRef.current.push(timeoutId);
    });
  };

  useEffect(() => {
    return () => {
      clearEditorHeightSyncTimeouts();
      if (chapterCoverCropOpenTimerRef.current) {
        clearTimeout(chapterCoverCropOpenTimerRef.current);
        chapterCoverCropOpenTimerRef.current = null;
      }
      chapterCoverCropOpenTaskRef.current?.cancel?.();
      chapterCoverCropOpenTaskRef.current = null;
    };
  }, []);

  return (
    <>
      <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
        <KeyboardAvoidingView className="flex-1" style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <View className="flex-1">
            {/* Header */}
            <View
              className="align-start flex-row items-center justify-between px-4 pb-2 pt-2"
              style={{ borderBottomWidth: 1, borderBottomColor: theme.border }}
            >
              <StyledTitle
                className="py-0"
                icon={
                  <TouchableOpacity onPress={() => router.back()}>
                    <MaterialIcons name="arrow-back" size={24} color={theme.icon} />
                  </TouchableOpacity>
                }
                title={`Part ${resolvedChapterTotal}`}
              />
              <View className="flex-row items-center" style={{ gap: 10 }}>
                {/*
                  Delete button — visible for both server chapters
                  ($id present) and offline-only drafts (localId present).
                  Without the localId branch, an offline draft has no
                  delete affordance from inside the editor and the only
                  way to remove it is to navigate back to the catalog.
                  The handler below routes to the right path based on
                  which id is present.
                */}
                {(chapterForm?.$id || chapterForm?.localId || chapter?.localId) && (
                  <TouchableOpacity
                    onPress={handleDeleteChapter}
                    activeOpacity={0.7}
                    style={{
                      height: 36,
                      width: 36,
                      borderRadius: 18,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: "rgba(239, 68, 68, 0.12)",
                      borderWidth: 1,
                      borderColor: "rgba(239, 68, 68, 0.28)",
                    }}
                  >
                    <Ionicons name="trash-outline" size={18} color={theme.danger} />
                  </TouchableOpacity>
                )}
                {/*
                  Premium Save button — uses theme.primary so it stays
                  in sync with the canonical brand purple used by the
                  "Publish Book" button inside BooksSavePromptModal and
                  every other primary CTA across the app. Soft matching
                  shadow gives the iOS "glow" effect and elevation:5
                  lifts it off the surface on Android.
                */}
                <TouchableOpacity
                  onPress={showSavePrompt}
                  activeOpacity={0.85}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingHorizontal: 14,
                    height: 36,
                    borderRadius: 18,
                    backgroundColor: theme.primary,
                    shadowColor: theme.primary,
                    shadowOffset: { width: 0, height: 4 },
                    shadowOpacity: 0.35,
                    shadowRadius: 10,
                    elevation: 5,
                  }}
                >
                  <Ionicons name="bookmark" size={15} color={theme.primaryContrast || "#FFFFFF"} />
                  <Text
                    style={{
                      marginLeft: 6,
                      color: theme.primaryContrast || "#FFFFFF",
                      fontSize: 13,
                      fontWeight: "700",
                      letterSpacing: 0.4,
                    }}
                  >
                    Save
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Content */}
            <ScrollView
              ref={scrollViewRef}
              className="space-y-4 px-4 py-5"
              contentContainerStyle={{ paddingBottom: editorBottomPadding }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* Thumbnail */}
              <TouchableOpacity onPress={openPicker} className="rounded-2xl p-4" style={sectionCardStyle}>
                <View className="flex-row items-center justify-between">
                  <Text className="text-sm font-semibold" style={{ color: theme.textMuted }}>
                    Part Cover
                  </Text>
                  <Text
                    className="text-[10px] font-medium"
                    style={{ color: theme.textSoft }}
                  >{`Max ${sizeLimitThumbnailUpload / 1024 / 1024}MB`}</Text>
                </View>
                <View className="mt-3 flex-row items-center space-x-3">
                  {chapterForm?.thumbnail ? (
                    <View className="items-center justify-center overflow-hidden rounded-xl" style={sectionCardStyle}>
                      <FastImage
                        className="h-24 w-40"
                        source={{
                          uri: chapterForm?.thumbnail?.uri || chapterForm?.thumbnail,
                          priority: FastImage.priority.high,
                        }}
                        resizeMode={FastImage.resizeMode.cover}
                      />
                    </View>
                  ) : (
                    <View
                      className="h-24 w-40 items-center justify-center space-y-1 rounded-xl p-3"
                      style={{ borderWidth: 1, borderStyle: "dashed", borderColor: theme.borderStrong, backgroundColor: theme.surfaceMuted }}
                    >
                      <FontAwesome name="plus" size={20} color={theme.iconMuted} />
                      <Text className="text-xs" style={{ color: theme.textSoft }}>
                        Upload
                      </Text>
                    </View>
                  )}
                  <View className="flex-1">
                    <Text className="text-base font-semibold" style={{ color: theme.text }}>
                      {chapterForm.thumbnail ? "Edit cover" : "Add a cover"}
                    </Text>
                    <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
                      Optional but helps this part stand out.
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>

              {/* Title */}
              <View className="rounded-2xl p-4" style={sectionCardStyle}>
                <View>
                  <View className="flex-row items-center justify-between">
                    <Text className="text-sm font-semibold" style={{ color: theme.textMuted }}>
                      Part Title
                    </Text>
                    <Text
                      className="text-[10px] font-medium"
                      style={{ color: theme.textSoft }}
                    >{`${chapterForm.title?.length || 0}/${sizeLimitTitleChars}`}</Text>
                  </View>
                  <TextInput
                    value={chapterForm.title}
                    onChangeText={(text) => handleChange("title", text)}
                    className="mt-3 rounded-xl px-3 py-3 text-[14px]"
                    style={inputStyle}
                    maxLength={Number(sizeLimitTitleChars)}
                    placeholderTextColor={theme.placeholder}
                    multiline
                    submitBehavior="blurAndSubmit"
                    returnKeyType="done"
                  />
                </View>
              </View>

              {/* MONETIZATION — only visible when the parent book is locked.
                  Authors can set a per-chapter unlock cost in coins and/or
                  stars (1-10 each, server-side range), or fall back to the
                  app_config default by tapping the "Default" segment. The
                  segments writes the chosen number into local state; the
                  save flow (see chapterPayload below) forwards both fields
                  to submit_chapter_update which writes columns
                  unlock_cost_coins / unlock_cost_stars on the chapter row.
                  Default = NULL → reader unlock modal falls back to
                  BOOKS_CHAPTER_COIN_PRICE / BOOKS_CHAPTER_STAR_PRICE. */}
              {bookData?.isLocked && (
                <View className="rounded-2xl p-4" style={sectionCardStyle}>
                  <View>
                    <Text className="text-sm font-semibold" style={{ color: theme.textMuted }}>
                      Unlock Cost
                    </Text>
                    <Text className="mt-1 text-[11px]" style={{ color: theme.textSoft }}>
                      Pick a per-chapter price, or tap Default to inherit the platform default.
                    </Text>
                  </View>

                  {/* Coins */}
                  <View className="mt-3">
                    <Text className="mb-1 text-[11px] font-semibold" style={{ color: theme.textSoft }}>
                      Coins (1-10)
                    </Text>
                    <SegmentedNumberPicker
                      values={[null, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]}
                      selected={chapterUnlockCostCoins}
                      onChange={setChapterUnlockCostCoins}
                    />
                  </View>

                  {/* Stars */}
                  <View className="mt-3">
                    <Text className="mb-1 text-[11px] font-semibold" style={{ color: theme.textSoft }}>
                      Stars (1-10)
                    </Text>
                    <SegmentedNumberPicker
                      values={[null, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]}
                      selected={chapterUnlockCostStars}
                      onChange={setChapterUnlockCostStars}
                    />
                  </View>
                </View>
              )}

              {/* Content */}
              <View className="rounded-2xl p-4" style={sectionCardStyle}>
                <View className="flex-row items-center justify-between">
                  <View>
                    <Text className="text-sm font-semibold" style={{ color: theme.textMuted }}>
                      Part Content
                    </Text>
                    <Text
                      className="mt-1 text-[10px] font-medium"
                      style={{ color: theme.textSoft }}
                    >{`Words ${getWordCount(chapterForm.content)}`}</Text>
                  </View>
                  <View
                    className="flex-row overflow-hidden rounded-full"
                    style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted }}
                  >
                    <TouchableOpacity
                      onPress={() => setEditorMode("write")}
                      className="px-4 py-1"
                      style={{ backgroundColor: editorMode === "write" ? theme.primary : "transparent" }}
                    >
                      <Text className="text-xs font-semibold" style={{ color: editorMode === "write" ? theme.primaryContrast : theme.textSoft }}>
                        Write
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setEditorMode("preview")}
                      className="px-4 py-1"
                      style={{ backgroundColor: editorMode === "preview" ? theme.primary : "transparent" }}
                    >
                      <Text className="text-xs font-semibold" style={{ color: editorMode === "preview" ? theme.primaryContrast : theme.textSoft }}>
                        Preview
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {editorMode === "write" ? (
                  <View
                    className="mt-3 rounded-xl p-1"
                    style={{ borderWidth: 1, borderColor: theme.inputBorder, backgroundColor: theme.inputBackground }}
                  >
                    <RichEditor
                      ref={richTextRef}
                      initialContentHTML={chapterForm.content ?? ""}
                      editorInitializedCallback={() => {
                        editorReadyRef.current = true;
                        scheduleEditorHeightSync();
                      }}
                      placeholder="Write your part..."
                      editorStyle={editorStyleProp}
                      style={{ minHeight: 260 }}
                      onChange={handleContentChange}
                    />
                  </View>
                ) : (
                  <View className="mt-3 rounded-xl p-3" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted }}>
                    {hasPreviewContent ? (
                      <RenderHTML
                        contentWidth={Math.max(windowWidth - 64, 0)}
                        source={{ html: normalizeBookContentToHtml(chapterForm.content ?? "") }}
                        baseStyle={previewBaseStyle}
                        renderersProps={{
                          img: {
                            enableExperimentalPercentWidth: true,
                            initialDimensions: { width: Math.max(windowWidth - 64, 0), height: 220 },
                          },
                        }}
                        tagsStyles={previewTagsStyles}
                      />
                    ) : (
                      <Text className="text-sm" style={{ color: theme.textSoft }}>
                        Nothing to preview yet.
                      </Text>
                    )}
                  </View>
                )}
              </View>
            </ScrollView>
          </View>

          <View className="w-full px-4 py-2" style={{ borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.background }}>
            <View>
              <RichToolbar
                editor={richTextRef}
                actions={[
                  actions.undo,
                  actions.redo,
                  actions.setBold,
                  actions.setItalic,
                  actions.setUnderline,
                  actions.setStrikethrough,
                  actions.insertImage,
                  actions.alignLeft,
                  actions.alignCenter,
                  actions.alignRight,
                  actions.alignFull,
                ]}
                onPressAddImage={handleInsertInlineImage}
                iconTint={theme.textSoft}
                selectedIconTint={theme.primary}
                style={{ backgroundColor: "transparent", paddingHorizontal: 0, marginHorizontal: 0 }}
              />
            </View>
            <Text className="self-end px-2 text-sm" style={{ color: theme.textSoft }}>{`Words: ${getWordCount(chapterForm.content)}`}</Text>
          </View>
        </KeyboardAvoidingView>

        {/* Modals */}
        <CustomAlertModal message={message} iconName="message" messageOpen={messageOpen} closeMessage={handleCloseMessage} />
        <BookChapterPublishSuccessModal
          visible={publishSuccessOpen}
          onClose={handleClosePublishSuccess}
          onViewBook={handleViewPublishedBook}
          book={publishedContent?.book}
          chapter={publishedContent?.chapter}
          isIntroductionEntry={false}
        />
        <BooksSavePromptModal
          visible={savePromptOpen}
          onClose={() => setSavePromptOpen(false)}
          onSaveLocalDraft={handleSaveLocalDraft}
          onSaveServerDraft={handleSaveServerDraft}
          onPublish={handlePublish}
          loadingLocalDraft={loadingLocalDraft}
          loadingServerDraft={loadingServerDraft}
          loadingPublish={loadingPublish}
          showLocalDraftOption={!isExistingServerChapter}
          showServerDraftOption
        />
      </SafeAreaView>
      <BannerCropModal
        visible={isChapterCoverCropOpen}
        asset={selectedChapterCoverAsset}
        aspectRatio={PROFILE_BANNER_ASPECT_RATIO}
        title="Preview part cover"
        description="Cropped with the native editor using the same wide cover ratio."
        helperText="Your part cover keeps the same wide crop used in the profile editor before it is saved to the part."
        confirmLabel="Use cover"
        onClose={closeChapterCoverCrop}
        onComplete={handleChapterCoverCropComplete}
      />
    </>
  );
};

export default ChapterEditor;
