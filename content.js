/**
 * CONTENT SCRIPT
 *
 * This script runs ON the YouTube page itself. It can see and modify
 * the YouTube page DOM (the HTML elements).
 *
 * It handles:
 * 1. Extracting video info (title, channel name) from the page
 * 2. Injecting "key moment" markers onto YouTube's progress bar
 * 3. Adding a "Digest" button to YouTube's action bar (next to Share/Save)
 *
 * Think of it like a robot sitting inside the YouTube tab,
 * reading the page and making small visual changes.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// GLOBAL STATE
// ============================================================

let ytdNoteButton = null;
let ytdNoteButtonTimer = null;
let ytdNoteKeyboardListenerAdded = false;
let ytdNoteButtonRetryTimer = null;
let ytdDigestButton = null;
let digestButtonObserver = null;
let digestButtonReconcileTimer = null;
let digestButtonResizeListenerAdded = false;
let ytdSubtitleOverlay = null;
let ytdSubtitleToggle = null;
let ytdSubtitleTrack = null;
// Always starts closed. A video never inherits an activation — not from the
// previous video, not from a cached track, not from a previous browser session.
let ytdSubtitleMode = "off";
let ytdSubtitleVideo = null;
let ytdSubtitleVideoId = "";
let ytdSubtitleGeneration = 0;
let ytdSubtitleLastPrefetchAt = 0;
let ytdSubtitleRetryTimer = null;

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * When the page loads, inject our Digest button and Note button.
 * We wait a bit for YouTube's UI to fully render.
 */
function init() {
  // Register the global "n" keyboard shortcut once
  if (!ytdNoteKeyboardListenerAdded) {
    document.addEventListener("keydown", handleNoteKeyboardShortcut);
    ytdNoteKeyboardListenerAdded = true;
  }

  // Try to inject the buttons immediately
  injectDigestButton();
  tryInjectNoteButton();

  // Also set up an observer to handle YouTube's dynamic content loading
  // (YouTube is an SPA, so elements appear/disappear as you navigate)
  setupButtonObserver();
  setupDigestButtonResizeListener();
  setupPlayerSubtitlesForCurrentVideo();
}

/**
 * Attempts to inject the note button. If the player container isn't ready yet,
 * retry a few times with a short delay. YouTube renders the player asynchronously
 * after navigation, so a single immediate attempt can miss it.
 */
function tryInjectNoteButton() {
  if (!window.location.pathname.includes("/watch")) return;

  // Clear any existing retry so we don't stack timers
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  let attempts = 0;
  const maxAttempts = 30; // ~3 seconds of retrying

  function attempt() {
    attempts++;
    const playerContainer = document.querySelector(
      "#movie_player.html5-video-player, #movie_player, .html5-video-player",
    );

    if (playerContainer) {
      injectNoteButton();
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
      return;
    }

    if (attempts >= maxAttempts) {
      debugLog(
        "[YouTube Digest Content] Player container not found after retries, giving up",
      );
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
    }
  }

  attempt();
  if (!ytdNoteButton || !ytdNoteButton.isConnected) {
    ytdNoteButtonRetryTimer = setInterval(attempt, 100);
  }
}

// Run init when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel or background script.
 * When they ask for video info, we read it from the page.
 * When they send key moments, we highlight them on the progress bar.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog("[YouTube Digest Content] Received message:", message.action, message);

  if (message.action === "getVideoInfo") {
    // Read video title and channel name from the page
    const info = extractVideoInfo();
    debugLog("[YouTube Digest Content] Returning video info:", info);
    sendResponse(info);
    return false; // Synchronous response
  }

  if (message.action === "highlightMoments") {
    // Key moment markers disabled — chapters are shown in the side panel only.
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "getCurrentTime") {
    // Return the current video playback time (used by auto-scroll)
    const video = document.querySelector("video.html5-main-video");
    sendResponse({
      currentTime: video ? Math.floor(video.currentTime) : 0,
      paused: video ? video.paused : true,
    });
    return false;
  }

  if (message.action === "seekTo") {
    // Jump the video to a specific timestamp
    debugLog("[YouTube Digest Content] Seeking to:", message.seconds);
    seekToTimestamp(message.seconds);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "showNoteSavedFeedback") {
    // Show brief feedback that note was saved
    showNoteSavedToast(message.note);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "setSubtitleOverlayTrack") {
    applySubtitleOverlayTrack(message.track, message.generation);
    sendResponse({ success: true });
    return false;
  }

  // Unknown action - still send a response to prevent hanging
  debugLog("[YouTube Digest Content] Unknown action:", message.action);
  sendResponse({ success: false, error: "Unknown action" });
  return false;
});

// ============================================================
// PLAYER SUBTITLES — A local overlay synchronized to video time
// ============================================================

function getYouTubeVideoIdFromLocation() {
  try {
    return new URL(window.location.href).searchParams.get("v") || "";
  } catch (_error) {
    return "";
  }
}

function normalizePlayerSubtitleMode(mode) {
  return ["zh", "bilingual", "off"].includes(mode) ? mode : "off";
}

/** The button cycle: 关 -> 中 -> 双 -> 关. */
function nextPlayerSubtitleMode(mode) {
  if (mode === "zh") return "bilingual";
  if (mode === "bilingual") return "off";
  return "zh";
}

function findPlayerSubtitleCue(segments, currentTime) {
  if (!Array.isArray(segments) || !segments.length) return null;
  const time = Number(currentTime);
  if (!Number.isFinite(time)) return null;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const cue = segments[index];
    if (Number(cue?.start) > time) continue;
    const explicitEnd = Number(cue?.end);
    if (Number.isFinite(explicitEnd)) {
      return time < explicitEnd ? cue : null;
    }
    const nextStart = Number(segments[index + 1]?.start);
    if (!Number.isFinite(nextStart) || time < nextStart) return cue;
  }
  return null;
}

function getSubtitlePlayerContainer() {
  return document.querySelector(
    "#movie_player.html5-video-player, #movie_player, .html5-video-player",
  );
}

function subtitleModeLabel(mode) {
  if (mode === "zh") return "中";
  if (mode === "bilingual") return "双";
  return "关";
}

function ensureSubtitleOverlay() {
  if (!window.location.pathname.includes("/watch")) return null;
  const playerContainer = getSubtitlePlayerContainer();
  if (!playerContainer) return null;

  if (
    window.getComputedStyle(playerContainer).position === "static" ||
    !playerContainer.style.position
  ) {
    playerContainer.style.position = "relative";
  }

  if (!ytdSubtitleOverlay || !ytdSubtitleOverlay.isConnected) {
    ytdSubtitleOverlay = document.createElement("div");
    ytdSubtitleOverlay.id = "ytd-digest-subtitle-overlay";
    ytdSubtitleOverlay.setAttribute("aria-live", "polite");
    ytdSubtitleOverlay.style.cssText = `
      position: absolute;
      z-index: 2147483000;
      left: 7%;
      right: 7%;
      bottom: 11%;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 5px;
      pointer-events: none;
      text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      font-size: clamp(16px, 2.1vw, 29px);
      font-weight: 700;
      line-height: 1.34;
      color: #fff;
      text-shadow: 0 2px 5px rgba(0, 0, 0, 0.95), 0 0 12px rgba(0, 0, 0, 0.85);
    `;
    playerContainer.appendChild(ytdSubtitleOverlay);
  } else if (ytdSubtitleOverlay.parentElement !== playerContainer) {
    playerContainer.appendChild(ytdSubtitleOverlay);
  }

  if (!ytdSubtitleToggle || !ytdSubtitleToggle.isConnected) {
    ytdSubtitleToggle = document.createElement("button");
    ytdSubtitleToggle.id = "ytd-digest-subtitle-toggle";
    ytdSubtitleToggle.type = "button";
    ytdSubtitleToggle.setAttribute("aria-label", "Switch YouTube Digest subtitles");
    ytdSubtitleToggle.style.cssText = `
      position: absolute;
      z-index: 2147483001;
      top: 16px;
      right: 92px;
      min-width: 36px;
      height: 32px;
      padding: 0 10px;
      border: 1px solid rgba(255, 255, 255, 0.46);
      border-radius: 999px;
      background: rgba(18, 18, 18, 0.74);
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 2px 9px rgba(0, 0, 0, 0.35);
    `;
    ytdSubtitleToggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // 关 -> 中 -> 双 -> 关. Only the first step spends anything: it is the
      // user explicitly authorizing translation for this video.
      handlePlayerSubtitleToggle(nextPlayerSubtitleMode(ytdSubtitleMode));
    });
    playerContainer.appendChild(ytdSubtitleToggle);
  } else if (ytdSubtitleToggle.parentElement !== playerContainer) {
    playerContainer.appendChild(ytdSubtitleToggle);
  }

  const video = document.querySelector("video.html5-main-video");
  if (video && video !== ytdSubtitleVideo) {
    ytdSubtitleVideo = video;
    ["timeupdate", "seeking", "loadedmetadata", "play", "ratechange"].forEach(
      (eventName) => video.addEventListener(eventName, onPlayerSubtitleTick),
    );
  }
  return playerContainer;
}

/**
 * Playback moved. Redraw the current cue and, only while the user has
 * subtitles switched on, ask for the next few phrases.
 */
function onPlayerSubtitleTick() {
  updatePlayerSubtitleOverlay();
  requestSubtitlePrefetch();
}

function renderPlayerSubtitleLine(text, className) {
  const line = document.createElement("div");
  line.className = className;
  line.textContent = text;
  line.style.cssText =
    "max-width: 100%; padding: 3px 9px; border-radius: 6px; background: rgba(0, 0, 0, 0.55);";
  return line;
}

function updatePlayerSubtitleOverlay() {
  if (!ytdSubtitleOverlay) return;
  // If YouTube swapped videos without us seeing the navigation event, the old
  // authorization is void — fall back to closed rather than showing stale text.
  const videoId = getYouTubeVideoIdFromLocation();
  if (videoId && videoId !== ytdSubtitleVideoId) {
    setupPlayerSubtitlesForCurrentVideo();
    return;
  }
  ytdSubtitleOverlay.replaceChildren();
  if (ytdSubtitleMode === "off" || !ytdSubtitleTrack) return;

  const video = document.querySelector("video.html5-main-video");
  const cue = findPlayerSubtitleCue(
    ytdSubtitleTrack.segments,
    video ? video.currentTime : 0,
  );
  if (!cue) return;

  if (ytdSubtitleMode === "bilingual") {
    ytdSubtitleOverlay.appendChild(
      renderPlayerSubtitleLine(cue.original, "ytd-digest-subtitle-original"),
    );
  }
  if (cue.translated) {
    ytdSubtitleOverlay.appendChild(
      renderPlayerSubtitleLine(cue.translated, "ytd-digest-subtitle-translation"),
    );
  }
}

function setPlayerSubtitleMode(mode) {
  ytdSubtitleMode = normalizePlayerSubtitleMode(mode);
  if (ytdSubtitleToggle) {
    ytdSubtitleToggle.textContent = subtitleModeLabel(ytdSubtitleMode);
    ytdSubtitleToggle.title =
      ytdSubtitleMode === "zh"
        ? "中文字幕，点击切换双语"
        : ytdSubtitleMode === "bilingual"
          ? "中英双语，点击关闭"
          : "字幕已关闭，点击开启中文翻译";
    ytdSubtitleToggle.setAttribute(
      "aria-pressed",
      String(ytdSubtitleMode !== "off"),
    );
  }
  updatePlayerSubtitleOverlay();
}

/**
 * The user clicked the subtitle button. This is the ONLY path in the extension
 * that can start a translation, and each transition means something different:
 *
 *   关 -> 中   authorize DeepSeek for this video, translate around the playhead
 *   中 -> 双   redraw what is already translated; costs nothing
 *   * -> 关    hide subtitles, stop prefetching, keep everything cached
 */
async function handlePlayerSubtitleToggle(nextMode) {
  const videoId = getYouTubeVideoIdFromLocation();
  const mode = normalizePlayerSubtitleMode(nextMode);
  if (!videoId) return;

  if (mode === "off") {
    setPlayerSubtitleMode("off");
    ytdSubtitleTrack = null;
    chrome.runtime
      .sendMessage({ action: "deactivateSubtitleTranslation", videoId })
      .catch(() => {});
    return;
  }

  if (ytdSubtitleMode === "off") {
    setPlayerSubtitleMode(mode);
    try {
      const result = await chrome.runtime.sendMessage({
        action: "activateSubtitleTranslation",
        videoId,
        currentTime: getPlayerCurrentTime(),
        mode,
      });
      if (result?.success) {
        ytdSubtitleGeneration = Number(result.generation) || 0;
      } else if (result?.error) {
        showSubtitleToggleError(result.error);
      }
    } catch (_error) {
      showSubtitleToggleError("字幕翻译暂时不可用");
    }
    return;
  }

  // 中 <-> 双: presentation only. No new provider request is made.
  setPlayerSubtitleMode(mode);
  chrome.runtime
    .sendMessage({ action: "setSubtitleDisplayMode", videoId, mode })
    .catch(() => {});
}

function showSubtitleToggleError(message) {
  setPlayerSubtitleMode("off");
  if (ytdSubtitleToggle) ytdSubtitleToggle.title = String(message || "");
}

function getPlayerCurrentTime() {
  const video = document.querySelector("video.html5-main-video");
  return video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
}

/**
 * Asks the background worker to translate the next few phrases as playback
 * moves forward. Refused outright by the background unless this exact tab and
 * video are still the ones the user switched on.
 */
function requestSubtitlePrefetch() {
  if (ytdSubtitleMode === "off") return;
  const videoId = getYouTubeVideoIdFromLocation();
  if (!videoId) return;
  const now = Date.now();
  if (now - ytdSubtitleLastPrefetchAt < 1500) return;
  ytdSubtitleLastPrefetchAt = now;
  chrome.runtime
    .sendMessage({
      action: "prefetchSubtitleWindow",
      videoId,
      currentTime: getPlayerCurrentTime(),
    })
    .catch(() => {});
}

function applySubtitleOverlayTrack(track, generation) {
  if (!track || track.videoId !== getYouTubeVideoIdFromLocation()) return;
  // A result from a session the user has already left must never be drawn.
  if (ytdSubtitleMode === "off") return;
  if (
    Number.isFinite(Number(generation)) &&
    ytdSubtitleGeneration &&
    Number(generation) < ytdSubtitleGeneration
  ) {
    return;
  }
  if (Number.isFinite(Number(generation))) ytdSubtitleGeneration = Number(generation);

  const segments = (Array.isArray(track.segments) ? track.segments : []).filter(
    (segment) =>
      Number.isFinite(Number(segment?.start)) &&
      Number.isFinite(Number(segment?.end)) &&
      Number(segment.end) > Number(segment.start),
  );
  ytdSubtitleTrack = { videoId: track.videoId, segments };
  ensureSubtitleOverlay();
  updatePlayerSubtitleOverlay();
}

function clearSubtitleOverlay() {
  ytdSubtitleOverlay?.remove();
  ytdSubtitleToggle?.remove();
  ytdSubtitleOverlay = null;
  ytdSubtitleToggle = null;
  ytdSubtitleTrack = null;
  ytdSubtitleMode = "off";
  ytdSubtitleVideo = null;
  ytdSubtitleVideoId = "";
  ytdSubtitleGeneration = 0;
  ytdSubtitleLastPrefetchAt = 0;
}

/**
 * Puts the subtitle button on the player and makes sure this video starts
 * closed. The button is shown even before any subtitle track exists, because
 * fetching one is precisely what the first click is for.
 */
function setupPlayerSubtitlesForCurrentVideo() {
  if (ytdSubtitleRetryTimer) {
    clearInterval(ytdSubtitleRetryTimer);
    ytdSubtitleRetryTimer = null;
  }
  if (!window.location.pathname.includes("/watch")) {
    // Left the player entirely (home, search, a channel page). Retire the
    // authorization rather than leaving a session alive with nothing driving it.
    const hadOverlay = !!ytdSubtitleOverlay;
    clearSubtitleOverlay();
    if (hadOverlay) {
      chrome.runtime
        .sendMessage({ action: "resetSubtitleSession" })
        .catch(() => {});
    }
    return;
  }

  const videoId = getYouTubeVideoIdFromLocation();
  if (videoId !== ytdSubtitleVideoId) {
    ytdSubtitleVideoId = videoId;
    ytdSubtitleTrack = null;
    ytdSubtitleGeneration = 0;
    ytdSubtitleMode = "off";
    // A page load or a video change retires the previous authorization.
    chrome.runtime
      .sendMessage({ action: "resetSubtitleSession", videoId })
      .catch(() => {});
  }

  let attempts = 0;
  const attempt = () => {
    attempts += 1;
    if (ensureSubtitleOverlay()) {
      setPlayerSubtitleMode(ytdSubtitleMode);
      if (ytdSubtitleRetryTimer) {
        clearInterval(ytdSubtitleRetryTimer);
        ytdSubtitleRetryTimer = null;
      }
      return;
    }
    if (attempts >= 30 && ytdSubtitleRetryTimer) {
      clearInterval(ytdSubtitleRetryTimer);
      ytdSubtitleRetryTimer = null;
    }
  };

  attempt();
  if (!ytdSubtitleRetryTimer && (!ytdSubtitleOverlay || !ytdSubtitleToggle)) {
    ytdSubtitleRetryTimer = setInterval(attempt, 300);
  }
}

// ============================================================
// DIGEST BUTTON INJECTION
// ============================================================

/**
 * Injects a "Digest" button into YouTube's action bar.
 * The button appears next to Share, Save, etc. below the video.
 *
 * When clicked, it opens the YouTube Digest side panel.
 */
function isVisibleDigestHost(element) {
  if (!element || !element.isConnected) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/**
 * YouTube keeps hidden copies of its responsive action toolbar in the DOM.
 * querySelector() can return one of those 0x0 copies before the toolbar the
 * viewer can actually see, so inspect every candidate and resolve the native
 * button group inside the visible action row for the current video.
 */
function findDigestButtonHost() {
  const primaryActionRows = Array.from(
    document.querySelectorAll("ytd-watch-metadata #actions-inner"),
  );

  for (const actionRow of primaryActionRows) {
    if (!isVisibleDigestHost(actionRow)) continue;

    const visibleButtonGroup = Array.from(
      actionRow.querySelectorAll("#top-level-buttons-computed"),
    ).find(isVisibleDigestHost);
    if (visibleButtonGroup) return visibleButtonGroup;
  }

  const fallbackCandidates = Array.from(
    document.querySelectorAll(
      "ytd-watch-metadata #actions #top-level-buttons-computed, " +
        "ytd-watch-metadata #top-level-buttons-computed, " +
        "#primary #actions #top-level-buttons-computed",
    ),
  );

  return (
    fallbackCandidates.find(
      (candidate) =>
        isVisibleDigestHost(candidate) &&
        (candidate.closest("ytd-watch-metadata") ||
          candidate.closest("#primary")),
    ) || null
  );
}

function createDigestButton() {
  const digestButton = document.createElement("button");
  digestButton.id = "ytd-digest-button";
  digestButton.type = "button";
  // The label names the feature people come here for, but the button itself
  // only opens the side panel. Subtitles are switched on in the player, so the
  // tooltip says so rather than implying this is the subtitle toggle.
  digestButton.setAttribute("aria-label", "打开 YouTube中文字幕及摘要 侧边栏");
  digestButton.title = "打开侧边栏。播放器字幕请用视频右上角的字幕按钮开启。";
  digestButton.innerHTML = `
    <span class="ytd-digest-icon" style="font-size: 11px;">▶</span>
    <span class="ytd-digest-label">字幕</span>
  `;

  // Style the button — rounded pill in our terracotta accent, sized to sit
  // comfortably among YouTube's native action buttons.
  digestButton.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 18px;
    height: 36px;
    border: none;
    border-radius: 18px;
    background: #c8674f;
    color: white;
    font-family: "Roboto", "Arial", sans-serif;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    margin-right: 8px;
    transition: background 0.2s, transform 0.1s, box-shadow 0.2s;
    box-shadow: 0 2px 8px rgba(200, 103, 79, 0.3);
    flex: 0 0 auto;
    align-self: center;
    width: max-content;
    min-width: max-content;
    max-width: max-content;
    white-space: nowrap;
  `;

  // Hover effects
  digestButton.addEventListener("mouseenter", () => {
    digestButton.style.background = "#b25742";
    digestButton.style.transform = "scale(1.02)";
  });

  digestButton.addEventListener("mouseleave", () => {
    digestButton.style.background = "#c8674f";
    digestButton.style.transform = "scale(1)";
  });

  // Click handler — open the side panel
  digestButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    debugLog("[YouTube Digest] Digest button clicked");

    // Send message to background script to open side panel
    try {
      const result = await chrome.runtime.sendMessage({
        action: "openSidePanel",
      });
      debugLog("[YouTube Digest] openSidePanel response:", result);
    } catch (err) {
      console.error("[YouTube Digest] Failed to open side panel:", err);
    }
  });

  ytdDigestButton = digestButton;
  return digestButton;
}

/**
 * Reconciles the Digest button with YouTube's currently visible action row.
 * This is intentionally idempotent because YouTube rebuilds its watch page
 * during navigation and at responsive breakpoints.
 */
function injectDigestButton() {
  const existingButtons = Array.from(
    document.querySelectorAll("#ytd-digest-button"),
  );

  if (!window.location.pathname.includes("/watch")) {
    existingButtons.forEach((button) => button.remove());
    ytdDigestButton = null;
    return false;
  }

  const actionsContainer = findDigestButtonHost();
  if (!actionsContainer) {
    debugLog("[YouTube Digest Content] Visible actions container not found yet");
    return false;
  }

  let digestButton = existingButtons.find(
    (button) => button === ytdDigestButton,
  );

  if (!digestButton) {
    existingButtons.forEach((button) => button.remove());
    existingButtons.length = 0;
    digestButton = createDigestButton();
  }

  existingButtons.forEach((button) => {
    if (button !== digestButton) button.remove();
  });

  if (digestButton.parentElement !== actionsContainer) {
    // YouTube turns #actions-inner into a vertical flex column at narrow
    // breakpoints. A direct child there stretches into a full-width second
    // row, so keep Digest inside the native horizontal button group and
    // prepend it to preserve visibility when space is limited.
    actionsContainer.insertBefore(digestButton, actionsContainer.firstChild);
  }

  debugLog("[YouTube Digest Content] Digest button reconciled");
  return true;
}

function scheduleDigestButtonReconciliation(delay = 80) {
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
  }

  digestButtonReconcileTimer = setTimeout(() => {
    digestButtonReconcileTimer = null;
    injectDigestButton();
  }, delay);
}

function setupDigestButtonResizeListener() {
  if (digestButtonResizeListenerAdded) return;

  window.addEventListener("resize", () => {
    scheduleDigestButtonReconciliation(120);
  });
  digestButtonResizeListenerAdded = true;
}

/**
 * Sets up a MutationObserver to watch for YouTube's dynamic content changes.
 * When the action buttons container appears (after navigation), we inject our button.
 */
function setupButtonObserver() {
  if (digestButtonObserver) return;

  digestButtonObserver = new MutationObserver(() => {
    // Check if we need to inject the buttons
    if (window.location.pathname.includes("/watch")) {
      scheduleDigestButtonReconciliation();
      if (!ytdNoteButton || !ytdNoteButton.isConnected) {
        tryInjectNoteButton();
      }
      if (ytdSubtitleTrack && (!ytdSubtitleOverlay || !ytdSubtitleOverlay.isConnected)) {
        ensureSubtitleOverlay();
        updatePlayerSubtitleOverlay();
      }
    }
  });

  // Watch the entire body for changes (YouTube rebuilds large chunks of the DOM)
  digestButtonObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// ============================================================
// NOTE BUTTON (Overlay on Video Player)
// ============================================================

/**
 * Injects a "Note" button overlay on top of the YouTube video player.
 * The button appears when the mouse enters or moves over the player and hides
 * after the cursor stays still for more than 2 seconds or leaves the player.
 */
function injectNoteButton() {
  // Don't inject if we're not on a video page
  if (!window.location.pathname.includes("/watch")) return;

  // Don't inject if button already exists and is properly tracked.
  // If a stale button exists (e.g., from a previous content-script instance),
  // remove it and re-inject so event listeners are attached to the live one.
  const existingButton = document.getElementById("ytd-note-button");
  if (existingButton) {
    if (ytdNoteButton === existingButton && existingButton.isConnected) {
      return; // already injected and connected
    }
    existingButton.remove();
  }

  // Find the video player container. YouTube rebuilds this dynamically, so
  // we try the most common selectors.
  const playerContainer = document.querySelector(
    "#movie_player.html5-video-player, " +
      "#movie_player, " +
      ".html5-video-player",
  );

  if (!playerContainer) {
    debugLog(
      "[YouTube Digest Content] Player container not found yet, will retry",
    );
    return;
  }

  // Ensure the player container has relative positioning for absolute children
  if (
    window.getComputedStyle(playerContainer).position === "static" ||
    !playerContainer.style.position
  ) {
    playerContainer.style.position = "relative";
  }

  debugLog("[YouTube Digest Content] Injecting note button");

  // Create the note button — a soft rounded pill that floats over the player
  const noteButton = document.createElement("button");
  noteButton.id = "ytd-note-button";
  noteButton.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right: 7px;">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
    </svg>
    <span>Note</span>
  `;

  // Soft rounded pill in the terracotta accent, with a gentle shadow.
  // Start hidden; visibility is controlled by mouse activity.
  noteButton.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 9999;
    display: flex;
    align-items: center;
    padding: 9px 16px;
    background: #c8674f;
    color: white;
    border: none;
    border-radius: 999px;
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.2px;
    cursor: pointer;
    transition: opacity 0.18s ease, transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
    opacity: 0;
    pointer-events: none;
    box-shadow: 0 4px 14px rgba(0,0,0,0.3);
  `;

  ytdNoteButton = noteButton;

  // Show button when mouse enters or moves over the player.
  // Hide after 2 seconds of idle or when the mouse leaves.
  playerContainer.addEventListener("mouseenter", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mousemove", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mouseleave", () => {
    clearTimeout(ytdNoteButtonTimer);
    ytdNoteButtonTimer = null;
    hideNoteButton();
  });

  // Hover effect — lift slightly
  noteButton.addEventListener("mouseenter", () => {
    noteButton.style.background = "#b25742";
    noteButton.style.boxShadow = "0 6px 18px rgba(0,0,0,0.35)";
    noteButton.style.transform = "translateY(-1px)";
  });

  noteButton.addEventListener("mouseleave", () => {
    noteButton.style.background = "#c8674f";
    noteButton.style.boxShadow = "0 4px 14px rgba(0,0,0,0.3)";
    noteButton.style.transform = "translateY(0)";
  });

  // Click handler — save the current moment as a note
  noteButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await saveCurrentNote();
  });

  playerContainer.appendChild(noteButton);

  debugLog("[YouTube Digest Content] Note button injected");
}

function showNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "1";
  ytdNoteButton.style.pointerEvents = "auto";
}

function hideNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "0";
  ytdNoteButton.style.pointerEvents = "none";
}

function resetNoteButtonTimer() {
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = setTimeout(() => {
    hideNoteButton();
  }, 2000);
}

/**
 * Handles the "n" keyboard shortcut for saving a note.
 * Only triggers on YouTube watch pages and when the user is not typing
 * in an input field.
 */
function handleNoteKeyboardShortcut(e) {
  if (!window.location.pathname.includes("/watch")) return;
  if (e.key !== "n" && e.key !== "N") return;

  // Ignore if the user is typing in an input/textarea/contenteditable
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  ) {
    return;
  }

  // Prevent YouTube's own "n" shortcut (e.g. next video in playlist)
  e.preventDefault();
  e.stopPropagation();

  // Show brief visual feedback on the button, then save
  showNoteButton();
  resetNoteButtonTimer();
  saveCurrentNote();
}

/**
 * Captures the current timestamp and saves it as a note.
 */
async function saveCurrentNote() {
  debugLog("[YouTube Digest] Saving note");

  const video = document.querySelector("video.html5-main-video");
  if (!video) {
    console.error("[YouTube Digest] No video element found");
    return;
  }

  // Go back 3 seconds to capture what was just said (user reacts after hearing it)
  const currentTime = Math.max(0, Math.floor(video.currentTime) - 3);
  const videoInfo = extractVideoInfo();
  const videoId = new URLSearchParams(window.location.search).get("v");

  const noteButton = ytdNoteButton;
  const originalContent = noteButton ? noteButton.innerHTML : "";

  if (noteButton) {
    noteButton.innerHTML =
      '<span style="letter-spacing: 0.2px;">SAVING...</span>';
    noteButton.style.pointerEvents = "none";
  }

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: videoId,
      timestamp: currentTime,
      videoTitle: videoInfo.title,
      channelName: videoInfo.channelName,
    });

    if (result.success) {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">SAVED</span>';
        noteButton.style.background = "#7c8b6f";
      }
      showNoteSavedToast(result.note);
    } else {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">ERROR</span>';
      }
      console.error("[YouTube Digest] Save note error:", result.error);
    }
  } catch (err) {
    if (noteButton) {
      noteButton.innerHTML =
        '<span style="letter-spacing: 0.2px;">ERROR</span>';
    }
    console.error("[YouTube Digest] Save note exception:", err);
  }

  setTimeout(() => {
    if (noteButton) {
      noteButton.innerHTML = originalContent;
      noteButton.style.background = "#c8674f";
      noteButton.style.pointerEvents = "auto";
    }
  }, 2000);
}

/**
 * Shows a toast notification when a note is saved.
 */
function showNoteSavedToast(note) {
  // Remove existing toast
  const existing = document.getElementById("ytd-note-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "ytd-note-toast";
  toast.innerHTML = `
    <div style="font-weight: 700; margin-bottom: 6px; color: #c8674f;">📝 Note saved</div>
    <div style="font-size: 12px; color: #6b6258; margin-bottom: 8px;">${escapeHtmlForContent(note.timestamp)} — ${escapeHtmlForContent(note.videoTitle)}</div>
    <div style="font-size: 13px; line-height: 1.55; color: #2e2a24;">"${escapeHtmlForContent(note.text)}"</div>
    <div style="margin-top: 10px; font-size: 11px;">
      <a href="${escapeHtmlForContent(note.timestampedUrl)}" style="color: #c8674f; font-weight: 600; text-decoration: none;">🔗 Copy link</a>
    </div>
  `;

  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    background: #ffffff;
    border: 1px solid #ece5d9;
    border-radius: 14px;
    padding: 16px 20px;
    max-width: 350px;
    box-shadow: 0 12px 32px rgba(50, 42, 32, 0.2);
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    animation: ytdSlideIn 0.3s ease;
  `;

  // Add animation keyframes
  const style = document.createElement("style");
  style.textContent = `
    @keyframes ytdSlideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  // Copy link handler
  toast.querySelector("a").addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(note.timestampedUrl);
      e.target.textContent = "✓ Copied!";
    } catch (err) {
      console.error("Copy failed:", err);
    }
  });

  document.body.appendChild(toast);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.style.animation = "ytdSlideIn 0.3s ease reverse";
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Reads the video title, channel name, and description directly from YouTube's page.
 * These are just sitting in the HTML — we grab them from the DOM elements.
 */
function extractVideoInfo() {
  // The video title is in an h1 element inside the #title container
  const titleElement = document.querySelector(
    "h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string",
  );

  // The channel name is in the channel info section
  const channelElement = document.querySelector(
    "#channel-name yt-formatted-string a, ytd-channel-name yt-formatted-string a",
  );

  // Video duration from the video element
  const videoElement = document.querySelector("video.html5-main-video");

  // Video description — YouTube has this in a few possible places
  const descriptionElement = document.querySelector(
    "#description-inner, " +
      "ytd-watch-metadata #description yt-attributed-string, " +
      "#description yt-formatted-string, " +
      "ytd-expander#description yt-attributed-string",
  );

  return {
    title: titleElement?.textContent?.trim() || "",
    channelName: channelElement?.textContent?.trim() || "",
    duration: videoElement?.duration || 0,
    description: descriptionElement?.textContent?.trim() || "",
  };
}

// ============================================================
// PROGRESS BAR KEY MOMENTS
// ============================================================

/**
 * Adds colored marker dots to YouTube's video progress bar
 * at the positions of key moments identified by the AI provider.
 *
 * How it works:
 * - YouTube's progress bar is a <div> element with a known class
 * - We calculate each moment's position as a percentage of total duration
 * - We inject small colored <div> elements at those positions
 * - The markers are absolutely positioned on top of the progress bar
 *
 * This is a "bonus feature" — it gives you a visual preview
 * of where the good stuff is in the video.
 */
function highlightKeyMoments(moments, videoDuration) {
  // Disabled: no timeline markers. Chapters live only in the side panel.
  return;
}

// ============================================================
// SEEK TO TIMESTAMP
// ============================================================

/**
 * Jumps the YouTube video to a specific timestamp (in seconds).
 * This is called when the user clicks a timestamp in the side panel.
 *
 * We simply set the video element's .currentTime property,
 * which is the standard HTML5 way to seek in a video.
 */
function seekToTimestamp(seconds) {
  const video = document.querySelector("video.html5-main-video");
  if (!video) {
    console.error("[YouTube Digest Content] No video element found for seek");
    return;
  }

  debugLog("[YouTube Digest Content] Seeking to:", seconds);
  video.currentTime = seconds;
  // Also play the video if it's paused
  if (video.paused) {
    video.play().catch(() => {}); // Ignore autoplay errors
  }
}

function escapeHtmlForContent(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

// ============================================================
// PAGE NAVIGATION DETECTION
// ============================================================

/**
 * YouTube is a "Single Page Application" (SPA). This means when you
 * click on a new video, the page doesn't fully reload — YouTube
 * dynamically swaps out the content. So our content script stays alive
 * but needs to detect when the video changes.
 *
 * We watch for URL changes using the `yt-navigate-finish` event,
 * which YouTube fires after navigation completes. When that happens,
 * we clean up old markers and re-inject the button.
 */
document.addEventListener("yt-navigate-finish", () => {
  clearSubtitleOverlay();
  // Clean up old key moment markers when navigating to a new video
  const existingMarkers = document.querySelectorAll(".ytd-key-moment-markers");
  existingMarkers.forEach((m) => m.remove());

  // Remove old buttons (they will be re-injected for the new video)
  document
    .querySelectorAll("#ytd-digest-button")
    .forEach((button) => button.remove());
  ytdDigestButton = null;
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
    digestButtonReconcileTimer = null;
  }

  const existingNoteButton = document.getElementById("ytd-note-button");
  if (existingNoteButton) existingNoteButton.remove();

  // Reset note button state
  ytdNoteButton = null;
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = null;
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  // Remove any toasts
  const existingToast = document.getElementById("ytd-note-toast");
  if (existingToast) existingToast.remove();

  // Re-inject buttons for the new video (with a small delay for YouTube to render)
  setTimeout(() => {
    scheduleDigestButtonReconciliation(0);
    tryInjectNoteButton();
    setupPlayerSubtitlesForCurrentVideo();
  }, 500);
});

// Pure helpers exposed only for the repository's Node tests.
globalThis.__YTD_PLAYER_SUBTITLES_TESTING__ = {
  normalizePlayerSubtitleMode,
  findPlayerSubtitleCue,
  subtitleModeLabel,
  nextPlayerSubtitleMode,
  getPlayerSubtitleMode: () => ytdSubtitleMode,
  setPlayerSubtitleMode,
  applySubtitleOverlayTrack,
  handlePlayerSubtitleToggle,
  setupPlayerSubtitlesForCurrentVideo,
  clearSubtitleOverlay,
};
