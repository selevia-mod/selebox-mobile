export const ContentType = {
  book: "book",
  clip: "clip",
  video: "video",
  post: "post",
};

export const EarningType = {
  stars: "stars",
  coins: "coins",
};

export const Modules = {
  chats: "chats",
};

// Phase D: chat moved off Stream Chat onto the Supabase-native system. No
// modules currently in maintenance. The maintenance gate stays here as a
// general-purpose tool — wire `Modules.<thing>` back in if any feature
// area needs to be temporarily curtained off in a future OTA.
export const MaintenanceModules = [];
