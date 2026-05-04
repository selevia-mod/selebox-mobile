// BookLockPromptBanner — soft in-app prompt shown to authors whose
// book is currently Free but who already monetize at least one OTHER
// book. The platform's mobile "Lock Book" Switch toggle silently
// dropped the threshold for months (the old updateBook stripped
// `isLocked` before the RPC saw it), so a writer who has 24 paid
// books and 3 free ones is highly likely to have meant the 3 free
// ones to be paid too. We surface this prompt instead of nagging
// universally — the qualifier is "this writer has at least one
// other paid book" (provided via the `shouldShow` prop, computed
// server-side via has_paid_books_for_author).
//
// UX shape:
//   • Soft notice card. Brand-purple accent stripe down the left edge,
//     calm copy, no exclamation marks. Not alarmist.
//   • Inline 5-10 segmented picker. One tap locks the book at that
//     threshold. No need to leave the current screen.
//   • "Already free on purpose" Dismiss link writes
//     books.lock_prompt_dismissed_at server-side so the banner stays
//     hidden for THIS book forever (or until the author re-unlocks,
//     at which point the trigger re-arms it).
//
// The banner unmounts itself optimistically when the author taps a
// number (book is now locked → the parent surface re-renders without
// the banner) or taps Dismiss. Failures roll back local state and
// surface a toast.
//
// Props
//   - book        Required. Mapped Appwrite-shaped book row. We read
//                 book.$id (or book.id), book.lock_from_chapter,
//                 book.lock_prompt_dismissed_at.
//   - shouldShow  Boolean. Caller computes "writer has at least one
//                 other paid book" via BookService.hasPaidBooks() and
//                 caches it for the session. Banner returns null if
//                 false. Must be true for the banner to render.
//   - userId      Required. Caller id (Appwrite hex or UUID). Forwarded
//                 to the lib's lock + dismiss methods.
//   - onLocked    Optional callback. Called with the new threshold
//                 value after a successful lock. Parent typically
//                 refetches the book / list so the banner unmounts.
//   - onDismissed Optional callback after a successful dismissal so
//                 the parent can hide the banner without a refetch.

import React, { useState } from "react";
import { ActivityIndicator, Alert, Text, TouchableOpacity, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import { BookService } from "../lib/books";
import SegmentedNumberPicker from "./SegmentedNumberPicker";

const BookLockPromptBanner = ({ book, shouldShow, userId, onLocked, onDismissed }) => {
  const { theme } = useAppTheme();
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  // Visibility gate — short-circuit early if any condition fails so
  // we never hit the network for a banner the parent wouldn't show.
  if (hidden) return null;
  if (!shouldShow) return null;
  if (!book) return null;
  if (book?.lock_from_chapter || book?.bookChapterLockStart) return null;
  if (book?.lock_prompt_dismissed_at) return null;

  const bookId = book?.$id || book?.id;
  if (!bookId) return null;

  const bookService = new BookService();

  const handleLock = async (threshold) => {
    if (busy) return;
    const n = Number(threshold);
    if (!Number.isFinite(n) || n < 5 || n > 10) return;
    try {
      setBusy(true);
      await bookService.updateBook({ ID: bookId, lockFromChapter: n, userId });
      setHidden(true);
      onLocked?.(n);
    } catch (err) {
      Alert.alert("Couldn't lock the book", err?.message || "Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = async () => {
    if (busy) return;
    Alert.alert(
      "Keep this book free?",
      "We won't show this prompt again for this book. You can still lock it later from the book editor.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Yes, keep free",
          style: "destructive",
          onPress: async () => {
            try {
              setBusy(true);
              await bookService.dismissBookLockPrompt({ ID: bookId, userId });
              setHidden(true);
              onDismissed?.();
            } catch (err) {
              Alert.alert("Couldn't save", err?.message || "Try again in a moment.");
            } finally {
              setBusy(false);
            }
          },
        },
      ],
      { cancelable: true },
    );
  };

  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: theme.surfaceMuted,
        borderRadius: 12,
        overflow: "hidden",
        marginBottom: 12,
        borderWidth: 1,
        borderColor: theme.borderSubtle ?? theme.surfaceStrong,
      }}
    >
      {/* Left accent stripe — brand purple. Provides at-a-glance
          "this is an actionable notice" affordance without an icon. */}
      <View style={{ width: 4, backgroundColor: theme.primary }} />

      <View style={{ flex: 1, padding: 14 }}>
        <Text style={{ color: theme.text, fontWeight: "700", fontSize: 14 }}>
          This book is currently free
        </Text>
        <Text style={{ color: theme.textSoft, fontSize: 12, marginTop: 4, lineHeight: 18 }}>
          You have other books with a paywall set. If you meant to lock this one too, pick where the
          paywall starts — chapters before that stay free as a teaser.
        </Text>

        <View style={{ marginTop: 10 }}>
          <SegmentedNumberPicker
            values={[5, 6, 7, 8, 9, 10]}
            selected={null}
            onChange={handleLock}
            disabled={busy}
          />
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 10 }}>
          {busy ? (
            <ActivityIndicator size="small" color={theme.textSoft} style={{ marginRight: 8 }} />
          ) : null}
          <TouchableOpacity onPress={handleDismiss} disabled={busy} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={{ color: theme.textSoft, fontSize: 12, textDecorationLine: "underline" }}>
              Already free on purpose? Dismiss
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
};

export default BookLockPromptBanner;
