/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for YouTube Digest: video detection, transcript analysis,
 * rendering results, and export features.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// STATE
// ============================================================

let currentVideoId = null;
let currentVideoUrl = null;
let currentAnalysis = null;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptTimestamped = null; // With timestamps for AI analysis
let currentTranscriptLanguage = null;
let currentVideoTitle = "";
let currentChannelName = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let isAnalysisLoading = false; // Track if analysis is in progress
let youtubeTabId = null; // Store the YouTube tab ID for reliable messaging
let errorAction = null;

// --- Translation state ---
// The public transcript control intentionally supports only the original
// subtitles, Chinese, and an aligned source + Chinese view.
let currentTranscriptMode = "original";
// Which layout the transcript list is currently drawn in. Lets an incoming
// translation batch patch rows in place instead of rebuilding the list.
let renderedTranscriptMode = "original";
// Set when the reader picks a view in the panel, so a later player update does
// not yank them back. Cleared for every new video.
let transcriptModePinnedByUser = false;
// Older versions translated readable side-panel paragraphs separately. Keep
// that cache only as a migration fallback so already-paid translations remain
// useful; all new translation work uses the timestamp-accurate player cues.
let transcriptParagraphCache = new Map();
// Player cues use shorter, timestamp-accurate units than the readable side-panel
// paragraphs. Keeping their cache separate prevents a paragraph translation from
// ever being displayed against only part of the source sentence.
let playerSubtitleCueCache = new Map();
// --- Auto-scroll state (follow video playback in transcript) ---
let autoScrollEnabled = true; // True = scroll transcript to follow video playback
let autoScrollInterval = null; // setInterval ID for polling video time
let lastAutoScrollTime = 0; // Timestamp of last programmatic scroll (ignores scroll events within 1s)

// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
});

// Caption normalization, short-cue segmentation, and cue cache keys are shared
// with the background worker so both sides derive the exact same cue IDs — a
// translation paid for by the player is therefore reused here for free.
const {
  normalizeCaptionText,
  splitOversizedThought,
  buildPlayerSubtitleCues,
  playerSubtitleCueCacheKey: buildPlayerSubtitleCueCacheKey,
} = YTD_SUBTITLE_UNITS;

/**
 * Reconstructs complete sentences across raw caption boundaries. Each segment
 * keeps the timestamp of the first caption that contributed text. Character
 * and time limits prevent a malformed Supadata entry from becoming one giant
 * row while punctuation remains the preferred boundary.
 */
function groupTranscriptEntries(entries, limits = TRANSCRIPT_SEGMENT_LIMITS) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const pieces = [];
  entries.forEach((entry, entryIndex) => {
    const text = normalizeCaptionText(entry?.text);
    if (!text) return;
    const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0;
    const duration = Math.max(0, Number(entry.duration) || 0);
    const sentenceParts =
      text.match(/[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) ||
      [text];
    let consumedChars = 0;

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart);
      if (!cleanPart) return;
      const oversizedParts = splitOversizedThought(cleanPart, limits.maxChars);
      oversizedParts.forEach((part, partIndex) => {
        const ratio = text.length ? Math.min(1, consumedChars / text.length) : 0;
        pieces.push({
          text: part,
          start: start + duration * ratio,
          semanticEnd:
            /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
            oversizedParts.length > 1,
          clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
          sourceOrder: `${entryIndex}:${partIndex}`,
        });
        consumedChars += part.length + 1;
      });
    });
  });

  const grouped = [];
  let current = null;

  const flush = () => {
    if (!current || !current.text.trim()) return;
    const index = grouped.length;
    const text = normalizeCaptionText(current.text);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      text,
      texts: [text],
    });
    current = null;
  };

  pieces.forEach((piece) => {
    if (!current) current = { start: piece.start, text: "" };
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
    const elapsed = Math.max(0, piece.start - current.start);
    const comfortablySized = current.text.length >= limits.minChars;
    const reachedIdeal = current.text.length >= limits.idealChars;
    const atNaturalBoundary =
      piece.semanticEnd ||
      (piece.clauseEnd &&
        (reachedIdeal ||
          current.text.length >= limits.maxChars ||
          elapsed >= limits.maxSeconds));
    const reachedGuardrail =
      atNaturalBoundary &&
      (current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds);
    const reachedHardGuardrail =
      current.text.length >= Math.round(limits.maxChars * 1.2) ||
      elapsed >= limits.maxSeconds + 5;

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedGuardrail ||
      reachedHardGuardrail
    ) {
      flush();
    }
  });
  flush();

  return grouped;
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  await evictOldCacheEntries(20);

  const configStatus = await chrome.runtime.sendMessage({
    action: "checkConfig",
  });

  if (!configStatus.hasSupadataKey || !configStatus.hasAiKey) {
    showConfigError(configStatus);
    return;
  }

  await checkCurrentTab();
});

// Listen for messages from the Digest button on YouTube page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startDigestFromButton") {
    // Load the digest for the current video. Served from cache when we've
    // seen this video before (no API calls); fetched fresh otherwise.
    // (This used to force-clear the cache on every click, which silently
    // burned a transcript credit + analysis tokens per click.)
    checkCurrentTab();
    sendResponse({ success: true });
  }
  if (message.action === "transcriptProgress") {
    // Background is telling us the transcript fetch status changed
    updateLoading(message.title, message.subtitle);
    sendResponse({ success: true });
  }
  if (message.action === "noteSaved") {
    // Refresh notes list when a new note is saved
    const filterAll = document
      .getElementById("notesFilterAll")
      ?.classList.contains("active");
    loadNotes(filterAll ? null : currentVideoId);
    sendResponse({ success: true });
  }
  if (message.action === "subtitleSessionChanged") {
    // The player switched subtitles on, off, or between 中 and 双. Follow it.
    if (!message.videoId || message.videoId === currentVideoId) {
      applyTranscriptModeFromPlayer(message.mode);
      if (message.mode === "off") setTranslatingSpinner(false);
    }
    sendResponse({ success: true });
  }
  if (message.action === "subtitleTrackUpdated") {
    handleSubtitleTrackUpdate(message.videoId, message.track, message.mode);
    setTranslatingSpinner(false);
    sendResponse({ success: true });
  }
  return false;
});

// ============================================================
// FOLLOW THE ACTIVE TAB
// ============================================================
// The panel watches which tab is in front of it and reacts:
//   - Front tab is NOT YouTube  -> the panel closes itself (window.close()).
//     We do this OURSELVES rather than relying only on the background
//     script's per-tab enable/disable, because Chrome doesn't reliably
//     apply per-tab panel state to tabs spawned in unusual ways (e.g. a
//     link opened from another app) — which let the panel linger on
//     non-YouTube pages.
//   - Front tab IS YouTube but on a different video -> refresh the digest.
//     YouTube is a single-page app (clicking a video swaps content without
//     a reload), so we track URL changes; startDigest() caches per video,
//     making re-checks instant and free for already-digested videos.
//
// Everything is scoped to the window this panel lives in: tab switches in
// OTHER browser windows must not close this panel or hijack its content.

let navigationRefreshTimer = null;
let panelWindowId = null;
chrome.windows.getCurrent().then((w) => {
  panelWindowId = w.id;
});

function scheduleDigestRefresh() {
  // Small delay lets YouTube finish rendering the new video's title and
  // description before we read them. Also collapses rapid-fire URL events
  // into a single refresh.
  clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => {
    checkCurrentTab();
  }, 600);
}

function panelIsShowingResults() {
  const results = document.getElementById("resultsState");
  return results && results.style.display !== "none";
}

/**
 * Reacts to the URL now in front of the panel: close on non-YouTube,
 * refresh the digest when the video changed.
 */
function handleFrontTabUrl(url) {
  if (!(url || "").startsWith("https://www.youtube.com")) {
    // Panel is a YouTube-only tool — remove itself from non-YouTube tabs.
    window.close();
    return;
  }

  const newVideoId = extractVideoId(url);
  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video).
  if (newVideoId !== currentVideoId || !panelIsShowingResults()) {
    scheduleDigestRefresh();
  }
}

// Fires when a tab's URL changes — including YouTube's no-reload navigation.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab.active) return;
  if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
  handleFrontTabUrl(changeInfo.url);
});

// Fires when a different tab comes to the front — switching tabs, or a new
// tab being opened (including ones opened by clicking links in other apps).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (panelWindowId !== null && windowId !== panelWindowId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Brand-new tabs may not have committed their URL yet — fall back to
    // the pending one so we judge where the tab is actually going.
    handleFrontTabUrl(tab.url || tab.pendingUrl || "");
  } catch (e) {
    // Tab closed before we could read it — nothing to do.
  }
});

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Error retry
  document.getElementById("errorBtn").addEventListener("click", () => {
    if (errorAction) {
      errorAction();
      return;
    }
    if (currentVideoId) {
      startDigest(currentVideoId, currentVideoUrl);
    }
  });

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  // Transcript actions
  document
    .getElementById("copyTranscriptBtn")
    ?.addEventListener("click", copyTranscript);
  document
    .getElementById("exportTranscriptBtn")
    ?.addEventListener("click", exportTranscript);
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      handleTranscriptModeChange(button.dataset.transcriptMode);
    });
  });

  // Follow playback button — re-enables auto-scroll after user scrolled away
  document
    .getElementById("followPlaybackBtn")
    ?.addEventListener("click", () => {
      autoScrollEnabled = true;
      document.getElementById("followPlaybackBtn").style.display = "none";
      // Jump straight back to the line currently being spoken. We scroll
      // directly (not via playbackTrackingTick) because the tick skips
      // entries that are already highlighted — and the current line almost
      // always IS highlighted, which made this button appear to do nothing.
      if (!scrollToActiveEntry()) {
        playbackTrackingTick(); // No highlight yet — let a tick establish one
      }
    });

  // Notes filter buttons
  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    setNotesFilter(false);
    loadNotes(currentVideoId);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    setNotesFilter(true);
    loadNotes(null); // Load all notes
  });
}

function setNotesFilter(showAll) {
  const thisVideoButton = document.getElementById("notesFilterThis");
  const allNotesButton = document.getElementById("notesFilterAll");
  thisVideoButton?.classList.toggle("active", !showAll);
  thisVideoButton?.setAttribute("aria-pressed", String(!showAll));
  allNotesButton?.classList.toggle("active", showAll);
  allNotesButton?.setAttribute("aria-pressed", String(showAll));
}

// ============================================================
// VIDEO DETECTION
// ============================================================

async function checkCurrentTab() {
  try {
    // Try multiple strategies to find the YouTube tab
    let tab = null;

    // Strategy 1: Active tab in last focused window
    let tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tabs[0]?.url?.includes("youtube.com")) {
      tab = tabs[0];
    }

    // Strategy 2: Any active YouTube tab
    if (!tab) {
      tabs = await chrome.tabs.query({
        url: "https://www.youtube.com/*",
        active: true,
      });
      if (tabs[0]) tab = tabs[0];
    }

    // Strategy 3: Any YouTube tab (last resort)
    if (!tab) {
      tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
      if (tabs[0]) tab = tabs[0];
    }

    debugLog("[YouTube Digest Panel] Found tab:", tab?.id, tab?.url);

    if (!tab?.url) {
      showState("welcome");
      return;
    }

    // Store the tab ID for reliable messaging later
    youtubeTabId = tab.id;

    const videoId = extractVideoId(tab.url);

    if (videoId) {
      currentVideoUrl = tab.url;

      try {
        // Route through background script for reliable message passing
        const result = await chrome.runtime.sendMessage({
          action: "relayToContent",
          payload: { action: "getVideoInfo" },
        });
        debugLog("[YouTube Digest Panel] getVideoInfo result:", result);
        if (result.success && result.response) {
          currentVideoTitle = result.response.title || "";
          currentChannelName = result.response.channelName || "";
          currentVideoDescription = result.response.description || "";
          currentVideoDuration = result.response.duration || 0;
        }
      } catch (e) {
        console.error("[YouTube Digest Panel] getVideoInfo error:", e);
        currentVideoTitle = "";
        currentChannelName = "";
        currentVideoDescription = "";
        currentVideoDuration = 0;
      }

      startDigest(videoId, tab.url);
    } else {
      showState("welcome");
    }
  } catch (error) {
    console.error("Tab check error:", error);
    showState("welcome");
  }
}

function extractVideoId(url) {
  try {
    const urlObj = new URL(url);

    if (
      urlObj.hostname.includes("youtube.com") &&
      urlObj.searchParams.has("v")
    ) {
      return urlObj.searchParams.get("v");
    }

    if (urlObj.hostname === "youtu.be") {
      return urlObj.pathname.slice(1);
    }

    if (urlObj.pathname.startsWith("/embed/")) {
      return urlObj.pathname.split("/")[2];
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

async function startDigest(videoId, videoUrl) {
  // Check if we already have this video loaded in memory
  if (videoId === currentVideoId && currentAnalysis) {
    showState("results");
    return;
  }

  // A new video always starts from the original transcript. Chinese reappears
  // only if the player reports that the user switched it on for THIS video.
  if (videoId !== currentVideoId) {
    currentTranscriptMode = "original";
    transcriptModePinnedByUser = false;
    setTranscriptModeButtons("original");
    setTranslatingSpinner(false);
  }

  // Check cache for this video
  const cached = await loadFromCache(videoId);
  if (cached) {
    debugLog("Loading from cache:", videoId);
    currentVideoId = videoId;
    currentVideoUrl = videoUrl;
    currentAnalysis = cached.analysis || null;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptTimestamped = cached.transcriptTimestamped;
    currentTranscriptLanguage = cached.transcriptLanguage || null;
    isAnalysisLoading = false;

    // Restore semantic-segment translations from persistent storage.
    if (cached.paragraphCache) {
      for (const [key, value] of Object.entries(cached.paragraphCache)) {
        transcriptParagraphCache.set(key, value);
      }
    }
    if (cached.playerCueCache) {
      for (const [key, value] of Object.entries(cached.playerCueCache)) {
        playerSubtitleCueCache.set(key, value);
      }
    }

    if (currentVideoTitle || currentChannelName) {
      const videoInfo = document.getElementById("videoInfo");
      document.getElementById("videoTitle").textContent = currentVideoTitle;
      document.getElementById("videoChannel").textContent = currentChannelName;
      videoInfo.style.display = "block";
    }

    // Always render transcript first
    renderTranscript();

    // Render analysis if we have it cached
    if (currentAnalysis) {
      renderAnalysisResults(currentAnalysis);
      highlightMomentsOnPage(currentAnalysis.keyMoments);
    }

    showState("results");
    document.getElementById("tabsNav").style.display = "flex";

    // Load notes for this video
    loadNotes(videoId);

    // Setup explain feature
    setupExplainFeature();
    // Mirror the player's current subtitle state. Reads cache only.
    syncSubtitleStateFromPlayer(videoId);
    return;
  }

  currentVideoId = videoId;
  currentVideoUrl = videoUrl;
  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;
  isAnalysisLoading = false;
  playerSubtitleCueCache = new Map();

  if (currentVideoTitle || currentChannelName) {
    const videoInfo = document.getElementById("videoInfo");
    document.getElementById("videoTitle").textContent = currentVideoTitle;
    document.getElementById("videoChannel").textContent = currentChannelName;
    videoInfo.style.display = "block";
  }

  showState("loading");
  updateLoading("Fetching transcript", "");

  const transcriptResult = await chrome.runtime.sendMessage({
    action: "fetchTranscript",
    videoId: videoId,
  });

  if (!transcriptResult.success) {
    if (transcriptResult.error === "NO_SUPADATA_KEY") {
      showError(
        "API key missing",
        "Add your Supadata API key in YouTube Digest Settings.",
      );
      return;
    }
    showError(
      "No transcript found",
      transcriptResult.message || transcriptResult.error,
    );
    return;
  }

  currentTranscript = transcriptResult.transcript;
  currentTranscriptText = transcriptResult.transcriptText;
  currentTranscriptTimestamped = transcriptResult.transcriptTextTimestamped;
  currentTranscriptLanguage = transcriptResult.language || null;

  // Render transcript immediately (no LLM needed)
  renderTranscript();
  showState("results");
  document.getElementById("tabsNav").style.display = "flex";

  // Load notes for this video
  loadNotes(videoId);

  // Setup explain feature for text selection
  setupExplainFeature();
  syncSubtitleStateFromPlayer(videoId);

  // Save transcript to cache (without analysis)
  await saveToCache(videoId);

  // DON'T run LLM analysis automatically - wait for user to click Overview tab
  // This saves tokens when user just wants to see the transcript
}

// ============================================================
// RENDERING
// ============================================================

/**
 * Renders the analysis results into the Overview tab.
 * Shows chapters and key quotes only.
 */
function renderAnalysisResults(analysis) {
  // Chapters
  const chapterList = document.getElementById("chapterList");
  chapterList.innerHTML = "";
  (analysis.chapters || []).forEach((chapter) => {
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.dataset.seconds = chapter.timestampSeconds;
    li.innerHTML = `
      <span class="chapter-timestamp">${escapeHtml(chapter.timestamp)}</span>
      <div class="chapter-content">
        <span class="chapter-title">${escapeHtml(chapter.title)}</span>
        <span class="chapter-summary">${escapeHtml(chapter.summary || "")}</span>
      </div>
    `;
    li.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Chapter clicked:",
        chapter.timestamp,
        chapter.timestampSeconds,
      );
      seekTo(chapter.timestampSeconds);
    });
    chapterList.appendChild(li);
  });

  // Quotes - sort by timestamp (chronological order)
  const quotesList = document.getElementById("quotesList");
  quotesList.innerHTML = "";
  const sortedQuotes = [...(analysis.keyQuotes || [])].sort(
    (a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0),
  );
  sortedQuotes.forEach((quote) => {
    const div = document.createElement("div");
    div.className = "quote-item";
    div.dataset.seconds = quote.timestampSeconds;
    div.innerHTML = `
      <div class="quote-text">${escapeHtml(quote.quote)}</div>
      <div class="quote-meta">
        <span class="quote-timestamp">${escapeHtml(quote.timestamp)}</span>
        <div class="quote-actions">
          <button class="quote-save-note-btn" title="Save this quote as a note">📝 Note</button>
          <button class="quote-copy-btn" title="Copy this quote">⧉ Copy</button>
        </div>
      </div>
    `;
    div.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Quote clicked:",
        quote.timestamp,
        quote.timestampSeconds,
      );
      seekTo(quote.timestampSeconds);
    });

    const quoteCopyBtn = div.querySelector(".quote-copy-btn");
    quoteCopyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(quote.quote);
        quoteCopyBtn.textContent = "✓ Copied";
        setTimeout(() => {
          quoteCopyBtn.textContent = "⧉ Copy";
        }, 1500);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

    const quoteSaveNoteBtn = div.querySelector(".quote-save-note-btn");
    quoteSaveNoteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await saveQuoteAsNote(quote, quoteSaveNoteBtn);
    });

    quotesList.appendChild(div);
  });
}

/**
 * Saves a key quote as a timestamped note.
 */
async function saveQuoteAsNote(quote, btn) {
  if (!currentVideoId) return;

  const originalText = btn.textContent;
  btn.textContent = "Saving...";
  btn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: currentVideoId,
      timestamp: quote.timestampSeconds,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
    });

    if (result.success) {
      btn.textContent = "✓ Saved";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
      // Refresh notes list if on Notes tab
      loadNotes(currentVideoId);
    } else {
      console.error("[YouTube Digest] Save quote as note failed:", result.error);
      btn.textContent = "Error";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    }
  } catch (error) {
    console.error("[YouTube Digest] Save quote as note error:", error);
    btn.textContent = "Error";
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  }
}

/**
 * Legacy function for backwards compatibility with cached data.
 * Renders both transcript and analysis.
 */
function renderResults(analysis) {
  renderAnalysisResults(analysis);

  renderTranscript();

  document.getElementById("tabsNav").style.display = "flex";

  // Setup explain feature for text selection
  setupExplainFeature();
}

/**
 * Returns true while the user has a range of text selected.
 * Transcript row clicks must not seek in that state: the click emitted after
 * selection mouseup belongs to the selection/explain interaction, not playback.
 */
function hasNonCollapsedTextSelection() {
  const selection = window.getSelection();
  return Boolean(
    selection && selection.rangeCount > 0 && !selection.isCollapsed,
  );
}

/**
 * Preserves normal row-click seeking while keeping text selection inert.
 */
function seekFromTranscriptEntryClick(event, seconds) {
  if (hasNonCollapsedTextSelection()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  seekTo(seconds);
}

function renderTranscript() {
  if (!currentTranscript) return;
  renderedTranscriptMode = "original";

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  // Show a small badge indicating the transcript came from the video's
  // existing subtitles. (We no longer AI-transcribe audio, so subtitles
  // are the only source.)
  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> From video subtitles · ${escapeHtml(getOriginalTranscriptLabel())}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = groupTranscriptEntries(currentTranscript);

  grouped.forEach((group) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = group.start;

    const minutes = Math.floor(group.start / 60);
    const seconds = Math.floor(group.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      <span class="transcript-text">${renderSubtitleInlineMarkup(group.text)}</span>
    `;

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, group.start),
    );
    transcriptList.appendChild(div);
  });

  // Keep the mode control honest about what this transcript can show.
  updateTranscriptModeAvailability();

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

function copyTranscript() {
  copyToClipboardWithFeedback(currentTranscriptText || "", "copyTranscriptBtn");
}

function exportTranscript() {
  const transcriptContent = currentTranscriptText || "";
  const videoUrl = `https://youtube.com/watch?v=${currentVideoId}`;

  let exportText = "";
  exportText += `TRANSCRIPT\n`;
  exportText += `${"=".repeat(60)}\n\n`;
  exportText += `Title: ${currentVideoTitle || "Unknown"}\n`;
  exportText += `Channel: ${currentChannelName || "Unknown"}\n`;
  exportText += `URL: ${videoUrl}\n`;
  exportText += `\n${"—".repeat(60)}\n\n`;

  if (currentVideoDescription) {
    exportText += `DESCRIPTION:\n${currentVideoDescription}\n`;
    exportText += `\n${"—".repeat(60)}\n\n`;
  }

  exportText += `TRANSCRIPT:\n\n${transcriptContent}\n`;
  exportText += `\n${"—".repeat(60)}\n`;
  exportText += `Exported by YouTube Digest\n`;

  const filename = `${sanitizeFilename(currentVideoTitle)}-transcript.txt`;
  downloadTextFile(exportText, filename);
}

// ============================================================
// UI STATE MANAGEMENT
// ============================================================

function showState(state) {
  document.getElementById("welcomeState").style.display =
    state === "welcome" ? "flex" : "none";
  document.getElementById("loadingState").style.display =
    state === "loading" ? "block" : "none";
  document.getElementById("errorState").style.display =
    state === "error" ? "block" : "none";
  const uploadEl = document.getElementById("uploadState");
  if (uploadEl) uploadEl.style.display = "none"; // Upload state removed — always hidden
  document.getElementById("resultsState").style.display =
    state === "results" ? "block" : "none";

  // The tab bar only belongs on the results view. We toggle it HERE, in one
  // place, so it tracks the view automatically. Previously each caller had to
  // remember to re-show it after showState("results"), and one path forgot —
  // which is why the tabs could vanish when re-opening an already-analyzed video.
  document.getElementById("tabsNav").style.display =
    state === "results" ? "flex" : "none";

  if (state !== "results") {
    stopPlaybackTracking();
  }
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
}

function showError(title, message) {
  errorAction = null;
  showState("error");
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorBtn").textContent = "Try Again";
}

function showConfigError(configStatus) {
  const missingKeys = [];
  if (!configStatus.hasSupadataKey) missingKeys.push("Supadata");
  if (!configStatus.hasAiKey) missingKeys.push("AI provider");

  showState("error");
  document.getElementById("errorTitle").textContent = "API Keys Missing";
  document.getElementById("errorMessage").textContent =
    `Add your ${missingKeys.join(" and ")} API key${missingKeys.length === 1 ? "" : "s"} in YouTube Digest Settings.`;
  document.getElementById("errorBtn").textContent = "Open Settings";
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

// ============================================================
// TAB SWITCHING
// ============================================================

function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });

  // Start/stop playback tracking based on which tab is active
  if (tabName === "transcript") {
    startPlaybackTracking();
  } else {
    stopPlaybackTracking();
  }

  // Lazy-load LLM analysis when user switches to Overview tab
  if (tabName === "overview" && !currentAnalysis && !isAnalysisLoading) {
    triggerAnalysis();
  }
}

/**
 * Triggers the LLM analysis (lazy-loaded when user clicks Overview or Quotes tab).
 * This saves tokens by not running analysis until needed.
 */
async function triggerAnalysis() {
  if (!currentTranscriptTimestamped || isAnalysisLoading || currentAnalysis)
    return;

  isAnalysisLoading = true;

  // Show loading indicators in the Overview tab
  const chapterList = document.getElementById("chapterList");
  const quotesList = document.getElementById("quotesList");

  if (chapterList)
    chapterList.innerHTML =
      '<li class="chapter-item" style="color: var(--text-muted); border: none;">Loading chapters...</li>';
  if (quotesList)
    quotesList.innerHTML =
      '<div class="quote-item" style="color: var(--text-muted); border-left-color: var(--border);">Loading quotes...</div>';

  try {
    const analysisResult = await chrome.runtime.sendMessage({
      action: "analyzeTranscript",
      transcriptText: currentTranscriptTimestamped,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoDescription: currentVideoDescription,
      videoDuration: currentVideoDuration,
    });

    if (!analysisResult.success) {
      if (chapterList)
        chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">Analysis failed: ${escapeHtml(analysisResult.error || "Unknown error")}</li>`;
      isAnalysisLoading = false;
      return;
    }

    currentAnalysis = analysisResult.analysis;
    renderAnalysisResults(currentAnalysis);
    highlightMomentsOnPage(currentAnalysis.keyMoments);

    // Save to cache now that we have analysis
    await saveToCache(currentVideoId);
  } catch (error) {
    console.error("[YouTube Digest Panel] Analysis error:", error);
    if (chapterList)
      chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">Error: ${escapeHtml(error.message)}</li>`;
  }

  isAnalysisLoading = false;
}

// ============================================================
// TIMESTAMP / SEEK
// ============================================================

async function seekTo(seconds) {
  debugLog("[YouTube Digest Panel] seekTo called with:", seconds);
  if (seconds === undefined || seconds === null) {
    debugLog("[YouTube Digest Panel] seekTo aborted - no seconds value");
    return;
  }

  const payload = {
    action: "seekTo",
    seconds: Number(seconds),
  };

  try {
    // Try direct messaging to the stored YouTube tab first (fastest/reliable)
    if (youtubeTabId) {
      try {
        await chrome.tabs.sendMessage(youtubeTabId, payload);
        debugLog("[YouTube Digest Panel] seekTo direct success");
        return;
      } catch (directErr) {
        debugLog(
          "[YouTube Digest Panel] Direct seekTo failed, falling back to relay:",
          directErr.message,
        );
      }
    }

    // Fallback: route through background script
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload,
    });
    debugLog("[YouTube Digest Panel] seekTo relay result:", result);
  } catch (error) {
    console.error("[YouTube Digest Panel] seekTo error:", error);
  }
}

/**
 * Plays a saved note at its timestamp.
 * - If the note belongs to the video currently open, we seek the player in place.
 * - If it belongs to a DIFFERENT video (e.g. viewing "All Notes"), seeking the
 *   current player would jump to the wrong content, so we open that video in a
 *   new tab at the right timestamp instead.
 */
function playNote(note) {
  if (note.videoId && note.videoId === currentVideoId) {
    seekTo(note.timestampSeconds);
  } else {
    // note.timestampedUrl already includes the &t=<seconds>s anchor
    chrome.tabs.create({ url: note.timestampedUrl });
  }
}

async function highlightMomentsOnPage(moments) {
  if (!moments || !moments.length) return;

  try {
    // Route through background script for reliable message passing
    await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: {
        action: "highlightMoments",
        moments: moments,
        videoDuration: currentVideoDuration,
      },
    });
  } catch (error) {
    console.error("Highlight error:", error);
  }
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

/**
 * Renders the small subset of inline formatting commonly present in subtitle
 * tracks and model translations. Everything is escaped first; only exact,
 * attribute-free allowlisted tags are restored as markup afterwards.
 */
function renderSubtitleInlineMarkup(text) {
  return escapeHtml(text).replace(
    /&lt;(\/?)(i|em|b|strong|u)&gt;|&lt;br(?:\s*\/)?&gt;/gi,
    (_match, closing, tagName) =>
      tagName ? `<${closing}${tagName.toLowerCase()}>` : "<br>",
  );
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error("Copy failed:", error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId) {
  const btn = document.getElementById(buttonId);
  const original = btn.textContent;

  const success = await copyToClipboard(text);
  if (success) {
    btn.textContent = "✓ Copied";
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  }
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(str) {
  return (str || "untitled")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50)
    .toLowerCase();
}

// ============================================================
// TEXT SELECTION — EXPLAIN FEATURE
// ============================================================

/**
 * Sets up text selection handling in the transcript.
 * When user selects text, shows an "Explain" button.
 */
function setupExplainFeature() {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  // Remove existing tooltip if any
  const existingTooltip = document.getElementById("explainTooltip");
  if (existingTooltip) existingTooltip.remove();

  // Create the explain tooltip/button
  const tooltip = document.createElement("div");
  tooltip.id = "explainTooltip";
  tooltip.className = "explain-tooltip";
  tooltip.innerHTML = `<button class="explain-btn">💡 Explain</button>`;
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let selectedText = "";

  // Interacting with Explain must preserve the transcript selection and stay
  // isolated from document/row click behavior.
  tooltip.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  tooltip.addEventListener("mouseup", (event) => {
    event.stopPropagation();
  });
  tooltip.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  // Listen for text selection
  document.addEventListener("mouseup", (e) => {
    const selection = window.getSelection();
    const text = selection.toString().trim();

    // Only show if selecting within transcript
    const isInTranscript = transcriptList.contains(selection.anchorNode);

    // Allow any selection length (removed 10+ char requirement)
    if (text.length > 0 && isInTranscript) {
      selectedText = text;

      // Position the tooltip near the selection
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      tooltip.style.display = "block";
      tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
      tooltip.style.left = `${rect.left + rect.width / 2}px`;
    } else {
      tooltip.style.display = "none";
    }
  });

  // Hide tooltip when clicking elsewhere
  document.addEventListener("mousedown", (e) => {
    if (!tooltip.contains(e.target)) {
      tooltip.style.display = "none";
    }
  });

  // Handle explain button click
  tooltip
    .querySelector(".explain-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText) return;

      tooltip.style.display = "none";
      await showExplanation(selectedText);
    });
}

/**
 * Shows the explanation modal and fetches it from the configured AI provider.
 */
async function showExplanation(selectedText) {
  // Create modal
  const modal = document.createElement("div");
  modal.id = "explainModal";
  modal.className = "explain-modal-overlay";
  modal.innerHTML = `
    <div class="explain-modal">
      <div class="explain-modal-header">
        <div class="explain-modal-title">Explain</div>
        <button class="explain-modal-close" id="closeExplain">✕</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? "..." : ""}"</div>
      <div class="explain-modal-content" id="explanationContent">
        <div class="explain-loading">
          <div class="loading-bar"></div>
          <span>Analyzing...</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  document
    .getElementById("closeExplain")
    .addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  // Get some context around the selection from the transcript
  const transcriptContext = getTranscriptContext(selectedText);

  // Fetch explanation
  try {
    const result = await chrome.runtime.sendMessage({
      action: "explainSelection",
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle: currentVideoTitle,
    });

    const contentDiv = document.getElementById("explanationContent");
    if (result.success) {
      contentDiv.innerHTML = `<div class="explain-text">${escapeHtml(result.explanation).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</div>`;
    } else {
      contentDiv.innerHTML = `<div class="explain-error">Failed to get explanation: ${escapeHtml(result.error)}</div>`;
    }
  } catch (error) {
    const contentDiv = document.getElementById("explanationContent");
    contentDiv.innerHTML = `<div class="explain-error">Error: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText) {
  const fullText = currentTranscriptText || "";
  const index = fullText.indexOf(selectedText);

  if (index === -1) return "";

  // Get 200 chars before and after
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selectedText.length + 200);

  return fullText.substring(start, end);
}

// ============================================================
// CACHING
// ============================================================

/**
 * Saves the current digest results to persistent local storage.
 * Results survive browser restarts — reopening the same video loads from cache
 * without consuming API tokens or Supadata calls.
 * Cache expires after 30 days. Oldest entries evicted when > 20 videos cached.
 */
async function saveToCache(videoId) {
  if (!videoId || !currentTranscript) return;

  try {
    // Persist both readable paragraph translations and short player-cue
    // translations. Their keys intentionally differ because the boundaries do.
    const paragraphCacheForVideo = {};
    for (const [key, value] of transcriptParagraphCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        paragraphCacheForVideo[key] = value;
      }
    }
    const playerCueCacheForVideo = {};
    for (const [key, value] of playerSubtitleCueCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        playerCueCacheForVideo[key] = value;
      }
    }

    const cacheData = {
      analysis: currentAnalysis, // May be null if not yet analyzed
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptLanguage: currentTranscriptLanguage,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      paragraphCache: paragraphCacheForVideo,
      playerCueCache: playerCueCacheForVideo,
      timestamp: Date.now(),
    };

    await chrome.storage.local.set({ [`digest_${videoId}`]: cacheData });
    debugLog(
      "Saved to cache:",
      videoId,
      currentAnalysis ? "(with analysis)" : "(transcript only)",
    );

    // Evict old entries if we have more than 20 videos cached
    await evictOldCacheEntries(20);
  } catch (error) {
    console.error("Cache save error:", error);
  }
}

/**
 * Keeps the cache from growing unbounded.
 * Removes the oldest entries when we exceed maxEntries videos.
 *
 * @param {number} maxEntries - Maximum number of cached videos to keep
 */
async function evictOldCacheEntries(maxEntries) {
  try {
    const allData = await chrome.storage.local.get(null);
    let digestKeys = Object.keys(allData).filter((k) =>
      k.startsWith("digest_"),
    );
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = digestKeys.filter((key) => {
      const timestamp = Number(allData[key]?.timestamp) || 0;
      return Date.now() - timestamp > THIRTY_DAYS;
    });
    if (expired.length) {
      await chrome.storage.local.remove(expired);
      const expiredSet = new Set(expired);
      digestKeys = digestKeys.filter((key) => !expiredSet.has(key));
    }

    if (digestKeys.length <= maxEntries) return;

    // Sort by timestamp (oldest first) and remove excess
    const sorted = digestKeys
      .map((k) => ({ key: k, ts: allData[k]?.timestamp || 0 }))
      .sort((a, b) => a.ts - b.ts);

    const toRemove = sorted
      .slice(0, sorted.length - maxEntries)
      .map((e) => e.key);
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
      debugLog(`[YouTube Digest] Evicted ${toRemove.length} old cache entries`);
    }
  } catch (error) {
    console.error("Cache eviction error:", error);
  }
}

/**
 * Loads digest results from persistent local storage.
 * Returns null if not cached or expired (30-day expiry).
 */
async function loadFromCache(videoId) {
  if (!videoId) return null;

  try {
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    const cached = result[`digest_${videoId}`];

    if (!cached) return null;

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await chrome.storage.local.remove(`digest_${videoId}`);
      return null;
    }

    return cached;
  } catch (error) {
    console.error("Cache load error:", error);
    return null;
  }
}

/**
 * Updates the cache after enhance or translation operations.
 */
async function updateCache() {
  if (currentVideoId) {
    await saveToCache(currentVideoId);
  }
}

// ============================================================
// NOTES
// ============================================================

/**
 * Loads and renders notes from storage.
 * @param {string|null} videoId - Filter by video ID, or null for all notes
 */
async function loadNotes(videoId) {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getNotes",
      videoId: videoId,
    });

    if (result.success) {
      renderNotes(result.notes, videoId);
    }
  } catch (error) {
    console.error("[YouTube Digest Panel] Load notes error:", error);
  }
}

/**
 * Renders the notes list in the Notes tab.
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");

  if (!notesList) return;

  notesList.innerHTML = "";

  if (!notes || notes.length === 0) {
    notesIntro.style.display = "block";
    notesIntro.textContent = filteredVideoId
      ? "No notes for this video yet. Hover over the video and click 📝 Note to save."
      : "No notes saved yet. Hover over a video and click 📝 Note to save.";
    return;
  }

  notesIntro.style.display = "none";

  notes.forEach((note) => {
    const noteEl = document.createElement("div");
    noteEl.className = "note-item";
    noteEl.innerHTML = `
      <div class="note-header">
        <span class="note-timestamp" data-url="${escapeHtml(note.timestampedUrl)}" data-seconds="${Number(note.timestampSeconds) || 0}">${escapeHtml(note.timestamp)}</span>
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
        <button class="note-delete" data-id="${escapeHtml(note.id)}" title="Delete note">✕</button>
      </div>
      <div class="note-text">"${escapeHtml(note.text)}"</div>
      <div class="note-actions">
        <button class="note-action-btn note-copy-text">⧉ Copy text</button>
        <button class="note-action-btn note-copy-link" data-url="${escapeHtml(note.timestampedUrl)}">🔗 Copy timestamp</button>
        <button class="note-action-btn note-play" data-seconds="${Number(note.timestampSeconds) || 0}">▶ Play</button>
      </div>
    `;

    // Timestamp click - play from this point (in this tab or a new one)
    noteEl.querySelector(".note-timestamp").addEventListener("click", () => {
      playNote(note);
    });

    // Delete button
    noteEl
      .querySelector(".note-delete")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteNote(note.id);
        loadNotes(filteredVideoId);
      });

    // Copy text button — copies just the note's text
    noteEl
      .querySelector(".note-copy-text")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.text);
          const btn = noteEl.querySelector(".note-copy-text");
          btn.textContent = "✓ Copied!";
          setTimeout(() => {
            btn.textContent = "⧉ Copy text";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Copy timestamp button — copies the timestamped YouTube link
    noteEl
      .querySelector(".note-copy-link")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.timestampedUrl);
          const btn = noteEl.querySelector(".note-copy-link");
          btn.textContent = "✓ Copied!";
          setTimeout(() => {
            btn.textContent = "🔗 Copy timestamp";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Play button (in this tab if it's the current video, else a new tab)
    noteEl.querySelector(".note-play").addEventListener("click", () => {
      playNote(note);
    });

    notesList.appendChild(noteEl);
  });
}

/**
 * Deletes a note by ID.
 */
async function deleteNote(noteId) {
  try {
    await chrome.runtime.sendMessage({
      action: "deleteNote",
      noteId: noteId,
    });
  } catch (error) {
    console.error("[YouTube Digest Panel] Delete note error:", error);
  }
}

// ============================================================
// AUTO-SCROLL — Follow video playback in transcript
// ============================================================
// While a video plays, the transcript automatically scrolls to show which
// 30-second chunk is currently being spoken. If the user manually scrolls
// (e.g., to read ahead), auto-scroll pauses and a "Follow playback" button
// appears so they can resume it. Highlight always stays active regardless.

/**
 * Starts polling the video's current time and highlighting/scrolling
 * to the matching transcript entry.
 */
function startPlaybackTracking() {
  if (!currentTranscript || !currentTranscript.length) return;

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  autoScrollEnabled = true;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Poll video time every 500ms
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);

  // Listen for manual scrolls on the content area
  const contentArea = document.getElementById("contentArea");
  contentArea.removeEventListener("scroll", onContentAreaScroll);
  contentArea.addEventListener("scroll", onContentAreaScroll);
}

/**
 * Stops playback tracking entirely. Called when leaving transcript tab,
 * starting a new digest, or leaving results state.
 */
function stopPlaybackTracking() {
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  autoScrollEnabled = true; // Reset for next time
  lastAutoScrollTime = 0;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Remove active highlights
  document
    .querySelectorAll(".transcript-entry.active-playback")
    .forEach((el) => {
      el.classList.remove("active-playback");
    });
}

/**
 * One tick of the playback tracker. Gets current video time from the
 * YouTube tab and highlights + scrolls to the matching transcript entry.
 */
async function playbackTrackingTick() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: { action: "getCurrentTime" },
    });

    if (!result.success || !result.response) return;

    // Auto-scroll only. Following playback never queues translation work —
    // the player owns that, and only after the user switched subtitles on.
    highlightActiveEntry(result.response.currentTime || 0);
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away
  }
}

/**
 * Scrolls the transcript to the entry currently being spoken (the one
 * carrying the active-playback highlight). Returns false if nothing is
 * highlighted yet. Stamps lastAutoScrollTime BEFORE scrolling so the scroll
 * events from our own smooth animation aren't mistaken for the user
 * scrolling away (which would re-disable auto-scroll immediately).
 */
function scrollToActiveEntry() {
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!activeEntry) return false;

  lastAutoScrollTime = Date.now();
  activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  const entries = transcriptList.querySelectorAll(".transcript-entry");
  if (entries.length === 0) return;

  // Find the entry whose time range contains the current playback time
  let activeEntry = null;
  entries.forEach((entry, index) => {
    const entrySeconds = parseInt(entry.dataset.seconds);
    const nextEntry = entries[index + 1];
    const nextSeconds = nextEntry
      ? parseInt(nextEntry.dataset.seconds)
      : Infinity;

    if (currentSeconds >= entrySeconds && currentSeconds < nextSeconds) {
      activeEntry = entry;
    }
  });

  if (!activeEntry) return;

  // Skip if this entry is already highlighted (no DOM thrashing)
  if (activeEntry.classList.contains("active-playback")) return;

  // Remove old highlight, add new one
  entries.forEach((e) => e.classList.remove("active-playback"));
  activeEntry.classList.add("active-playback");

  // Only scroll if auto-scroll is enabled
  if (autoScrollEnabled) {
    lastAutoScrollTime = Date.now();
    activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * Scroll event handler for the content area.
 * Detects manual scrolling and disables auto-scroll so the user
 * can read at their own pace without being yanked back.
 */
function onContentAreaScroll() {
  // Ignore scroll events within 1 second of a programmatic scroll
  // (smooth scroll animations can last longer than a simple boolean flag)
  if (Date.now() - lastAutoScrollTime < 1000) return;

  // User scrolled manually — disable auto-scroll and show the button
  if (autoScrollEnabled && autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
}

// ============================================================
// TRANSCRIPT MODE UI — Original / Chinese / aligned bilingual
// ============================================================

function getOriginalTranscriptLabel() {
  const language = String(currentTranscriptLanguage || "").trim();
  return /^[A-Za-z0-9-]{1,20}$/.test(language)
    ? `Original (${language})`
    : "Original";
}

function getActiveTranscriptSegments() {
  return groupTranscriptEntries(currentTranscript || []);
}

function transcriptTranslationCacheKey(segment) {
  return `${currentVideoId}:zh:semantic:${segment.id}`;
}

function playerSubtitleCueCacheKey(cue) {
  return buildPlayerSubtitleCueCacheKey(currentVideoId, cue);
}

/**
 * Maps one readable side-panel paragraph to the short, timestamp-accurate
 * player cues that cover the same time window. Both views can therefore reuse
 * one translation without changing the side panel's paragraph layout.
 */
function getCueIndicesForTranscriptSegment(segments, segmentIndex, cues) {
  if (
    !Array.isArray(segments) ||
    !Array.isArray(cues) ||
    !Number.isInteger(segmentIndex) ||
    !segments[segmentIndex]
  ) {
    return [];
  }

  const start = Number(segments[segmentIndex].start) || 0;
  const nextStart = Number(segments[segmentIndex + 1]?.start);
  const end = Number.isFinite(nextStart) && nextStart > start
    ? nextStart
    : Number.POSITIVE_INFINITY;

  const indices = [];
  cues.forEach((cue, cueIndex) => {
    const cueStart = Number(cue?.start);
    if (!Number.isFinite(cueStart)) return;
    if (cueStart >= start && cueStart < end) indices.push(cueIndex);
  });
  return indices;
}

function composeTranscriptTranslationFromCues(
  segments,
  segmentIndex,
  cues,
  getTranslation,
) {
  const cueIndices = getCueIndicesForTranscriptSegment(
    segments,
    segmentIndex,
    cues,
  );
  if (!cueIndices.length) return { cueIndices, text: "", complete: false };

  const translatedParts = cueIndices.map((cueIndex) =>
    String(getTranslation(cues[cueIndex]) || "").trim(),
  );
  const complete = translatedParts.every(Boolean);
  return {
    cueIndices,
    text: complete ? normalizeCaptionText(translatedParts.join(" ")) : "",
    complete,
  };
}

function getReusedTranscriptTranslation(segments, segmentIndex, cues) {
  const composed = composeTranscriptTranslationFromCues(
    segments,
    segmentIndex,
    cues,
    (cue) => playerSubtitleCueCache.get(playerSubtitleCueCacheKey(cue)),
  );
  if (composed.complete) return composed.text;

  // Preserve a translation purchased by an older extension version while the
  // shared short-cue cache is being filled. No new paragraph request is made.
  const legacy = transcriptParagraphCache.get(
    transcriptTranslationCacheKey(segments[segmentIndex]),
  );
  return legacy || "";
}

let activePlayerSubtitleCueMemo = { transcript: null, cues: [] };

function getActivePlayerSubtitleCues() {
  const transcript = currentTranscript || [];
  if (activePlayerSubtitleCueMemo.transcript !== transcript) {
    activePlayerSubtitleCueMemo = {
      transcript,
      cues: buildPlayerSubtitleCues(transcript),
    };
  }
  return activePlayerSubtitleCueMemo.cues;
}

function transcriptModeForSubtitleOverlayMode(mode) {
  return mode === "zh" || mode === "bilingual" ? mode : "original";
}

function setTranscriptModeButtons(mode) {
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    const active = button.dataset.transcriptMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

/**
 * How much of this video the player has already had translated. Reading is the
 * only thing this control can do, so it is offered exactly when there is
 * something to read.
 */
function hasCachedTranscriptTranslation() {
  if (!currentVideoId || !currentTranscript) return false;
  return getActivePlayerSubtitleCues().some((cue) =>
    playerSubtitleCueCache.get(playerSubtitleCueCacheKey(cue)),
  );
}

/**
 * Enables 中文 / 双语 once cached Chinese exists, and keeps the hint visible
 * only while they are unavailable.
 */
function updateTranscriptModeAvailability() {
  const available = hasCachedTranscriptTranslation();
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    const needsTranslation = button.dataset.transcriptMode !== "original";
    button.disabled = needsTranslation && !available;
  });
  const hint = document.getElementById("transcriptModeHint");
  if (hint) hint.hidden = available;
}

/**
 * Switches which view of this transcript the panel shows.
 *
 * All three modes are reading views over subtitles and translations the panel
 * already holds, so none of them calls a provider. Translation itself is still
 * started in one place only: the subtitle button on the video player. Until
 * that has produced something, 中文 and 双语 stay disabled and the hint points
 * at the player.
 */
function handleTranscriptModeChange(mode) {
  if (!["original", "zh", "bilingual"].includes(mode)) return;
  if (mode !== "original" && !hasCachedTranscriptTranslation()) {
    const hint = document.getElementById("transcriptModeHint");
    if (!hint) return;
    hint.classList.add("transcript-mode-hint--nudge");
    setTimeout(() => hint.classList.remove("transcript-mode-hint--nudge"), 1200);
    return;
  }
  // A deliberate choice outranks the player until this video is left.
  transcriptModePinnedByUser = true;
  renderTranscriptInMode(mode);
}

/**
 * Draws the transcript in one mode. Renders from cache only — no request of
 * any kind is issued from this function or anything it calls.
 */
function renderTranscriptInMode(mode) {
  const transcriptMode = transcriptModeForSubtitleOverlayMode(mode);
  currentTranscriptMode = transcriptMode;
  setTranscriptModeButtons(transcriptMode);
  updateTranscriptModeAvailability();
  if (!currentTranscript) return;

  if (transcriptMode === "original") {
    if (renderedTranscriptMode !== "original") renderTranscript();
    return;
  }

  const segments = getActiveTranscriptSegments();
  const playerCues = getActivePlayerSubtitleCues();
  if (renderedTranscriptMode !== transcriptMode) {
    renderTranscriptModeRows(segments, transcriptMode, playerCues);
  } else {
    // Patch the rows in place so a batch arriving mid-read does not throw the
    // user back to the top of the transcript.
    refreshReusedTranscriptRows(segments, playerCues);
  }
}

/**
 * Follows the player's subtitle button, which sets the default view for a
 * video. Once the reader has picked a view themselves, their choice holds and
 * incoming batches only refresh the rows underneath it.
 */
function applyTranscriptModeFromPlayer(mode) {
  renderTranscriptInMode(
    transcriptModePinnedByUser ? currentTranscriptMode : mode,
  );
}

/**
 * Loads whatever the player has already paid for: the current session's mode
 * and the cached Chinese cues for this video. Both reads are local.
 */
async function syncSubtitleStateFromPlayer(videoId) {
  if (!videoId) return;
  try {
    const cached = await chrome.runtime.sendMessage({
      action: "getSubtitleOverlayTrack",
      videoId,
    });
    (cached?.track?.segments || []).forEach((segment) => {
      if (segment?.id && segment.translated) {
        playerSubtitleCueCache.set(
          buildPlayerSubtitleCueCacheKey(videoId, segment),
          segment.translated,
        );
      }
    });
  } catch (_error) {
    // No cached track yet — the panel simply shows the original transcript.
  }

  let mode = "off";
  try {
    const state = await chrome.runtime.sendMessage({
      action: "getSubtitleSessionState",
      videoId,
    });
    mode = state?.mode || "off";
  } catch (_error) {
    // Treat an unreachable worker as "player subtitles are off".
  }
  if (videoId !== currentVideoId) return;
  applyTranscriptModeFromPlayer(mode);
}

/**
 * A translation batch finished in the background. Merge it into the panel's
 * cache and redraw — this is display work, never a trigger for more work.
 */
function handleSubtitleTrackUpdate(videoId, track, mode) {
  if (!videoId || videoId !== currentVideoId) return;
  (track?.segments || []).forEach((segment) => {
    if (segment?.id && segment.translated) {
      playerSubtitleCueCache.set(
        buildPlayerSubtitleCueCacheKey(videoId, segment),
        segment.translated,
      );
    }
  });
  // renderTranscriptInMode refreshes the control, so the first batch makes
  // 中文 and 双语 readable even for someone still looking at the original.
  applyTranscriptModeFromPlayer(mode || currentTranscriptMode);
}

function renderTranscriptSegmentContent(segment, mode, translated, error) {
  const original = renderSubtitleInlineMarkup(segment.text);
  let translationHtml = "";
  if (translated) {
    translationHtml = renderSubtitleInlineMarkup(translated);
  } else if (error) {
    translationHtml = `${escapeHtml(error)}<button class="translation-retry-btn" type="button">Retry</button>`;
  } else {
    translationHtml = "Waiting for translation…";
  }

  if (mode === "bilingual") {
    return `<span class="transcript-copy"><span class="transcript-original">${original}</span><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
  }

  return `<span class="transcript-copy"><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
}

function renderTranscriptModeRows(segments, mode, playerCues) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return [];
  renderedTranscriptMode = mode;
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();
  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  const originalLabel = getOriginalTranscriptLabel();
  const modeLabel =
    mode === "bilingual"
      ? `${originalLabel} + 简体中文`
      : `简体中文 · translated from ${originalLabel}`;
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> From video subtitles · ${modeLabel}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  const rows = [];
  segments.forEach((segment, index) => {
    const div = document.createElement("div");
    const cached = getReusedTranscriptTranslation(
      segments,
      index,
      playerCues,
    );
    div.className = `transcript-entry ${cached ? "translated" : "translating"}`;
    div.dataset.seconds = segment.start;
    div.dataset.segmentId = segment.id;
    div.dataset.segmentIndex = index;

    const minutes = Math.floor(segment.start / 60);
    const seconds = Math.floor(segment.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;
    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      ${renderTranscriptSegmentContent(segment, mode, cached, "")}
    `;
    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, segment.start),
    );
    transcriptList.appendChild(div);
    rows.push(div);
  });

  startPlaybackTracking();
  return rows;
}

function refreshReusedTranscriptRows(segments, playerCues) {
  segments.forEach((segment, index) => {
    const row = document.querySelector(
      `.transcript-entry[data-segment-id="${CSS.escape(segment.id)}"]`,
    );
    if (!row) return;
    const translated = getReusedTranscriptTranslation(
      segments,
      index,
      playerCues,
    );
    const copy = row.querySelector(".transcript-copy");
    if (copy) {
      copy.outerHTML = renderTranscriptSegmentContent(
        segment,
        currentTranscriptMode,
        translated,
        "",
      );
    }
    row.classList.toggle("translated", !!translated);
    row.classList.toggle("translating", !translated);
    row.classList.remove("translation-failed");
  });
}

// The player-cue translation queue used to live here. It now runs in the
// background worker (see background.js) so the player keeps translating with
// this panel closed, and so the DeepSeek key never reaches a UI context.
// Nothing in this file may call a translation provider.

function setTranslatingSpinner(show) {
  const spinner = document.getElementById("langSpinner");
  if (spinner) spinner.classList.toggle("visible", !!show);
}

// Pure helpers are exposed for the repository's Node tests. The extension does
// not read this object at runtime.
globalThis.__YTD_TRANSCRIPT_TESTING__ = {
  // Seeds the transcript state that startDigest normally fills in, so the
  // render path can be exercised without a live tab or a network call.
  setTranscriptStateForTests({ videoId, transcript, cueTranslations = {} }) {
    currentVideoId = videoId;
    currentTranscript = transcript;
    currentTranscriptLanguage = "en";
    playerSubtitleCueCache = new Map(Object.entries(cueTranslations));
  },
  renderTranscript,
  renderTranscriptInMode,
  handleTranscriptModeChange,
  hasCachedTranscriptTranslation,
  groupTranscriptEntries,
  splitOversizedThought,
  renderSubtitleInlineMarkup,
  renderTranscriptSegmentContent,
  buildPlayerSubtitleCues,
  getCueIndicesForTranscriptSegment,
  composeTranscriptTranslationFromCues,
  transcriptModeForSubtitleOverlayMode,
  applyTranscriptModeFromPlayer,
  handleSubtitleTrackUpdate,
  getCurrentTranscriptMode: () => currentTranscriptMode,
};
