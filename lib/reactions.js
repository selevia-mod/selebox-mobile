// Reactions config — mirrors web's REACTIONS export in /Selebox/supabase.js so
// mobile and web stay aligned. Order is significant: it determines picker
// layout and the canonical emoji-summary order in the stats row.
export const REACTIONS = [
  { key: "heart", emoji: "❤️", label: "Love" },
  { key: "laugh", emoji: "😂", label: "Haha" },
  { key: "sad", emoji: "😢", label: "Sad" },
  { key: "cry", emoji: "😭", label: "Cry" },
  { key: "angry", emoji: "😡", label: "Angry" },
];

export const DEFAULT_REACTION_KEY = "heart";

export const getReactionByKey = (key) => REACTIONS.find((r) => r.key === key) || null;
