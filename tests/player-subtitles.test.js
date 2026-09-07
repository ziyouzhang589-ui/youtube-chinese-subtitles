const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.resolve(__dirname, "..", "content.js"),
  "utf8",
);

class FakeNode {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.id = "";
    this.className = "";
    this.type = "";
    this.title = "";
    this.textContent = "";
    this.children = [];
    this.parentElement = null;
    this.isConnected = true;
    this.style = { cssText: "", position: "" };
    this.attributes = {};
    this.listeners = {};
  }

  appendChild(child) {
    child.parentElement = this;
    child.isConnected = true;
    this.children.push(child);
    return child;
  }

  replaceChildren(...nodes) {
    this.children = nodes;
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(
        (child) => child !== this,
      );
    }
    this.parentElement = null;
    this.isConnected = false;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(name, handler) {
    (this.listeners[name] ||= []).push(handler);
  }

  removeEventListener() {}

  dispatch(name, event = {}) {
    (this.listeners[name] || []).forEach((handler) =>
      handler({ preventDefault() {}, stopPropagation() {}, ...event }),
    );
  }

  getBoundingClientRect() {
    return { width: 640, height: 360 };
  }

  querySelectorAll() {
    return [];
  }

  closest() {
    return null;
  }
}

/**
 * Loads content.js against a fake watch page. `messages` records everything the
 * page tries to tell the background worker, which is how these tests prove that
 * only a deliberate click can start a translation.
 */
function loadPlayer({ videoId = "abc12345678", pathname = "/watch" } = {}) {
  const messages = [];
  const documentListeners = {};
  const player = new FakeNode();
  player.id = "movie_player";
  const video = new FakeNode("video");
  video.currentTime = 0;

  const intervals = new Map();
  let nextTimerId = 1;

  const sandbox = {
    console,
    URL,
    document: {
      readyState: "complete",
      fullscreenElement: null,
      addEventListener(name, handler) {
        (documentListeners[name] ||= []).push(handler);
      },
      querySelector(selector) {
        if (selector.includes("movie_player") || selector.includes("html5-video-player")) {
          return player;
        }
        if (selector.includes("video.html5-main-video")) return video;
        return null;
      },
      querySelectorAll() {
        return [];
      },
      getElementById() {
        return null;
      },
      createElement: (tag) => new FakeNode(tag),
    },
    window: {
      location: {
        href: `https://www.youtube.com/watch?v=${videoId}`,
        pathname,
      },
      addEventListener() {},
      getComputedStyle: () => ({ position: "relative" }),
    },
    MutationObserver: class {
      observe() {}
    },
    setTimeout: (callback) => {
      nextTimerId += 1;
      return nextTimerId;
    },
    clearTimeout() {},
    setInterval: (callback, delay) => {
      const id = (nextTimerId += 1);
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async (message) => {
          messages.push(message);
          if (message.action === "activateSubtitleTranslation") {
            return { success: true, generation: 4, mode: message.mode };
          }
          return { success: true };
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);

  return {
    sandbox,
    helpers: sandbox.__YTD_PLAYER_SUBTITLES_TESTING__,
    messages,
    setFullscreen(element) {
      sandbox.document.fullscreenElement = element;
      (documentListeners.fullscreenchange || []).forEach((handler) => handler());
    },
    player,
    video,
    setLocation(nextVideoId) {
      sandbox.window.location.href = `https://www.youtube.com/watch?v=${nextVideoId}`;
    },
    toggle() {
      return player.children.find(
        (child) => child.id === "ytd-digest-subtitle-toggle",
      );
    },
    overlay() {
      return player.children.find(
        (child) => child.id === "ytd-digest-subtitle-overlay",
      );
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("player subtitle modes normalize to closed", () => {
  const { helpers } = loadPlayer();
  assert.equal(helpers.normalizePlayerSubtitleMode("zh"), "zh");
  assert.equal(helpers.normalizePlayerSubtitleMode("bilingual"), "bilingual");
  assert.equal(helpers.normalizePlayerSubtitleMode("unexpected"), "off");
  assert.equal(helpers.subtitleModeLabel("zh"), "中");
  assert.equal(helpers.subtitleModeLabel("bilingual"), "双");
  assert.equal(helpers.subtitleModeLabel("off"), "关");
});

test("the button cycles 关 -> 中 -> 双 -> 关", () => {
  const { helpers } = loadPlayer();
  assert.equal(helpers.nextPlayerSubtitleMode("off"), "zh");
  assert.equal(helpers.nextPlayerSubtitleMode("zh"), "bilingual");
  assert.equal(helpers.nextPlayerSubtitleMode("bilingual"), "off");
});

test("player subtitle cue selection follows timestamp boundaries", () => {
  const { helpers } = loadPlayer();
  const segments = [
    { id: "a", start: 0, original: "One", translated: "一" },
    { id: "b", start: 5, original: "Two", translated: "二" },
    { id: "c", start: 10, original: "Three", translated: "三" },
  ];

  assert.equal(helpers.findPlayerSubtitleCue(segments, -1), null);
  assert.equal(helpers.findPlayerSubtitleCue(segments, 0).id, "a");
  assert.equal(helpers.findPlayerSubtitleCue(segments, 4.99).id, "a");
  assert.equal(helpers.findPlayerSubtitleCue(segments, 5).id, "b");
  assert.equal(helpers.findPlayerSubtitleCue(segments, 11).id, "c");
});

test("player subtitle cue selection clears during an explicit source gap", () => {
  const { helpers } = loadPlayer();
  const segments = [
    { id: "a", start: 0, end: 2.2, original: "One", translated: "一" },
    { id: "b", start: 3, end: 5, original: "Two", translated: "二" },
  ];

  assert.equal(helpers.findPlayerSubtitleCue(segments, 2.19).id, "a");
  assert.equal(helpers.findPlayerSubtitleCue(segments, 2.2), null);
  assert.equal(helpers.findPlayerSubtitleCue(segments, 2.8), null);
  assert.equal(helpers.findPlayerSubtitleCue(segments, 3).id, "b");
  assert.equal(helpers.findPlayerSubtitleCue(segments, 5), null);
});

test("the toggle appears on a watch page and starts closed", () => {
  const player = loadPlayer();
  player.helpers.setupPlayerSubtitlesForCurrentVideo();

  // The button is there before any subtitle track exists — fetching one is
  // exactly what the first click is for.
  assert.ok(player.toggle(), "subtitle button is injected");
  assert.equal(player.toggle().textContent, "关");
  assert.equal(player.helpers.getPlayerSubtitleMode(), "off");
  assert.equal(
    player.messages.some((message) =>
      String(message.action).startsWith("activate"),
    ),
    false,
    "showing the button authorizes nothing",
  );
});

test("only 关 -> 中 activates translation; 中 -> 双 is presentation only", async () => {
  const player = loadPlayer();
  player.helpers.setupPlayerSubtitlesForCurrentVideo();
  player.messages.length = 0;

  player.toggle().dispatch("click");
  await settle();
  assert.equal(player.helpers.getPlayerSubtitleMode(), "zh");
  const activation = player.messages.find(
    (message) => message.action === "activateSubtitleTranslation",
  );
  assert.ok(activation, "the first click authorizes translation");
  assert.equal(activation.videoId, "abc12345678");
  assert.equal(activation.mode, "zh");

  player.messages.length = 0;
  player.toggle().dispatch("click");
  await settle();
  assert.equal(player.helpers.getPlayerSubtitleMode(), "bilingual");
  assert.deepEqual(
    player.messages.map((message) => message.action),
    ["setSubtitleDisplayMode"],
    "中 -> 双 never re-activates",
  );
});

test("closing subtitles stops the overlay and the prefetching", async () => {
  const player = loadPlayer();
  player.helpers.setupPlayerSubtitlesForCurrentVideo();
  player.toggle().dispatch("click");
  await settle();
  player.helpers.applySubtitleOverlayTrack(
    {
      videoId: "abc12345678",
      segments: [{ id: "c1", start: 0, end: 4, original: "Hello", translated: "你好" }],
    },
    4,
  );
  assert.equal(player.overlay().children.length, 1);

  player.messages.length = 0;
  player.toggle().dispatch("click"); // 中 -> 双
  player.toggle().dispatch("click"); // 双 -> 关
  await settle();

  assert.equal(player.helpers.getPlayerSubtitleMode(), "off");
  assert.equal(player.overlay().children.length, 0, "subtitles disappear at once");
  assert.ok(
    player.messages.some(
      (message) => message.action === "deactivateSubtitleTranslation",
    ),
  );

  // Playback continuing must not ask for more translation once closed.
  player.messages.length = 0;
  player.video.currentTime = 30;
  player.video.dispatch("timeupdate");
  await settle();
  assert.deepEqual(player.messages, []);
});

test("moving to another video resets the toggle to closed", async () => {
  const player = loadPlayer();
  player.helpers.setupPlayerSubtitlesForCurrentVideo();
  player.toggle().dispatch("click");
  await settle();
  assert.equal(player.helpers.getPlayerSubtitleMode(), "zh");

  player.setLocation("zzz98765432");
  player.messages.length = 0;
  player.helpers.setupPlayerSubtitlesForCurrentVideo();

  assert.equal(player.helpers.getPlayerSubtitleMode(), "off");
  assert.equal(player.toggle().textContent, "关");
  assert.deepEqual(
    player.messages.map((message) => message.action),
    ["resetSubtitleSession"],
    "a new video retires the old authorization and asks for nothing",
  );
});

test("a track for a closed or superseded session is never drawn", () => {
  const player = loadPlayer();
  player.helpers.setupPlayerSubtitlesForCurrentVideo();
  const track = {
    videoId: "abc12345678",
    segments: [{ id: "c1", start: 0, end: 4, original: "Hello", translated: "你好" }],
  };

  // Subtitles are off: a late batch must not make text appear.
  player.helpers.applySubtitleOverlayTrack(track, 9);
  assert.equal(player.overlay().children.length, 0);

  // A track for a different video is ignored outright.
  player.helpers.setPlayerSubtitleMode("zh");
  player.helpers.applySubtitleOverlayTrack(
    { videoId: "zzz98765432", segments: track.segments },
    9,
  );
  assert.equal(player.overlay().children.length, 0);

  // The current session's own batch does render.
  player.helpers.applySubtitleOverlayTrack(track, 9);
  assert.equal(player.overlay().children.length, 1);

  // ...but a straggler from an older generation does not overwrite it.
  player.helpers.applySubtitleOverlayTrack(
    {
      videoId: "abc12345678",
      segments: [{ id: "c1", start: 0, end: 4, original: "Stale", translated: "过期" }],
    },
    3,
  );
  assert.equal(player.overlay().children[0].textContent, "你好");
});

test("playback only prefetches while subtitles are switched on", async () => {
  const player = loadPlayer();
  player.helpers.setupPlayerSubtitlesForCurrentVideo();

  player.video.currentTime = 12;
  player.video.dispatch("timeupdate");
  await settle();
  assert.deepEqual(
    player.messages.filter((message) => message.action === "prefetchSubtitleWindow"),
    [],
    "a closed player never prefetches",
  );

  player.toggle().dispatch("click");
  await settle();
  player.messages.length = 0;
  player.video.currentTime = 40;
  player.video.dispatch("timeupdate");
  await settle();
  const prefetch = player.messages.find(
    (message) => message.action === "prefetchSubtitleWindow",
  );
  assert.ok(prefetch, "an open player asks for the next few phrases");
  assert.equal(prefetch.currentTime, 40);
});

test("leaving the watch page removes the subtitle UI and retires the session", async () => {
  const player = loadPlayer();
  player.helpers.setupPlayerSubtitlesForCurrentVideo();
  player.toggle().dispatch("click");
  await settle();

  player.sandbox.window.location.pathname = "/feed/subscriptions";
  player.messages.length = 0;
  player.helpers.setupPlayerSubtitlesForCurrentVideo();

  assert.equal(player.toggle(), undefined, "no subtitle button off the player");
  assert.equal(player.helpers.getPlayerSubtitleMode(), "off");
  assert.deepEqual(
    player.messages.map((message) => message.action),
    ["resetSubtitleSession"],
  );
});


test("entering fullscreen asks for the panel, leaving asks for it back", async () => {
  const player = loadPlayer();
  player.helpers.setupFullscreenPanelHiding();
  player.messages.length = 0;

  player.setFullscreen({});
  await settle();
  assert.deepEqual(
    player.messages.map((message) => message.action),
    ["hideSidePanelForFullscreen"],
  );

  player.messages.length = 0;
  player.setFullscreen(null);
  await settle();
  assert.deepEqual(
    player.messages.map((message) => message.action),
    ["restoreSidePanelAfterFullscreen"],
  );
});

test("only a real fullscreen transition sends a message", async () => {
  const player = loadPlayer();
  player.helpers.setupFullscreenPanelHiding();
  // Registering twice must not double every message either.
  player.helpers.setupFullscreenPanelHiding();
  player.messages.length = 0;

  // YouTube emits both the standard and the prefixed event on some paths, so
  // the same state arriving twice must stay one message.
  player.setFullscreen({});
  player.setFullscreen({});
  await settle();
  assert.equal(player.messages.length, 1);

  player.setFullscreen(null);
  player.setFullscreen(null);
  await settle();
  assert.equal(player.messages.length, 2);
});
