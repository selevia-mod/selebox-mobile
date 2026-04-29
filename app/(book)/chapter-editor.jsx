import { FontAwesome, Ionicons, MaterialIcons } from "@expo/vector-icons";
import * as FileSystem from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { cleanupTempFile, convertToWebP, persistImagePickerAsset } from "../../lib/image-utils";
import { NotificationService } from "../../lib/notifications";
import { useModalMessage } from "../../lib/useModalMessage";
import { removeLocalDraft, upsertLocalDraft } from "../../store/reducers/books";

const sanitizeImageTag = (tag = "") => {
  const srcMatch = tag.match(/\ssrc=(["'])(.*?)\1/i);
  const src = srcMatch?.[2]?.trim();
  if (!src || !/^https?:\/\//i.test(src)) return "";
  return `<img src="${src.replace(/"/g, "&quot;")}" />`;
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
const hasInlineImage = (html = "") => /<img\b[^>]*>/i.test(html);
const stripHtml = (value = "") =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();

const createLocalDraftKey = ({ userId }) => {
  if (!userId) return "";
  return `bookDraft:${userId}:local:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
};

const createExistingBookDraftKey = ({ userId, bookId }) => {
  if (!userId || !bookId) return "";
  return `bookDraft:${userId}:book:${bookId}`;
};
const escapeHtmlAttribute = (value = "") => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const INLINE_IMAGE_BASE_STYLE = "max-width:100%; height:auto; display:block; margin:12px auto; border-radius:12px; object-fit:cover;";
const INLINE_IMAGE_PENDING_STYLE = `${INLINE_IMAGE_BASE_STYLE} filter: blur(8px); opacity: 0.6;`;

const resolveLocalChapterId = ({ chapterForm, chapter }) => {
  if (chapterForm?.localId) return chapterForm.localId;
  if (chapter?.localId) return chapter.localId;
  if (chapterForm?.$id) return `server:${chapterForm.$id}`;
  if (chapter?.$id) return `server:${chapter.$id}`;
  return `localChapter:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
};

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
      console.log("buildLocalInlinePreviewSrc convert error", error);
    }

    try {
      const base64 = await FileSystem.readAsStringAsync(previewUri, { encoding: FileSystem.EncodingType.Base64 });
      if (!base64) return sourceUri;
      return `data:${previewMime};base64,${base64}`;
    } catch (error) {
      console.log("buildLocalInlinePreviewSrc read error", error);
      return sourceUri;
    } finally {
      cleanupTempFile(previewUri, sourceUri);
    }
  };

  const getSanitizedChapterContent = (content = "") => stripBackgroundStyles(normalizeBookContentToHtml(content));
  const hasFilledEntry = useCallback(
    (entry) => {
      const title = String(entry?.title || "").trim();
      const content = getSanitizedChapterContent(entry?.content ?? "");
      const hasContent = Boolean(stripHtml(content)?.length || hasInlineImage(content));
      const hasThumbnail = Boolean(entry?.thumbnail?.uri || entry?.thumbnail);
      return Boolean(title || hasContent || hasThumbnail);
    },
    [getSanitizedChapterContent],
  );

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
      console.log("persistEntryToLocalDraft: error", error);
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
      console.log("handleSaveLocalDraft: error", error);
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
      console.log("handleSaveServerDraft: error", error);
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
      console.log("handlePublish: error", error);
    } finally {
      setLoadingPublish(false);
      setSavePromptOpen(false);
      saveRequestInFlightRef.current = false;
    }
  };

  const clearSavedLocalDraftChapter = () => {
    const localDraftKey = activeLocalDraftKey || draftKeyParam;
    if (!localDraftKey) return;

    const existingDraft = localDrafts?.[localDraftKey];
    const existingChapters = Array.isArray(existingDraft?.chapters)
      ? existingDraft.chapters
      : existingDraft?.chapterForm
        ? [existingDraft.chapterForm]
        : [];
    const chapterLocalId = resolveLocalChapterId({ chapterForm, chapter });

    if (!existingDraft || !chapterLocalId) {
      dispatch(removeLocalDraft(localDraftKey));
      return;
    }

    const remainingChapters = existingChapters.filter((item) => item?.localId !== chapterLocalId);
    if (!remainingChapters.length) {
      dispatch(removeLocalDraft(localDraftKey));
      return;
    }

    dispatch(
      upsertLocalDraft({
        key: localDraftKey,
        draft: {
          ...existingDraft,
          chapterForm: remainingChapters[0],
          chapters: remainingChapters,
          meta: {
            ...(existingDraft?.meta || {}),
            chaptersTotal: remainingChapters.length,
          },
          updatedAt: Date.now(),
        },
      }),
    );
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

        const chapterPayload = {
          title: chapterForm.title,
          content: getSanitizedChapterContent(chapterForm.content),
          status: status,
          order: Number(resolvedChapterTotal),
          ...(responseChapterThumbnail ? { thumbnail: responseChapterThumbnail } : {}),
        };

        if (chapterForm.$id) {
          savedChapter = await bookService.updateBookChapter({
            ID: chapterForm.$id,
            ...chapterPayload,
          });
        } else {
          const responseChapterData = await bookService.createNewBookChapter({
            ...chapterPayload,
            bookId: responseBook.$id,
          });
          savedChapter = responseChapterData;

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
      console.log("handleSave: error", error);
      showMessage("Unable to save this part right now. Please try again.", 700);
    }
  };

  const handleDeleteChapter = async () => {
    try {
      Alert.alert(
        "Confirm Deletion",
        "Are you sure you want to delete this part? There is no going back!",
        [
          {
            text: "No",
            style: "cancel",
          },
          {
            text: "Yes",
            onPress: async () => {
              await bookService.deleteBookChapter({ ID: chapterForm.$id });
              router.back();
            },
            style: "destructive",
          },
        ],
        { cancelable: true },
      );
    } catch (error) {
      console.log("handleDeleteChapter: error", error);
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
      console.log("openPicker: error", error);
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
      console.log("handleChapterCoverCropComplete: error", error);
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
      console.log("handleInsertInlineImage: error", error);
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
    setPublishedContent({
      book: publishedBook,
      chapter: publishedChapter,
    });
    setPublishSuccessOpen(true);
  };

  const handleClosePublishSuccess = () => {
    setPublishSuccessOpen(false);
    setPublishedContent(null);
    console.log(bookData?.$id);
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
    img: { marginTop: 8, marginBottom: 14, borderRadius: 12 },
  };
  const editorCssText = `body { font-size: 14px; color: ${theme.inputText}; } * { background-color: transparent !important; }`;

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
              <View className="flex-row space-x-2">
                {chapterForm?.$id && (
                  <TouchableOpacity onPress={handleDeleteChapter}>
                    <Ionicons name="trash" size={24} color={theme.danger} />
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={showSavePrompt}>
                  <Ionicons name="save" size={24} color={theme.icon} />
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
                      editorStyle={{
                        backgroundColor: "transparent",
                        color: theme.inputText,
                        placeholderColor: theme.placeholder,
                        contentCSSText: editorCssText,
                      }}
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
