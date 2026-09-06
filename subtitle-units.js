/**
 * SHARED SUBTITLE UNITS
 *
 * The background worker, the side panel, and the player overlay must agree on
 * exactly which short phrase a cue ID refers to. If they disagreed, a cached
 * translation could be shown against the wrong time range — or worse, the same
 * phrase would be sent to the provider twice under two different IDs.
 *
 * This module is therefore the single source of truth for:
 *   - how raw captions are normalized,
 *   - how they are split into short, time-bounded player cues,
 *   - the stable cue ID and the persistent cache key derived from it,
 *   - the three display modes a player subtitle can be in.
 *
 * It contains no secrets and performs no I/O, so it is safe to load into the
 * side panel and (if ever needed) a content script.
 */
var YTD_SUBTITLE_UNITS = (() => {
  const PLAYER_SUBTITLE_CUE_LIMITS = Object.freeze({
    maxChars: 88,
    maxSeconds: 4.8,
    softBoundaryMinChars: 36,
    fallbackSeconds: 3.5,
  });

  // How much is translated when the user enables subtitles or plays forward:
  // the phrase being spoken plus a small look-ahead. Deliberately small so a
  // video that is opened and abandoned costs almost nothing.
  const SUBTITLE_PREFETCH_LOOKAHEAD = 5; // current cue + 5 following
  const SUBTITLE_BATCH_SIZE = 3; // cues per provider request

  const SUBTITLE_DISPLAY_MODES = Object.freeze(["off", "zh", "bilingual"]);

  function normalizeSubtitleDisplayMode(mode) {
    return SUBTITLE_DISPLAY_MODES.includes(mode) ? mode : "off";
  }

  function normalizeCaptionText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/([㐀-鿿])\s+([㐀-鿿])/g, "$1$2")
      .replace(/([，。；：！？])\s+(?=[㐀-鿿])/g, "$1")
      .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
      .trim();
  }

  /**
   * Splits a single oversized thought at the strongest nearby punctuation.
   * Word boundaries are the final safety valve for captions with no punctuation.
   */
  function splitOversizedThought(text, maxChars) {
    const parts = [];
    let rest = normalizeCaptionText(text);

    while (rest.length > maxChars) {
      const windowText = rest.slice(0, maxChars + 1);
      const lowerBound = Math.floor(maxChars * 0.55);
      let cut = -1;

      for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(windowText))) {
          if (match.index >= lowerBound) cut = match.index + match[0].length;
        }
        if (cut > 0) break;
      }

      if (cut <= 0) cut = maxChars;
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }

    if (rest) parts.push(rest);
    return parts;
  }

  /**
   * Produces short, time-bounded display cues for the player. Unlike the
   * side-panel transcript, these deliberately favor a clean one-to-two-line
   * subtitle over reconstructing a long paragraph.
   */
  function buildPlayerSubtitleCues(entries, limits = PLAYER_SUBTITLE_CUE_LIMITS) {
    if (!Array.isArray(entries) || entries.length === 0) return [];

    const sourceEntries = entries
      .map((entry) => ({
        text: normalizeCaptionText(entry?.text),
        start: Number(entry?.start),
        duration: Number(entry?.duration),
      }))
      .filter((entry) => entry.text && Number.isFinite(entry.start))
      .sort((a, b) => a.start - b.start);
    const pieces = [];

    sourceEntries.forEach((entry, entryIndex) => {
      const nextStart = sourceEntries[entryIndex + 1]?.start;
      const inferredDuration =
        Number.isFinite(nextStart) && nextStart > entry.start
          ? nextStart - entry.start
          : limits.fallbackSeconds;
      const duration = entry.duration > 0 ? entry.duration : inferredDuration;
      const sentenceParts =
        entry.text.match(
          /[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g,
        ) || [entry.text];
      let searchFrom = 0;

      sentenceParts.forEach((sentencePart) => {
        const cleanPart = normalizeCaptionText(sentencePart);
        if (!cleanPart) return;
        splitOversizedThought(cleanPart, limits.maxChars).forEach((part) => {
          const partStart = Math.max(
            searchFrom,
            entry.text.indexOf(part, searchFrom),
          );
          const safePartStart = partStart >= 0 ? partStart : searchFrom;
          const partEnd = Math.min(entry.text.length, safePartStart + part.length);
          const startRatio = safePartStart / Math.max(1, entry.text.length);
          const endRatio = partEnd / Math.max(1, entry.text.length);
          pieces.push({
            text: part,
            start: entry.start + duration * startRatio,
            end: entry.start + duration * endRatio,
            terminal: /[.!?。！？]["')\]”’）】」』]*$/.test(part),
            softBoundary: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
          });
          searchFrom = Math.max(safePartStart + part.length, searchFrom);
        });
      });
    });

    const cues = [];
    let current = null;
    const flush = () => {
      if (!current?.text.trim()) return;
      const index = cues.length;
      const start = Math.max(0, current.start);
      const end = Math.max(start + 0.15, current.end);
      cues.push({
        id: `player-${index}-${Math.round(start * 1000)}-${Math.round(end * 1000)}`,
        start,
        end,
        text: normalizeCaptionText(current.text),
      });
      current = null;
    };

    pieces.forEach((piece) => {
      if (!current) current = { start: piece.start, end: piece.end, text: "" };
      current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
      current.end = Math.max(current.end, piece.end);
      const length = current.text.length;
      const elapsed = current.end - current.start;
      if (
        piece.terminal ||
        (piece.softBoundary && length >= limits.softBoundaryMinChars) ||
        length >= limits.maxChars ||
        elapsed >= limits.maxSeconds
      ) {
        flush();
      }
    });
    flush();

    return cues;
  }

  /**
   * The persistent cache key for one translated cue. Identical in the
   * background worker and the side panel so a translation is paid for once.
   */
  function playerSubtitleCueCacheKey(videoId, cue) {
    const id = typeof cue === "string" ? cue : cue?.id;
    return `${videoId}:zh:player:${id}`;
  }

  /**
   * Index of the cue covering `currentTime`, or the next upcoming cue when the
   * playhead sits in a gap. Used to decide where prefetching should start.
   */
  function findPlaybackCueIndex(cues, currentTime) {
    if (!Array.isArray(cues) || !cues.length) return 0;
    const time = Number(currentTime) || 0;
    for (let index = cues.length - 1; index >= 0; index -= 1) {
      const cue = cues[index];
      if (Number(cue?.start) <= time && Number(cue?.end) > time) return index;
    }
    const nextIndex = cues.findIndex((cue) => Number(cue?.start) > time);
    return nextIndex >= 0 ? nextIndex : Math.max(0, cues.length - 1);
  }

  return {
    PLAYER_SUBTITLE_CUE_LIMITS,
    SUBTITLE_PREFETCH_LOOKAHEAD,
    SUBTITLE_BATCH_SIZE,
    SUBTITLE_DISPLAY_MODES,
    normalizeSubtitleDisplayMode,
    normalizeCaptionText,
    splitOversizedThought,
    buildPlayerSubtitleCues,
    playerSubtitleCueCacheKey,
    findPlaybackCueIndex,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SUBTITLE_UNITS;
}
