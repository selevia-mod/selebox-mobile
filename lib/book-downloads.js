import { storage } from "../store/storage";

const DOWNLOAD_PREFIX = "book-download:";
const DOWNLOAD_INDEX_KEY = "book-download-index";

const safeParse = (value) => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    console.log("book-downloads: parse error", error);
    return null;
  }
};

const getDownloadKey = (bookId) => `${DOWNLOAD_PREFIX}${bookId}`;

const getDownloadIndex = () => safeParse(storage.getString(DOWNLOAD_INDEX_KEY)) || [];

const setDownloadIndex = (ids) => {
  storage.set(DOWNLOAD_INDEX_KEY, JSON.stringify(ids));
};

const updateDownloadIndex = (bookId, shouldInclude) => {
  const ids = new Set(getDownloadIndex());
  if (shouldInclude) {
    ids.add(bookId);
  } else {
    ids.delete(bookId);
  }
  setDownloadIndex([...ids]);
};

export const saveDownloadedBook = ({ bookId, book, chapters }) => {
  const payload = {
    bookId,
    book,
    chapters,
    chapterIds: chapters.map((chapter) => chapter.$id),
    downloadedAt: Date.now(),
  };
  storage.set(getDownloadKey(bookId), JSON.stringify(payload));
  updateDownloadIndex(bookId, true);
  return payload;
};

export const getDownloadedBook = (bookId) => {
  const entry = storage.getString(getDownloadKey(bookId));
  return safeParse(entry);
};

export const isBookDownloaded = (bookId) => !!storage.getString(getDownloadKey(bookId));

export const removeDownloadedBook = (bookId) => {
  storage.delete(getDownloadKey(bookId));
  updateDownloadIndex(bookId, false);
};

export const getDownloadedBookIds = () => getDownloadIndex();

export const clearDownloadedBooks = () => {
  const ids = getDownloadIndex();
  ids.forEach((bookId) => storage.delete(getDownloadKey(bookId)));
  storage.delete(DOWNLOAD_INDEX_KEY);
};

export const upsertDownloadedChapter = ({ bookId, chapter, book }) => {
  const existing = getDownloadedBook(bookId);
  if (!existing) return null;

  const chapters = Array.isArray(existing.chapters) ? [...existing.chapters] : [];
  const existingIndex = chapters.findIndex((item) => item?.$id === chapter?.$id);
  if (existingIndex >= 0) {
    chapters[existingIndex] = { ...chapters[existingIndex], ...chapter };
  } else {
    chapters.push(chapter);
  }

  if (chapters.every((item) => typeof item?.order === "number")) {
    chapters.sort((a, b) => a.order - b.order);
  }

  const payload = {
    ...existing,
    book: book || existing.book,
    chapters,
    chapterIds: Array.from(new Set(chapters.map((item) => item.$id))),
    updatedAt: Date.now(),
  };

  storage.set(getDownloadKey(bookId), JSON.stringify(payload));
  updateDownloadIndex(bookId, true);
  return payload;
};

export const findDownloadedBookByChapterId = (chapterId) => {
  const ids = getDownloadIndex();
  for (const bookId of ids) {
    const entry = getDownloadedBook(bookId);
    if (entry?.chapters?.some((chapter) => chapter.$id === chapterId)) {
      return entry;
    }
  }
  return null;
};
