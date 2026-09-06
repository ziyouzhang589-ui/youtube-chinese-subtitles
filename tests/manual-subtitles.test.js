/**
 * Manual-activation guarantees.
 *
 * The single rule these tests defend: DeepSeek is called only after the user
 * presses the subtitle button on the player, for that video, in that tab.
 * Opening the panel, switching videos, reloading, scrolling, or replaying a
 * video that was translated before must all cost nothing.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const encode = (value) => new TextEncoder().encode(value);
// The worker's arrays come from a separate realm, so copy them into this one
// before comparing.
const openTabs = (bg) => Array.from(bg.helpers.getOpenSidePanelTabs());
const settle = async (turns = 12) => {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function streamingResponse(text) {
  let done = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (done) return { done: true };
            done = true;
            return { done: false, value: encode(text) };
          },
          async cancel() {},
        };
      },
    },
  };
}

function createListenerHub() {
  const listeners = [];
  return {
    addListener(fn) {
      listeners.push(fn);
    },
    emit(...args) {
      listeners.forEach((fn) => fn(...args));
    },
    listeners,
  };
}

function createStorageArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const result = {};
      list.forEach((key) => {
        if (key in data) result[key] = data[key];
      });
      return result;
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete data[key]);
    },
    async setAccessLevel() {},
  };
}

/**
 * Loads background.js against a fake Chrome, and returns handles for driving
 * it the way the player and the toolbar icon would.
 */
function loadBackground({
  local = {},
  session = {},
  supportsClose = true,
  supadataStatus = 200,
  supadataBody = null,
  transcript = [
    { text: "First sentence here.", start: 0, duration: 3 },
    { text: "Second sentence here.", start: 3, duration: 3 },
    { text: "Third sentence here.", start: 6, duration: 3 },
    { text: "Fourth sentence here.", start: 9, duration: 3 },
    { text: "Fifth sentence here.", start: 12, duration: 3 },
    { text: "Sixth sentence here.", start: 15, duration: 3 },
    { text: "Seventh sentence here.", start: 18, duration: 3 },
    { text: "Eighth sentence here.", start: 21, duration: 3 },
  ],
} = {}) {
  const calls = { supadata: 0, deepseek: 0, aiPayloads: [] };
  const localArea = createStorageArea(local);
  const sessionArea = createStorageArea(session);
  const tabMessages = [];
  const runtimeMessages = [];
  const sidePanelOps = [];
  const onMessage = createListenerHub();
  const onStartup = createListenerHub();
  const onRemoved = createListenerHub();

  const fetchImpl = async (url, options) => {
    const href = String(url);
    if (href.startsWith("chrome-extension://test/")) {
      // The worker loads its prompts from the packaged files.
      const body = read(href.replace("chrome-extension://test/", ""));
      return { ok: true, status: 200, async text() { return body; } };
    }
    if (href.includes("supadata")) {
      calls.supadata += 1;
      if (supadataStatus !== 200) {
        return {
          ok: false,
          status: supadataStatus,
          async json() {
            return supadataBody || {};
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            lang: "en",
            content: transcript.map((entry) => ({
              text: entry.text,
              offset: entry.start * 1000,
              duration: entry.duration * 1000,
              lang: "en",
            })),
          };
        },
      };
    }
    calls.deepseek += 1;
    const body = JSON.parse(options.body);
    const payload = JSON.parse(body.messages.at(-1).content);
    calls.aiPayloads.push(payload.segments.map((segment) => segment.id));
    return streamingResponse(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                segments: payload.segments.map((segment) => ({
                  id: segment.id,
                  text: `译:${segment.text}`,
                })),
              }),
            },
          },
        ],
      }),
    );
  };

  const sidePanel = {
    setPanelBehavior: (options) => {
      sidePanelOps.push({ op: "behavior", ...options });
      return Promise.resolve();
    },
    setOptions: (options) => {
      sidePanelOps.push({ op: "setOptions", ...options });
      return Promise.resolve();
    },
    open: (options) => {
      sidePanelOps.push({ op: "open", ...options });
      return Promise.resolve();
    },
    onOpened: createListenerHub(),
    onClosed: createListenerHub(),
  };
  if (supportsClose) {
    sidePanel.close = (options) => {
      sidePanelOps.push({ op: "close", ...options });
      return Promise.resolve();
    };
  }

  const onClicked = createListenerHub();
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout,
    importScripts() {},
    chrome: {
      storage: { local: localArea, session: sessionArea },
      action: { onClicked },
      sidePanel,
      runtime: {
        onInstalled: createListenerHub(),
        onStartup,
        onMessage,
        sendMessage: async (message) => {
          runtimeMessages.push(message);
        },
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
      },
      tabs: {
        onUpdated: createListenerHub(),
        onActivated: createListenerHub(),
        onRemoved,
        sendMessage: async (tabId, message) => {
          tabMessages.push({ tabId, message });
        },
        query: async () => [],
      },
      scripting: { executeScript: async () => [] },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value,
      chatCompletionsUrl: () => "https://api.deepseek.com/chat/completions",
      canonicalYouTubeUrl: (videoId) => `https://www.youtube.com/watch?v=${videoId}`,
    },
  };
  sandbox.globalThis = sandbox;
  localArea.data.ytd_settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    supadataApiKey: "test-supadata",
  };

  vm.runInNewContext(read("subtitle-units.js"), sandbox);
  vm.runInNewContext(read("background.js"), sandbox);

  // Drives chrome.runtime.onMessage the way a page or panel would.
  const send = (message, sender = {}) =>
    new Promise((resolve) => {
      let answered = false;
      const respond = (value) => {
        if (answered) return;
        answered = true;
        resolve(value);
      };
      const handled = onMessage.listeners.some((listener) =>
        listener(message, sender, respond),
      );
      if (!handled) respond(undefined);
    });

  return {
    sandbox,
    helpers: sandbox.__YTD_TRANSLATION_TESTING__,
    calls,
    localArea,
    sessionArea,
    tabMessages,
    runtimeMessages,
    sidePanelOps,
    sidePanel,
    send,
    clickAction: (tab) => onClicked.emit(tab),
    fireStartup: () => onStartup.emit(),
    closeTab: (tabId) => onRemoved.emit(tabId),
  };
}

const TAB = 7;
const VIDEO = "abc12345678";

test("no message except an explicit activation reaches DeepSeek", async () => {
  const bg = loadBackground();

  // Opening the panel, reading state, switching videos, and reading the cached
  // track are all things the UI does on its own. None may spend anything.
  bg.clickAction({ id: TAB });
  await bg.send({ action: "getSubtitleSessionState", videoId: VIDEO });
  await bg.send({ action: "getSubtitleOverlayTrack", videoId: VIDEO });
  await bg.send({ action: "resetSubtitleSession" }, { tab: { id: TAB } });
  await bg.send(
    { action: "prefetchSubtitleWindow", videoId: VIDEO, currentTime: 4 },
    { tab: { id: TAB } },
  );
  await settle();

  assert.equal(bg.calls.deepseek, 0);
  assert.equal(bg.calls.supadata, 0);
});

test("activation translates only the current window, then reuses the cache", async () => {
  const bg = loadBackground();

  const activated = await bg.send(
    {
      action: "activateSubtitleTranslation",
      videoId: VIDEO,
      currentTime: 0,
      mode: "zh",
    },
    { tab: { id: TAB } },
  );
  await settle(40);

  assert.equal(activated.success, true);
  assert.equal(bg.calls.supadata, 1);
  assert.ok(bg.calls.deepseek > 0, "the activated window is translated");

  // Current cue plus five look-ahead cues, three per request.
  const requested = bg.calls.aiPayloads.flat();
  assert.ok(requested.length <= 6, `translated ${requested.length} cues`);
  assert.ok(bg.calls.aiPayloads.every((batch) => batch.length <= 3));

  // The player was handed a track carrying the Chinese text.
  const pushed = bg.tabMessages.filter(
    (entry) => entry.message.action === "setSubtitleOverlayTrack",
  );
  assert.ok(pushed.length > 0);
  assert.equal(pushed.at(-1).tabId, TAB);
  assert.ok(
    pushed.at(-1).message.track.segments.some((segment) => segment.translated),
  );

  // 中 -> 双 is presentation only.
  const before = bg.calls.deepseek;
  await bg.send(
    { action: "setSubtitleDisplayMode", videoId: VIDEO, mode: "bilingual" },
    { tab: { id: TAB } },
  );
  await settle();
  assert.equal(bg.calls.deepseek, before);

  // Same window again: everything is cached, so nothing is re-sent.
  await bg.send(
    { action: "prefetchSubtitleWindow", videoId: VIDEO, currentTime: 0 },
    { tab: { id: TAB } },
  );
  await settle();
  assert.equal(bg.calls.deepseek, before);
});

test("closing subtitles stops prefetching but keeps the cache", async () => {
  const bg = loadBackground();
  await bg.send(
    { action: "activateSubtitleTranslation", videoId: VIDEO, currentTime: 0, mode: "zh" },
    { tab: { id: TAB } },
  );
  await settle(40);
  const afterActivation = bg.calls.deepseek;
  assert.ok(afterActivation > 0);

  await bg.send(
    { action: "deactivateSubtitleTranslation", videoId: VIDEO },
    { tab: { id: TAB } },
  );
  await bg.send(
    { action: "prefetchSubtitleWindow", videoId: VIDEO, currentTime: 30 },
    { tab: { id: TAB } },
  );
  await settle(20);

  assert.equal(bg.calls.deepseek, afterActivation, "no work after 关");
  assert.equal(bg.helpers.getSubtitleSession(), null);

  const cachedTrack = bg.localArea.data[`ytd_subtitle_track_${VIDEO}`];
  assert.ok(cachedTrack, "translations survive switching subtitles off");
  assert.ok(cachedTrack.segments.some((segment) => segment.translated));
});

test("a revisited, already-translated video starts closed and costs nothing", async () => {
  const first = loadBackground();
  await first.send(
    { action: "activateSubtitleTranslation", videoId: VIDEO, currentTime: 0, mode: "zh" },
    { tab: { id: TAB } },
  );
  await settle(40);

  // Same persistent storage, brand-new browser session.
  const second = loadBackground({ local: { ...first.localArea.data } });
  await second.send({ action: "getSubtitleOverlayTrack", videoId: VIDEO });
  const state = await second.send({
    action: "getSubtitleSessionState",
    videoId: VIDEO,
  });
  assert.equal(state.mode, "off", "a cached video still starts closed");
  assert.equal(second.calls.deepseek, 0);
  assert.equal(second.calls.supadata, 0);

  // Re-enabling replays the cache instead of the provider.
  await second.send(
    { action: "activateSubtitleTranslation", videoId: VIDEO, currentTime: 0, mode: "zh" },
    { tab: { id: TAB } },
  );
  await settle(40);
  assert.equal(second.calls.deepseek, 0, "cached cues are never re-translated");
  assert.equal(second.calls.supadata, 0, "the cached transcript is reused");
});

test("a stale cached mode never reactivates translation", async () => {
  const bg = loadBackground({
    local: {
      [`ytd_subtitle_track_${VIDEO}`]: {
        videoId: VIDEO,
        mode: "bilingual",
        timestamp: Date.now(),
        segments: [
          { id: "player-0-0-2000", start: 0, end: 2, original: "Hi", translated: "嗨" },
        ],
      },
    },
  });

  const result = await bg.send({ action: "getSubtitleOverlayTrack", videoId: VIDEO });
  assert.equal(result.track.mode, "off");
  const state = await bg.send({ action: "getSubtitleSessionState", videoId: VIDEO });
  assert.equal(state.mode, "off");
  assert.equal(bg.calls.deepseek, 0);
});

test("switching videos voids the previous authorization", async () => {
  const bg = loadBackground();
  await bg.send(
    { action: "activateSubtitleTranslation", videoId: VIDEO, currentTime: 0, mode: "zh" },
    { tab: { id: TAB } },
  );
  await settle(40);
  const firstGeneration = bg.helpers.getSubtitleSession().generation;

  await bg.send({ action: "resetSubtitleSession" }, { tab: { id: TAB } });
  assert.equal(bg.helpers.getSubtitleSession(), null);

  const spent = bg.calls.deepseek;
  const refused = await bg.send(
    { action: "prefetchSubtitleWindow", videoId: "zzz98765432", currentTime: 0 },
    { tab: { id: TAB } },
  );
  await settle(20);
  assert.equal(refused.success, false);
  assert.equal(bg.calls.deepseek, spent, "the new video translates nothing");

  // A result addressed to the retired generation must not be pushed.
  bg.tabMessages.length = 0;
  const workspace = { videoId: VIDEO, cues: [], translations: new Map() };
  await bg.helpers.buildSubtitleTrack(workspace);
  assert.equal(
    bg.helpers.subtitleSessionMatches(TAB, VIDEO, firstGeneration),
    false,
  );
});

test("a page script cannot claim another tab's session", async () => {
  const bg = loadBackground();
  await bg.send(
    { action: "activateSubtitleTranslation", videoId: VIDEO, currentTime: 0, mode: "zh" },
    { tab: { id: TAB } },
  );
  await settle(40);
  const spent = bg.calls.deepseek;

  // A different tab passing the right videoId is still refused: the session is
  // keyed on sender.tab.id, which a page script cannot forge.
  const refused = await bg.send(
    { action: "prefetchSubtitleWindow", videoId: VIDEO, currentTime: 30, tabId: TAB },
    { tab: { id: TAB + 1 } },
  );
  await settle(20);
  assert.equal(refused.success, false);
  assert.equal(bg.calls.deepseek, spent);
});

test("an activation without a tab context is rejected", async () => {
  const bg = loadBackground();
  const result = await bg.send({
    action: "activateSubtitleTranslation",
    videoId: VIDEO,
    currentTime: 0,
    mode: "zh",
  });
  await settle();
  assert.equal(result.success, false);
  assert.match(result.error, /tab context/i);
  assert.equal(bg.calls.deepseek, 0);
});

test("fetching the transcript keeps notes and the overview intact", async () => {
  const bg = loadBackground({
    local: {
      [`digest_${VIDEO}`]: {
        analysis: { chapters: [{ title: "Kept" }] },
        videoTitle: "My video",
        timestamp: Date.now(),
      },
    },
  });
  await bg.send(
    { action: "activateSubtitleTranslation", videoId: VIDEO, currentTime: 0, mode: "zh" },
    { tab: { id: TAB } },
  );
  await settle(40);

  const cached = bg.localArea.data[`digest_${VIDEO}`];
  assert.deepEqual(cached.analysis, { chapters: [{ title: "Kept" }] });
  assert.equal(cached.videoTitle, "My video");
  assert.ok(cached.transcript.length > 0);
  assert.ok(Object.keys(cached.playerCueCache || {}).length > 0);
});

test("the toolbar icon opens and closes the panel, and startup forgets it", async () => {
  const bg = loadBackground();
  assert.deepEqual(openTabs(bg), []);
  // openPanelOnActionClick is off: this worker owns both halves of the toggle.
  assert.ok(
    bg.sidePanelOps.some(
      (op) => op.op === "behavior" && op.openPanelOnActionClick === false,
    ),
  );

  bg.clickAction({ id: TAB });
  await settle();
  assert.ok(bg.sidePanelOps.some((op) => op.op === "open" && op.tabId === TAB));
  assert.deepEqual(openTabs(bg), [TAB]);

  bg.clickAction({ id: TAB });
  await settle();
  assert.ok(bg.sidePanelOps.some((op) => op.op === "close" && op.tabId === TAB));
  assert.deepEqual(openTabs(bg), []);

  // The panel's own close button reports through onClosed.
  bg.clickAction({ id: TAB });
  await settle();
  bg.sidePanel.onClosed.emit({ tabId: TAB });
  assert.deepEqual(openTabs(bg), []);

  // A browser restart starts closed again.
  bg.clickAction({ id: TAB });
  await settle();
  assert.deepEqual(openTabs(bg), [TAB]);
  bg.fireStartup();
  assert.deepEqual(openTabs(bg), []);
  assert.equal(bg.helpers.getSubtitleSession(), null);
});

test("a Chrome without sidePanel.close still opens from the icon", async () => {
  const bg = loadBackground({ supportsClose: false });
  bg.clickAction({ id: TAB });
  await settle();
  bg.clickAction({ id: TAB });
  await settle();
  const opens = bg.sidePanelOps.filter((op) => op.op === "open");
  assert.equal(opens.length, 2, "each click opens; the native X closes");
});

test("a service-worker restart restores state without opening or translating", async () => {
  const bg = loadBackground();
  bg.clickAction({ id: TAB });
  await bg.send(
    { action: "activateSubtitleTranslation", videoId: VIDEO, currentTime: 0, mode: "zh" },
    { tab: { id: TAB } },
  );
  await settle(40);

  // The worker was evicted and woke up again: same session storage, same
  // persistent cache, but no startup event.
  const woken = loadBackground({
    local: { ...bg.localArea.data },
    session: { ...bg.sessionArea.data },
  });
  await settle();

  assert.deepEqual(openTabs(woken), [TAB]);
  assert.equal(woken.helpers.getSubtitleSession()?.videoId, VIDEO);
  assert.equal(woken.calls.deepseek, 0, "waking up translates nothing");
  assert.equal(
    woken.sidePanelOps.filter((op) => op.op === "open").length,
    0,
    "waking up opens nothing",
  );
});

test("closing the tab ends its subtitle session", async () => {
  const bg = loadBackground();
  bg.clickAction({ id: TAB });
  await bg.send(
    { action: "activateSubtitleTranslation", videoId: VIDEO, currentTime: 0, mode: "zh" },
    { tab: { id: TAB } },
  );
  await settle(40);

  bg.closeTab(TAB);
  assert.equal(bg.helpers.getSubtitleSession(), null);
  assert.deepEqual(openTabs(bg), []);
});

test("one video is fetched from Supadata at most once", async () => {
  const bg = loadBackground();

  // The side panel opening a video and the player subtitle button being
  // switched on are two independent paths to the same transcript. Fired
  // together, they must still produce a single Supadata request: two would
  // spend two credits and trip the rate limit with a back-to-back burst.
  const [panel, player] = await Promise.all([
    bg.send({ action: "fetchTranscript", videoId: VIDEO }),
    bg.send(
      { action: "activateSubtitleTranslation", videoId: VIDEO, currentTime: 0, mode: "zh" },
      { tab: { id: TAB } },
    ),
  ]);
  await settle(40);

  assert.equal(panel.success, true);
  assert.equal(player.success, true);
  assert.equal(bg.calls.supadata, 1, "concurrent callers share one request");
});

test("an already fetched transcript is served without touching Supadata", async () => {
  const bg = loadBackground();

  const first = await bg.send({ action: "fetchTranscript", videoId: VIDEO });
  assert.equal(first.success, true);
  assert.equal(first.fromCache, undefined);
  assert.equal(bg.calls.supadata, 1);

  // Reopening the video, and switching subtitles on, both read the cache.
  const second = await bg.send({ action: "fetchTranscript", videoId: VIDEO });
  await bg.send(
    { action: "activateSubtitleTranslation", videoId: VIDEO, currentTime: 0, mode: "zh" },
    { tab: { id: TAB } },
  );
  await settle(40);

  assert.equal(second.success, true);
  assert.equal(second.fromCache, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(second.transcript)),
    JSON.parse(JSON.stringify(first.transcript)),
  );
  assert.equal(bg.calls.supadata, 1, "no second credit is ever spent");
});

test("a failed fetch is shared, not repeated, by concurrent callers", async () => {
  const bg = loadBackground({ transcript: [] });

  const [a, b] = await Promise.all([
    bg.send({ action: "fetchTranscript", videoId: VIDEO }),
    bg.send({ action: "fetchTranscript", videoId: VIDEO }),
  ]);

  assert.equal(a.success, false);
  assert.equal(b.success, false);
  assert.equal(bg.calls.supadata, 1, "a failure must not double the burst");

  // The failure is not cached: a later, deliberate retry does reach Supadata.
  const retry = await bg.send({ action: "fetchTranscript", videoId: VIDEO });
  assert.equal(retry.success, false);
  assert.equal(bg.calls.supadata, 2, "Try Again still retries");
});

test("a Supadata refusal repeats Supadata's own reason", async () => {
  const { supadataErrorDetail } = loadBackground().helpers;

  // The two fields sometimes repeat each other; say it once.
  assert.equal(
    supadataErrorDetail({ error: "limit-exceeded", message: "Limit exceeded" }),
    "Limit exceeded",
  );
  assert.equal(
    supadataErrorDetail({
      message: "Limit exceeded",
      details: "You have reached your plan's monthly quota limit.",
    }),
    "Limit exceeded You have reached your plan's monthly quota limit.",
  );
  assert.equal(
    supadataErrorDetail({ message: "Same", details: "Same" }),
    "Same",
  );
  assert.equal(supadataErrorDetail({}), "");
  assert.equal(supadataErrorDetail(null), "");
  assert.equal(supadataErrorDetail({ message: 42, details: [] }), "");
  assert.ok(supadataErrorDetail({ message: "x".repeat(500) }).length <= 303);
});

test("a rate-limited fetch tells the reader which limit was hit", async () => {
  const bg = loadBackground({
    supadataStatus: 429,
    supadataBody: {
      error: "limit-exceeded",
      message: "Limit exceeded",
      details: "You have reached your plan's monthly quota limit.",
    },
  });

  const result = await bg.send({ action: "fetchTranscript", videoId: VIDEO });
  assert.equal(result.success, false);
  assert.equal(result.error, "RATE_LIMITED");
  // The old copy always blamed a short burst, which sent the reader looking
  // for a rate limit when the real problem was the monthly quota.
  assert.match(result.message, /monthly quota limit/);
  assert.match(result.message, /dash\.supadata\.ai/);
  assert.doesNotMatch(result.message, /Please wait a minute/);

  // A refusal with no explanation still gives the reader somewhere to look.
  const bare = loadBackground({ supadataStatus: 429, supadataBody: {} });
  const bareResult = await bare.send({ action: "fetchTranscript", videoId: VIDEO });
  assert.match(bareResult.message, /dash\.supadata\.ai/);
});
