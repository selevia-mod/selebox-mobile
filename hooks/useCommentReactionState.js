import { useCallback, useRef, useState } from "react";
import { DEFAULT_REACTION_KEY, getReactionByKey } from "../lib/reactions";

// Shared state + handlers for the comment reaction picker — wires up the
// floating <ReactionPicker> to a comment item and its replies.
//
// Backend wiring lives in the consumer (the actual like/unlike server call is
// triggered from the consumer's existing handler when toggleTopLevelDefault is
// called and reaction state transitions in/out of "reacted"). Reply reactions
// are pure visual state for now — they'll persist when Phase 5 of the
// Supabase migration brings the proper `reactions` table.
//
// Usage:
//   const reactions = useCommentReactionState({ initialLiked });
//
//   <TouchableOpacity
//     ref={reactions.likeButtonRef}
//     onPress={() => { reactions.toggleTopLevelDefault(); existingLikeHandler(); }}
//     onLongPress={reactions.openTopLevelPicker}
//     delayLongPress={220}
//   >
//     {reactions.activeReaction
//       ? <Text>{reactions.activeReaction.emoji}</Text>
//       : <HeartOutline />}
//   </TouchableOpacity>
//
//   {replies.map((reply) => (
//     <TouchableOpacity
//       ref={(el) => reactions.registerReplyButton(reply.$id, el)}
//       onPress={() => reactions.toggleReplyDefault(reply.$id)}
//       onLongPress={() => reactions.openReplyPicker(reply.$id)}
//       delayLongPress={220}
//     >
//       {reactions.getReplyReaction(reply.$id)?.emoji ?? "React"}
//     </TouchableOpacity>
//   ))}
//
//   <ReactionPicker
//     visible={reactions.pickerVisible}
//     anchor={reactions.pickerAnchor}
//     activeKey={reactions.pickerActiveKey}
//     onSelect={reactions.handlePickReaction}
//     onClose={reactions.closePicker}
//   />
const useCommentReactionState = ({ initialLiked = false } = {}) => {
  const [userReactionKey, setUserReactionKey] = useState(initialLiked ? DEFAULT_REACTION_KEY : null);
  const [replyReactions, setReplyReactions] = useState({}); // { [replyId]: reactionKey }
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState(null);
  const [pickerTargetId, setPickerTargetId] = useState(null); // null = top-level, else replyId

  const likeButtonRef = useRef(null);
  const replyButtonRefsMap = useRef(new Map());

  const registerReplyButton = useCallback((replyId, el) => {
    if (!replyId) return;
    if (el) replyButtonRefsMap.current.set(replyId, el);
    else replyButtonRefsMap.current.delete(replyId);
  }, []);

  const openTopLevelPicker = useCallback(() => {
    likeButtonRef.current?.measureInWindow?.((x, y, width, height) => {
      setPickerAnchor({ x, y, width, height });
      setPickerTargetId(null);
      setPickerVisible(true);
    });
  }, []);

  const openReplyPicker = useCallback((replyId) => {
    if (!replyId) return;
    const ref = replyButtonRefsMap.current.get(replyId);
    ref?.measureInWindow?.((x, y, width, height) => {
      setPickerAnchor({ x, y, width, height });
      setPickerTargetId(replyId);
      setPickerVisible(true);
    });
  }, []);

  const toggleTopLevelDefault = useCallback(() => {
    setUserReactionKey((prev) => (prev ? null : DEFAULT_REACTION_KEY));
  }, []);

  const toggleReplyDefault = useCallback((replyId) => {
    if (!replyId) return;
    setReplyReactions((prev) => {
      const next = { ...prev };
      if (next[replyId]) delete next[replyId];
      else next[replyId] = DEFAULT_REACTION_KEY;
      return next;
    });
  }, []);

  const handlePickReaction = useCallback(
    (key) => {
      if (pickerTargetId === null) {
        setUserReactionKey(key);
      } else {
        setReplyReactions((prev) => ({ ...prev, [pickerTargetId]: key }));
      }
    },
    [pickerTargetId],
  );

  const closePicker = useCallback(() => setPickerVisible(false), []);

  const getReplyReaction = useCallback(
    (replyId) => {
      const key = replyReactions[replyId];
      return key ? getReactionByKey(key) : null;
    },
    [replyReactions],
  );

  const activeReaction = userReactionKey ? getReactionByKey(userReactionKey) : null;
  const pickerActiveKey = pickerTargetId === null ? userReactionKey : replyReactions[pickerTargetId] ?? null;

  return {
    // State
    userReactionKey,
    setUserReactionKey,
    activeReaction,
    pickerVisible,
    pickerAnchor,
    pickerActiveKey,
    pickerTargetId,
    isPickerForTopLevel: pickerTargetId === null,
    // Refs
    likeButtonRef,
    registerReplyButton,
    // Handlers
    openTopLevelPicker,
    openReplyPicker,
    toggleTopLevelDefault,
    toggleReplyDefault,
    handlePickReaction,
    closePicker,
    getReplyReaction,
  };
};

export default useCommentReactionState;
