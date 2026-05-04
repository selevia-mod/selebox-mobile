#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/backfill-video-durations.js
  ─────────────────────────────────────────────────────────────────────────
  Populate videos.duration via the Bunny Stream Library API.

  Why the Bunny Stream API (not M3U8 parsing)
  ───────────────────────────────────────────
  The original approach was to fetch each video's M3U8 manifest and sum
  #EXTINF tags. That fails on Selebox because:
    - Stored video_url uses an /<guid>/<filename>.mp4 path layout, not
      the canonical /<guid>/playlist.m3u8 layout, so the manifest fetch
      404s on most rows.
    - Even when a manifest is reachable, its .ts segment list is large
      and the parse is order-dependent.

  Bunny Stream's management API holds the canonical metadata for every
  uploaded video, including a `length` field (duration in seconds). One
  GET per video, no parsing, fast.

  Endpoint:
    GET https://video.bunnycdn.com/library/<library_id>/videos/<video_id>
    Headers: AccessKey: <library API key>

  Response shape (relevant fields):
    {
      "guid": "...",
      "length": 245,         // seconds
      "status": 4,           // 4 = ready
      "title": "...",
      ...
    }

  Resolving the (library_id, video_id) per row
  ────────────────────────────────────────────
  Selebox spans two Bunny Stream libraries (`selebox-videos-stream` +
  `selebox-web`). The videos table has bunny_library_id and
  bunny_video_id columns; if populated, use those directly. If not,
  parse the GUID from video_url (the first non-empty path segment
  after the host) and assume the default library from
  BUNNY_STREAM_VIDEOS_LIBRARY_ID.

  Idempotency
  ───────────
  WHERE clause filters to rows where duration is null OR <= 0. Re-run
  is safe — once a row has a positive duration written, the script
  skips it. Pass FORCE=1 to re-process every row regardless.

  Usage
  ─────
    SUPABASE_URL=https://your-project.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
    BUNNY_STREAM_LIBRARY_ID=541939 \
    BUNNY_STREAM_API_KEY=3d707dc2-... \
    node scripts/backfill-video-durations.js

    Optional:
      DRY_RUN=1     Walk + parse, no Supabase writes.
      LIMIT=100     Process first N rows (smoke test).
      VERBOSE=1     Log every API call + result.
      CONCURRENCY=8 Concurrent Bunny API requests (default 8).
      FORCE=1       Re-process even if duration is already set.
*/

const { createClient } = require("@supabase/supabase-js");

const env = (k, fallback) => {
  const v = process.env[k];
  if (v) return v;
  if (fallback !== undefined) return fallback;
  console.error(`Missing env var: ${k}`);
  process.exit(1);
};

const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
// Default values mirror private/secrets.js so the script can be run
// without retyping every key. Override per-invocation if you're
// targeting the second Bunny library (selebox-web), since that one
// has different credentials.
const DEFAULT_LIBRARY_ID = env("BUNNY_STREAM_LIBRARY_ID", "541939");
const DEFAULT_API_KEY = env("BUNNY_STREAM_API_KEY", "3d707dc2-15b2-4ba1-bc3e71e4eb62-b375-4047");
// OVERRIDE_LIBRARY_ID forces every API call to use this library,
// ignoring whatever's in row.bunny_library_id. Useful when the
// column has stale/wrong data (some rows ended up tagged with the
// stories library ID by mistake during an earlier migration).
const OVERRIDE_LIBRARY_ID = process.env.OVERRIDE_LIBRARY_ID || null;
const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const VERBOSE = process.env.VERBOSE === "1";
const CONCURRENCY = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : 8;
const FORCE = process.env.FORCE === "1";

const PAGE_SIZE = 200;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── GUID extraction ──────────────────────────────────────────────────────
// Selebox stored Bunny URLs look like:
//   https://vz-fdf88b4d-33a.b-cdn.net//<guid>/<filename>
//   https://vz-fdf88b4d-33a.b-cdn.net/<guid>/play_720p.mp4
// We want the first non-empty path segment as the GUID.
const extractGuidFromUrl = (videoUrl) => {
  if (!videoUrl || typeof videoUrl !== "string") return null;
  try {
    const url = new URL(videoUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments[0] || null;
  } catch (_) {
    return null;
  }
};

// Standard UUID regex — Bunny GUIDs are full UUIDs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Bunny Stream API ─────────────────────────────────────────────────────
// Log the FIRST few non-404 errors regardless of VERBOSE so the operator
// always has enough info to diagnose without re-running. After 5 logged
// errors we go quiet to avoid spamming.
let _errorLogBudget = 5;
const fetchBunnyDuration = async (libraryId, videoGuid, apiKey, rowId, videoUrl) => {
  const url = `https://video.bunnycdn.com/library/${libraryId}/videos/${videoGuid}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        AccessKey: apiKey,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      if (response.status !== 404 && _errorLogBudget > 0) {
        _errorLogBudget -= 1;
        let body = "";
        try {
          body = (await response.text()).slice(0, 200);
        } catch (_) {}
        console.log(
          `  ❗ bunny api ${response.status} — request: GET ${url} — row ${rowId} — videoUrl ${videoUrl} — body: ${body}`,
        );
      }
      return { ok: false, status: response.status };
    }
    const data = await response.json();
    const length = Number(data?.length);
    if (!Number.isFinite(length) || length <= 0) return { ok: false, status: 200, reason: "no_length" };
    return { ok: true, length, status: data?.status };
  } catch (err) {
    if (_errorLogBudget > 0) {
      _errorLogBudget -= 1;
      console.log(`  ❗ bunny api fetch threw: ${err?.message || err} — row ${rowId} — videoUrl ${videoUrl}`);
    }
    return { ok: false, status: 0, error: err?.message || String(err) };
  }
};

// ── Concurrency limiter ──────────────────────────────────────────────────
async function pMap(items, concurrency, mapper) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array(Math.min(concurrency, items.length))
    .fill(0)
    .map(async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await mapper(items[idx], idx);
      }
    });
  await Promise.all(workers);
  return results;
}

// ── Page through videos ──────────────────────────────────────────────────
async function* iterVideosNeedingDuration() {
  let scanned = 0;
  let lastId = null;
  while (true) {
    let q = sb
      .from("videos")
      .select("id, video_url, duration, bunny_video_id, bunny_library_id")
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (!FORCE) q = q.or("duration.is.null,duration.lte.0");
    if (lastId) q = q.gt("id", lastId);

    const { data, error } = await q;
    if (error) throw new Error(`videos page query failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      yield row;
      scanned += 1;
      if (LIMIT && scanned >= LIMIT) return;
    }
    lastId = data[data.length - 1].id;
    if (data.length < PAGE_SIZE) break;
  }
}

// ── Driver ───────────────────────────────────────────────────────────────
async function run() {
  console.log("[backfill-video-durations] starting", {
    DRY_RUN,
    LIMIT,
    VERBOSE,
    CONCURRENCY,
    FORCE,
    DEFAULT_LIBRARY_ID,
    OVERRIDE_LIBRARY_ID: OVERRIDE_LIBRARY_ID || "(none)",
  });

  let scanned = 0;
  let resolved = 0;
  let updated = 0;
  let skippedNoGuid = 0;
  let skippedNotFound = 0;
  let errors = 0;
  let pending = [];

  const flush = async () => {
    if (!pending.length) return;

    const work = pending.map((row) => ({ row, length: null, skipReason: null }));

    await pMap(work, CONCURRENCY, async (entry) => {
      const { row } = entry;

      // Resolve (library_id, video_guid). The row's bunny_library_id
      // column has stale/wrong data on this catalog (most rows tagged
      // with the stories library 522607 but the videos actually live
      // in library 541939 per the CDN pull-zone). So we DELIBERATELY
      // ignore row.bunny_library_id and use the default — overrideable
      // via OVERRIDE_LIBRARY_ID env if running against a second
      // library. GUID still prefers per-row data when available.
      const libraryId = OVERRIDE_LIBRARY_ID || DEFAULT_LIBRARY_ID;
      const videoGuid = row.bunny_video_id || extractGuidFromUrl(row.video_url);

      if (!videoGuid || !UUID_RE.test(videoGuid)) {
        entry.skipReason = "no_guid";
        return;
      }

      const result = await fetchBunnyDuration(libraryId, videoGuid, DEFAULT_API_KEY, row.id, row.video_url);
      if (!result.ok) {
        entry.skipReason = result.status === 404 ? "not_found" : "api_error";
        if (VERBOSE) console.log(`  bunny api ${result.status} for ${row.id} (guid ${videoGuid}, lib ${libraryId})`);
        return;
      }
      entry.length = Math.round(result.length);
    });

    // Categorize results into skip buckets, collect successful resolutions
    // for bulk upsert.
    const upsertBatch = [];
    for (const entry of work) {
      const { row, length, skipReason } = entry;
      if (skipReason === "no_guid") {
        skippedNoGuid += 1;
        if (VERBOSE) console.log(`  skip no-guid: ${row.id} → ${row.video_url}`);
        continue;
      }
      if (skipReason === "not_found") {
        skippedNotFound += 1;
        continue;
      }
      if (skipReason === "api_error") {
        errors += 1;
        continue;
      }
      if (!Number.isFinite(length) || length <= 0) {
        skippedNotFound += 1;
        continue;
      }
      resolved += 1;
      upsertBatch.push({ id: row.id, duration: length });
    }

    if (upsertBatch.length === 0) {
      pending = [];
      return;
    }

    if (DRY_RUN) {
      updated += upsertBatch.length;
      if (VERBOSE) {
        for (const u of upsertBatch) console.log(`  [dry-run] would set videos.duration = ${u.duration} for ${u.id}`);
      }
      pending = [];
      return;
    }

    // Per-row UPDATE in parallel. Bulk upsert (single call) trips
    // INSERT-time NOT NULL constraints on columns the rows already
    // have set, even though we're really doing UPDATEs — that's a
    // PostgREST/Postgres ON CONFLICT idiosyncrasy. Plain UPDATE
    // skips that path. With concurrency 32 a 200-row flush lands in
    // ~1-2s instead of 20s, fast enough.
    await pMap(upsertBatch, 32, async (entry) => {
      const { error } = await sb.from("videos").update({ duration: entry.duration }).eq("id", entry.id);
      if (error) {
        errors += 1;
        console.error(`  update failed for ${entry.id}: ${error.message}`);
      } else {
        updated += 1;
        if (VERBOSE) console.log(`  set ${entry.id} → ${entry.duration}s`);
      }
    });

    pending = [];
  };

  for await (const row of iterVideosNeedingDuration()) {
    scanned += 1;
    pending.push(row);
    if (pending.length >= PAGE_SIZE) {
      await flush();
      console.log(
        `  progress: scanned=${scanned} resolved=${resolved} updated=${updated} noGuid=${skippedNoGuid} notFound=${skippedNotFound} err=${errors}`,
      );
    }
  }
  await flush();

  console.log("[backfill-video-durations] done", {
    scanned,
    resolved,
    updated,
    skippedNoGuid,
    skippedNotFound,
    errors,
  });
  if (errors) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
