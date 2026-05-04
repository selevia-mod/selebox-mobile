export const SELECTABLE_ROLE_KEYS = {
  creator: "creator",
  writer: "writer",
};

export const ROLE_KEYS = {
  ...SELECTABLE_ROLE_KEYS,
  moderator: "moderator",
  auditor: "auditor",
  user: "user",
};

const PIONEER_ROLE_KEY = "pioneer";
export const PIONEER_ROLE_NAME = "Pioneer";

const ROLE_NAME_BY_KEY = {
  [ROLE_KEYS.creator]: "Creator",
  [ROLE_KEYS.writer]: "Writer",
  [ROLE_KEYS.moderator]: "Moderator",
  [ROLE_KEYS.auditor]: "Auditor",
  [ROLE_KEYS.user]: "User",
};

const ROLE_KEY_BY_NAME = Object.fromEntries(Object.entries(ROLE_NAME_BY_KEY).map(([roleKey, roleName]) => [roleName.toLowerCase(), roleKey]));

// `pillBg` is the solid Facebook-style colored chip background used by
// UserRoleChips. The other fields drive UserRoleBadgeIcons (icon-only
// surfaces) and the legacy chip variant — kept intact so we don't
// regress places that still render with the soft tint.
export const ROLE_BADGE_META = {
  Creator: {
    color: "#D4A017",
    bg: "rgba(212,160,23,0.16)",
    pillBg: "#D4A017", // gold
    lightColor: "#a16207",
    lightBg: "transparent",
    lightBorder: "transparent",
    lightIconBg: "transparent",
    lightIconBorder: "transparent",
    customIcon: "creator",
    badgeCustomIcon: "creator",
  },
  Writer: {
    color: "#70c2ea",
    lightColor: "#1d4ed8",
    bg: "rgba(37,99,235,0.18)",
    pillBg: "#1d4ed8", // blue (blue-700)
    lightBg: "transparent",
    lightBorder: "transparent",
    lightIconBg: "transparent",
    lightIconBorder: "transparent",
    customIcon: "writer",
    badgeCustomIcon: "writer",
  },
  [PIONEER_ROLE_NAME]: {
    color: "#10e8de",
    bg: "rgba(16,232,222,0.18)",
    pillBg: "#0e7490", // dark cyan (cyan-700)
    lightColor: "#0f766e",
    lightBg: "transparent",
    lightBorder: "transparent",
    lightIconBg: "transparent",
    lightIconBorder: "transparent",
    customIcon: "pioneer",
  },
  Moderator: {
    color: "#f43f5e",
    bg: "rgba(244,63,94,0.18)",
    pillBg: "#9f1239", // maroon (rose-800)
  },
  Auditor: { color: "#0ea5e9", bg: "rgba(14,165,233,0.18)", pillBg: "#0369a1" },
  User: { color: "#94a3b8", bg: "rgba(148,163,184,0.15)", pillBg: "#64748b" },
};

const TRANSPARENT = "transparent";

export const getRoleBadgeSurfaceColor = (role, isDarkMode, variant = "chip") => {
  const meta = ROLE_BADGE_META[role] ?? ROLE_BADGE_META.User;

  if (isDarkMode) return meta.bg;

  return variant === "icon" ? (meta.lightIconBg ?? meta.lightBg ?? meta.bg) : (meta.lightBg ?? meta.bg);
};

export const getRoleBadgeBorderColor = (role, isDarkMode, variant = "chip") => {
  if (isDarkMode) return TRANSPARENT;

  const meta = ROLE_BADGE_META[role] ?? ROLE_BADGE_META.User;

  return variant === "icon" ? (meta.lightIconBorder ?? meta.lightBorder ?? TRANSPARENT) : (meta.lightBorder ?? TRANSPARENT);
};

export const getRoleBadgeForegroundColor = (role, isDarkMode) => {
  const meta = ROLE_BADGE_META[role] ?? ROLE_BADGE_META.User;

  return isDarkMode ? meta.color : (meta.lightColor ?? meta.color);
};

// Solid Facebook-style pill background. Used by UserRoleChips so the
// chip itself reads as the role color with white text, instead of the
// soft tint + colored text variant.
export const getRolePillBackgroundColor = (role) => {
  const meta = ROLE_BADGE_META[role] ?? ROLE_BADGE_META.User;
  return meta.pillBg ?? meta.color;
};

// Hydrate the role flags the badge logic expects from a raw Supabase
// `profiles` row. Mirrors the canonical pattern in lib/users-supabase.js
// (hydrateProfileRow): both the legacy single-string `role` column and
// the newer `roles` text[] column are accepted as inputs.
//
// Returns an object you can spread onto any user-shaped adapter so
// `getAssignedRoleKeys` (which checks user.creator / user.moderator /
// user.auditor / user.roles[]) detects the role correctly.
//
// Use this in posts-supabase / comments-supabase / books-supabase
// adapters so postOwner / commentOwner / uploader pick up role flags.
export const expandProfileRoleFlags = (profileRow = {}) => {
  const rolesArray = Array.isArray(profileRow.roles) ? profileRow.roles : [];
  const roleString = typeof profileRow.role === "string" ? profileRow.role : "";
  const has = (key) => rolesArray.includes(key) || roleString === key;
  return {
    creator: has("creator"),
    moderator: has("moderator"),
    auditor: has("auditor"),
    isWriter: has("writer"),
    userPlus: has("pioneer") || Boolean(profileRow.userPlus) || Boolean(profileRow.user_plus),
    roles: rolesArray.length ? rolesArray : roleString ? [roleString] : [],
    role: roleString || (rolesArray[0] ?? "user"),
  };
};

const hasLegacyWriterRole = (user) => Boolean(user?.isWriter) || Boolean(user?.userPlus);
const hasRawRoleName = (roles, roleName) =>
  Array.isArray(roles) && roles.some((value) => typeof value === "string" && value.trim().toLowerCase() === roleName);

export const hasPioneerRole = (user) => Boolean(user?.userPlus) || hasRawRoleName(user?.roles, PIONEER_ROLE_KEY);

export const normalizeRoleKey = (value) => {
  if (typeof value !== "string") return null;

  const normalizedValue = value.trim().toLowerCase();

  return ROLE_NAME_BY_KEY[normalizedValue] ? normalizedValue : (ROLE_KEY_BY_NAME[normalizedValue] ?? null);
};

const appendUniqueRoleKey = (roleKeys, roleKey) => {
  if (!roleKey || roleKeys.includes(roleKey)) return roleKeys;

  roleKeys.push(roleKey);
  return roleKeys;
};

const getNormalizedRoleKeys = (roles) =>
  Array.isArray(roles) ? roles.reduce((acc, value) => appendUniqueRoleKey(acc, normalizeRoleKey(value)), []) : [];

export const appendRoleKey = (roles, roleKey) => {
  const nextRoleKey = normalizeRoleKey(roleKey);
  const nextRoles = getNormalizedRoleKeys(roles);

  return appendUniqueRoleKey(nextRoles, nextRoleKey);
};

export const getAssignedRoleKeys = (user) => {
  const roleKeys = getNormalizedRoleKeys(user?.roles);

  if (user?.creator) appendUniqueRoleKey(roleKeys, ROLE_KEYS.creator);
  if (hasLegacyWriterRole(user)) appendUniqueRoleKey(roleKeys, ROLE_KEYS.writer);
  if (user?.moderator) appendUniqueRoleKey(roleKeys, ROLE_KEYS.moderator);
  if (user?.auditor) appendUniqueRoleKey(roleKeys, ROLE_KEYS.auditor);

  return roleKeys;
};

export const hasRoleKey = (user, roleKey) => getAssignedRoleKeys(user).includes(roleKey);

export const isWriterRoleEnabled = (user) => hasRoleKey(user, ROLE_KEYS.writer);

export const getRoleNames = (user) => {
  const roleKeys = getAssignedRoleKeys(user);
  const roleNames = !roleKeys.length
    ? [ROLE_NAME_BY_KEY[ROLE_KEYS.user]]
    : roleKeys.map((roleKey) => ROLE_NAME_BY_KEY[roleKey] ?? ROLE_NAME_BY_KEY[ROLE_KEYS.user]);

  if (!hasPioneerRole(user)) return roleNames;

  const visibleRoleNames = roleNames.filter(
    (roleName) => roleName !== ROLE_NAME_BY_KEY[ROLE_KEYS.writer] && roleName !== ROLE_NAME_BY_KEY[ROLE_KEYS.user],
  );

  return visibleRoleNames.includes(PIONEER_ROLE_NAME) ? visibleRoleNames : [...visibleRoleNames, PIONEER_ROLE_NAME];
};

// Roles that get a verified-seal badge. Filter on `pillBg` presence —
// every badge-worthy role gets a solid color in ROLE_BADGE_META, while
// the fallback "User" role does not. This replaces the previous filter
// (`iconName || customIcon`) which excluded Moderator + Auditor because
// they never had custom hex/pen/star icons in the legacy badge system,
// even though they SHOULD render with the new scalloped seal.
export const getBadgeRoleNames = (user) =>
  getRoleNames(user).filter((role) => Boolean(ROLE_BADGE_META[role]?.pillBg));

export const getBadgeExpirationDate = (value) => {
  if (!value) return null;

  const expiration = new Date(value);
  if (Number.isNaN(expiration.getTime())) return null;

  return expiration;
};

export const hasActiveSelectedRole = (user, now = new Date()) => {
  const hasSelectableRole = hasRoleKey(user, SELECTABLE_ROLE_KEYS.creator) || hasRoleKey(user, SELECTABLE_ROLE_KEYS.writer);
  if (!hasSelectableRole) return false;

  const expiration = getBadgeExpirationDate(user?.badgeExpiration);
  if (!expiration) return true;

  return expiration.getTime() > now.getTime();
};

export const getActiveSelectedRoleKey = (user, now = new Date()) => {
  if (!hasActiveSelectedRole(user, now)) return null;

  const assignedRoleKeys = getAssignedRoleKeys(user);

  if (assignedRoleKeys.includes(SELECTABLE_ROLE_KEYS.creator)) return SELECTABLE_ROLE_KEYS.creator;
  if (assignedRoleKeys.includes(SELECTABLE_ROLE_KEYS.writer)) return SELECTABLE_ROLE_KEYS.writer;

  return null;
};
