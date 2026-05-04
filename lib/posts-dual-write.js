// Posts dual-write helpers — create / update / delete.
//
// USE_SUPABASE_POSTS is currently TRUE: mobile READS posts from
// Supabase, but the legacy createNewPost / updatePost / deletePost in
// lib/posts.js still write to Appwrite only. Without these mirrors,
// mobile-created posts are invisible on the Supabase feed (i.e., on
// the very mobile feed that just created them — and on web).
//
// Best-effort like every other dual-write helper:
//   • Resolution failure (no profile mirror) → skip
//   • Supabase error → log and skip; never throw to the caller
//
// Why a separate file (vs inlining in posts.js):
//   posts.js is the legacy Appwrite-side module. Putting the Supabase
//   client + resolver caches there would create a module-load cycle
//   with posts-supabase.js (which already imports from posts.js for
//   shared adapters). Lazy-loading the Supabase client here breaks the
//   cycle the same way books-dual-write.js does it for books.

let _supabaseClient = null;
const getSupabase = async () => {
  if (_supabaseClient) return _supabaseClient;
  const mod = await import("./supabase");
  _supabaseClient = mod.default;
  return _supabaseClient;
};

const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const _isUuid = (s) => typeof s === "string" && _UUID_RE.test(s);

// hex → uuid resolution cache for profiles. Re-uses the resolver pattern
// from books-dual-write / video-appwrite. We don't share the cache across
// files because each file's lifetime is the same JS module load — no
// duplication concern at the cost of a few extra lookups on the first
// dual-write per session.
const _profileCache = new Map();

const resolveProfileToUuid = async (rawId) => {
  if (!rawId) return null;
  if (_isUuid(rawId)) return rawId;
  if (_profileCache.has(rawId)) return _profileCache.get(rawId);
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.from("profiles").select("id").eq("legacy_appwrite_id", rawId).maybeSingle();
    if (error) {
      console.log("[posts-dual-write] resolve profile failed:", error.message);
      return null;
    }
    const resolved = data?.id || null;
    _profileCache.set(rawId, resolved);
    return resolved;
  } catch (e) {
    console.log("[posts-dual-write] resolve profile threw:", e?.message);
    return null;
  }
};

// Mobile's postUrls is an array of image URIs (only one is ever
// rendered today — the schema enforces a single image per post via
// posts.image_url). Take the first non-empty entry.
const _firstImageUrl = (postUrls) => {
  if (!Array.isArray(postUrls)) return null;
  for (const u of postUrls) {
    if (typeof u === "string" && u.length > 0) return u;
    if (u && typeof u.uri === "string" && u.uri.length > 0) return u.uri;
  }
  return null;
};

// ─── Create ─────────────────────────────────────────────────────────────
// All Supabase writes go through SECURITY DEFINER RPCs because mobile
// authenticates against Appwrite (USE_SUPABASE_AUTH=false), which means
// auth.uid() is null on the Supabase side and every direct insert fails
// the standard `WITH CHECK (auth.uid() = user_id)` RLS check. The RPCs
// trust the resolved actor uuid as a parameter and bypass RLS via
// SECURITY DEFINER. Once USE_SUPABASE_AUTH ships, these can be replaced
// with direct inserts (or kept as a compat shim).
export const dualWritePost = async ({ appwriteDocId, postOwnerAppwriteId, body, postUrls }) => {
  if (!appwriteDocId || !postOwnerAppwriteId) return null;
  const userUuid = await resolveProfileToUuid(postOwnerAppwriteId);
  if (!userUuid) return null;
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc("submit_post", {
      p_actor_id: userUuid,
      p_body: (body || "").trim() || null,
      p_image_url: _firstImageUrl(postUrls),
      p_video_id: null,
      p_book_id: null,
      p_reposted_from: null,
      p_legacy_appwrite_id: appwriteDocId,
    });
    if (error) {
      console.log("[posts-dual-write] submit_post error:", error.message);
      return null;
    }
    return data?.id || null;
  } catch (e) {
    console.log("[posts-dual-write] submit_post threw:", e?.message);
    return null;
  }
};

// ─── Update ─────────────────────────────────────────────────────────────
// Partial update keyed by legacy_appwrite_id. Only forwards the columns
// the caller actually changed; the RPC keeps the rest untouched so we
// don't trample trigger-managed counts or fields web set independently.
export const dualWriteUpdatePost = async ({ appwriteDocId, props = {} }) => {
  if (!appwriteDocId) return;
  // Resolve which fields were actually edited.
  const bodyChanged = "post" in props || "body" in props;
  const imageChanged = "postUrls" in props || "image_url" in props;
  if (!bodyChanged && !imageChanged) return;

  const ownerHex = props.postOwner;
  const userUuid = ownerHex ? await resolveProfileToUuid(ownerHex) : null;
  if (!userUuid) {
    // Without an actor uuid the RPC's _assert_actor_exists would reject.
    // Fall back to legacy_appwrite_id-keyed update via the original
    // shape; the strict RLS will still reject, but we log clearly.
    console.log("[posts-dual-write] updatePost: no actor uuid, skipping (caller didn't pass postOwner)");
    return;
  }

  const newBody = bodyChanged ? ((props.post ?? props.body) || "").trim() : null;
  const newImage = imageChanged
    ? (props.image_url !== undefined ? props.image_url : _firstImageUrl(props.postUrls))
    : null;

  try {
    const sb = await getSupabase();
    const { error } = await sb.rpc("submit_post_update", {
      p_actor_id: userUuid,
      p_legacy_appwrite_id: appwriteDocId,
      p_body: bodyChanged ? newBody : null,
      p_image_url: imageChanged && newImage !== null ? newImage : null,
      // Distinguishes "explicitly clear the image" from "leave alone".
      p_set_image_to_null: imageChanged && (newImage === null || newImage === ""),
    });
    if (error) console.log("[posts-dual-write] submit_post_update error:", error.message);
  } catch (e) {
    console.log("[posts-dual-write] submit_post_update threw:", e?.message);
  }
};

// ─── Delete ─────────────────────────────────────────────────────────────
// RPC enforces ownership via _assert_actor_exists + the in-RPC owner
// check. CASCADE on FKs cleans up children — same semantics web's
// deletePostById uses.
export const dualWriteDeletePost = async ({ appwriteDocId, postOwnerAppwriteId }) => {
  if (!appwriteDocId) return;
  // Caller may not have postOwner handy on every delete site; fall back
  // to looking it up from the post row by legacy_appwrite_id.
  let userUuid = postOwnerAppwriteId ? await resolveProfileToUuid(postOwnerAppwriteId) : null;
  if (!userUuid) {
    try {
      const sb = await getSupabase();
      const { data } = await sb.from("posts").select("user_id").eq("legacy_appwrite_id", appwriteDocId).maybeSingle();
      userUuid = data?.user_id || null;
    } catch (_) {
      /* fall through — RPC will reject if still null */
    }
  }
  if (!userUuid) {
    console.log("[posts-dual-write] deletePost: cannot resolve actor uuid, skipping");
    return;
  }
  try {
    const sb = await getSupabase();
    const { error } = await sb.rpc("submit_post_delete", {
      p_actor_id: userUuid,
      p_legacy_appwrite_id: appwriteDocId,
      p_post_id: null,
    });
    if (error) console.log("[posts-dual-write] submit_post_delete error:", error.message);
  } catch (e) {
    console.log("[posts-dual-write] submit_post_delete threw:", e?.message);
  }
};

// ─── Comments (post + video, unified `comments` table) ─────────────────
// Delete sites pass an Appwrite hex id; we resolve to the comment owner
// via Supabase, hand both to submit_comment_delete (RPC verifies the
// actor matches the row's user_id before deleting).
export const dualWriteDeleteComment = async ({ appwriteDocId, commentOwnerAppwriteId }) => {
  if (!appwriteDocId) return;
  let userUuid = commentOwnerAppwriteId ? await resolveProfileToUuid(commentOwnerAppwriteId) : null;
  if (!userUuid) {
    // Fall back: read the comment owner from Supabase. SELECT is
    // permitted (RLS allows true on SELECT for comments).
    try {
      const sb = await getSupabase();
      const { data } = await sb.from("comments").select("user_id").eq("legacy_appwrite_id", appwriteDocId).maybeSingle();
      userUuid = data?.user_id || null;
    } catch (_) { /* fall through */ }
  }
  if (!userUuid) return;
  try {
    const sb = await getSupabase();
    const { error } = await sb.rpc("submit_comment_delete", {
      p_actor_id: userUuid,
      p_comment_id: null,
      p_legacy_appwrite_id: appwriteDocId,
    });
    if (error) console.log("[posts-dual-write] submit_comment_delete error:", error.message);
  } catch (e) {
    console.log("[posts-dual-write] submit_comment_delete threw:", e?.message);
  }
};

// Bulk variant — N parallel RPC calls. Slightly less efficient than the
// pre-RPC single bulk DELETE, but each call is small + the RPC verifies
// ownership per row, so the safety guarantees compose. For the typical
// case (deleting a parent + a handful of replies) the difference is
// imperceptible.
export const dualWriteDeleteCommentsBulk = async (appwriteDocIds = []) => {
  const ids = (appwriteDocIds || []).filter(Boolean);
  if (ids.length === 0) return;
  await Promise.all(ids.map((id) => dualWriteDeleteComment({ appwriteDocId: id })));
};

// ─── Reactions / Likes ──────────────────────────────────────────────────
// Used by the like-toggle in PostInformation. Web continues to use
// direct inserts under its real Supabase auth session; mobile routes
// through these RPCs because the `WITH CHECK (auth.uid() = user_id)`
// policy on `reactions` rejects every anon insert.
export const dualWriteSubmitReaction = async ({ userAppwriteId, targetType, targetId, emoji }) => {
  if (!userAppwriteId || !targetType || !targetId || !emoji) return;
  const userUuid = await resolveProfileToUuid(userAppwriteId);
  if (!userUuid) return;
  try {
    const sb = await getSupabase();
    const { error } = await sb.rpc("submit_reaction", {
      p_actor_id: userUuid,
      p_target_type: targetType,
      p_target_id: String(targetId),
      p_emoji: emoji,
    });
    if (error) console.log("[posts-dual-write] submit_reaction error:", error.message);
  } catch (e) {
    console.log("[posts-dual-write] submit_reaction threw:", e?.message);
  }
};

export const dualWriteRemoveReaction = async ({ userAppwriteId, targetType, targetId }) => {
  if (!userAppwriteId || !targetType || !targetId) return;
  const userUuid = await resolveProfileToUuid(userAppwriteId);
  if (!userUuid) return;
  try {
    const sb = await getSupabase();
    const { error } = await sb.rpc("submit_unreaction", {
      p_actor_id: userUuid,
      p_target_type: targetType,
      p_target_id: String(targetId),
    });
    if (error) console.log("[posts-dual-write] submit_unreaction error:", error.message);
  } catch (e) {
    console.log("[posts-dual-write] submit_unreaction threw:", e?.message);
  }
};

// ─── Comments — create/reply ────────────────────────────────────────────
// Mirrors mobile post + video comment creates into the unified Supabase
// comments table via RPC. Returns the new Supabase comment UUID so the
// caller can stash it for later parent-id linkage on replies.
export const dualWriteSubmitComment = async ({
  appwriteDocId,
  authorAppwriteId,
  postSupabaseId,
  videoSupabaseId,
  body,
  parentSupabaseId,
}) => {
  if (!authorAppwriteId) return null;
  const userUuid = await resolveProfileToUuid(authorAppwriteId);
  if (!userUuid) return null;
  if (!postSupabaseId && !videoSupabaseId) return null;
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc("submit_comment", {
      p_actor_id: userUuid,
      p_post_id: postSupabaseId || null,
      p_video_id: videoSupabaseId || null,
      p_body: (body || "").trim(),
      p_parent_id: parentSupabaseId || null,
      p_legacy_appwrite_id: appwriteDocId || null,
    });
    if (error) {
      console.log("[posts-dual-write] submit_comment error:", error.message);
      return null;
    }
    return data?.id || null;
  } catch (e) {
    console.log("[posts-dual-write] submit_comment threw:", e?.message);
    return null;
  }
};

// ─── Follows ────────────────────────────────────────────────────────────
// Replaces the would-be `.from('follows').insert()` mobile path. The
// notify_on_follow trigger on follows fires automatically on a successful
// insert, so this also generates the cross-platform follow notification
// without a separate notifyUser call.
export const dualWriteSubmitFollow = async ({ followerAppwriteId, followingAppwriteId }) => {
  if (!followerAppwriteId || !followingAppwriteId) return;
  const [followerUuid, followingUuid] = await Promise.all([
    resolveProfileToUuid(followerAppwriteId),
    resolveProfileToUuid(followingAppwriteId),
  ]);
  if (!followerUuid || !followingUuid) return;
  try {
    const sb = await getSupabase();
    const { error } = await sb.rpc("submit_follow", {
      p_actor_id: followerUuid,
      p_target_id: followingUuid,
    });
    if (error) console.log("[posts-dual-write] submit_follow error:", error.message);
  } catch (e) {
    console.log("[posts-dual-write] submit_follow threw:", e?.message);
  }
};

export const dualWriteSubmitUnfollow = async ({ followerAppwriteId, followingAppwriteId }) => {
  if (!followerAppwriteId || !followingAppwriteId) return;
  const [followerUuid, followingUuid] = await Promise.all([
    resolveProfileToUuid(followerAppwriteId),
    resolveProfileToUuid(followingAppwriteId),
  ]);
  if (!followerUuid || !followingUuid) return;
  try {
    const sb = await getSupabase();
    const { error } = await sb.rpc("submit_unfollow", {
      p_actor_id: followerUuid,
      p_target_id: followingUuid,
    });
    if (error) console.log("[posts-dual-write] submit_unfollow error:", error.message);
  } catch (e) {
    console.log("[posts-dual-write] submit_unfollow threw:", e?.message);
  }
};
