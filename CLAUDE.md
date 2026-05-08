# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**SeLeBox** (Tales of Siren) is a cross-platform mobile content platform built with Expo/React Native. It provides social media features for books, videos, clips, and real-time messaging with creator monetization.

- **Bundle ID**: com.talesofsiren.talesofsiren (iOS/Android)
- **Framework**: Expo ~52.0.46, React Native 0.76.9
- **Routing**: Expo Router (file-based routing)

## Development Commands

```bash
npm install              # Install dependencies (runs patch-package via postinstall)
npm run start            # Start Expo dev server
npm run ios              # Run on iOS simulator
npm run android          # Run on Android emulator
npm run prebuild         # Generate native code (first time or after dependency changes)
npm run prebuild-clean   # Clean and regenerate native code
npm run format           # Format all JS/JSX/JSON with Prettier
npm run check-install    # Verify Expo dependency compatibility
npm run check-updates    # Check for package updates
```

### Building & Deployment

```bash
npm run build-apk        # Android APK (EAS)
npm run build-aab        # Android App Bundle for Play Store (EAS)
npm run build-ios        # iOS for App Store (EAS)
npm run submit-ios       # Submit to App Store
npm run submit-android   # Submit to Play Store
```

### OTA Updates

**ALWAYS push OTAs via the EAS CLI directly. NEVER via `git push`.**

The GitHub Actions workflow (`.github/workflows/publish-eas-update.yaml`) is intentionally not the path we use day-to-day — it runs without our hands on the wheel and surprises everyone when a stray push goes to main. Direct CLI push gives us the message, a visible build log, and the ability to abort.

```bash
cd /Users/arcaracalague/Documents/selebox-mobile-main
eas update --branch main --message "<short summary of what's in the bundle>"
```

For the test branch (Appwrite `isTester` flag–gated):

```bash
eas update --branch test --message "<summary>"
```

`git commit` + `git push` are for source-history hygiene only — they should never be the trigger for shipping a JS bundle. Commit whenever you like, but the OTA is live the moment `eas update` finishes.

### Testing

No test suite is configured. Test manually on iOS simulator and Android emulator.

## Architecture

### Provider Nesting Order (`app/_layout.jsx`)

```
Redux Provider → PersistGate → GlobalProvider → ClipsStatsProvider → BookStatsProvider → VideosStatsProvider → InnerLayout
```

`InnerLayout` wraps the Stack navigator inside `GestureHandlerRootView`. (Pre-Phase D this also nested `OverlayProvider → Chat` for the Stream Chat SDK; both were removed when chat went Supabase-native and `stream-chat-expo` was uninstalled.)

### State Management

**Redux Store** (`/store/index.js`) — all slices use `redux-persist` with MMKV storage. Reducers are in `/store/reducers/`: `auth`, `books`, `videos`, `app`, `storyCache`, `post`, `creatorVideos`, `notifications`.

**Global Context** (`/context/global-provider.js`) — non-serializable app state (initialization, auth status, balance, avatar, push tokens, caches). Access via `useGlobalContext()`.

**Additional Context Providers** in `/context/`: `clip-stats-provider.js`, `book-stats-provider.js`, `video-stats-provider.js`.

### Navigation Structure (Expo Router)

File-based routing in `/app/` with grouped routes: `(tabs)`, `(auth)`, `(book)`, `(video)`, `(story)`, `(post)`, `(message)`, `(profile)`, `(edit)`, `(studio)`, `(store)`, `(payments)`, `(notification)`. Dynamic routes: `books/[id].jsx` (deep link), `search/[query].jsx`.

Main tabs: `home`, `books`, `videos`, `playlist`. (The `clips` tab was retired May 2026 and replaced by a "Reels coming soon" teaser route.)

Deep linking: `https://selebox.com/books/*` and `talesofsiren://books/*` (configured in `app.json`). Routes to `/(book)/book-info` with `bookId` param.

### Service Layer (`/lib/`)

Backend services use **Appwrite** (legacy BaaS, mid-migration) and **Supabase** (current — see `lib/feature-flags.js` for which subsystem is on which backend). Key files:

- `appwrite.js` — Core auth: account creation, sign-in/out, session/JWT management, self-healing user documents. Stream Chat token integration was removed in Phase D.
- `supabase.js`, `supabase-auth.js` — Supabase client + auth bridge.
- `messages-supabase.js` — Chat backend (was Stream Chat / Appwrite, now Supabase). The previous `stream.js` / `stream-connection-manager.js` files were deleted in Phase D.
- `bunny-service.js` / `fetch-bunny-storage.js` — Bunny.net CDN + storage zone operations (images, videos)
- `books.js`, `clips.js`, `video.js`, `posts.js`, `follows.js`, `notifications.js`, `messages.js`, `safety.js` — Domain CRUD services
- `book-comments.js`, `book-chapter-comments.js`, `book-reads.js`, `book-unlocks.js`, `book-rating.js`, `book-downloads.js` — Granular book engagement services
- `video-downloads.js`, `books-rankings.js` — Downloads and ranking services
- `users.js`, `user-documents.js`, `user-earnings.js` — User management
- `earningsService.js` / `withdrawalsService.js` / `calculateWithdrawal.js` — Creator monetization
- `firebase.js` — Firebase analytics integration
- `register-push-notifications.js` — Expo push notification registration
- `image-utils.js` — Image processing (resizing, WebP conversion)

All configuration (Appwrite project IDs, CDN keys, API keys) is imported from `private/secrets.js` as a default export.

### Custom Hooks (`/hooks/`)

- `useAutoUnlock.js` — Auto-unlock logic for gated content
- `useIsOffline.js` — Network connectivity detection
- `useResetOnBlur.js` — Reset component state when screen loses focus
- `useRewardedStars.js` — Rewarded ad / star currency integration

Additional hooks live in `/lib/`: `useEarnings.js`, `useTotalUnreadCount.js`, `useModalMessage.js`.

### Event System

Decoupled communication via Node.js `EventEmitter`:

- `lib/story-events.js` — default export `storyEvents` (story share/delete)
- `lib/tab-navigation-events.js` — default export `tabNavigationEvents` (double-tap scroll-to-top)

### Pagination Pattern

Cursor-based pagination throughout: `lastId` or `offset` cursor, `hasMore` flag, FlatList/FlashList `onEndReached`. Typical page size: 10-20 items.

### Caching Strategy

- **Redux Persist + MMKV**: Long-lived data (auth, books, videos, notifications)
- **Context State**: Session-scoped data
- **AsyncStorage**: Tokens (Expo push, Supabase session)

## Styling

**NativeWind** (Tailwind CSS for React Native), configured in `tailwind.config.js` and `babel.config.js`.

- Dark theme: background `#111827`, accent `#7975D4`
- Custom fonts in `tailwind.config.js`: Poppins weights (`font-pthin` through `font-pblack`), Inter weights (`font-inter-thin` through `font-inter-black`)
- Animations: React Native Reanimated

### Prettier Config (`.prettierrc`)

```json
{
  "printWidth": 150,
  "tabWidth": 2,
  "useTabs": false,
  "semi": true,
  "singleQuote": false,
  "jsxSingleQuote": false,
  "arrowParens": "always"
}
```

Tailwind class sorting via `prettier-plugin-tailwindcss`.

## Key Technologies

- **Backend**: Appwrite (`react-native-appwrite`) for legacy paths + Supabase (`@supabase/supabase-js`) for current code paths. Migration is feature-flag gated; see `lib/feature-flags.js` for the per-subsystem state.
- **Chat**: Supabase-native (custom `lib/messages-supabase.js` + Realtime subscriptions for live updates). Stream Chat Expo SDK was removed in Phase D; `stream-chat-expo` is no longer a dependency.
- **CDN**: Bunny.net — Bunny Stream for HLS video playback, Bunny Storage zones for images/general media. AWS S3+CloudFront retired May 2026; clips feature also retired May 2026 (replaced by a "Reels coming soon" teaser).
- **Payments**: `react-native-iap` (in-app purchases)
- **Ads**: `react-native-google-mobile-ads` (AdMob)
- **Analytics**: Firebase
- **Lists**: `@shopify/flash-list` and `FlatList`

## Important Notes

### Sensitive Files

- `private/secrets.js` — Contains all API keys, Appwrite config, Supabase URL/anon key, CDN keys. **This file is tracked by git.** Never modify secrets without coordinating with the team. (`STREAM_API_KEY` lives here historically but is no longer read by any active code.)
- Never commit: `.env`, `google-services.json`, service account JSON files

### Git Workflow

- **Main branch**: `main` — pushes trigger OTA updates via GitHub Actions (`.github/workflows/publish-eas-update.yaml` runs `eas update --branch main`)
- **Test branch**: `test` — pushes trigger test OTA updates (`.github/workflows/publish-eas-update-test.yaml`), gated by Appwrite `isTester` flag
- **Development branch**: `develop`

### EAS Build Profiles (`eas.json`)

- `development` — development client, internal distribution
- `preview` — internal distribution
- `production-apk` / `production-aab` / `production-ios` — store builds with auto-increment, channel `main`

### Patches

Uses `patch-package` (postinstall hook). Patches stored in `/patches/` when needed (directory created on first patch).

### Auth Providers

Supports three authentication methods: email/password, Google Sign-In (`@react-native-google-signin/google-signin`), and Apple Sign-In (`expo-apple-authentication`). All managed through Appwrite in `lib/appwrite.js`.

## Common Development Patterns

### Reading User State

```javascript
import { useGlobalContext } from "../context/global-provider";
const { user, isLogged, loading } = useGlobalContext();
```

### Accessing Redux State

```javascript
import { useSelector, useDispatch } from "react-redux";
const books = useSelector((state) => state.books);
const dispatch = useDispatch();
```

### Making API Calls

```javascript
import { BookService } from "../lib/books";
const bookService = new BookService();
const books = await bookService.getBooks(offset, limit);
```

### Navigation

```javascript
import { router } from "expo-router";
router.push("/book/book-info");
router.back();
```

### Importing Secrets

```javascript
import secrets from "../private/secrets";
const { appwriteConfig, STREAM_API_KEY } = secrets;
```
