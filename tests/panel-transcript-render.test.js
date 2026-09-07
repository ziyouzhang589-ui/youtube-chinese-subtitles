/**
 * The side panel must always show the transcript in the mode its own buttons
 * claim. These two can drift because startDigest paints the original list
 * directly, while the player's state arrives separately and afterwards.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.id = "";
    this.className = "";
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this.isConnected = true;
    this._html = "";
    this.textContent = "";
    this.attributes = {};
    this.classList = {
      _set: new Set(),
      add(name) {
        this._set.add(name);
      },
      remove(name) {
        this._set.delete(name);
      },
      toggle(name, force) {
        if (force) this._set.add(name);
        else this._set.delete(name);
      },
      contains(name) {
        return this._set.has(name);
      },
    };
  }

  set innerHTML(value) {
    this._html = String(value);
    if (this._html === "") this.children = [];
  }

  get innerHTML() {
    return this._html;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child) {
    child.parentElement = this;
    this.children.unshift(child);
    return child;
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(
        (node) => node !== this,
      );
    }
    this.parentElement = null;
    this.isConnected = false;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener() {}
  removeEventListener() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

function loadPanel() {
  const transcriptList = new FakeElement();
  const section = new FakeElement();
  section.appendChild(transcriptList);
  const modeButtons = ["original", "zh", "bilingual"].map((mode) => {
    const button = new FakeElement("button");
    button.dataset.transcriptMode = mode;
    button.disabled = false;
    // sidepanel.html ships with Original pressed.
    if (mode === "original") button.classList.add("active");
    return button;
  });
  const byId = {
    transcriptList,
    contentArea: new FakeElement(),
    followPlaybackBtn: new FakeElement(),
    langSpinner: new FakeElement(),
    transcriptModeHint: new FakeElement(),
  };

  const sandbox = {
    console,
    URL,
    CSS: { escape: (value) => value },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    IntersectionObserver: class {},
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      createElement: (tag) => new FakeElement(tag),
      getElementById: (id) => byId[id] || null,
      querySelector: () => null,
      querySelectorAll: (selector) =>
        selector === ".transcript-mode-btn" ? modeButtons : [],
    },
    chrome: {
      runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({}) },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: { addListener() {} }, onActivated: { addListener() {} } },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("subtitle-units.js"), sandbox);
  vm.runInNewContext(read("sidepanel.js"), sandbox);

  const helpers = sandbox.__YTD_TRANSCRIPT_TESTING__;
  return {
    helpers,
    modeButtons,
    // The source badge is the plainest read-out of which layout was painted.
    renderedLayout() {
      const badge = section.children.find(
        (child) => child.id === "transcriptSourceBadge",
      );
      if (!badge) return "none";
      return badge.innerHTML.includes("简体中文") ? "zh" : "original";
    },
    activeButton() {
      return modeButtons.find((button) => button.classList.contains("active"))
        ?.dataset.transcriptMode;
    },
    enabledButtons() {
      return modeButtons
        .filter((button) => !button.disabled)
        .map((button) => button.dataset.transcriptMode);
    },
    hintHidden() {
      return byId.transcriptModeHint.hidden === true;
    },
  };
}

const TRANSCRIPT = [
  { text: "For almost eighty years, tanker aircraft have been the backbone.", start: 0, duration: 4 },
  { text: "Their ability to extend range has created a new dimension.", start: 4, duration: 4 },
];

test("the panel's buttons and its transcript never disagree", () => {
  const panel = loadPanel();
  panel.helpers.setTranscriptStateForTests({
    videoId: "abc12345678",
    transcript: TRANSCRIPT,
  });

  // startDigest paints the original list.
  panel.helpers.renderTranscript();
  assert.equal(panel.renderedLayout(), "original");

  // The player reports Chinese, so the panel switches layout.
  panel.helpers.applyTranscriptModeFromPlayer("zh");
  assert.equal(panel.activeButton(), "zh");
  assert.equal(panel.renderedLayout(), "zh");

  // Re-opening the same video runs startDigest again, which repaints the
  // original list. The panel must notice that the layout regressed and redraw
  // Chinese, instead of assuming the list is still in Chinese and patching
  // rows that no longer exist.
  panel.helpers.renderTranscript();
  assert.equal(panel.renderedLayout(), "original");
  panel.helpers.applyTranscriptModeFromPlayer("zh");
  assert.equal(panel.activeButton(), "zh");
  assert.equal(
    panel.renderedLayout(),
    "zh",
    "the 中文 button must never sit above an English transcript",
  );
});

test("following the player back to 关 restores the original layout", () => {
  const panel = loadPanel();
  panel.helpers.setTranscriptStateForTests({
    videoId: "abc12345678",
    transcript: TRANSCRIPT,
  });

  panel.helpers.applyTranscriptModeFromPlayer("zh");
  assert.equal(panel.renderedLayout(), "zh");
  panel.helpers.applyTranscriptModeFromPlayer("bilingual");
  assert.equal(panel.activeButton(), "bilingual");
  panel.helpers.applyTranscriptModeFromPlayer("off");
  assert.equal(panel.activeButton(), "original");
  assert.equal(panel.renderedLayout(), "original");
});

// One translated cue for the transcript above, keyed the way the panel keys it.
function translationsFor(sandbox) {
  const units = require(path.join(root, "subtitle-units.js"));
  const cues = units.buildPlayerSubtitleCues(TRANSCRIPT);
  return Object.fromEntries(
    cues.map((cue, index) => [
      units.playerSubtitleCueCacheKey("abc12345678", cue),
      `\u8bd1\u6587${index}`,
    ]),
  );
}

test("all three views are switchable once a translation exists", () => {
  const panel = loadPanel();
  panel.helpers.setTranscriptStateForTests({
    videoId: "abc12345678",
    transcript: TRANSCRIPT,
    cueTranslations: translationsFor(),
  });
  panel.helpers.renderTranscript();

  assert.deepEqual(panel.enabledButtons(), ["original", "zh", "bilingual"]);
  assert.equal(panel.hintHidden(), true, "the hint retires once it is moot");

  // Reading views over text the panel already holds: each one just redraws.
  panel.helpers.handleTranscriptModeChange("zh");
  assert.equal(panel.activeButton(), "zh");
  assert.equal(panel.renderedLayout(), "zh");

  panel.helpers.handleTranscriptModeChange("bilingual");
  assert.equal(panel.activeButton(), "bilingual");
  assert.equal(panel.renderedLayout(), "zh");

  panel.helpers.handleTranscriptModeChange("original");
  assert.equal(panel.activeButton(), "original");
  assert.equal(panel.renderedLayout(), "original");
});

test("中文 and 双语 stay unavailable until the player has translated something", () => {
  const panel = loadPanel();
  panel.helpers.setTranscriptStateForTests({
    videoId: "abc12345678",
    transcript: TRANSCRIPT,
  });
  panel.helpers.renderTranscript();

  assert.equal(panel.helpers.hasCachedTranscriptTranslation(), false);
  assert.deepEqual(panel.enabledButtons(), ["original"]);
  assert.equal(panel.hintHidden(), false, "the hint points at the player");

  // Clicking anyway must not switch to an empty Chinese list.
  panel.helpers.handleTranscriptModeChange("zh");
  assert.equal(panel.activeButton(), "original");
  assert.equal(panel.renderedLayout(), "original");
});

test("a reader's own choice outranks later player updates", () => {
  const panel = loadPanel();
  panel.helpers.setTranscriptStateForTests({
    videoId: "abc12345678",
    transcript: TRANSCRIPT,
    cueTranslations: translationsFor(),
  });
  panel.helpers.renderTranscript();

  panel.helpers.handleTranscriptModeChange("original");
  // The player is mid-translation and keeps reporting 中. The reader asked for
  // the English text, so they keep it.
  panel.helpers.applyTranscriptModeFromPlayer("zh");
  assert.equal(panel.activeButton(), "original");
  assert.equal(panel.renderedLayout(), "original");

  panel.helpers.handleTranscriptModeChange("bilingual");
  panel.helpers.applyTranscriptModeFromPlayer("zh");
  assert.equal(panel.activeButton(), "bilingual");
});

test("opening the panel on a new video spends nothing until asked", () => {
  const js = read("sidepanel.js");

  // startDigest must stop at the ready state on a cache miss. Reaching the
  // network from there is what used to spend one Supadata credit per video
  // merely browsed with this panel open.
  const startDigest = js.slice(
    js.indexOf("async function startDigest("),
    js.indexOf("async function loadTranscriptForCurrentVideo("),
  );
  assert.match(startDigest, /showState\("ready"\);\s*\n\s*return;/);
  assert.doesNotMatch(startDigest, /action: "fetchTranscript"/);

  // The single fetch lives behind the button on that state.
  assert.match(js, /getElementById\("fetchTranscriptBtn"\)[\s\S]{0,120}loadTranscriptForCurrentVideo/);
  const fetchCalls = js.match(/action: "fetchTranscript"/g) || [];
  assert.equal(fetchCalls.length, 1, "one authorized path to Supadata");

  // A failed fetch must retry the fetch, not bounce back to the ready state.
  assert.match(js, /showError\([\s\S]{0,200}loadTranscriptForCurrentVideo,\s*\)/);
});

test("a cached video still opens by itself, because that is free", () => {
  const js = read("sidepanel.js");
  const startDigest = js.slice(
    js.indexOf("async function startDigest("),
    js.indexOf("async function loadTranscriptForCurrentVideo("),
  );
  // The cache hit renders and returns before the ready state is ever reached.
  const cacheHit = startDigest.slice(0, startDigest.indexOf('showState("ready")'));
  assert.match(cacheHit, /const cached = await loadFromCache\(videoId\)/);
  assert.match(cacheHit, /renderTranscript\(\)/);
  assert.match(cacheHit, /showState\("results"\)/);
});
