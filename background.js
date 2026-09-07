/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching YouTube transcripts via Supadata API
 * 3. Calling DeepSeek to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
importScripts("settings.js");
// Shared cue segmentation + cache keys. The player, the side panel and this
// worker must derive identical cue IDs or a paid translation would be lost.
importScripts("subtitle-units.js");

const DEBUG = false;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SUBTITLE_TRACK_STORAGE_PREFIX = "ytd_subtitle_track_";
const SUBTITLE_TRACK_MAX_ENTRIES = 20;
const SUBTITLE_TRACK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Temporary, per-browser-session switches. chrome.storage.session is wiped when
// the browser fully quits, which is exactly the "default closed again" rule.
const SIDE_PANEL_SESSION_KEY = "ytd_open_side_panel_tabs";
const SUBTITLE_SESSION_KEY = "ytd_subtitle_session";
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Prevent the YouTube content script from reading API keys or cached data.
// Side panel, options, and service-worker contexts remain trusted.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[YouTube Digest] Could not restrict storage access:", error),
  );

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
}

function normalizeSubtitleOverlayMode(mode) {
  return YTD_SUBTITLE_UNITS.normalizeSubtitleDisplayMode(mode);
}

function normalizeSubtitleOverlayTrack(input) {
  const videoId = typeof input?.videoId === "string" ? input.videoId.trim() : "";
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(videoId)) return null;

  const segments = Array.isArray(input?.segments) ? input.segments : [];
  if (segments.length > 2_000) return null;

  const normalizedSegments = segments
    .map((segment) => {
      const start = Number(segment?.start);
      const candidateEnd = Number(segment?.end);
      return {
        id: typeof segment?.id === "string" ? segment.id.slice(0, 128) : "",
        start,
        // Older stored tracks have no explicit end and remain readable. New
        // player tracks use it so a subtitle disappears during source gaps.
        end:
          Number.isFinite(candidateEnd) && candidateEnd > start
            ? candidateEnd
            : undefined,
        original: typeof segment?.original === "string" ? segment.original.trim() : "",
        translated:
          typeof segment?.translated === "string" ? segment.translated.trim() : "",
      };
    })
    .filter(
      (segment) =>
        segment.id &&
        Number.isFinite(segment.start) &&
        segment.start >= 0 &&
        segment.original &&
        segment.original.length <= 4_000 &&
        segment.translated.length <= 4_000,
    );

  // A stored track deliberately carries no display mode. "Should Chinese be
  // showing right now" is a temporary, user-granted intent — persisting it is
  // what used to make a reopened video translate itself automatically.
  return {
    videoId,
    mode: "off",
    segments: normalizedSegments,
    timestamp: Date.now(),
  };
}

function subtitleOverlayStorageKey(videoId) {
  return `${SUBTITLE_TRACK_STORAGE_PREFIX}${videoId}`;
}

async function evictSubtitleOverlayTracks() {
  const allData = await chrome.storage.local.get(null);
  let entries = Object.entries(allData)
    .filter(([key]) => key.startsWith(SUBTITLE_TRACK_STORAGE_PREFIX))
    .map(([key, value]) => ({ key, timestamp: Number(value?.timestamp) || 0 }));
  const expired = entries
    .filter((entry) => Date.now() - entry.timestamp > SUBTITLE_TRACK_MAX_AGE_MS)
    .map((entry) => entry.key);
  if (expired.length) await chrome.storage.local.remove(expired);

  entries = entries.filter((entry) => !expired.includes(entry.key));
  if (entries.length <= SUBTITLE_TRACK_MAX_ENTRIES) return;
  const excess = entries
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, entries.length - SUBTITLE_TRACK_MAX_ENTRIES)
    .map((entry) => entry.key);
  if (excess.length) await chrome.storage.local.remove(excess);
}

async function saveSubtitleOverlayTrack(input) {
  const track = normalizeSubtitleOverlayTrack(input);
  if (!track) throw new Error("Invalid subtitle overlay track");
  await chrome.storage.local.set({ [subtitleOverlayStorageKey(track.videoId)]: track });
  await evictSubtitleOverlayTracks();
  return track;
}

async function getSubtitleOverlayTrack(videoId) {
  const key = subtitleOverlayStorageKey(videoId);
  const result = await chrome.storage.local.get(key);
  const track = result[key];
  if (!track) return null;
  if (Date.now() - (Number(track.timestamp) || 0) > SUBTITLE_TRACK_MAX_AGE_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return normalizeSubtitleOverlayTrack(track);
}

// ============================================================
// PLAYER SUBTITLE SESSION
// ============================================================
//
// A "session" is one video, in one tab, that the user explicitly switched
// subtitles on for. Nothing here starts on its own: the only entry point is
// activateSubtitleTranslation(), sent when the player toggle moves 关 -> 中.
//
// The session lives in chrome.storage.session, so it disappears when the
// browser quits and can never resurrect a translation after a restart. Its
// `generation` counter invalidates in-flight work the moment the user closes
// subtitles or moves to another video.

let subtitleSession = null;
let subtitleGenerationCounter = 0;

const subtitleSessionReady = (async () => {
  try {
    const stored = await chrome.storage.session.get(SUBTITLE_SESSION_KEY);
    const value = stored?.[SUBTITLE_SESSION_KEY];
    if (value && typeof value === "object" && value.activatedByUser) {
      subtitleSession = value;
      subtitleGenerationCounter = Number(value.generation) || 0;
    }
  } catch (_error) {
    // A service worker without session storage simply starts with no session.
  }
})();

function persistSubtitleSession() {
  const payload = subtitleSession ? { [SUBTITLE_SESSION_KEY]: subtitleSession } : null;
  if (payload) {
    chrome.storage.session.set(payload).catch(() => {});
  } else {
    chrome.storage.session.remove(SUBTITLE_SESSION_KEY).catch(() => {});
  }
}

function subtitleSessionSnapshot() {
  return subtitleSession
    ? {
        tabId: subtitleSession.tabId,
        videoId: subtitleSession.videoId,
        mode: subtitleSession.mode,
        generation: subtitleSession.generation,
        activatedByUser: subtitleSession.activatedByUser,
      }
    : null;
}

function isValidVideoId(videoId) {
  return typeof videoId === "string" && /^[A-Za-z0-9_-]{6,20}$/.test(videoId);
}

/**
 * True only when this exact tab + video is the one the user switched on and
 * subtitles are still showing. Every provider call is gated on this.
 */
function subtitleSessionMatches(tabId, videoId, generation) {
  if (!subtitleSession?.activatedByUser) return false;
  if (subtitleSession.mode === "off") return false;
  if (Number.isInteger(tabId) && subtitleSession.tabId !== tabId) return false;
  if (videoId && subtitleSession.videoId !== videoId) return false;
  if (Number.isInteger(generation) && subtitleSession.generation !== generation) {
    return false;
  }
  return true;
}

function startSubtitleSession(tabId, videoId, mode) {
  subtitleGenerationCounter += 1;
  subtitleSession = {
    tabId,
    videoId,
    mode: normalizeSubtitleOverlayMode(mode) === "bilingual" ? "bilingual" : "zh",
    generation: subtitleGenerationCounter,
    activatedByUser: true,
  };
  persistSubtitleSession();
  return subtitleSession;
}

/**
 * Ends the current session. Bumping the generation is what cancels queued work
 * and stops late provider responses from reaching a player that moved on.
 */
function endSubtitleSession() {
  subtitleGenerationCounter += 1;
  subtitleSession = null;
  persistSubtitleSession();
  subtitleQueue.pending = [];
  subtitleQueue.queued.clear();
}

// ============================================================
// PLAYER SUBTITLE TRANSLATION QUEUE
// ============================================================
//
// This used to live in the side panel, which meant closing the panel silently
// killed the player's subtitles. It now runs here so the player works with the
// panel closed — and so the DeepSeek key never has to leave the worker.

let subtitleWorkspace = null; // { videoId, cues, translations: Map, videoTitle }

const subtitleQueue = {
  pending: [],
  queued: new Set(),
  inFlight: new Set(),
  processing: false,
};

function digestCacheKey(videoId) {
  return `digest_${videoId}`;
}

async function readDigestCache(videoId) {
  const key = digestCacheKey(videoId);
  const stored = await chrome.storage.local.get(key);
  const cached = stored?.[key];
  return cached && typeof cached === "object" ? cached : null;
}

/**
 * Writes back only the fields we own. Notes, the AI overview, and paragraph
 * translations already in the entry are carried through untouched.
 */
async function mergeDigestCache(videoId, patch) {
  const key = digestCacheKey(videoId);
  const existing = (await readDigestCache(videoId)) || {};
  await chrome.storage.local.set({
    [key]: { ...existing, ...patch, timestamp: Date.now() },
  });
}

/**
 * Builds (or reuses) the cue list and translation cache for one video.
 * Supadata is called only when no cached transcript exists.
 */
async function loadSubtitleWorkspace(videoId) {
  if (subtitleWorkspace?.videoId === videoId) return subtitleWorkspace;

  const cached = await readDigestCache(videoId);
  let transcript = Array.isArray(cached?.transcript) ? cached.transcript : null;
  let videoTitle = typeof cached?.videoTitle === "string" ? cached.videoTitle : "";

  if (!transcript?.length) {
    const fetched = await handleFetchTranscript(videoId);
    if (!fetched?.success) {
      throw new Error(fetched?.message || fetched?.error || "No transcript available");
    }
    // handleFetchTranscript has already cached this, merging rather than
    // replacing so an existing overview or note set survives.
    transcript = fetched.transcript;
  }

  const cues = YTD_SUBTITLE_UNITS.buildPlayerSubtitleCues(transcript);
  const translations = new Map();

  // Seed from the compact subtitle cache...
  const storedTrack = await getSubtitleOverlayTrack(videoId);
  storedTrack?.segments?.forEach((segment) => {
    if (segment.translated) translations.set(segment.id, segment.translated);
  });
  // ...and from the side panel's cue cache, so translations bought by an
  // earlier version are reused instead of being paid for twice.
  const legacyCache = cached?.playerCueCache;
  if (legacyCache && typeof legacyCache === "object") {
    cues.forEach((cue) => {
      if (translations.has(cue.id)) return;
      const value = legacyCache[YTD_SUBTITLE_UNITS.playerSubtitleCueCacheKey(videoId, cue)];
      if (typeof value === "string" && value.trim()) translations.set(cue.id, value.trim());
    });
  }

  subtitleWorkspace = { videoId, cues, translations, videoTitle };
  return subtitleWorkspace;
}

function buildSubtitleTrack(workspace) {
  return {
    videoId: workspace.videoId,
    mode: "off",
    segments: workspace.cues.map((cue) => ({
      id: cue.id,
      start: cue.start,
      end: cue.end,
      original: cue.text,
      translated: workspace.translations.get(cue.id) || "",
    })),
  };
}

/**
 * Persists translated cues in both caches the extension already reads: the
 * compact subtitle track (used by the player) and the side panel's cue cache.
 */
async function persistSubtitleTranslations(workspace) {
  const translatedSegments = workspace.cues
    .filter((cue) => workspace.translations.get(cue.id))
    .map((cue) => ({
      id: cue.id,
      start: cue.start,
      end: cue.end,
      original: cue.text,
      translated: workspace.translations.get(cue.id),
    }));
  if (!translatedSegments.length) return;

  await saveSubtitleOverlayTrack({
    videoId: workspace.videoId,
    segments: translatedSegments,
  }).catch(() => {});

  const cached = await readDigestCache(workspace.videoId);
  if (!cached) return;
  const playerCueCache = { ...(cached.playerCueCache || {}) };
  translatedSegments.forEach((segment) => {
    playerCueCache[
      YTD_SUBTITLE_UNITS.playerSubtitleCueCacheKey(workspace.videoId, segment)
    ] = segment.translated;
  });
  await mergeDigestCache(workspace.videoId, { playerCueCache });
}

async function pushSubtitleTrack(workspace, generation) {
  if (!subtitleSessionMatches(null, workspace.videoId, generation)) return;
  const track = buildSubtitleTrack(workspace);
  const tabId = subtitleSession.tabId;
  await chrome.tabs
    .sendMessage(tabId, {
      action: "setSubtitleOverlayTrack",
      track,
      generation,
    })
    .catch(() => {});
  // The side panel mirrors whatever the player already paid for. It is a
  // passive listener: if it is closed, nothing here changes.
  chrome.runtime
    .sendMessage({
      action: "subtitleTrackUpdated",
      videoId: workspace.videoId,
      generation,
      mode: subtitleSession.mode,
      track,
    })
    .catch(() => {});
}

function enqueueSubtitleCue(index, workspace, generation) {
  const cue = workspace.cues[index];
  if (!cue) return;
  // Three states, one check: already paid for, already waiting, already sent.
  if (workspace.translations.has(cue.id)) return;
  if (subtitleQueue.queued.has(cue.id) || subtitleQueue.inFlight.has(cue.id)) return;
  subtitleQueue.pending.push({ index, generation, videoId: workspace.videoId });
  subtitleQueue.queued.add(cue.id);
}

/**
 * Queues the phrase being spoken plus a short look-ahead. This is the only
 * place new provider work is created, and it runs solely for an active session.
 */
function enqueueSubtitleWindow(workspace, currentTime, generation) {
  const startIndex = YTD_SUBTITLE_UNITS.findPlaybackCueIndex(workspace.cues, currentTime);
  const end = Math.min(
    workspace.cues.length,
    startIndex + 1 + YTD_SUBTITLE_UNITS.SUBTITLE_PREFETCH_LOOKAHEAD,
  );
  for (let index = startIndex; index < end; index += 1) {
    enqueueSubtitleCue(index, workspace, generation);
  }
  processSubtitleQueue().catch((error) =>
    debugLog("[YouTube Digest BG] Subtitle queue stopped:", error?.message),
  );
}

async function processSubtitleQueue() {
  if (subtitleQueue.processing) return;
  subtitleQueue.processing = true;
  try {
    while (subtitleQueue.pending.length) {
      // Read the workspace fresh every batch. A video change swaps it, and any
      // queue entry left over from the old one is dropped by the checks below.
      const workspace = subtitleWorkspace;
      const batch = [];
      while (
        workspace &&
        batch.length < YTD_SUBTITLE_UNITS.SUBTITLE_BATCH_SIZE &&
        subtitleQueue.pending.length
      ) {
        const item = subtitleQueue.pending.shift();
        if (item.videoId !== workspace.videoId) continue;
        const cue = workspace.cues[item.index];
        if (!cue) continue;
        subtitleQueue.queued.delete(cue.id);
        // The user may have closed subtitles or moved on while this waited.
        if (!subtitleSessionMatches(null, workspace.videoId, item.generation)) continue;
        // Last-chance cache check: a concurrent batch may have just filled it.
        if (workspace.translations.has(cue.id)) continue;
        subtitleQueue.inFlight.add(cue.id);
        batch.push({ cue, generation: item.generation });
      }
      if (!batch.length) {
        if (!workspace) subtitleQueue.pending = [];
        continue;
      }

      const generation = batch[0].generation;
      try {
        const result = await handleTranslateContent(
          { segments: batch.map(({ cue }) => ({ id: cue.id, text: cue.text })) },
          "transcriptBatch",
          "zh",
          workspace.videoTitle,
        );
        if (result?.success) {
          (result.translatedContent?.segments || []).forEach((segment) => {
            if (segment?.id && segment.text) {
              // A late response still belongs to THIS video, so the cache keeps
              // it — only the push below is gated on the session still living.
              workspace.translations.set(segment.id, segment.text);
            }
          });
          await persistSubtitleTranslations(workspace);
          await pushSubtitleTrack(workspace, generation);
        }
      } catch (error) {
        debugLog("[YouTube Digest BG] Subtitle translation batch failed:", error?.message);
      } finally {
        batch.forEach(({ cue }) => subtitleQueue.inFlight.delete(cue.id));
      }
    }
  } finally {
    subtitleQueue.processing = false;
  }
}

/**
 * Handles 关 -> 中 in the player: the one action that authorizes DeepSeek use
 * for this video. Everything else can only reuse what this produced.
 */
async function handleActivateSubtitleTranslation(tabId, videoId, currentTime, mode) {
  await subtitleSessionReady;
  if (!Number.isInteger(tabId)) throw new Error("Missing tab context");
  if (!isValidVideoId(videoId)) throw new Error("Invalid video ID");

  const session = startSubtitleSession(tabId, videoId, mode);
  subtitleQueue.pending = [];
  subtitleQueue.queued.clear();

  let workspace;
  try {
    workspace = await loadSubtitleWorkspace(videoId);
  } catch (error) {
    // No subtitles to work with. Drop the authorization so playback does not
    // keep retrying Supadata behind the user's back.
    if (subtitleSessionMatches(tabId, videoId, session.generation)) endSubtitleSession();
    throw error;
  }
  if (!subtitleSessionMatches(tabId, videoId, session.generation)) {
    return { success: true, generation: session.generation, mode: session.mode };
  }

  // Show whatever is already cached before any network work starts.
  await pushSubtitleTrack(workspace, session.generation);
  enqueueSubtitleWindow(workspace, currentTime, session.generation);
  return { success: true, generation: session.generation, mode: session.mode };
}

async function handlePrefetchSubtitleWindow(tabId, videoId, currentTime) {
  await subtitleSessionReady;
  if (!subtitleSessionMatches(tabId, videoId)) {
    return { success: false, error: "Subtitle translation is not active" };
  }
  const generation = subtitleSession.generation;
  const workspace = await loadSubtitleWorkspace(videoId);
  if (!subtitleSessionMatches(tabId, videoId, generation)) {
    return { success: false, error: "Subtitle session changed" };
  }
  enqueueSubtitleWindow(workspace, currentTime, generation);
  return { success: true, generation };
}

/**
 * 中 <-> 双 only changes how an already-translated cue is drawn. No cue is
 * re-sent to the provider, because both texts are already in the track.
 */
async function handleSetSubtitleDisplayMode(tabId, videoId, mode) {
  await subtitleSessionReady;
  const normalized = normalizeSubtitleOverlayMode(mode);
  if (normalized === "off") return handleDeactivateSubtitleTranslation(tabId, videoId);
  if (!subtitleSessionMatches(tabId, videoId)) {
    return { success: false, error: "Subtitle translation is not active" };
  }
  subtitleSession.mode = normalized;
  persistSubtitleSession();
  chrome.runtime
    .sendMessage({
      action: "subtitleSessionChanged",
      videoId,
      mode: normalized,
      generation: subtitleSession.generation,
    })
    .catch(() => {});
  return { success: true, mode: normalized };
}

async function handleDeactivateSubtitleTranslation(tabId, videoId) {
  await subtitleSessionReady;
  const wasActive = subtitleSessionMatches(tabId, videoId);
  if (wasActive || subtitleSession?.tabId === tabId) endSubtitleSession();
  chrome.runtime
    .sendMessage({ action: "subtitleSessionChanged", videoId, mode: "off" })
    .catch(() => {});
  return { success: true, mode: "off" };
}

/**
 * Page reload, video change, or SPA navigation. The old video's authorization
 * never carries over to the new one.
 */
async function handleResetSubtitleSession(tabId) {
  await subtitleSessionReady;
  // Only this tab's own session is retired. A video playing with subtitles on
  // in another tab is none of this page's business.
  const ownsSession =
    !Number.isInteger(tabId) || subtitleSession?.tabId === tabId;
  if (!ownsSession) return { success: true };

  const hadSession = !!subtitleSession;
  endSubtitleSession();
  subtitleWorkspace = null;
  if (hadSession) {
    chrome.runtime
      .sendMessage({ action: "subtitleSessionChanged", videoId: "", mode: "off" })
      .catch(() => {});
  }
  return { success: true };
}

async function handleGetSubtitleSessionState(videoId) {
  await subtitleSessionReady;
  const snapshot = subtitleSessionSnapshot();
  const active = !!snapshot && (!videoId || snapshot.videoId === videoId);
  return {
    success: true,
    session: active ? snapshot : null,
    mode: active ? snapshot.mode : "off",
  };
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
}) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    const error = new Error(
      "DeepSeek API key not configured. Open YouTube Digest Settings.",
    );
    error.code = "NO_AI_KEY";
    throw error;
  }
  const body = {
    model: settings.aiModel,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  // Product features need bounded, predictable latency rather than reasoning traces.
  body.thinking = { type: "disabled" };

  const controller = new AbortController();
  let timeoutKind = "";
  let idleTimeoutId;
  let hardTimeoutId;
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(
      () => abortForTimeout("idle"),
      AI_PROVIDER_IDLE_TIMEOUT_MS,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    AI_PROVIDER_HARD_TIMEOUT_MS,
  );
  resetIdleTimeout();
  try {
    const response = await fetch(
      YTD_SETTINGS.chatCompletionsUrl(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.aiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    // Receiving headers proves DeepSeek is still making progress. DeepSeek
    // may then send blank-line body chunks while a non-streaming request queues.
    resetIdleTimeout();

    const data = await readBoundedAiResponse(response, resetIdleTimeout);
    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `DeepSeek error: ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("DeepSeek returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        "DeepSeek request was inactive for 50 seconds. Please Retry.",
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        "DeepSeek request exceeded the 120-second limit. Please Retry.",
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Every received chunk is activity, including DeepSeek's blank lines.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  // Some fetch implementations do not expose a readable stream. Preserve a
  // bounded body read for that case.
  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    const byteLength = new TextEncoder().encode(responseText).byteLength;
    if (byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  // Legacy/test fetch shims may expose only json(). The hard and idle timers
  // still bound this fallback even though chunk-level activity is unavailable.
  const data = await response.json();
  onActivity();
  return data;
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

// The side panel is opened by the user and by nobody else. Chrome's built-in
// "open on action click" behaviour is switched off so this worker owns both
// halves of the toggle and always knows which state the panel is in.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch(() => {});

const supportsSidePanelClose = typeof chrome.sidePanel?.close === "function";

/**
 * Which tabs the user has opened the panel for, this browser session.
 *
 * Kept in memory so the action click can decide synchronously (awaiting
 * anything first would spend the user gesture that sidePanel.open() needs),
 * and mirrored into chrome.storage.session so a restarted service worker does
 * not forget. Session storage is cleared when Chrome quits, which is exactly
 * the "panel is closed again after a restart" rule.
 */
const openSidePanelTabs = new Set();

// Tabs whose panel we closed because the video went fullscreen, so we know to
// put it back afterwards. Kept apart from openSidePanelTabs, which stays an
// honest record of what is actually on screen so the toolbar toggle keeps
// working while fullscreen.
const panelsHiddenForFullscreen = new Set();

const sidePanelStateReady = (async () => {
  try {
    const stored = await chrome.storage.session.get(SIDE_PANEL_SESSION_KEY);
    const ids = stored?.[SIDE_PANEL_SESSION_KEY];
    if (Array.isArray(ids)) {
      ids.forEach((id) => {
        if (Number.isInteger(id)) openSidePanelTabs.add(id);
      });
    }
  } catch (_error) {
    // No session storage — start from "closed everywhere", the safe default.
  }
})();

function persistSidePanelState() {
  chrome.storage.session
    .set({ [SIDE_PANEL_SESSION_KEY]: [...openSidePanelTabs] })
    .catch(() => {});
}

function markSidePanelOpen(tabId) {
  if (!Number.isInteger(tabId)) return;
  if (!openSidePanelTabs.has(tabId)) {
    openSidePanelTabs.add(tabId);
    persistSidePanelState();
  }
}

function markSidePanelClosed(tabId) {
  if (!Number.isInteger(tabId)) return;
  if (openSidePanelTabs.delete(tabId)) persistSidePanelState();
}

/**
 * Opens the panel for one tab. setOptions + open are called with no await
 * between them so the click's user-gesture context survives.
 */
function openSidePanelForTab(tabId) {
  chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
  const opening = Promise.resolve(chrome.sidePanel.open({ tabId }));
  markSidePanelOpen(tabId);
  return opening.catch((error) => {
    markSidePanelClosed(tabId);
    throw error;
  });
}

function closeSidePanelForTab(tabId) {
  markSidePanelClosed(tabId);
  if (!supportsSidePanelClose) return Promise.resolve();
  return Promise.resolve(chrome.sidePanel.close({ tabId })).catch(() => {});
}

// Toolbar icon: open when closed, close when open. On a Chrome without
// sidePanel.close() this degrades to "icon opens, native X closes".
chrome.action.onClicked.addListener((tab) => {
  const tabId = tab?.id;
  if (!Number.isInteger(tabId)) return;
  // Touching the icon during fullscreen is a deliberate override, so drop any
  // pending restore rather than reopening the panel behind the reader later.
  panelsHiddenForFullscreen.delete(tabId);
  if (supportsSidePanelClose && openSidePanelTabs.has(tabId)) {
    closeSidePanelForTab(tabId);
    return;
  }
  openSidePanelForTab(tabId).catch((error) => {
    console.error("[YouTube Digest BG] Could not open the side panel:", error);
  });
});

// Keep our record honest when Chrome opens or closes the panel for us — most
// importantly when the user clicks the panel's own close button.
if (typeof chrome.sidePanel?.onOpened?.addListener === "function") {
  chrome.sidePanel.onOpened.addListener((info) => markSidePanelOpen(info?.tabId));
}
if (typeof chrome.sidePanel?.onClosed?.addListener === "function") {
  chrome.sidePanel.onClosed.addListener((info) => {
    if (Number.isInteger(info?.tabId)) markSidePanelClosed(info.tabId);
    else {
      openSidePanelTabs.clear();
      persistSidePanelState();
    }
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  panelsHiddenForFullscreen.delete(tabId);
  markSidePanelClosed(tabId);
  if (subtitleSession?.tabId === tabId) endSubtitleSession();
});

// A fresh browser session starts with everything off: no panel, no subtitles.
// This runs on real browser startup only — never on a service-worker wake-up,
// which must not disturb a panel or a translation the user already switched on.
chrome.runtime.onStartup.addListener(() => {
  openSidePanelTabs.clear();
  panelsHiddenForFullscreen.clear();
  subtitleSession = null;
  subtitleWorkspace = null;
  subtitleQueue.pending = [];
  subtitleQueue.queued.clear();
  chrome.storage.session
    .remove([SIDE_PANEL_SESSION_KEY, SUBTITLE_SESSION_KEY])
    .catch(() => {});
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel scoped to YouTube tabs only.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. To make YouTube Digest behave like a YouTube-only tool, we
 * enable the panel on YouTube tabs and disable it everywhere else. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 * The original code only handled onUpdated, which is why the panel stayed
 * visible when switching to an already-loaded non-YouTube tab.
 */
function updatePanelForTab(tabId, url) {
  const isYouTube = (url || "").startsWith("https://www.youtube.com");
  // This decides only whether the panel is AVAILABLE here. It never opens the
  // panel — opening is always a deliberate user action.
  // setOptions can reject if the tab just closed — ignore that harmlessly.
  chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: isYouTube })
    .catch(() => {});
  // Chrome closes a panel it just disabled, so our record has to follow.
  if (!isYouTube) markSidePanelClosed(tabId);
}

// A tab navigated to a new URL.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return; // ignore title/favicon-only updates
  updatePanelForTab(tabId, changeInfo.url);
});

// The user switched to a different tab (or opened a new one).
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updatePanelForTab(tabId, tab.url);
  } catch (e) {
    // Tab vanished before we could read it — nothing to do.
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "fetchTranscript") {
    handleFetchTranscript(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep the message channel open for async response
  }

  if (message.action === "analyzeTranscript") {
    // Pass video duration to help the AI validate timestamps
    handleAnalyzeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
      message.videoDuration,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using DeepSeek.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    // Save a note at the current timestamp
    handleSaveNote(
      message.videoId,
      message.timestamp,
      message.videoTitle,
      message.channelName,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getVideoInfo") {
    handleGetVideoInfo(message.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Translation: send content to DeepSeek.
  if (message.action === "translateContent") {
    handleTranslateContent(
      message.content,
      message.contentType,
      message.targetLanguage,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ----- Player subtitle session -----
  // sender.tab.id is the authority for which tab a message belongs to. A page
  // script cannot claim to speak for a different tab by passing its own ID.

  // The single action that authorizes DeepSeek use for a video: the player
  // toggle moving 关 -> 中.
  if (message.action === "activateSubtitleTranslation") {
    handleActivateSubtitleTranslation(
      sender.tab?.id,
      message.videoId,
      message.currentTime,
      message.mode,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "prefetchSubtitleWindow") {
    handlePrefetchSubtitleWindow(
      sender.tab?.id,
      message.videoId,
      message.currentTime,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "setSubtitleDisplayMode") {
    handleSetSubtitleDisplayMode(sender.tab?.id, message.videoId, message.mode)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deactivateSubtitleTranslation") {
    handleDeactivateSubtitleTranslation(sender.tab?.id, message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "resetSubtitleSession") {
    handleResetSubtitleSession(sender.tab?.id)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Read-only views used by the side panel to mirror the player's state.
  if (message.action === "getSubtitleSessionState") {
    handleGetSubtitleSessionState(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getSubtitleOverlayTrack") {
    getSubtitleOverlayTrack(message.videoId)
      .then((track) => sendResponse({ success: true, track }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasSupadataKey: !!settings.supadataApiKey,
          hasAiKey: !!settings.aiApiKey,
        }),
      )
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  // The video went fullscreen. Chrome leaves the panel in place and simply
  // gives the fullscreen content the room beside it, so close it ourselves.
  if (message.action === "hideSidePanelForFullscreen") {
    const tabId = sender.tab?.id;
    if (
      Number.isInteger(tabId) &&
      supportsSidePanelClose &&
      openSidePanelTabs.has(tabId)
    ) {
      panelsHiddenForFullscreen.add(tabId);
      closeSidePanelForTab(tabId);
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "restoreSidePanelAfterFullscreen") {
    const tabId = sender.tab?.id;
    // Best effort. sidePanel.open() wants a user gesture, and leaving
    // fullscreen with Esc carries none, so this can be refused. The panel then
    // stays closed and the toolbar icon opens it, rather than the reader being
    // left with a broken-looking extension.
    if (Number.isInteger(tabId) && panelsHiddenForFullscreen.delete(tabId)) {
      openSidePanelForTab(tabId).catch(() => {});
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "openSidePanel") {
    // The in-page Digest button only ever OPENS the panel. Closing it is the
    // toolbar icon's job (or the panel's own close button).
    const tabId = sender.tab?.id;
    debugLog("[YouTube Digest BG] openSidePanel requested from tab:", tabId);

    if (Number.isInteger(tabId)) {
      openSidePanelForTab(tabId)
        .then(() => {
          // Tell the panel to load this video, in case it was already open.
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startDigestFromButton" })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.error("[YouTube Digest BG] openSidePanel error:", err);
        });
    }

    sendResponse({ success: true });
    return false;
  }

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[YouTube Digest BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        // Query specifically for YouTube tabs to avoid side panel context issues
        // Try multiple query strategies to find the right tab
        let tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        debugLog(
          "[YouTube Digest BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        // If no YouTube tab found, try broader query
        if (!tabs[0] || !tabs[0].url?.includes("youtube.com")) {
          tabs = await chrome.tabs.query({
            url: "https://www.youtube.com/*",
            active: true,
          });
          debugLog("[YouTube Digest BG] Active YouTube tabs:", tabs.length);
        }

        // Still nothing? Try any YouTube tab
        if (!tabs[0]) {
          tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
          debugLog("[YouTube Digest BG] Any YouTube tabs:", tabs.length);
        }

        if (tabs[0]) {
          debugLog(
            "[YouTube Digest BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response = await chrome.tabs.sendMessage(
            tabs[0].id,
            message.payload,
          );

          // For getVideoInfo, PREFER YouTube's own player data over the
          // DOM scrape. The player's videoDetails is canonical: its `author`
          // is always THIS video's channel and its `shortDescription` is the
          // full text. The DOM scrape is unreliable — e.g. on a playlist page
          // it grabbed the playlist owner's name ("Zara Zhang") instead of the
          // real channel ("Replit and Stripe"), and its description is
          // truncated while the box is collapsed. We fall back to the DOM
          // only for fields the player didn't provide.
          if (message.payload?.action === "getVideoInfo") {
            const playerInfo = await getPlayerVideoDetails(tabs[0].id);
            if (playerInfo) {
              response = {
                title: playerInfo.title || response?.title || "",
                channelName:
                  playerInfo.channelName || response?.channelName || "",
                duration: playerInfo.duration || response?.duration || 0,
                description:
                  playerInfo.description || response?.description || "",
              };
            }
          }

          debugLog("[YouTube Digest BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[YouTube Digest BG] No YouTube tab found");
          sendResponse({ success: false, error: "No YouTube tab found" });
        }
      } catch (err) {
        console.error("[YouTube Digest BG] Relay error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }
});

/**
 * Reads the current video's full details straight from YouTube's player.
 *
 * Content scripts live in an isolated world and can't touch the page's own
 * JavaScript. But with the "scripting" permission we can run a tiny function
 * in the page's MAIN world, where YouTube's player object lives. Its
 * getPlayerResponse() carries videoDetails with the FULL description —
 * unlike the DOM, which truncates it until the user clicks "...more".
 *
 * Returns null on any failure so callers can fall back to DOM scraping.
 */
async function getPlayerVideoDetails(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const player = document.getElementById("movie_player");
          const details = player?.getPlayerResponse?.()?.videoDetails;
          if (!details) return null;
          return {
            title: details.title || "",
            channelName: details.author || "",
            description: details.shortDescription || "",
            duration: Number(details.lengthSeconds) || 0,
          };
        } catch (e) {
          return null;
        }
      },
    });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn("[YouTube Digest BG] Player details unavailable:", e.message);
    return null;
  }
}

// ============================================================
// TRANSCRIPT FETCHING VIA SUPADATA API
// ============================================================

/**
 * Fetches the transcript for a YouTube video using Supadata API.
 *
 * Supadata is a specialized service that reliably extracts transcripts
 * from YouTube videos. It handles all the complexity of parsing YouTube's
 * internal data structures, dealing with different caption formats, etc.
 *
 * API Docs: https://docs.supadata.ai
 *
 * @param {string} videoId - The YouTube video ID (e.g., "dQw4w9WgXcQ")
 * @returns {Object} - { success, transcript, transcriptText, language } or { success: false, error }
 */
/**
 * Supadata's own explanation of a refusal, as one short line. Its payload
 * carries a human-readable `message` and a more specific `details`, and the
 * two sometimes repeat each other.
 */
function supadataErrorDetail(errorData) {
  const parts = [errorData?.message, errorData?.details]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  if (!unique.length) return "";
  const text = unique.join(" ").replace(/\s+/g, " ");
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

// Requests currently in flight, keyed by video ID. Two independent paths can
// ask for the same transcript: the side panel opening a video, and the player
// subtitle button being switched on. Without this, a long video (Supadata
// answers those asynchronously and we poll for up to a minute) could be
// fetched twice, spending two credits and producing exactly the kind of
// back-to-back burst that trips Supadata's rate limit.
const inFlightTranscriptRequests = new Map();

/**
 * Returns the transcript for a video, fetching it at most once.
 *
 * Serves an already cached transcript without touching the network, and joins
 * a concurrent caller to the request that is already running.
 */
async function handleFetchTranscript(videoId) {
  const cached = await readDigestCache(videoId);
  if (Array.isArray(cached?.transcript) && cached.transcript.length) {
    return {
      success: true,
      transcript: cached.transcript,
      transcriptText: cached.transcriptText || "",
      transcriptTextTimestamped: cached.transcriptTimestamped || "",
      language: cached.transcriptLanguage || null,
      fromCache: true,
    };
  }

  const pending = inFlightTranscriptRequests.get(videoId);
  if (pending) return pending;

  const request = fetchTranscriptFromSupadata(videoId)
    .then(async (result) => {
      // Cache here, at the one place that spends the credit, so the next
      // caller is served locally no matter which path it came from. Merging
      // keeps any overview, notes, and translations already stored.
      if (result?.success && result.transcript?.length) {
        await mergeDigestCache(videoId, {
          transcript: result.transcript,
          transcriptText: result.transcriptText,
          transcriptTimestamped: result.transcriptTextTimestamped,
          transcriptLanguage: result.language || null,
        }).catch(() => {});
      }
      return result;
    })
    .finally(() => {
      inFlightTranscriptRequests.delete(videoId);
    });
  inFlightTranscriptRequests.set(videoId, request);
  return request;
}

async function fetchTranscriptFromSupadata(videoId) {
  try {
    const settings = await getSettings();
    if (!settings.supadataApiKey) {
      return {
        success: false,
        error: "NO_SUPADATA_KEY",
        message: "Supadata API key not configured. Open YouTube Digest Settings.",
      };
    }

    // Share only the canonical watch URL. This strips playlist, referral,
    // timestamp, and other browsing parameters from the active tab URL.
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    // Using the universal transcript endpoint with text=false to get timestamped chunks
    const apiUrl = new URL("https://api.supadata.ai/v1/transcript");
    apiUrl.searchParams.set("url", canonicalVideoUrl);
    apiUrl.searchParams.set("text", "false"); // Get timestamped chunks, not plain text
    apiUrl.searchParams.set("lang", "en"); // Prefer English
    // Caption-only product scope: never fall back to paid AI transcription.
    apiUrl.searchParams.set("mode", "native");

    // Make the API request
    const response = await fetch(apiUrl.toString(), {
      method: "GET",
      headers: {
        "x-api-key": settings.supadataApiKey,
      },
    });

    // Handle async jobs (for videos > 20 minutes, Supadata returns a job ID)
    if (response.status === 202) {
      const jobData = await response.json();
      // Poll for the result
      return await pollTranscriptJob(jobData.jobId, settings.supadataApiKey);
    }

    if (response.status === 206) {
      return {
        success: false,
        error: "NO_TRANSCRIPT",
        message: "No native subtitle track is available for this video.",
      };
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 401) {
        return {
          success: false,
          error: "INVALID_SUPADATA_KEY",
          message: "Your Supadata API key is invalid. Open YouTube Digest Settings.",
        };
      }
      if (response.status === 404) {
        return {
          success: false,
          error: "NO_TRANSCRIPT",
          message: "No subtitles found for this video.",
        };
      }
      if (response.status === 429) {
        // Supadata answers 429 with limit-exceeded for two different problems:
        // too many requests in a short burst, and a monthly quota that is
        // spent. Its own text says which, so repeat that instead of guessing.
        // Guessing sent the reader chasing a rate limit that was not there.
        const detail = supadataErrorDetail(errorData);
        return {
          success: false,
          error: "RATE_LIMITED",
          message: detail
            ? `Supadata refused the request: ${detail} Check the key in Settings and your remaining credits at dash.supadata.ai.`
            : "Supadata rate limit reached. Wait a minute and try again, then check your remaining credits at dash.supadata.ai.",
        };
      }
      throw new Error(
        errorData.message || `Supadata API error: ${response.status}`,
      );
    }

    const data = await response.json();

    // Parse the response into our internal format
    // Supadata returns: { content: [{ text, offset, duration, lang }], lang, availableLangs }
    const transcript = [];
    let transcriptTextPlain = ""; // Plain text for display/export
    let transcriptTextTimestamped = ""; // Timestamped text for AI analysis

    if (data.content && Array.isArray(data.content)) {
      for (const chunk of data.content) {
        if (chunk.text) {
          // Clean up caption artifacts:
          // ">>" = speaker change marker from YouTube auto-captions
          const cleanText = chunk.text.replace(/>> ?/g, "").trim();
          if (!cleanText) continue; // Skip if nothing left after cleanup

          // offset is in milliseconds, convert to seconds
          const startSeconds = Math.floor((chunk.offset || 0) / 1000);
          const minutes = Math.floor(startSeconds / 60);
          const seconds = startSeconds % 60;
          const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

          transcript.push({
            text: cleanText,
            start: startSeconds,
            duration: Math.floor((chunk.duration || 0) / 1000),
            language: chunk.lang || data.lang || null,
          });

          // Plain text without timestamps (for display/export)
          transcriptTextPlain += cleanText + " ";

          // Timestamped text for DeepSeek (format: [MM:SS] text)
          // This allows the model to reference actual transcript positions.
          transcriptTextTimestamped += `[${timestamp}] ${cleanText}\n`;
        }
      }
    }

    if (transcript.length === 0) {
      return {
        success: false,
        error: "EMPTY_TRANSCRIPT",
        message: "Supadata returned an empty transcript for this video.",
      };
    }

    return {
      success: true,
      transcript: transcript,
      transcriptText: transcriptTextPlain.trim(), // For display
      transcriptTextTimestamped: transcriptTextTimestamped.trim(), // For AI
      language: typeof data.lang === "string" ? data.lang : null,
    };
  } catch (error) {
    console.error("Transcript fetch error:", error);
    return {
      success: false,
      error: error.message || "Failed to fetch transcript",
    };
  }
}

/**
 * Polls for transcript job completion (for long videos).
 * Supadata processes videos > 20 minutes asynchronously.
 *
 * @param {string} jobId - The job ID returned by the initial request
 * @returns {Object} - Same format as handleFetchTranscript
 */
async function pollTranscriptJob(jobId, supadataApiKey) {
  const maxAttempts = 60; // Max 60 seconds of polling
  const pollInterval = 1000; // Poll every 1 second

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Wait before polling
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const response = await fetch(
      `https://api.supadata.ai/v1/transcript/${encodeURIComponent(jobId)}`,
      {
        headers: { "x-api-key": supadataApiKey },
      },
    );

    if (!response.ok) {
      throw new Error(`Job polling failed: ${response.status}`);
    }

    const data = await response.json();

    if (data.status === "completed") {
      // Parse the completed transcript
      const transcript = [];
      let transcriptTextPlain = "";
      let transcriptTextTimestamped = "";

      if (data.content && Array.isArray(data.content)) {
        for (const chunk of data.content) {
          if (chunk.text) {
            // Clean up caption artifacts (">>" = speaker change marker)
            const cleanText = chunk.text.replace(/>> ?/g, "").trim();
            if (!cleanText) continue;

            const startSeconds = Math.floor((chunk.offset || 0) / 1000);
            const minutes = Math.floor(startSeconds / 60);
            const seconds = startSeconds % 60;
            const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

            transcript.push({
              text: cleanText,
              start: startSeconds,
              duration: Math.floor((chunk.duration || 0) / 1000),
              language: chunk.lang || data.lang || null,
            });
            transcriptTextPlain += cleanText + " ";
            transcriptTextTimestamped += `[${timestamp}] ${chunk.text}\n`;
          }
        }
      }

      return {
        success: true,
        transcript: transcript,
        transcriptText: transcriptTextPlain.trim(),
        transcriptTextTimestamped: transcriptTextTimestamped.trim(),
        language: typeof data.lang === "string" ? data.lang : null,
      };
    }

    if (data.status === "failed") {
      throw new Error("Transcript processing failed");
    }

    // Status is 'queued' or 'active' — keep polling
  }

  throw new Error("Transcript processing timed out");
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    // e.g. ["a", "b", ]  ->  ["a", "b" ]
    const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

// ============================================================
// DEEPSEEK ANALYSIS
// ============================================================

/**
 * Sends the transcript to DeepSeek for analysis.
 *
 * The prompt asks the model to produce chapters covering the whole video
 * and 3-5 key quotes with timestamps.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "DeepSeek API key not configured. Open YouTube Digest Settings.",
      };
    }

    // Convert duration to MM:SS format for context
    // The transcript text is already prefixed with [M:SS] markers. Its LAST
    // marker is the most reliable signal of where the content actually ends —
    // more trustworthy than the duration metadata, which is sometimes missing
    // or wrong. We use the larger of (metadata duration, last transcript stamp).
    let lastTranscriptSeconds = 0;
    const stampMatches = transcriptText.match(/\[(\d+):(\d{2})\]/g) || [];
    if (stampMatches.length) {
      const last =
        stampMatches[stampMatches.length - 1].match(/\[(\d+):(\d{2})\]/);
      lastTranscriptSeconds = parseInt(last[1]) * 60 + parseInt(last[2]);
    }

    const effectiveSeconds = Math.max(
      Math.floor(videoDuration || 0),
      lastTranscriptSeconds,
    );
    const durationMinutes = Math.floor(effectiveSeconds / 60);
    const durationSeconds = Math.floor(effectiveSeconds % 60);
    const durationFormatted = `${durationMinutes}:${String(durationSeconds).padStart(2, "0")}`;
    const maxTimestampSeconds = effectiveSeconds;

    // The "last chapter must be after" threshold (75% in) forces the model to
    // cover the WHOLE video instead of front-loading chapters near the start.
    // We do NOT prescribe a chapter count — the model picks the natural splits.
    const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
    const lateThreshold = `${Math.floor(lateThresholdSeconds / 60)}:${String(
      lateThresholdSeconds % 60,
    ).padStart(2, "0")}`;

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "analysis.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.md",
      "User prompt",
      promptVariables,
    );

    debugLog("[YouTube Digest] Requesting video analysis", settings.aiModel);
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 8192,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parse the JSON, tolerating trailing commas / stray prose
    let analysis = parseLooseJson(responseText);

    // Treat every model response as untrusted data. Rebuild the supported
    // schema and derive display timestamps from validated numeric seconds.
    analysis = validateAndFixTimestamps(analysis, maxTimestampSeconds);

    return {
      success: true,
      analysis: analysis,
    };
  } catch (error) {
    console.error("Analysis error:", error);
    if (error.status === 401) {
      return {
        success: false,
        error: "INVALID_AI_KEY",
        message: "DeepSeek rejected the API key.",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "DeepSeek rate-limited this request. Try again shortly.",
      };
    }
    return {
      success: false,
      error: error.message || "Failed to analyze transcript",
    };
  }
}

/**
 * Validates all timestamps in the analysis and fixes any that exceed video duration.
 * This is a safety net to prevent hallucinated timestamps from reaching the UI.
 *
 * @param {Object} analysis - The parsed analysis from DeepSeek
 * @param {number} maxSeconds - Maximum valid timestamp in seconds
 * @returns {Object} - Analysis with validated timestamps
 */
function validateAndFixTimestamps(analysis, maxSeconds) {
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;

  // Helper to format seconds as MM:SS
  const formatTimestamp = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const safeSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      return {
        title,
        summary: safeString(chapter?.summary, 1500),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (
    Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : []
  )
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyMoments = (
    Array.isArray(analysis?.keyMoments) ? analysis.keyMoments : []
  )
    .map(safeSeconds)
    .filter((seconds) => seconds !== null)
    .slice(0, 100);

  return { chapters, keyQuotes, keyMoments };
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Gets video info (title, channel, description) from the active YouTube tab.
 * We do this by asking the content script to read the page.
 */
async function handleGetVideoInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getVideoInfo",
    });
    return response;
  } catch (error) {
    return { title: "", channelName: "", description: "" };
  }
}

// ============================================================
// EXPLAIN SELECTION
// ============================================================

/**
 * Explains selected text using DeepSeek.
 * Provides context, definitions, and clarification for complex terms.
 *
 * @param {string} selectedText - The text the user selected
 * @param {string} transcriptContext - Surrounding transcript for context
 * @param {string} videoTitle - Video title for additional context
 * @returns {Object} - { success, explanation } or { success: false, error }
 */
// ============================================================
// NOTE MANAGEMENT
// ============================================================

/**
 * Saves a note at the current timestamp.
 * Fetches the transcript if needed, finds the relevant line, and cleans it up.
 */
async function handleSaveNote(
  videoId,
  timestamp,
  videoTitle,
  channelName,
) {
  try {
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));

    // First, try to get the transcript from the digest cache. The side panel
    // saves digests to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and
    // refetched the transcript from Supadata on every saved note.
    let transcript = null;
    try {
      const cached = await chrome.storage.local.get(`digest_${videoId}`);
      if (cached[`digest_${videoId}`]?.transcript) {
        transcript = cached[`digest_${videoId}`].transcript;
        debugLog("[YouTube Digest] Using cached transcript for note");
      }
    } catch (e) {
      debugLog("[YouTube Digest] No cached transcript, fetching...");
    }

    // If no cached transcript, fetch it
    if (!transcript) {
      const transcriptResult = await handleFetchTranscript(videoId);
      if (!transcriptResult.success) {
        return { success: false, error: "Could not fetch transcript" };
      }
      transcript = transcriptResult.transcript;
    }

    // Find the transcript line at the current timestamp
    // Look for the line that contains this timestamp (or the closest one before)
    let matchedLine = null;
    let matchedIndex = 0;
    let contextLines = [];
    let beforeLine = null; // a few sentences before
    let afterLine = null; // a few sentences after

    for (let i = 0; i < transcript.length; i++) {
      const line = transcript[i];
      if (
        line.start <= safeTimestamp &&
        (!transcript[i + 1] || transcript[i + 1].start > safeTimestamp)
      ) {
        matchedLine = line;
        matchedIndex = i;

        // Build a buffer of 2 lines before and 4 lines after the target.
        // This gives the model enough text to find a natural sentence boundary
        // and complete a thought that spans multiple short caption chunks.
        const beforeLines = [];
        for (let j = 1; j <= 2 && i - j >= 0; j++) {
          beforeLines.unshift(transcript[i - j].text);
        }
        if (beforeLines.length > 0) {
          beforeLine = beforeLines.join(" ");
        }

        const afterLines = [];
        for (let j = 1; j <= 4 && i + j < transcript.length; j++) {
          afterLines.push(transcript[i + j].text);
        }
        if (afterLines.length > 0) {
          afterLine = afterLines.join(" ");
        }

        // Get broader context (8 lines before and 12 lines after) for understanding
        const startIdx = Math.max(0, i - 8);
        const endIdx = Math.min(transcript.length - 1, i + 12);
        for (let j = startIdx; j <= endIdx; j++) {
          contextLines.push(transcript[j].text);
        }
        break;
      }
    }

    if (!matchedLine) {
      // Fallback: use the last line if timestamp is beyond transcript
      matchedLine = transcript[transcript.length - 1];
      matchedIndex = transcript.length - 1;

      // Get buffer sentence (only before, since we're at the end)
      const beforeLines = [];
      for (let j = 1; j <= 2 && matchedIndex - j >= 0; j++) {
        beforeLines.unshift(transcript[matchedIndex - j].text);
      }
      if (beforeLines.length > 0) {
        beforeLine = beforeLines.join(" ");
      }

      const startIdx = Math.max(0, matchedIndex - 8);
      for (let j = startIdx; j <= matchedIndex; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    // Clean up the text with DeepSeek.
    const cleanedText = await cleanupNoteText(
      matchedLine.text,
      beforeLine,
      afterLine,
      contextLines.join(" "),
      videoTitle,
    );

    // Format timestamp as MM:SS
    const minutes = Math.floor(safeTimestamp / 60);
    const seconds = safeTimestamp % 60;
    const formattedTimestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    // Create timestamped URL
    const timestampedUrl = `${canonicalVideoUrl}&t=${safeTimestamp}s`;

    // Create the note object
    const note = {
      id: `note_${Date.now()}`,
      videoId: videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Video",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: formattedTimestamp,
      timestampSeconds: safeTimestamp,
      timestampedUrl: timestampedUrl,
      text: cleanedText,
      rawText: matchedLine.text,
      createdAt: Date.now(),
    };

    // Save to storage
    await saveNoteToStorage(note);

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    return { success: true, note };
  } catch (error) {
    console.error("[YouTube Digest] Save note error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Cleans up transcript lines using DeepSeek.
 * Takes the target line plus buffer sentences (1 before, 1 after).
 * Uses JSON output to prevent any preambles from appearing.
 */
async function cleanupNoteText(
  targetText,
  beforeText,
  afterText,
  fullContext,
  videoTitle,
) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    return [beforeText, targetText, afterText].filter(Boolean).join(" ");
  }

  try {
    debugLog("[YouTube Digest] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "note-cleanup.md",
      "User prompt",
      variables,
    );
    const { text: resultText } = await requestAiCompletion({
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let result = resultText.trim() || targetText;

    // Parse the JSON response (tolerating trailing commas / fences).
    try {
      const parsed = parseLooseJson(result);
      if (typeof parsed.quote === "string" && parsed.quote.trim()) {
        return parsed.quote.trim().slice(0, 3000);
      }
    } catch (parseError) {
      console.warn(
        "[YouTube Digest] JSON parse failed for note, stripping preambles:",
        parseError,
      );
      result = result.replace(
        /^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i,
        "",
      );
      result = result.replace(
        /^(The cleaned (quote|text|version)( is)?:?\s*)/i,
        "",
      );
      result = result.replace(/^(I will.*?:?\s*)/i, "");
      result = result.replace(/^(Cleaned:?\s*)/i, "");
      result = result.replace(/^["']|["']$/g, "");
    }

    return result.slice(0, 3000);
  } catch (e) {
    console.error("[YouTube Digest] Cleanup error:", e);
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(" ");
}

/**
 * Saves a note to chrome.storage.local
 */
async function saveNoteToStorage(note) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes = result.ytd_notes || [];
  notes.unshift(note); // Add to beginning (newest first)

  // Keep only last 100 notes to prevent storage bloat
  if (notes.length > 100) {
    notes.splice(100);
  }

  await chrome.storage.local.set({ ytd_notes: notes });
}

/**
 * Gets notes from storage, optionally filtered by video ID
 */
async function handleGetNotes(videoId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];

    if (videoId) {
      notes = notes.filter((n) => n.videoId === videoId);
    }

    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Deletes a note by ID
 */
async function handleDeleteNote(noteId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];
    notes = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ ytd_notes: notes });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "DeepSeek API key not configured.",
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[YouTube Digest] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    console.error("Explain selection error:", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
    };
  }
}

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - Must be 'zh'
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  if (targetLanguage !== "zh") {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = "Simplified Chinese";
  const langSpecific = await loadPromptSection(
    "translation.md",
    "Chinese rules",
  );
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) {
    throw new Error("Transcript translation requires 1 to 4 segments");
  }

  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Aligns untrusted model output by exact stable ID. Missing, duplicated,
 * unknown, empty, or clearly non-Chinese values become explicit row errors.
 */
function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid Chinese translation",
    })),
  };
}

/**
 * Translates content using DeepSeek.
 * @param {Object} content - JSON object containing semantic transcript segments
 * @param {string} contentType - Must be 'transcriptBatch'
 * @param {string} targetLanguage - 'zh' for Simplified Chinese
 * @param {string} videoTitle - The video title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(
  content,
  contentType,
  targetLanguage,
  videoTitle,
) {
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
      };
    }
    if (contentType !== "transcriptBatch") {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
      };
    }

    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "DeepSeek API key not configured" };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules(targetLanguage);
    const systemPrompt = await loadPromptSection(
      "translation.md",
      "Transcript batch translation",
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const userContent = JSON.stringify({ segments: sourceSegments });
    const translationOptions = {
      temperature: 0.2,
      maxTokens: 1536,
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      userContent,
      translationOptions,
    );

    // DeepSeek JSON mode can rarely return an empty content string. The prompt
    // already requires JSON, so retry once without response_format.
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(systemPrompt, userContent, {
        temperature: translationOptions.temperature,
        maxTokens: translationOptions.maxTokens,
      });
    }
    if (!result.success) return result;

    const parsed = parseLooseJson(result.text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "Translation returned no valid Chinese segments",
      };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    console.error("[YouTube Digest] Translation error:", error);
    return { success: false, error: error.message || "Translation failed" };
  }
}

/**
 * Makes a single DeepSeek call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callAiTranslation(
  systemPrompt,
  userContent,
  { temperature = 0.3, maxTokens = 8192, responseFormat } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      responseFormat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    return { success: true, text };
  } catch (error) {
    if (error.status === 429) {
      return {
        success: false,
        error: "Rate limited — try again in a moment",
        code: "RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  handleFetchTranscript,
  supadataErrorDetail,
  requestAiCompletion,
  callAiTranslation,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleTranslateContent,
  normalizeSubtitleOverlayMode,
  normalizeSubtitleOverlayTrack,
  subtitleOverlayStorageKey,
  subtitleSessionMatches,
  subtitleSessionSnapshot,
  startSubtitleSession,
  endSubtitleSession,
  buildSubtitleTrack,
  getSubtitleSession: () => subtitleSession,
  getOpenSidePanelTabs: () => [...openSidePanelTabs],
  getPanelsHiddenForFullscreen: () => [...panelsHiddenForFullscreen],
  markSidePanelOpen,
  markSidePanelClosed,
};
