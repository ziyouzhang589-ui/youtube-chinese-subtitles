const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadSidepanelHelpers({
  sendMessage = () => Promise.resolve({}),
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
} = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => {
        let value = "";
        return {
          set textContent(text) {
            value = String(text);
          },
          get innerHTML() {
            return value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
          },
        };
      },
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  // The side panel and the background worker must share one cue definition.
  vm.runInNewContext(read("subtitle-units.js"), sandbox);
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return sandbox.__YTD_TRANSCRIPT_TESTING__;
}

function loadBackgroundHelpers({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  },
  fetchImpl = fetch,
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
} = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    AbortController,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async () => ({ ytd_settings: settings }),
          set: async () => {},
          remove: async () => {},
        },
        session: {
          get: async () => ({}),
          set: async () => {},
          remove: async () => {},
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior: () => Promise.resolve(),
        setOptions: () => Promise.resolve(),
        open: () => Promise.resolve(),
        close: () => Promise.resolve(),
        onOpened: listeners,
        onClosed: listeners,
      },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        onStartup: listeners,
        sendMessage: () => Promise.resolve(),
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
      },
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
        onRemoved: listeners,
        sendMessage: () => Promise.resolve(),
        query: async () => [],
      },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value,
      chatCompletionsUrl: (baseUrl) => `${baseUrl}/chat/completions`,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("subtitle-units.js"), sandbox);
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox.__YTD_TRANSLATION_TESTING__;
}

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay, active: true });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.active = false;
    },
    fireActive(delay) {
      const match = [...timers.entries()].find(
        ([, timer]) => timer.active && timer.delay === delay,
      );
      assert.ok(match, `Expected an active ${delay}ms timer`);
      match[1].active = false;
      match[1].callback();
    },
    activeCount(delay) {
      return [...timers.values()].filter(
        (timer) => timer.active && timer.delay === delay,
      ).length;
    },
    createdCount(delay) {
      return [...timers.values()].filter((timer) => timer.delay === delay).length;
    },
  };
}

function streamingResponse(chunks, { ok = true, status = 200 } = {}) {
  let index = 0;
  return {
    ok,
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {},
        };
      },
    },
  };
}

const encode = (value) => new TextEncoder().encode(value);
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("Transcript header offers the three reading views without a provider call", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  assert.match(html, /data-transcript-mode="original"[\s\S]*?>Original</);
  assert.match(html, /data-transcript-mode="zh"[\s\S]*?>\u4e2d\u6587</);
  assert.match(html, /data-transcript-mode="bilingual"[\s\S]*?>\u53cc\u8bed</);
  // The control switches views over text already held; it never starts a
  // translation, and it says where the switch actually is until one exists.
  assert.match(html, /id="transcriptModeHint"[\s\S]*?\u8bf7\u5728\u89c6\u9891\u64ad\u653e\u5668\u4e2d\u5f00\u542f\u7ffb\u8bd1/);
  assert.match(js, /handleTranscriptModeChange\(button\.dataset\.transcriptMode\)/);
  assert.match(js, /hasCachedTranscriptTranslation\(\)/);
  assert.doesNotMatch(js, /English \+ Chinese/);
  assert.match(js, /Original \(\$\{language\}\)/);
});

test("semantic segmentation rebuilds sentences across caption boundaries", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "Caption boundaries should" },
      { start: 2, text: "not break a complete sentence." },
      { start: 5, text: "The next thought also" },
      { start: 7, text: "stays together!" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(
    segments[0].text,
    "Caption boundaries should not break a complete sentence.",
  );
  assert.equal(segments[0].start, 0);
  assert.equal(segments[1].text, "The next thought also stays together!");
  assert.equal(segments[1].start, 5);
});

test("player subtitle cues stay short and preserve their source time ranges", () => {
  const { buildPlayerSubtitleCues } = loadSidepanelHelpers();
  const { findPlaybackCueIndex } = require(path.join(root, "subtitle-units.js"));
  const cues = buildPlayerSubtitleCues(
    [
      {
        start: 0,
        duration: 6,
        text: "This is the first short thought, and this is the second one.",
      },
      {
        start: 6,
        duration: 3,
        text: "The next sentence is separate.",
      },
    ],
    { maxChars: 48, maxSeconds: 4.8, softBoundaryMinChars: 18, fallbackSeconds: 3.5 },
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(cues.map(({ text }) => text))),
    ["This is the first short thought,", "and this is the second one.", "The next sentence is separate."],
  );
  assert.ok(cues.every((cue) => cue.end > cue.start));
  assert.equal(findPlaybackCueIndex(cues, cues[0].start), 0);
  assert.equal(findPlaybackCueIndex(cues, cues[0].end + 0.01), 1);
  assert.equal(findPlaybackCueIndex(cues, 99), cues.length - 1);
});

test("side-panel paragraphs reuse and merge player cue translations", () => {
  const {
    getCueIndicesForTranscriptSegment,
    composeTranscriptTranslationFromCues,
  } = loadSidepanelHelpers();
  const segments = [
    { id: "segment-a", start: 0, text: "First readable paragraph." },
    { id: "segment-b", start: 6, text: "Second readable paragraph." },
  ];
  const cues = [
    { id: "cue-a", start: 0, end: 2.8, text: "First phrase." },
    { id: "cue-b", start: 2.8, end: 6, text: "Second phrase." },
    { id: "cue-c", start: 6, end: 9, text: "Next paragraph." },
  ];
  const translated = new Map([
    ["cue-a", "第一短句。"],
    ["cue-b", "第二短句。"],
  ]);

  assert.deepEqual(
    JSON.parse(JSON.stringify(getCueIndicesForTranscriptSegment(segments, 0, cues))),
    [0, 1],
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        composeTranscriptTranslationFromCues(
          segments,
          0,
          cues,
          (cue) => translated.get(cue.id),
        ),
      ),
    ),
    {
      cueIndices: [0, 1],
      text: "第一短句。第二短句。",
      complete: true,
    },
  );

  translated.delete("cue-b");
  assert.equal(
    composeTranscriptTranslationFromCues(
      segments,
      0,
      cues,
      (cue) => translated.get(cue.id),
    ).complete,
    false,
  );
});

test("the only translation queue lives in the background worker", () => {
  const panel = read("sidepanel.js");
  const background = read("background.js");

  // Nothing in the side panel may reach a translation provider. If any of
  // these come back, opening the panel can start spending money again.
  assert.doesNotMatch(panel, /requestTranscriptTranslationBatch/);
  assert.doesNotMatch(panel, /activeTranslationQueue/);
  assert.doesNotMatch(panel, /createPlayerSubtitleTranslationQueue/);
  assert.doesNotMatch(panel, /translateTranscript/);
  assert.doesNotMatch(panel, /contentType: "transcriptBatch"/);
  assert.doesNotMatch(panel, /action: "translateContent"/);
  assert.doesNotMatch(panel, /IntersectionObserver/);

  // ...and the background owns the queue, with all three dedupe states.
  assert.match(background, /contentType,?\s*$|"transcriptBatch"/m);
  assert.match(background, /subtitleQueue\.inFlight/);
  assert.match(background, /subtitleQueue\.queued/);
  assert.match(background, /workspace\.translations\.has\(cue\.id\)/);
});

test("a huge raw Supadata entry is split into seekable bounded segments", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const text = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
  const segments = groupTranscriptEntries([
    { start: 12, duration: 90, text },
  ]);
  assert.ok(segments.length > 8);
  assert.ok(segments.every((segment) => segment.text.length <= 384));
  assert.equal(segments[0].start, 12);
  assert.ok(segments.at(-1).start > segments[0].start);
  assert.ok(segments.every((segment) => /^segment-\d+-\d+$/.test(segment.id)));
});

test("Chinese sentence and clause punctuation creates semantic guardrails", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "这是一个被字幕切开的" },
      { start: 2, text: "完整句子。这是第二个想法，" },
      { start: 5, text: "也应该保持语义完整！" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, "这是一个被字幕切开的完整句子。");
  assert.equal(segments[1].text, "这是第二个想法，也应该保持语义完整！");
});

test("structured translation batches align by stable ID in the background", () => {
  const background = loadBackgroundHelpers();
  const source = [
    { id: "segment-0-0", text: "A complete first sentence." },
    { id: "segment-1-5000", text: "A complete second sentence." },
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(background.validateTranscriptBatchRequest({ segments: source }))),
    source,
  );

  const normalized = background.normalizeTranslatedSegmentBatch(
    {
      segments: [
        { id: "unknown", text: "\u5ffd\u7565" },
        { id: "segment-1-5000", text: "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002" },
      ],
    },
    source,
  );
  assert.equal(normalized.segments[0].id, source[0].id);
  assert.equal(normalized.segments[0].text, "");
  assert.match(normalized.segments[0].error, /Missing or invalid/i);
  assert.equal(
    normalized.segments[1].text,
    "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002",
  );
});

test("translated-only omits English while bilingual renders aligned English and Chinese", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const segment = { id: "segment-0-0", text: "Original English sentence." };
  const translatedOnly = renderTranscriptSegmentContent(
    segment,
    "zh",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  const bilingual = renderTranscriptSegmentContent(
    segment,
    "bilingual",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  assert.doesNotMatch(translatedOnly, /Original English sentence/);
  assert.match(translatedOnly, /\u4e2d\u6587\u8bd1\u6587/);
  assert.match(bilingual, /transcript-original/);
  assert.match(bilingual, /Original English sentence/);
  assert.match(bilingual, /\u4e2d\u6587\u8bd1\u6587/);
});

test("subtitle formatting tags render in original and translated segment text", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const html = renderTranscriptSegmentContent(
    {
      id: "segment-0-0",
      text: "Think <i>deeply</i>, <b>carefully</b>, and <u>clearly</u>.<br>Next line.",
    },
    "bilingual",
    "\u5b57\u5730<i>\u601d\u8003</i>\u7684\u3002<strong>\u91cd\u70b9</strong>",
    "",
  );

  assert.match(html, /Think <i>deeply<\/i>/);
  assert.match(html, /<b>carefully<\/b>/);
  assert.match(html, /<u>clearly<\/u>\.<br>Next line/);
  assert.match(html, /\u5b57\u5730<i>\u601d\u8003<\/i>\u7684\u3002<strong>\u91cd\u70b9<\/strong>/);
});

test("subtitle markup renderer keeps attributed and arbitrary HTML escaped", () => {
  const { renderSubtitleInlineMarkup } = loadSidepanelHelpers();
  const html = renderSubtitleInlineMarkup(
    '<img src=x onerror="alert(1)"><i onclick="alert(2)">unsafe</i><script>alert(3)</script>',
  );

  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;i onclick=&quot;alert\(2\)&quot;&gt;unsafe<\/i>/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img\b|<i\s+onclick|<script\b/);
});

test("background rejects unsupported language fallthrough and malformed batches", () => {
  const source = read("background.js");
  const { validateTranscriptBatchRequest } = loadBackgroundHelpers();
  assert.match(source, /targetLanguage !== "zh"/);
  assert.throws(
    () => validateTranscriptBatchRequest({ segments: [] }),
    /1 to 4 segments/,
  );
  assert.throws(
    () =>
      validateTranscriptBatchRequest({
        segments: [
          { id: "duplicate", text: "first" },
          { id: "duplicate", text: "second" },
        ],
      }),
    /unique and stable/,
  );
});

test("all AI product requests use DeepSeek non-thinking and JSON behavior", async () => {
  const deepSeekRequests = [];
  const successfulFetch = (requests) => async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "translated" } }],
      }),
    };
  };

  const deepSeek = loadBackgroundHelpers({
    fetchImpl: successfulFetch(deepSeekRequests),
  });
  const deepSeekResult = await deepSeek.requestAiCompletion({
    maxTokens: 128,
    responseFormat: { type: "json_object" },
    messages: [{ role: "user", content: "Hello." }],
  });
  assert.equal(deepSeekResult.text, "translated");
  assert.deepEqual(deepSeekRequests[0].thinking, { type: "disabled" });
  assert.deepEqual(deepSeekRequests[0].response_format, {
    type: "json_object",
  });

  const backgroundSource = read("background.js");
  assert.equal(
    (backgroundSource.match(/await requestAiCompletion\(\{/g) || []).length,
    4,
  );
  assert.doesNotMatch(backgroundSource, /disableThinking/);
  for (const callPath of [
    "handleAnalyzeTranscript",
    "cleanupNoteText",
    "handleExplainSelection",
    "callAiTranslation",
  ]) {
    assert.match(
      backgroundSource,
      new RegExp(`async function ${callPath}\\([\\s\\S]*?requestAiCompletion\\(\\{`),
    );
  }
});

test("blank-line chunks reset provider idle timeout and valid JSON succeeds", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async () =>
      streamingResponse([
        encode("\n"),
        encode("\n"),
        encode('{"choices":[{"message":{"content":"translated"}}]}'),
      ]),
  });

  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "translated");
  assert.equal(timers.createdCount(50_000), 5);
  assert.equal(timers.activeCount(50_000), 0);
  assert.equal(timers.activeCount(120_000), 0);
});

test("provider idle silence aborts with a distinct Retry-able error", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, { signal }) => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              });
            }),
        }),
      },
    }),
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  timers.fireActive(50_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_IDLE_TIMEOUT");
  assert.match(result.error, /inactive for 50 seconds.*Retry/i);
  assert.equal(timers.activeCount(120_000), 0);
});

test("blank-line keepalives cannot evade the provider hard cap", async () => {
  const timers = createFakeTimers();
  let releaseRead;
  let signal;
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () =>
              new Promise((resolve, reject) => {
                releaseRead = () => resolve({ done: false, value: encode("\n") });
                signal.addEventListener("abort", () => {
                  const error = new Error("aborted");
                  error.name = "AbortError";
                  reject(error);
                }, { once: true });
              }),
          }),
        },
      };
    },
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  releaseRead();
  await nextTurn();
  releaseRead();
  await nextTurn();
  assert.equal(timers.activeCount(50_000), 1);
  timers.fireActive(120_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_HARD_TIMEOUT");
  assert.match(result.error, /120-second limit.*Retry/i);
  assert.equal(timers.activeCount(50_000), 0);
});

test("provider response reader accepts leading whitespace before JSON", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([
        encode('  \n\t{"choices":[{"message":{"content":"ok"}}]}'),
      ]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "ok");
});

test("provider response reader rejects bodies over 2 MiB", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([new Uint8Array(2 * 1024 * 1024 + 1)]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_RESPONSE_TOO_LARGE");
  assert.match(result.error, /2 MiB limit/);
});

test("DeepSeek retries one empty transcript JSON response without response_format", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: requests.length === 1
                ? ""
                : '{"segments":[{"id":"segment-0-0","text":"\u4e2d\u6587\u8bd1\u6587\u3002"}]}',
            },
          }],
        }),
      };
    },
  });
  const result = await helpers.handleTranslateContent(
    { segments: [{ id: "segment-0-0", text: "English source sentence." }] },
    "transcriptBatch",
    "zh",
    "Video",
  );
  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(requests[1], "response_format"), false);
  assert.equal(requests[0].max_tokens, 1536);
});

test("Chinese prompt preserves natural bilingual-learning style rules", () => {
  const prompt = read("prompts/translation.md");
  assert.match(prompt, /Translate the complete thought/);
  assert.match(prompt, /Use 你, never 您/);
  assert.match(prompt, /spaces between Chinese and adjacent English words or digits/);
  assert.match(prompt, /source-language `text`/);
});

test("subtitle overlay tracks retain only safe, timestamped public subtitle data", () => {
  const background = loadBackgroundHelpers();
  const track = background.normalizeSubtitleOverlayTrack({
    videoId: "abc12345678",
    mode: "zh",
    segments: [
      { id: "segment-0-0", start: 0, original: "Hello", translated: "\u4f60\u597d" },
      { id: "segment-1-2000", start: 2, end: 3.5, original: "World", translated: "\u4e16\u754c" },
    ],
  });

  assert.equal(track.videoId, "abc12345678");
  // The stored cache must never remember that Chinese was showing. A cached
  // "mode" is exactly what used to make a revisited video translate itself.
  assert.equal(track.mode, "off");
  assert.equal(track.segments.length, 2);
  assert.equal(track.segments[0].translated, "\u4f60\u597d");
  assert.equal(track.segments[1].end, 3.5);
  assert.equal(background.normalizeSubtitleOverlayMode("bilingual"), "bilingual");
  assert.equal(background.normalizeSubtitleOverlayMode("other"), "off");
  assert.equal(
    background.subtitleOverlayStorageKey("abc12345678"),
    "ytd_subtitle_track_abc12345678",
  );
});

test("the prefetch window starts at the cue currently being spoken", () => {
  const units = require(path.join(root, "subtitle-units.js"));
  const cues = [
    { start: 0, end: 5 },
    { start: 5, end: 10 },
    { start: 10, end: 15 },
  ];
  assert.equal(units.findPlaybackCueIndex(cues, 0), 0);
  assert.equal(units.findPlaybackCueIndex(cues, 7), 1);
  assert.equal(units.findPlaybackCueIndex(cues, 99), 2);
  // Current cue plus five, three per request: a video that is opened and
  // abandoned costs at most a couple of small calls.
  assert.equal(units.SUBTITLE_PREFETCH_LOOKAHEAD, 5);
  assert.equal(units.SUBTITLE_BATCH_SIZE, 3);
});

test("the side panel mirrors the player's mode and never starts translation", () => {
  const sidepanel = loadSidepanelHelpers({
    sendMessage: () => {
      throw new Error("the side panel must not talk to the provider");
    },
  });

  assert.equal(sidepanel.transcriptModeForSubtitleOverlayMode("zh"), "zh");
  assert.equal(sidepanel.transcriptModeForSubtitleOverlayMode("bilingual"), "bilingual");
  assert.equal(sidepanel.transcriptModeForSubtitleOverlayMode("off"), "original");
  assert.equal(sidepanel.transcriptModeForSubtitleOverlayMode(undefined), "original");

  // Following the player is pure display work: no transcript is loaded here,
  // so these calls must be inert rather than fetching anything.
  assert.equal(sidepanel.getCurrentTranscriptMode(), "original");
  sidepanel.applyTranscriptModeFromPlayer("zh");
  assert.equal(sidepanel.getCurrentTranscriptMode(), "zh");
  sidepanel.applyTranscriptModeFromPlayer("off");
  assert.equal(sidepanel.getCurrentTranscriptMode(), "original");
  sidepanel.handleSubtitleTrackUpdate("abc12345678", { segments: [] }, "zh");
});

test("opening a different video resets the panel to the original transcript", () => {
  const js = read("sidepanel.js");
  // startDigest must clear the previous video's display mode, so a video that
  // was read in Chinese does not make the next one look activated.
  assert.match(
    js,
    /if \(videoId !== currentVideoId\) \{[\s\S]*?currentTranscriptMode = "original";/,
  );
  // Neither cache path may kick off a translation on load.
  assert.doesNotMatch(js, /if \(currentTranscriptMode !== "original"\) translateTranscript/);
  assert.match(js, /syncSubtitleStateFromPlayer\(videoId\)/);
});

test("scrolling and playback tracking cannot queue translation work", () => {
  const js = read("sidepanel.js");
  const tick = js
    .slice(
      js.indexOf("async function playbackTrackingTick()"),
      js.indexOf("function scrollToActiveEntry()"),
    )
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(tick, /prefetch/i);
  assert.doesNotMatch(tick, /translat/i);
  // The scroll-driven prefetch observer is gone entirely.
  assert.doesNotMatch(js, /transcriptScrollObserver/);
});
