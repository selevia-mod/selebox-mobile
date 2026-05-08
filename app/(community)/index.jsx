// app/(community)/index.jsx — Phase 1: Your Community tab
//
// Owner-side surface only. Other tabs (Joined / Discover) ship in V2.
// On mount we call getMyCommunity(); the result branches the render
// into one of three states:
//
//   • Owner — has a community → full owner UI (header + support bar +
//     composer + feed + likes/comments).
//   • Non-owner — no community row exists → "Become a creator to start
//     your community" empty state with CTA back to profile.
//   • Loading — skeleton.
//
// State management is intentionally inline — feature is brand new and
// the surface is contained. If we add Joined/Discover tabs we can lift
// shared state to a context provider.

import { Feather, MaterialIcons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import AnimatedSkeleton from "../../components/AnimatedSkeleton";
import ReactionPicker from "../../components/ReactionPicker";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import {
  createCommunityPost,
  deleteCommunityPost,
  getCachedFirstFeedPage,
  getCachedMyCommunity,
  getCommunityFeed,
  getMyCommunity,
  reactToCommunityPost,
  unreactFromCommunityPost,
  updateMyCommunity,
} from "../../lib/communities";
import { DEFAULT_REACTION_KEY, getReactionByKey } from "../../lib/reactions";

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

const timeAgo = (iso) => {
  if (!iso) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
};

// ─────────────────────────────────────────────────────────────────────
// Header — community avatar, name (with rename), subscriber count
// ─────────────────────────────────────────────────────────────────────

const CommunityHeader = ({ community, owner, onRename, theme }) => {
  // Tightened padding: bottom pad only (top pad lives on ScreenHeader),
  // small horizontal pad so content doesn't kiss the edges. Avatar
  // bumped from 56 to 64 for more visual weight.
  return (
    <View className="px-3 pb-3">
      <View className="flex-row items-center">
        {owner?.avatar ? (
          <Image
            source={{ uri: owner.avatar }}
            className="h-16 w-16 rounded-2xl"
            style={{ backgroundColor: theme.surfaceMuted }}
            resizeMode="cover"
          />
        ) : (
          <View
            className="h-16 w-16 items-center justify-center rounded-2xl"
            style={{ backgroundColor: theme.primary }}
          >
            <Text className="text-2xl font-bold" style={{ color: theme.primaryContrast }}>
              {(owner?.username || "S").charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
        <View className="ml-3 flex-1" style={{ minWidth: 0 }}>
          <Pressable onPress={onRename} className="flex-row items-center">
            <Text
              className="flex-1 text-[19px] font-bold"
              style={{ color: theme.text }}
              numberOfLines={2}
            >
              {community.name}
            </Text>
            <Feather name="edit-2" size={16} color={theme.iconMuted} style={{ marginLeft: 6 }} />
          </Pressable>
          <Text className="mt-0.5 text-xs" style={{ color: theme.textSoft }} numberOfLines={1}>
            {community.subscriber_count ?? 0} subscriber{community.subscriber_count === 1 ? "" : "s"} · {community.post_count ?? 0} post
            {community.post_count === 1 ? "" : "s"}
          </Text>
        </View>
      </View>
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Support Bar — placeholder until V2 (full editor sheet)
// ─────────────────────────────────────────────────────────────────────

const SupportBar = ({ supportBar, theme }) => {
  // V1: simple text-only support bar OR empty placeholder.
  // V2 will get a full editor with type=promo|book|video|tip_jar variants.
  // Tightened: smaller margin (mx-3 instead of mx-4), shorter empty
  // pad (py-6 instead of py-10) so the placeholder doesn't dominate
  // the page on first launch.
  if (!supportBar) {
    return (
      <View
        className="mx-3 mb-3 items-center justify-center rounded-2xl py-6"
        style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border, borderStyle: "dashed" }}
      >
        <View
          className="mb-2 h-9 w-9 items-center justify-center rounded-full"
          style={{ backgroundColor: theme.surfaceStrong }}
        >
          <Feather name="plus" size={20} color={theme.iconMuted} />
        </View>
        <Text className="text-sm" style={{ color: theme.textSoft }}>
          Edit your "support bar" here
        </Text>
      </View>
    );
  }
  return (
    <View
      className="mx-3 mb-3 rounded-2xl p-4"
      style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
    >
      <Text className="font-semibold" style={{ color: theme.text }}>
        {supportBar.text || "Support"}
      </Text>
      {supportBar.cta ? (
        <Text className="mt-1 text-sm" style={{ color: theme.primary }}>
          {supportBar.cta}
        </Text>
      ) : null}
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Composer — owner posts text (image picker comes in next iteration)
// ─────────────────────────────────────────────────────────────────────

const Composer = ({ owner, communityId, onPosted, theme }) => {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef(null);

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      const post = await createCommunityPost({ communityId, body: trimmed });
      setBody("");
      inputRef.current?.blur();
      onPosted?.(post);
    } catch (err) {
      Alert.alert("Couldn't post", err?.message || "Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View
      // Tightened: mx-3 instead of mx-4, softened border to theme.border
      // (was loud purple). The composer is plenty discoverable without
      // the heavy outline.
      className="mx-3 mb-3 rounded-2xl p-3"
      style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
    >
      <View className="flex-row items-start">
        {owner?.avatar ? (
          <Image
            source={{ uri: owner.avatar }}
            className="h-10 w-10 rounded-full"
            style={{ backgroundColor: theme.surfaceMuted }}
          />
        ) : (
          <View
            className="h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.primary }}
          >
            <Text className="font-bold" style={{ color: theme.primaryContrast }}>
              {(owner?.username || "S").charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
        <View className="ml-2 flex-1" style={{ minWidth: 0 }}>
          <TextInput
            ref={inputRef}
            value={body}
            onChangeText={setBody}
            placeholder="Share something with your fans…"
            placeholderTextColor={theme.textSoft}
            multiline
            maxLength={2000}
            style={{
              minHeight: 36,
              maxHeight: 140,
              color: theme.text,
              fontSize: 14,
              paddingTop: 8,
            }}
          />
          {body.length > 0 ? (
            <View className="mt-2 flex-row items-center justify-between">
              <Text className="text-xs" style={{ color: theme.textSoft }}>
                {body.length} / 2000
              </Text>
              <TouchableOpacity
                onPress={submit}
                disabled={submitting || !body.trim()}
                className="rounded-full px-4 py-2"
                style={{
                  backgroundColor: body.trim() ? theme.primary : theme.surfaceMuted,
                  opacity: submitting ? 0.6 : 1,
                }}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color={theme.primaryContrast} />
                ) : (
                  <Text className="text-sm font-semibold" style={{ color: body.trim() ? theme.primaryContrast : theme.textSoft }}>
                    Post
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Post Card — body + images + like/comment/share row
// ─────────────────────────────────────────────────────────────────────

const PostCard = ({ post, owner, isOwner, onDelete, theme }) => {
  // FB-style reaction state: optimisticReaction is the user's current
  // reaction key (heart|laugh|sad|cry|angry) or null if they haven't
  // reacted. The like-row count covers the whole reaction set.
  const [optimisticReaction, setOptimisticReaction] = useState(post.my_reaction || null);
  const [optimisticLikeCount, setOptimisticLikeCount] = useState(post.likes_count || 0);

  // Reaction picker state — anchored to the like button. The button's
  // onLayout populates the anchor coords; long-press shows the picker.
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState(null);
  const likeBtnRef = useRef(null);

  // Sync if the parent prop changes (e.g. cache refresh / new feed page).
  useEffect(() => {
    setOptimisticReaction(post.my_reaction || null);
    setOptimisticLikeCount(post.likes_count || 0);
  }, [post.id, post.my_reaction, post.likes_count]);

  // Tap behavior — toggle the current reaction off, or default to
  // 'heart' if nothing is selected. Same as Facebook / Instagram:
  // tap is the fast path for the most-common case.
  const handleLikeTap = async () => {
    if (optimisticReaction) {
      // Already reacted → clear. Optimistic count -1.
      const prev = optimisticReaction;
      setOptimisticReaction(null);
      setOptimisticLikeCount((n) => Math.max(0, n - 1));
      try {
        await unreactFromCommunityPost(post.id);
      } catch (err) {
        setOptimisticReaction(prev);
        setOptimisticLikeCount((n) => n + 1);
      }
    } else {
      // No reaction → set default heart. Optimistic count +1.
      setOptimisticReaction(DEFAULT_REACTION_KEY);
      setOptimisticLikeCount((n) => n + 1);
      try {
        await reactToCommunityPost(post.id, DEFAULT_REACTION_KEY);
      } catch (err) {
        setOptimisticReaction(null);
        setOptimisticLikeCount((n) => Math.max(0, n - 1));
      }
    }
  };

  // Long-press → reaction picker. Measure the button position so
  // the picker pill anchors above it. measureInWindow gives screen-
  // space coords which is what ReactionPicker expects.
  const handleLikeLongPress = () => {
    likeBtnRef.current?.measureInWindow?.((x, y, width) => {
      setPickerAnchor({ x, y, width });
      setPickerVisible(true);
    });
  };

  // Picker chose a reaction → upsert (insert or swap). Count only
  // changes on the no-reaction → has-reaction transition; swapping
  // between reactions keeps the count flat.
  const handlePickReaction = async (reactionKey) => {
    const prev = optimisticReaction;
    setOptimisticReaction(reactionKey);
    if (!prev) setOptimisticLikeCount((n) => n + 1);
    try {
      await reactToCommunityPost(post.id, reactionKey);
    } catch (err) {
      setOptimisticReaction(prev);
      if (!prev) setOptimisticLikeCount((n) => Math.max(0, n - 1));
    }
  };

  // Resolved reaction descriptor (or default heart for the fallback
  // grey/outline state). reactionMeta gives the emoji + accent color.
  const reactionMeta = optimisticReaction ? getReactionByKey(optimisticReaction) : null;

  const handleMenu = () => {
    if (!isOwner) return;
    Alert.alert("Post options", null, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          Alert.alert("Delete post?", "This can't be undone.", [
            { text: "Cancel", style: "cancel" },
            {
              text: "Delete",
              style: "destructive",
              onPress: async () => {
                try {
                  await deleteCommunityPost(post.id);
                  onDelete?.(post.id);
                } catch (err) {
                  Alert.alert("Couldn't delete", err?.message || "Please try again.");
                }
              },
            },
          ]);
        },
      },
    ]);
  };

  return (
    <View
      className="mx-3 mb-3 rounded-2xl p-3"
      style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}
    >
      <View className="flex-row items-center">
        {post.author?.avatar ? (
          <Image
            source={{ uri: post.author.avatar }}
            className="h-9 w-9 rounded-full"
            style={{ backgroundColor: theme.surfaceMuted }}
          />
        ) : (
          <View
            className="h-9 w-9 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.primary }}
          >
            <Text className="text-xs font-bold" style={{ color: theme.primaryContrast }}>
              {(post.author?.username || "S").charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
        <View className="ml-2 flex-1" style={{ minWidth: 0 }}>
          <Text className="text-sm font-semibold" style={{ color: theme.text }} numberOfLines={1}>
            {post.author?.username || "Unknown"}
          </Text>
          <Text className="text-xs" style={{ color: theme.textSoft }}>
            {timeAgo(post.created_at)}
          </Text>
        </View>
        {isOwner ? (
          <TouchableOpacity onPress={handleMenu} hitSlop={8} className="px-2">
            <Feather name="more-horizontal" size={20} color={theme.iconMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {post.body ? (
        <Text className="mt-2 text-[15px]" style={{ color: theme.text, lineHeight: 22 }}>
          {post.body}
        </Text>
      ) : null}

      {post.image_urls?.length > 0 ? (
        <View className="mt-2">
          {post.image_urls.map((uri, idx) => (
            <Image
              key={`${post.id}-img-${idx}`}
              source={{ uri }}
              className="mt-1 w-full rounded-xl"
              style={{ aspectRatio: 4 / 3, backgroundColor: theme.surfaceMuted }}
              resizeMode="cover"
            />
          ))}
        </View>
      ) : null}

      <View className="mt-3 flex-row items-center justify-between border-t pt-3" style={{ borderTopColor: theme.border }}>
        {/* Reaction button — long-press opens the 5-emoji picker;
            tap toggles the current reaction (defaults to heart for
            the no-reaction case). When the user has reacted we show
            the actual emoji + the reaction's label tinted in its
            accent color so the row reads like FB Lite. */}
        <TouchableOpacity
          ref={likeBtnRef}
          onPress={handleLikeTap}
          onLongPress={handleLikeLongPress}
          delayLongPress={220}
          className="flex-row items-center"
          hitSlop={6}
        >
          {reactionMeta ? (
            <Text style={{ fontSize: 18, lineHeight: 22 }}>{reactionMeta.emoji}</Text>
          ) : (
            <MaterialIcons name="favorite-border" size={20} color={theme.iconMuted} />
          )}
          <Text
            className="ml-1 text-sm font-semibold"
            style={{ color: reactionMeta ? theme.text : theme.textSoft }}
          >
            {optimisticLikeCount > 0 ? optimisticLikeCount : reactionMeta ? reactionMeta.label : "Like"}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Alert.alert("Comments", "Comments thread coming next.")} className="flex-row items-center" hitSlop={6}>
          <Feather name="message-circle" size={20} color={theme.iconMuted} />
          <Text className="ml-1 text-sm" style={{ color: theme.textSoft }}>
            {post.comments_count > 0 ? post.comments_count : "Comment"}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity className="flex-row items-center" hitSlop={6}>
          <Feather name="share-2" size={20} color={theme.iconMuted} />
          <Text className="ml-1 text-sm" style={{ color: theme.textSoft }}>
            Share
          </Text>
        </TouchableOpacity>
      </View>

      {/* Floating 5-emoji reaction picker. Mounts as a Modal so it
          floats above the FlatList without clipping; closes on
          backdrop tap or after a selection lands. */}
      <ReactionPicker
        visible={pickerVisible}
        anchor={pickerAnchor}
        activeKey={optimisticReaction}
        onSelect={handlePickReaction}
        onClose={() => setPickerVisible(false)}
      />
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Empty / non-owner state — caller has no community of their own
// ─────────────────────────────────────────────────────────────────────

const NoCommunityState = ({ theme }) => (
  <View className="flex-1 items-center justify-center px-8">
    <View className="mb-4 h-16 w-16 items-center justify-center rounded-full" style={{ backgroundColor: theme.surfaceMuted }}>
      <Feather name="users" size={32} color={theme.iconMuted} />
    </View>
    <Text className="text-center text-lg font-bold" style={{ color: theme.text }}>
      Your Community is locked
    </Text>
    <Text className="mt-2 text-center text-sm" style={{ color: theme.textSoft }}>
      Become a Creator or Writer to unlock your own Fans Club — a dedicated space to post for your readers and supporters.
    </Text>
    <TouchableOpacity
      onPress={() => router.push("/edit-profile")}
      className="mt-6 rounded-full px-6 py-3"
      style={{ backgroundColor: theme.primary }}
    >
      <Text className="font-semibold" style={{ color: theme.primaryContrast }}>
        Become a Creator
      </Text>
    </TouchableOpacity>
  </View>
);

// ─────────────────────────────────────────────────────────────────────
// Main screen
// ─────────────────────────────────────────────────────────────────────

const CommunityScreen = () => {
  const { theme } = useAppTheme();
  const { user } = useGlobalContext();

  // SWR-style initial state — synchronously seed from the in-memory
  // caches so re-entry within TTL paints data on the first frame
  // (no skeleton flash). When the cache is cold (first ever entry,
  // or after >60s away), `cachedCommunity` is null and we fall back
  // to the loading=true path below.
  //
  // Pattern proven on the moments viewer (task #161) and matches what
  // home / books / profile already do via Redux Persist.
  const cachedCommunity = useState(() => getCachedMyCommunity())[0];
  const cachedFeedPage = useState(() => (cachedCommunity ? getCachedFirstFeedPage(cachedCommunity.id) : null))[0];

  const [community, setCommunity] = useState(cachedCommunity);
  // Only show the full skeleton when we genuinely have nothing to
  // paint. With cache hit we go straight to the real layout and the
  // background refetch updates state in place.
  const [loading, setLoading] = useState(!cachedCommunity);
  const [feed, setFeed] = useState(cachedFeedPage?.documents || []);
  const [feedLoading, setFeedLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(cachedFeedPage?.hasMore ?? true);
  const [cursor, setCursor] = useState(cachedFeedPage?.nextCursor || null);
  const [loadingMore, setLoadingMore] = useState(false);

  const owner = user || null;
  const isOwner = community && owner && community.owner_id === owner.$id;

  // `force` defaults to false now — let the 60s TTL cache absorb
  // rapid re-entries (drawer round-trip, sub-screen pop, etc.). Pass
  // force:true only on explicit pull-to-refresh.
  const loadCommunity = useCallback(async ({ silent = false, force = false } = {}) => {
    // Don't paint a skeleton if we already have something rendered —
    // the user shouldn't see the screen blink to grey on a routine
    // background refresh.
    if (!silent && !community) setLoading(true);
    try {
      const c = await getMyCommunity({ force });
      setCommunity(c);
      if (c) await loadFeed(c.id, { reset: true, silent: !!community });
    } catch (err) {
      console.warn("[community] load error", err?.message);
      Alert.alert("Couldn't load your community", err?.message || "Please try again.");
    } finally {
      setLoading(false);
    }
  }, [community]);

  // `silent` skips the skeleton on the feed too — used when we already
  // have cached posts on screen and just want to backfill quietly.
  const loadFeed = useCallback(async (communityId, { reset = false, silent = false } = {}) => {
    if (!communityId) return;
    if (reset && !silent) setFeedLoading(true);
    try {
      const res = await getCommunityFeed({
        communityId,
        cursor: reset ? null : cursor,
        limit: PAGE_SIZE,
      });
      setFeed((prev) => (reset ? res.documents : [...prev, ...res.documents]));
      setHasMore(res.hasMore);
      setCursor(res.nextCursor);
    } catch (err) {
      console.warn("[community] feed error", err?.message);
    } finally {
      setFeedLoading(false);
    }
  }, [cursor]);

  const onRefresh = async () => {
    // Pull-to-refresh = explicit user intent for fresh data; bypass
    // the cache here. The `silent: true` keeps the page quiet (no
    // skeleton flash) — the RefreshControl's spinner is feedback
    // enough.
    setRefreshing(true);
    try {
      await loadCommunity({ silent: true, force: true });
    } finally {
      setRefreshing(false);
    }
  };

  const loadMore = async () => {
    if (loadingMore || !hasMore || !community) return;
    setLoadingMore(true);
    try {
      await loadFeed(community.id);
    } finally {
      setLoadingMore(false);
    }
  };

  // Initial load + refresh on focus.
  useFocusEffect(
    useCallback(() => {
      loadCommunity();
    }, [loadCommunity])
  );

  // Inline rename via Alert.prompt-style flow.
  const handleRename = () => {
    if (!isOwner) return;
    if (Platform.OS === "ios") {
      Alert.prompt(
        "Rename community",
        "Choose a new name (3-60 characters)",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Save",
            onPress: async (text) => {
              const trimmed = (text || "").trim();
              if (trimmed.length < 3 || trimmed.length > 60) {
                Alert.alert("Invalid name", "Use 3-60 characters.");
                return;
              }
              try {
                const updated = await updateMyCommunity({ name: trimmed });
                setCommunity(updated);
              } catch (err) {
                Alert.alert("Couldn't rename", err?.message || "Please try again.");
              }
            },
          },
        ],
        "plain-text",
        community?.name || ""
      );
    } else {
      // Android Alert.prompt isn't supported — push to a future inline
      // rename modal. For now, show a hint.
      Alert.alert("Rename", "Inline rename coming next on Android. iOS users can long-press the name to rename.");
    }
  };

  const handlePosted = (newPost) => {
    // Optimistic prepend — refetch to pick up server-side hydration
    // (author info, counter triggers).
    setFeed((prev) => [
      {
        ...newPost,
        author: { $id: owner?.$id, id: owner?.$id, username: owner?.username, avatar: owner?.avatar },
        i_liked: false,
        likes_count: 0,
        comments_count: 0,
      },
      ...prev,
    ]);
    if (community) {
      setCommunity({ ...community, post_count: (community.post_count || 0) + 1 });
    }
  };

  const handleDeletePost = (postId) => {
    setFeed((prev) => prev.filter((p) => p.id !== postId));
    if (community) {
      setCommunity({ ...community, post_count: Math.max(0, (community.post_count || 0) - 1) });
    }
  };

  // ─── Render branches ──────────────────────────────────────────────

  // Note: we use plain SafeAreaView instead of StyledSafeAreaView here.
  // StyledSafeAreaView has `items-center justify-center` baked in,
  // which pins content to the screen's middle and shrinks width to
  // content's intrinsic size — breaks any full-bleed feed layout.
  // Same fix the story editor used (task #89). The community screen
  // needs full vertical and horizontal stretch.
  const safeAreaStyle = { flex: 1, width: "100%", backgroundColor: theme.background };

  if (loading) {
    return (
      <SafeAreaView style={safeAreaStyle}>
        <View className="px-4 pt-4">
          <View className="flex-row items-center">
            <AnimatedSkeleton style={{ width: 64, height: 64, borderRadius: 16 }} />
            <View className="ml-3 flex-1">
              <AnimatedSkeleton style={{ width: "60%", height: 18, borderRadius: 8 }} />
              <AnimatedSkeleton className="mt-2" style={{ width: "40%", height: 12, borderRadius: 6 }} />
            </View>
          </View>
          <AnimatedSkeleton className="mt-6" style={{ width: "100%", height: 100, borderRadius: 16 }} />
          <AnimatedSkeleton className="mt-4" style={{ width: "100%", height: 70, borderRadius: 16 }} />
          <AnimatedSkeleton className="mt-4" style={{ width: "100%", height: 200, borderRadius: 16 }} />
        </View>
      </SafeAreaView>
    );
  }

  if (!community) {
    return (
      <SafeAreaView style={safeAreaStyle}>
        <ScreenHeader title="Community" theme={theme} />
        <NoCommunityState theme={theme} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={safeAreaStyle}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScreenHeader title="Community" theme={theme} />

        <FlatList
          data={feed}
          keyExtractor={(item) => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />
          }
          onEndReachedThreshold={0.5}
          onEndReached={loadMore}
          ListHeaderComponent={
            <>
              <CommunityHeader community={community} owner={owner} onRename={handleRename} theme={theme} />
              <SupportBar supportBar={community.support_bar} theme={theme} />
              {isOwner ? (
                <Composer
                  owner={owner}
                  communityId={community.id}
                  onPosted={handlePosted}
                  theme={theme}
                />
              ) : null}
            </>
          }
          renderItem={({ item }) => (
            <PostCard
              post={item}
              owner={owner}
              isOwner={isOwner}
              onDelete={handleDeletePost}
              theme={theme}
            />
          )}
          ListEmptyComponent={
            !feedLoading && feed.length === 0 ? (
              <View className="items-center justify-center px-8 py-16">
                <View className="mb-3 h-12 w-12 items-center justify-center rounded-full" style={{ backgroundColor: theme.surfaceMuted }}>
                  <Feather name="message-square" size={22} color={theme.iconMuted} />
                </View>
                <Text className="text-center font-semibold" style={{ color: theme.text }}>
                  No posts yet
                </Text>
                <Text className="mt-1 text-center text-sm" style={{ color: theme.textSoft }}>
                  Share your first update with your fans above.
                </Text>
              </View>
            ) : null
          }
          ListFooterComponent={
            loadingMore ? (
              <View className="py-6">
                <ActivityIndicator size="small" color={theme.primary} />
              </View>
            ) : null
          }
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Reusable header bar
// ─────────────────────────────────────────────────────────────────────

const ScreenHeader = ({ title, theme }) => (
  // Zero vertical padding — back chip flush with safe-area edge.
  // Walked down from py-3 → py-2 → py-1 → py-0 per Charles. The 40pt
  // height of the back chip itself still gives us a sane tap target
  // and visual rhythm; no extra padding needed above or below.
  <View className="flex-row items-center px-4">
    <TouchableOpacity
      onPress={() => router.back()}
      className="mr-3 h-10 w-10 items-center justify-center rounded-full"
      style={{ backgroundColor: theme.surfaceMuted }}
    >
      <MaterialIcons name="arrow-back" size={22} color={theme.icon} />
    </TouchableOpacity>
    <Text className="text-lg font-bold" style={{ color: theme.text }}>
      {title}
    </Text>
  </View>
);

export default CommunityScreen;
