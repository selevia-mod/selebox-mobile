# Videos tab — "scroll down → white only" investigation

_Session: April 30, 2026. Read-only audit, no code changed. Hand off to the next session for the actual fixes._

> **Symptom (user report):** scrolling down through the Videos > For You feed, the screen blanks to white. Content paints in only after the scroll settles.

---

## TL;DR — what's almost certainly causing it

The outer `FlashList` in `app/(tabs)/videos.jsx` is being **forced to re-mount its visible cells on every parent render**, because:

1. `renderItem` (`renderSection`) is a fresh function reference on every render.
2. `extraData={{ ... 9 state slices ... }}` is a new object literal on every render.
3. `estimatedItemSize={300}` is significantly smaller than the actual sections (carousels are 300–600+ px tall, `Category` rows can hit ~700+).

When you scroll down quickly, FlashList tries to recycle a cell into the next-visible position, but because `renderItem` and `extraData` are new on every render, it can't recycle — it has to mount fresh. The fresh section component (e.g. `VideosLatest`) immediately mounts a horizontal `FlatList` of up to 30 `VideoCardNew` children, each of which:

- runs a `useEffect` that kicks off `getVideoDurationSeconds(item)` (a `fetch` of the M3U8 manifest if not cached),
- mounts a `FastImage` for the thumbnail,
- mounts a `LoaderKit` animated spinner inside the avatar,
- recomputes a layout block on every render (card width, line heights, row height, etc.).

For a few frames, the cell exists but its content hasn't painted yet → user sees white.

The Books tab is selectively immune because most Books surfaces (`BooksDiscover`, `BooksRanking`, `BooksWeeklyFeatured`, etc.) explicitly tune their `FlatList` props (`removeClippedSubviews`, `windowSize`, etc.). **None of the `Videos*` section components do.**

---

## Evidence

### 1. Outer FlashList renderItem and extraData are unstable

`app/(tabs)/videos.jsx`

```jsx
// L410: not wrapped in useCallback
const renderSection = ({ item }) => {
  const getComponent = () => {
    switch (item.type) {
      case "MostPeopleWant": return <VideosMostPeopleWant videos={mostPeopleWant} />;
      case "VideosFromFollowing": return <VideosFromFollowing videos={fromFollowing} />;
      // ... 8 more cases
    }
  };
  return <View style={{ marginBottom: SECTION_SPACING }}>{getComponent()}</View>;
};

// L499–514: extraData is a NEW OBJECT every render
<FlashList
  data={videosSections}
  renderItem={renderSection}
  keyExtractor={keyExtractor}
  extraData={{
    mostPeopleWant, fromFollowing, suggestedForYou, continueWatching,
    trendingWeek, youMightLike, popularInYourArea, latestVideos, categoryVideos,
  }}
  estimatedItemSize={300}
  ...
/>
```

`keyExtractor` IS memoized (L450), good. But `renderItem` and `extraData` together are enough to defeat recycling.

The `useEffect` at L297–335 makes this much worse — every Redux `videosCache` update calls 10 separate `setX(filterBlocked(...))`, which means 10 cascading renders, each producing a new `extraData` object literal.

### 2. estimatedItemSize is wrong for most sections

From `utils/videoCardLayout.js` + each section component (cardWidth = `width × 0.8` typically):

| Section | Approx. real height (iPhone 393w) |
|---|---|
| MostPeopleWant / Latest / Trending / Following / Suggested / Popular / YouMight | ~300–340 px |
| Category (rows = 2 cards stacked) | ~500–700 px |
| ContinueWatching | ~200 px (smaller cards) |

`estimatedItemSize={300}` underestimates every Category section, which inflates `drawDistance` → too few cells in flight → blanks during fast scroll. FlashList tolerates wrong estimates but punishes them at the bottom of fast scrolls, which is exactly the symptom.

### 3. Section components allocate fresh layout + closures every render

Every `Videos*` section component does this on each render:

```jsx
const { width } = useWindowDimensions();
const cardWidth = width * 0.8;
const { imageHeight, cardHeight } = getVideoCardLayout({ cardWidth, aspectRatio: 0.59 });
const containerHeight = getSectionTitleHeight() + cardHeight;

const renderItem = ({ item }) => {       // new fn ref every render
  return <VideoCardNew key={item.uri} item={item} customWidth={cardWidth} customHeight={imageHeight} />;
};

<FlatList horizontal data={videos} renderItem={renderItem} keyExtractor={(item, index) => ...} />
```

- `renderItem` is recreated each render → every `VideoCardNew` is forced to re-render too because props are referentially new.
- `keyExtractor` is recreated each render.
- The horizontal `FlatList` has **no virtualization tuning**: no `removeClippedSubviews`, no `windowSize`, no `initialNumToRender`, no `maxToRenderPerBatch`. Horizontal RN `FlatList`s default to mounting all items at once. Result: when a section comes into view, **30 `VideoCardNew` instances mount synchronously**.

### 4. VideoCardNew is heavy and not memoized

`components/VideoCardNew.jsx`:

- **Not wrapped in `React.memo`** → every parent re-render rebuilds the JSX tree.
- `useEffect` (L23–32) calls `getVideoDurationSeconds(item).then(...)` on mount. If the manifest is uncached, this is an HTTP fetch. **30 cards mounting at once = 30 manifest fetches racing FastImage thumbnail loads** for the same screen. Cache + in-flight dedupe protect against duplicates of the *same* video, but not bursts of distinct videos.
- `Dimensions.get("window")` is called at module-render time — should use `useWindowDimensions` (used in section components) or hoist.
- ~10 layout values recomputed every render (cardWidth, cardHeight, avatarSize, fontSize, titleLineHeight, metaFontSize, metaLineHeight, textStackGap, textBlockHeight, rowHeight).
- `LoaderKit` (`BallScaleMultiple`) animation runs while avatars load — 30 concurrent loops compete with the JS thread during scroll.
- Style objects are inline literals throughout — minor, but adds up at 30× per section × N sections.

`components/VideoCardSmall.jsx` has the same `getVideoDurationSeconds` mount pattern and lacks memoization.

### 5. Books vs Videos comparison

`components/BooksDiscover.jsx` L1163: `removeClippedSubviews={false}` — explicit decision after evaluation.
`Videos*` section components: **no virtualization props anywhere**. The Books tab inherited a tuning round; Videos didn't.

---

## Ranked fix list (next session)

In order of expected impact for the white-on-scroll symptom specifically:

### P0 — outer FlashList stability (likely fixes 60–80% of the symptom)

1. **Memoize `renderSection`** with `useCallback`. Deps should be just the 9 state slices it reads, OR — better — pass the slices in via a single `useMemo`'d object and have `renderSection` read from it via `extraData`/closure.
2. **Stabilize `extraData`** with `useMemo`:
   ```js
   const extraData = useMemo(() => ({
     mostPeopleWant, fromFollowing, suggestedForYou, continueWatching,
     trendingWeek, youMightLike, popularInYourArea, latestVideos, categoryVideos,
   }), [mostPeopleWant, fromFollowing, suggestedForYou, continueWatching,
        trendingWeek, youMightLike, popularInYourArea, latestVideos, categoryVideos]);
   ```
   Honestly though — FlashList only needs `extraData` if `renderItem` reads from props/state outside `item`. Once `renderSection` is closed over the right state via `useCallback`, you can usually drop `extraData` entirely.
3. **Use `getItemType` on the FlashList** so FlashList recycles each section type into its own pool. Without this, FlashList's recycler can try to reuse a Category cell for a TrendingWeek cell, causing layout thrash.
   ```js
   const getItemType = useCallback((item) => item.type, []);
   ```
4. **Tune `estimatedItemSize`** — measure once with real content. Likely closer to **420** for the average. Or split: estimate per-type via `overrideItemLayout`.
5. **Remove the inline wrapper `<View style={{ marginBottom: SECTION_SPACING }}>`** in `renderSection` and push that gap to `ItemSeparatorComponent` instead. Saves a re-render of the wrapper on every cell update.

### P1 — VideoCardNew memoization (cuts re-render storms)

6. **Wrap `VideoCardNew` in `React.memo`**, with a custom comparator that ignores style props if they change by value but not shape, and compares `item` by `$id`.
7. Hoist all per-item layout math behind `useMemo` keyed on `customWidth`, `customHeight`, `customFontSize`, `customAvatarSize`.
8. Replace `Dimensions.get("window")` with `useWindowDimensions()` — re-renders correctly on rotation, no perf cost.
9. Same treatment for `VideoCardSmall`.

### P2 — section-level FlatList tuning (helps cold-mount, not the recycler)

10. On every horizontal `FlatList` in `Videos*` sections:
    - `initialNumToRender={4}` (only render 4 cards on first paint instead of all 30)
    - `maxToRenderPerBatch={4}`
    - `windowSize={3}`
    - `removeClippedSubviews={true}` on Android; leave default on iOS
    - Memoize `renderItem` and `keyExtractor` with `useCallback`
    - Or, since these are short flat lists with stable item types, swap `FlatList` for `FlashList horizontal` with a real `estimatedItemSize`.
11. Memoize `cardWidth` / `imageHeight` / `cardHeight` / `containerHeight` (cheap but cleaner).

### P3 — duration fetch coordination

12. Currently every visible card kicks its own duration fetch. Consider a **section-level prefetch** — when a section becomes visible, kick off `getVideoDurationSeconds` for its first 4–6 items in a `requestIdleCallback`-style scheduler before each card mounts. Cards that find a cache hit on mount won't trigger any work.
13. Optional: bump duration TTL from 10 min to 24 h and persist via AsyncStorage so cold launches don't refetch.

### P4 — avatar loader weight

14. Replace `LoaderKit BallScaleMultiple` with a static placeholder (theme.surfaceMuted background + initials) while the avatar loads. Animations during scroll are expensive. The card is already showing initials as fallback after error — just show that during the loading state too.

---

## Verification plan for the fix session

1. Apply P0 (#1–#5) only. Walk through For You — fast scroll down, scroll up, switch tabs back. Expectation: white-on-scroll mostly gone.
2. If still present in Category sections specifically, that confirms the height estimate is the residual issue → tune `overrideItemLayout` or per-type estimates.
3. Apply P1 (`React.memo` on cards). Re-run. Expectation: any remaining lag during scroll smooths out, especially on lower-end Android.
4. Apply P2 (#10–#11). Watch for any visual regressions — `removeClippedSubviews` on Android occasionally clips overlay pills (it doesn't here because the duration pill is inside the thumbnail wrapper).
5. Profile with `react-devtools` Profiler — confirm `Videos` re-renders ≤ 2 per data load, not ≤ 10.
6. On a real device with throttled 3G, confirm cold-open of For You doesn't fire 60+ parallel fetches in the network panel.

---

## Out of scope for this report — but worth noting

- **Books tab refresh latency** (the original "Outstanding / paused" item) is a separate axis — it's about the cold-open round-trip count (~20 round-trips on first Discover open). Different fix shape: deferred section loads, parallel chunking, persisted cache. Recommend tackling Videos first since the symptom is more visible.
- **`VideosFromFollowing` follow-resolution** does a full FollowService.getFollowing → fetchVideos chain on every cold load. Fine for now, but if that's slow, pre-warm it from the Books-tab pattern (mount-time prefetch).
- **`getRandomOffset` in `loadVideosData`** triggers a *second* `fetchVideos` request when the catalog is bigger than 60 — adds ~300–500ms to refresh latency. Could be eliminated by sampling client-side from a larger initial pull, or by caching the random-pool separately.

---

## Files read for this audit

- `app/(tabs)/videos.jsx`
- `components/VideoCardNew.jsx`
- `components/VideoCardSmall.jsx`
- `components/VideosMostPeopleWant.jsx`
- `components/VideosLatest.jsx`
- `components/VideosTrendingWeek.jsx`
- `components/VideosFromFollowing.jsx`
- `components/VideosPerCategory.jsx`
- `lib/utils/video-duration.js`
- `utils/videoCardLayout.js`
- `components/BooksDiscover.jsx` (comparison)
