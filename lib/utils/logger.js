import { recordCrashlyticsError } from "../crashlytics";

// Thin logging wrapper around the existing Crashlytics setup.
//
// Why: hundreds of `console.log("X error:", e)` calls exist across the
// codebase. They surface in dev console but never reach production
// telemetry — meaning real-user errors are invisible. This logger gives a
// single ergonomic API that routes by level + environment.
//
// Usage:
//   import logger from "../lib/utils/logger";
//   logger.debug("PostCard", "rendering", { postId });        // dev only
//   logger.info("Auth", "user signed in");                     // dev only
//   logger.warn("Feed", "stale cache");                        // breadcrumb in prod
//   logger.error("PostInformation", "getPostLike failed", e);  // recordError in prod
//
// Migration pattern from existing code:
//   // Before:
//   try { ... } catch (e) { console.log("getPostLike error", e); }
//
//   // After:
//   try { ... } catch (e) { logger.error("PostInformation", "getPostLike failed", e); }

const isDev = typeof __DEV__ !== "undefined" ? __DEV__ : process.env.NODE_ENV !== "production";
const TAG_WIDTH = 22; // pad tags for column alignment in dev console

const formatTag = (tag) => {
  const safe = String(tag || "app").slice(0, TAG_WIDTH);
  return `[${safe}]`.padEnd(TAG_WIDTH + 2);
};

const formatLine = (tag, message, error) => {
  const errorMsg = error?.message || (typeof error === "string" ? error : null);
  const base = `${formatTag(tag)} ${message}`;
  return errorMsg ? `${base}: ${errorMsg}` : base;
};

// Lazily resolve crashlytics so failures (e.g. no native module in some test
// envs) don't crash the logger itself.
const safeCrashlyticsLog = (line) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crashlytics = require("@react-native-firebase/crashlytics").default;
    crashlytics().log(line);
  } catch {
    // no-op — Crashlytics not available
  }
};

const logger = {
  // Pure dev breadcrumb. No-op in production.
  debug: (tag, message, ...args) => {
    if (!isDev) return;
    // eslint-disable-next-line no-console
    console.log(formatLine(tag, message), ...args);
  },

  // Informational. Dev console only — not worth Crashlytics noise.
  info: (tag, message, ...args) => {
    if (!isDev) return;
    // eslint-disable-next-line no-console
    console.log(formatLine(tag, message), ...args);
  },

  // Visible problem that didn't crash. Dev console + Crashlytics breadcrumb.
  warn: (tag, message, error) => {
    const line = formatLine(tag, message, error);
    if (isDev) {
      // eslint-disable-next-line no-console
      console.warn(line);
    } else {
      safeCrashlyticsLog(line);
    }
  },

  // Caught error. Dev console + Crashlytics recordError in prod (counts as a
  // non-fatal — visible in Firebase Crashlytics dashboard alongside crashes).
  error: (tag, message, error) => {
    const line = formatLine(tag, message, error);
    if (isDev) {
      // eslint-disable-next-line no-console
      console.error(line);
      if (error?.stack) {
        // eslint-disable-next-line no-console
        console.error(error.stack);
      }
    } else {
      recordCrashlyticsError(error || new Error(message), `${tag}: ${message}`);
    }
  },
};

export default logger;
export { logger };
