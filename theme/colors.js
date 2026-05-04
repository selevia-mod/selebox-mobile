export const THEME_MODES = {
  dark: "dark",
  light: "light",
};

export const DEFAULT_THEME_MODE = THEME_MODES.light;

const sharedColors = {
  // Primary — Selebox violet (matches selebox.com)
  primary: "#8b5cf6", // violet-500
  primaryStrong: "#7c3aed", // violet-600 — pressed/active
  primaryDark: "#5b21b6", // violet-800
  primaryDeepest: "#4c1d95", // violet-900 — gradient end
  primaryLight: "#a78bfa", // violet-400
  primaryLightest: "#c4b5fd", // violet-300
  primarySoft: "rgba(139,92,246,0.16)",
  primaryContrast: "#ffffff",

  // Accents
  accentPink: "#ec4899", // matches web --pink
  accentPurple: "#8b5cf6", // alias of primary — used by section pills, selected-state borders, story bar accents
  accentPurpleSoft: "rgba(139,92,246,0.16)",
  accentBlue: "#3ec5ff",
  accentBlueSoft: "rgba(62,197,255,0.16)",
  // Dedicated, eye-friendly color for @username mentions inside comment
  // bodies. The previous design used accentBlue (bright cyan) which read
  // as harsh against the lavender comment-card background. A muted
  // brand-aligned purple is calmer, on-brand, and still clearly
  // hyperlink-y. Lives here so all comment surfaces (posts, videos,
  // books, chapters, inline) render mentions consistently.
  mention: "#6e5fbe",
  mentionSoft: "rgba(110,95,190,0.14)",
  accentGreen: "#22c55e",
  accentGreenSoft: "rgba(34,197,94,0.16)",
  accentTeal: "#14b8a6",
  accentTealSoft: "rgba(20,184,166,0.16)",
  accentAmber: "#fbbf24", // matches web --accent (coins)
  accentAmberSoft: "rgba(251,191,36,0.16)",

  // Semantic
  danger: "#ef4444", // matches web --red
  dangerSoft: "rgba(239,68,68,0.16)",
  like: "#ff4d6d",
  likeSoft: "rgba(255,77,109,0.18)",
  comment: "#3ec5ff",
  commentSoft: "rgba(62,197,255,0.18)",
  coin: "#fbbf24",
  offlineBg: "rgba(239,68,68,0.12)",
  offlineBorder: "rgba(239,68,68,0.25)",
  offlineIcon: "#fca5a5",
};

export const themeColors = {
  // Dark mode — YouTube-inspired neutrals + Selebox violet accent
  [THEME_MODES.dark]: {
    mode: THEME_MODES.dark,
    isDark: true,
    ...sharedColors,
    background: "#0f0f0f", // YouTube page bg
    backgroundMuted: "#181818",
    surface: "#1f1f1f", // cards
    surfaceElevated: "#272727", // popovers / modals
    surfaceMuted: "rgba(255,255,255,0.04)",
    surfaceStrong: "#3a3a3a", // pressed
    card: "#1f1f1f",
    cardStrong: "#272727",
    border: "rgba(255,255,255,0.08)",
    borderStrong: "rgba(255,255,255,0.14)",
    divider: "rgba(255,255,255,0.08)",
    text: "#f1f1f1",
    textMuted: "#aaaaaa",
    textSoft: "rgba(255,255,255,0.56)",
    textSubtle: "rgba(255,255,255,0.4)",
    textInverse: "#0f0f0f",
    icon: "#f1f1f1",
    iconMuted: "#aaaaaa",
    placeholder: "#717171",
    inputBackground: "#272727",
    inputBorder: "rgba(255,255,255,0.12)",
    inputText: "#f1f1f1",
    searchBackground: "#121212",
    searchBorder: "rgba(255,255,255,0.14)",
    searchText: "#f1f1f1",
    searchPlaceholder: "#717171",
    handle: "#3a3a3a",
    overlay: "rgba(0,0,0,0.32)",
    overlayStrong: "rgba(0,0,0,0.5)",
    backdrop: "rgba(0,0,0,0.8)",
    mediaBackground: "#000000",
    mediaOverlay: "rgba(0,0,0,0.3)",
    mediaOverlayStrong: "rgba(0,0,0,0.5)",
    skeletonBase: "rgba(255,255,255,0.06)",
    skeletonHighlight: "rgba(255,255,255,0.18)",
    badge: "#ef4444",
    badgeBorder: "#0f0f0f",
  },
  // Light mode — soft violet-tinted surfaces (matches web's #faf8ff)
  [THEME_MODES.light]: {
    mode: THEME_MODES.light,
    isDark: false,
    ...sharedColors,
    background: "#faf8ff", // subtle violet tint
    backgroundMuted: "#f1f1f7",
    surface: "#ffffff",
    surfaceElevated: "#ffffff",
    surfaceMuted: "#f7f5ff",
    surfaceStrong: "#e9e3fc",
    card: "#ffffff",
    cardStrong: "#fbfaff",
    border: "rgba(15,23,42,0.08)",
    borderStrong: "rgba(15,23,42,0.14)",
    divider: "rgba(15,23,42,0.08)",
    text: "#0f172a",
    textMuted: "#334155",
    textSoft: "#64748b",
    textSubtle: "#94a3b8",
    textInverse: "#ffffff",
    icon: "#0f172a",
    iconMuted: "#475569",
    placeholder: "#94a3b8",
    inputBackground: "#fbfaff",
    inputBorder: "rgba(124,58,237,0.18)",
    inputText: "#0f172a",
    searchBackground: "#ffffff",
    searchBorder: "rgba(124,58,237,0.18)",
    searchText: "#0f172a",
    searchPlaceholder: "#94a3b8",
    handle: "#cbd5e1",
    overlay: "rgba(15,23,42,0.08)",
    overlayStrong: "rgba(15,23,42,0.18)",
    backdrop: "rgba(15,23,42,0.42)",
    mediaBackground: "#0f172a",
    mediaOverlay: "rgba(15,23,42,0.2)",
    mediaOverlayStrong: "rgba(15,23,42,0.45)",
    skeletonBase: "rgba(148,163,184,0.18)",
    skeletonHighlight: "rgba(148,163,184,0.3)",
    badge: "#ef4444",
    badgeBorder: "#ffffff",
  },
};

export const getThemeColors = (themeMode = DEFAULT_THEME_MODE) => themeColors[themeMode] || themeColors[DEFAULT_THEME_MODE];
