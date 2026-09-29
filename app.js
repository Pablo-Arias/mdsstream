const $ = (id) => document.getElementById(id);
const list = $("sets"), statusEl = $("status"), audio = $("audio"), player = $("player");
const seek = $("seek");

const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';

// What this device has played: { [setId]: { t: seconds, d: duration, done: bool } }.
// Stored in the browser only — no account, nothing leaves the phone.
const STORE_KEY = "mdfs.progress";
const LAST_KEY = "mdfs.last";
let progress = {};
try { progress = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch {}
const saveProgress = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(progress)); } catch {} };

function recordPosition(done = false) {
  if (!current || !isFinite(audio.duration)) return;
  const prev = progress[current.id] || {};
  const t = audio.currentTime, d = audio.duration;
  progress[current.id] = { t, d, done: prev.done || done || t / d > 0.95 };
  saveProgress();
}

let sets = [];
let current = null;
let filter = "all";
const openNotes = new Set(); // survives re-renders

const ICON_SHARE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m0 0L8 7m4-4 4 4M6 11H5v10h14V11h-1"/></svg>';
const setLink = (set) => `${location.origin}${location.pathname}#${set.id}`;

const fmtTime = (s) => {
  if (!isFinite(s)) return "–:––";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

function render() {
  const shown = sets.filter((s) => filter === "all" || s.objective === filter);
  list.replaceChildren(
    ...shown.map((s) => {
      const isCurrent = current && current.id === s.id;
      const playing = isCurrent && !audio.paused;
      const p = progress[s.id];
      const state = !p ? "new" : p.done ? "played" : "started";
      const stateLabel = { new: "New", played: "Played ✓", started: `Resume at ${fmtTime(p?.t)}` }[state];
      return el("li", { class: `set is-${state}${isCurrent ? " is-current" : ""}`, id: `set-${s.id}` },
        el("button", {
          class: `set-play${s.cover ? " has-cover" : ""}`, type: "button", "data-id": s.id,
          "aria-label": `${playing ? "Pause" : "Play"} ${s.title}`,
          ...(s.cover && { style: `background-image:url("${encodeURI(s.cover.thumb)}")` }),
          html: playing ? ICON_PAUSE : ICON_PLAY,
        }),
        el("div", {},
          el("p", { class: "set-title" }, s.title),
          el("p", { class: "set-state" }, stateLabel),
          el("p", { class: "set-meta" },
            s.objectiveLabel && el("span", { class: `badge ${s.objective}` }, s.objectiveLabel),
            s.genre && el("span", {}, s.genre),
            s.bpm && el("span", {}, `${s.bpm} BPM`),
            s.category && el("span", {}, s.category),
            s.duration && el("span", {}, fmtTime(s.duration)),
            el("span", {}, fmtDate(s.date)),
          ),
          state === "started" && el("div", { class: "set-progress", style: `--p:${(p.t / p.d) * 100}%` }),
          s.notes && el("details", { class: "set-notes", "data-id": s.id, ...(openNotes.has(s.id) && { open: "" }) },
            el("summary", {}, "Notes"),
            el("p", {}, s.notes),
          ),
        ),
        el("button", { class: "set-share", type: "button", "data-id": s.id, "aria-label": `Share ${s.title}`, html: ICON_SHARE }),
      );
    }),
  );
  statusEl.textContent = sets.length && !shown.length ? "No sets of this type yet." : "";
}

// The audio isn't fetched until play is pressed, so until then the position lives in
// `startAt` and the bar shows the saved values.
let startAt = 0;
const loaded = () => audio.readyState >= 1;
const position = () => (loaded() ? audio.currentTime : startAt);
function setPosition(t) {
  if (loaded()) audio.currentTime = t;
  else { startAt = t; showPosition(t, progress[current.id]?.d || current.duration); }
}
function showPosition(t, d) {
  if (d) { seek.max = Math.floor(d); $("dur").textContent = fmtTime(d); }
  seek.value = Math.floor(t);
  $("cur").textContent = fmtTime(t);
}

// Put a set in the player without playing it. Starts where this device left off,
// unless the set was finished — then from the top.
function load(set) {
  recordPosition();
  current = set;
  audio.src = set.url;
  const p = progress[set.id];
  startAt = p && !p.done && p.t > 5 ? p.t : 0;
  const d = p?.d || set.duration;
  showPosition(startAt, d);
  if (!d) $("dur").textContent = fmtTime(NaN);
  player.hidden = false;
  $("now-title").textContent = set.title;
  history.replaceState(null, "", `#${set.id}`);
  try { localStorage.setItem(LAST_KEY, set.id); } catch {}
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: set.title,
      artist: "MDS",
      album: [set.genre, set.objectiveLabel].filter(Boolean).join(" · ") || "Vercors Stream",
      artwork: set.cover
        ? [{ src: set.cover.url }]
        : [{ src: "icon-512.png", sizes: "512x512", type: "image/png" }],
    });
  }
}

function play(set) {
  if (current && current.id === set.id) {
    audio.paused ? audio.play() : audio.pause();
    return;
  }
  load(set);
  audio.play().catch(() => {});
  render();
}

// Next/previous in the list as it's currently shown (newest first, filter applied).
function neighbour(step) {
  const shown = sets.filter((s) => filter === "all" || s.objective === filter);
  const i = shown.findIndex((s) => s.id === current?.id);
  return i === -1 ? null : shown[i + step] || null;
}

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

// Phones open their share sheet; elsewhere the link is copied.
async function share(set) {
  const url = setLink(set);
  if (navigator.share) {
    try { await navigator.share({ title: `${set.title} · MDS`, text: `${set.title} · MDS`, url }); } catch {}
    return;
  }
  try { await navigator.clipboard.writeText(url); toast("Link copied"); }
  catch { prompt("Copy this link:", url); }
}

// Events
list.addEventListener("click", (e) => {
  const playBtn = e.target.closest(".set-play");
  if (playBtn) play(sets.find((s) => s.id === playBtn.dataset.id));
  const shareBtn = e.target.closest(".set-share");
  if (shareBtn) share(sets.find((s) => s.id === shareBtn.dataset.id));
});
list.addEventListener("toggle", (e) => {
  if (!e.target.matches?.(".set-notes")) return;
  e.target.open ? openNotes.add(e.target.dataset.id) : openNotes.delete(e.target.dataset.id);
}, true);

document.querySelector(".filters").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  filter = btn.dataset.filter;
  $("types").dataset.filter = filter;
  for (const b of e.currentTarget.children) b.setAttribute("aria-pressed", String(b === btn));
  render();
});

$("toggle").addEventListener("click", () => (audio.paused ? audio.play() : audio.pause()));
$("back").addEventListener("click", () => setPosition(Math.max(0, position() - 15)));
$("fwd").addEventListener("click", () => setPosition(position() + 30));

let seeking = false;
seek.addEventListener("input", () => { seeking = true; $("cur").textContent = fmtTime(+seek.value); });
seek.addEventListener("change", () => { setPosition(+seek.value); seeking = false; });

audio.addEventListener("loadedmetadata", () => {
  if (startAt) { audio.currentTime = startAt; startAt = 0; }
  seek.max = Math.floor(audio.duration) || 0;
  $("dur").textContent = fmtTime(audio.duration);
});
let lastSave = 0;
audio.addEventListener("timeupdate", () => {
  if (Date.now() - lastSave > 5000) { lastSave = Date.now(); recordPosition(); }
  if (seeking) return;
  seek.value = Math.floor(audio.currentTime);
  $("cur").textContent = fmtTime(audio.currentTime);
});
audio.addEventListener("pause", () => recordPosition());
audio.addEventListener("ended", () => {
  recordPosition(true);
  const next = neighbour(1); // autoplay the next set down the list
  if (next) play(next);
});
addEventListener("pagehide", () => recordPosition());
for (const ev of ["play", "pause", "ended"]) {
  audio.addEventListener(ev, () => {
    player.classList.toggle("playing", !audio.paused);
    $("toggle").setAttribute("aria-label", audio.paused ? "Play" : "Pause");
    render();
  });
}

if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => audio.play());
  ms.setActionHandler("pause", () => audio.pause());
  ms.setActionHandler("seekbackward", () => $("back").click());
  ms.setActionHandler("seekforward", () => $("fwd").click());
  ms.setActionHandler("seekto", (d) => setPosition(d.seekTime));
  ms.setActionHandler("nexttrack", () => { const n = neighbour(1); if (n) play(n); });
  ms.setActionHandler("previoustrack", () => { const n = neighbour(-1); if (n) play(n); });
}

// Space = play/pause (starts the first listed set if nothing is loaded yet).
// A focused button already reacts to Space by itself, so leave those alone.
addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest("button, a, textarea, select, [contenteditable], input:not([type=range])") || $("install-help").open) return;
  e.preventDefault();
  if (current) audio.paused ? audio.play() : audio.pause();
  else list.querySelector(".set-play")?.click();
});

// Add to Home Screen. Android/Chrome gives us a real install prompt; iPhone needs
// the Share menu, so there we show the steps instead.
const installBtn = $("install"), installHelp = $("install-help");
const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
const isInstalled = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
let installPrompt = null;

if (!isInstalled && (isIOS || isAndroid)) installBtn.hidden = false;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  if (!isInstalled) installBtn.hidden = false;
});
addEventListener("appinstalled", () => (installBtn.hidden = true));

const SHARE_GLYPH = '<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m0 0L8 7m4-4 4 4M6 11H5v10h14V11h-1"/></svg>';
installBtn.addEventListener("click", async () => {
  if (installPrompt) {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    if (outcome === "accepted") installBtn.hidden = true;
    return;
  }
  const steps = isIOS
    ? [
        `Tap the Share button ${SHARE_GLYPH} (bottom bar in Safari, top right in Chrome).`,
        "Scroll down and tap <b>Add to Home Screen</b>.",
        "Tap <b>Add</b>. MDS now opens like an app.",
        "Opened this from Instagram or another app? Open it in Safari first.",
      ]
    : [
        "Open your browser menu <b>⋮</b> (top right).",
        "Tap <b>Add to Home screen</b> or <b>Install app</b>.",
        "Confirm. MDS now opens like an app.",
      ];
  $("install-steps").innerHTML = steps.map((t) => `<li>${t}</li>`).join("");
  installHelp.showModal();
});

// Load
fetch("sets.json", { cache: "no-cache" })
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((data) => {
    sets = data.sets || [];
    statusEl.textContent = sets.length ? "" : "No sets yet — come back soon.";
    render();
    // Reopen the set from a shared link (…/#1198364518), or else the last one played here.
    // Browsers block autoplay, so it waits in the player at its saved position.
    let lastId = null;
    try { lastId = localStorage.getItem(LAST_KEY); } catch {}
    const linked = sets.find((s) => `#${s.id}` === location.hash);
    const restored = linked || sets.find((s) => s.id === lastId);
    if (restored) {
      load(restored);
      render();
      if (linked) $(`set-${linked.id}`)?.scrollIntoView({ block: "center" });
    }
  })
  .catch(() => (statusEl.textContent = "Couldn't load the sets. Try again in a moment."));
