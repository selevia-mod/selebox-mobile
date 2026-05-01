// lib/users.js — user-lookup dispatcher
//
// Routes between Supabase (lib/users-supabase.js) and Appwrite
// (lib/users-appwrite.js) based on the USE_SUPABASE_USERS flag.
// Same pattern as lib/follows.js — keeps the import path stable so
// the ~10 consumer files don't have to change during the migration.
//
// API:
//   getUserByID({ ID })
//   fetchUsersByQuery(queries)
//   searchUsers(searchQuery)
//   FetchAllCreators(setAllCreators)
//   pingUserActive({ userId })
//   invalidateUserCache(id)
//
// Both backends return Appwrite-shaped user objects ($id, name, avatar,
// etc.) so consumer code doesn't fork.

import { USE_SUPABASE_USERS } from "./feature-flags";
import * as supabaseImpl from "./users-supabase";
import * as appwriteImpl from "./users-appwrite";

const impl = USE_SUPABASE_USERS ? supabaseImpl : appwriteImpl;

export const getUserByID = impl.getUserByID;
export const fetchUsersByQuery = impl.fetchUsersByQuery;
export const searchUsers = impl.searchUsers;
export const FetchAllCreators = impl.FetchAllCreators;
export const pingUserActive = impl.pingUserActive;

// `invalidateUserCache` is the same helper in both files — they both
// re-export from the shared cache module. Either is fine; we prefer
// the Supabase one for consistency with the broader migration.
export const invalidateUserCache = impl.invalidateUserCache;
