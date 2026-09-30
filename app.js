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

// Listen counts, star ratings and notifications live on a small Cloudflare Worker.
// It only ever sees an anonymous random ID for this device, never who you are.
const API = location.hostname === "localhost" ? "http://localhost:8787" : "https://mdsstream-api.mdsstream.workers.dev";
const DEVICE_KEY = "mdfs.device";
let device = null;
try {
  device = localStorage.getItem(DEVICE_KEY);
  if (!device) localStorage.setItem(DEVICE_KEY, (device = crypto.randomUUID()));
} catch {}
let stats = null; // { sets: { [id]: { listens, rating, ratings } }, mine: { [id]: stars } }

async function api(path, body) {
  const res = await fetch(`${API}${path}`, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}
const refreshStats = (data) => { stats = data; render(); updateMomentUI(); };

let sets = [];
let current = null;
let filter = "all";
const openNotes = new Set(); // survives re-renders

const ICON_SHARE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m0 0L8 7m4-4 4 4M6 11H5v10h14V11h-1"/></svg>';
const inFilter = (s) => filter === "all" || (s.objectives || []).some((o) => o.id === filter);
// Offline: sets saved into this browser (Cache Storage), played from a local blob URL.
// Nextcloud doesn't allow other sites to read its files, so saving goes through the Worker.
const OFFLINE_CACHE = "mds-offline-v1";
const OFFLINE_KEY = "mdfs.offline";
const offlineUrls = new Map(); // setId → blob: URL, ready to play
const saving = new Map(); // setId → percent
let offlineIds = new Set();
try { offlineIds = new Set(JSON.parse(localStorage.getItem(OFFLINE_KEY)) || []); } catch {}
const saveOfflineIndex = () => { try { localStorage.setItem(OFFLINE_KEY, JSON.stringify([...offlineIds])); } catch {} };
const offlineRequest = (id) => new Request(new URL(`offline/${encodeURIComponent(id)}.mp3`, location.href));
const sourceFor = (set) => offlineUrls.get(set.id) || set.url;

// Turn saved sets into playable blob URLs. Drops copies the browser evicted, and copies
// of a set whose file has since been edited (size changed), so it can be saved again.
async function prepareOffline() {
  if (!("caches" in window) || !offlineIds.size) return;
  const cache = await caches.open(OFFLINE_CACHE);
  for (const id of [...offlineIds]) {
    const res = await cache.match(offlineRequest(id));
    const blob = res && (await res.blob());
    const set = sets.find((s) => s.id === id);
    if (blob && (!set?.size || blob.size === set.size)) {
      offlineUrls.set(id, URL.createObjectURL(blob));
    } else {
      offlineIds.delete(id);
      if (res) await cache.delete(offlineRequest(id));
    }
  }
  saveOfflineIndex();
}

async function saveOffline(set) {
  if (!("caches" in window) || !window.ReadableStream || !window.TransformStream) {
    return toast("This browser can't save sets offline. Try the MP3 file instead.");
  }
  navigator.storage?.persist?.().catch(() => {}); // ask the browser not to clear it
  saving.set(set.id, 0);
  render();
  try {
    const res = await fetch(`${API}/audio/${encodeURIComponent(set.id)}`);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || set.size || 0;
    let got = 0, lastDraw = 0;
    const progress = new TransformStream({
      transform(chunk, ctl) {
        got += chunk.length;
        if (total && Date.now() - lastDraw > 250) {
          lastDraw = Date.now();
          saving.set(set.id, Math.min(99, Math.floor((got / total) * 100)));
          render();
        }
        ctl.enqueue(chunk);
      },
    });
    const cache = await caches.open(OFFLINE_CACHE);
    await cache.put(offlineRequest(set.id), new Response(res.body.pipeThrough(progress), { headers: { "Content-Type": "audio/mpeg" } }));
    if (total && got < total) throw new Error("incomplete download");
    const saved = await cache.match(offlineRequest(set.id));
    offlineUrls.set(set.id, URL.createObjectURL(await saved.blob()));
    offlineIds.add(set.id);
    saveOfflineIndex();
    toast("Saved: plays without internet");
  } catch (err) {
    console.error(err);
    caches.open(OFFLINE_CACHE).then((c) => c.delete(offlineRequest(set.id))).catch(() => {});
    toast(err?.name === "QuotaExceededError" ? "Not enough space on this device." : "Couldn't save. Try again on a good connection.");
  }
  saving.delete(set.id);
  render();
}

async function removeOffline(set) {
  if (!confirm(`Remove "${set.title}" from this device? You can still stream it.`)) return;
  const url = offlineUrls.get(set.id);
  offlineIds.delete(set.id);
  offlineUrls.delete(set.id);
  saveOfflineIndex();
  if (current?.id === set.id && url) { // keep playing, from the internet
    const t = audio.currentTime, playing = !audio.paused;
    audio.src = set.url;
    startAt = t;
    if (playing) audio.play().catch(() => {});
  }
  if (url) URL.revokeObjectURL(url);
  await caches.open(OFFLINE_CACHE).then((c) => c.delete(offlineRequest(set.id))).catch(() => {});
  render();
  toast("Removed from this device");
}

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
  const shown = sets.filter(inFilter);
  list.replaceChildren(
    ...shown.map((s) => {
      const isCurrent = current && current.id === s.id;
      const playing = isCurrent && !audio.paused;
      const p = progress[s.id];
      const state = !p ? "new" : p.done ? "played" : "started";
      const stateLabel = { new: "New", played: "Played ✓", started: `Resume at ${fmtTime(p?.t)}` }[state];
      const unavailable = !navigator.onLine && !offlineUrls.has(s.id);
      return el("li", { class: `set is-${state}${isCurrent ? " is-current" : ""}${unavailable ? " is-unavailable" : ""}`, id: `set-${s.id}` },
        el("button", {
          class: `set-play${s.cover ? " has-cover" : ""}`, type: "button", "data-id": s.id,
          "aria-label": `${playing ? "Pause" : "Play"} ${s.title}`,
          ...(s.cover && { style: `background-image:url("${encodeURI(s.cover.thumb)}")` }),
          html: playing ? ICON_PAUSE : ICON_PLAY,
        }),
        el("div", {},
          el("p", { class: "set-title" }, s.title),
          el("p", { class: "set-state" }, stateLabel),
          s.authors && el("p", { class: "set-author" },
            el("span", { class: "set-author-label" }, s.authors.length > 1 ? "Artists:" : "Artist:"),
            ` ${s.authors.join(" & ")}`,
          ),
          el("p", { class: "set-meta" },
            ...(s.objectives || []).map((o) => el("span", { class: `badge ${o.id}` }, o.label)),
            s.genres && el("span", {}, s.genres.join(" · ")),
            s.bpm && el("span", {}, `${s.bpm} BPM`),
            s.category && el("span", {}, s.category),
            s.duration && el("span", {}, fmtTime(s.duration)),
            el("span", {}, fmtDate(s.date)),
          ),
          state === "started" && el("div", { class: "set-progress", style: `--p:${(p.t / p.d) * 100}%` }),
          stats && socialRow(s),
          el("p", { class: "set-actions" },
            saving.has(s.id)
              ? el("span", { class: "offline-btn saving", role: "status" }, `Saving… ${saving.get(s.id)}%`)
              : offlineUrls.has(s.id)
                ? el("button", { type: "button", class: "offline-btn saved", "data-id": s.id, "data-action": "remove-offline", "aria-label": `Saved offline. Remove ${s.title} from this device` }, "✓ Saved offline")
                : el("button", { type: "button", class: "offline-btn", "data-id": s.id, "data-action": "save-offline" }, "⬇ Save offline"),
            el("a", { class: "offline-btn", href: `${s.url}${s.url.includes("?") ? "&" : "?"}download`, download: "", "aria-label": `Download the MP3 file of ${s.title}` }, "MP3 file"),
          ),
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

// Stars (tap to rate; yours are highlighted) + average and listen count.
function socialRow(s) {
  const st = stats.sets[s.id] || { listens: 0, rating: null, ratings: 0 };
  const mine = stats.mine[s.id] || 0;
  const best = [...(st.moments || [])].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3);
  const SHOW_LISTENS = false; // still counted by the Worker, just not shown for now
  const summary = [
    st.ratings ? `${st.rating.toFixed(1)} (${st.ratings})` : "Not rated yet",
    SHOW_LISTENS && `${st.listens} ${st.listens === 1 ? "listen" : "listens"}`,
  ].filter(Boolean).join(" · ");
  return el("div", { class: "set-social" },
    el("span", { class: "stars", role: "group", "aria-label": mine ? `Your rating: ${mine} of 5` : "Rate this set" },
      ...[1, 2, 3, 4, 5].map((n) => el("button", {
        type: "button", class: `star${n <= mine ? " on" : ""}`, "data-id": s.id, "data-stars": n,
        "aria-label": `Rate ${n} star${n > 1 ? "s" : ""}`, "aria-pressed": String(n === mine),
      }, "★")),
    ),
    el("span", { class: "social-summary" }, summary),
    best.length > 0 && el("p", { class: "best" },
      el("span", { class: "best-label" }, "♥ Best moments:"),
      ...best.map(([t, n]) => el("button", {
        type: "button", class: "moment-chip", "data-id": s.id, "data-t": t,
        "aria-label": `Play from ${fmtTime(t)}, marked by ${n}`,
      }, `${fmtTime(t)} (${n})`)),
    ),
  );
}

// "Good part" marks: 30-second windows, one per device per window (tap again to remove).
const BUCKET = 30;
const bucketOf = (t) => Math.floor(t / BUCKET) * BUCKET;
const myMarks = (id) => stats?.myMoments?.[id] || [];
let shownBucket = null;

function updateMomentUI() {
  const btn = $("moment");
  if (!current || !btn) return;
  shownBucket = bucketOf(position());
  const on = myMarks(current.id).includes(shownBucket);
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
  btn.hidden = !stats;
  drawHeat();
}

// Where listeners marked good parts, drawn over the seek bar (brighter = more marks).
function drawHeat() {
  const d = current?.duration || audio.duration;
  const marks = stats?.sets[current?.id]?.moments || [];
  const heat = $("heat");
  if (!heat) return;
  if (!d || !marks.length) return heat.replaceChildren();
  const max = Math.max(...marks.map(([, n]) => n));
  heat.replaceChildren(...marks.map(([t, n]) => el("span", {
    style: `left:${(t / d) * 100}%;width:${Math.max((BUCKET / d) * 100, 1)}%;opacity:${0.35 + (0.65 * n) / max}`,
  })));
}

async function toggleMoment() {
  if (!current || !device || !stats) return;
  const t = position();
  const b = bucketOf(t);
  const marks = ((stats.myMoments ??= {})[current.id] ??= []);
  const on = !marks.includes(b);
  on ? marks.push(b) : marks.splice(marks.indexOf(b), 1); // show it right away
  updateMomentUI();
  try {
    refreshStats(await api("/moment", { setId: current.id, device, t, on }));
    toast(on ? `♥ Marked ${fmtTime(b)} as a good part` : "Mark removed");
  } catch {
    toast("Couldn't save. Try again later.");
  }
}

// Start a set at a given second (used by "Best moments").
function playAt(set, t) {
  if (!current || current.id !== set.id) load(set);
  setPosition(t);
  audio.play().catch(() => {});
  render();
  updateMomentUI();
}

async function rate(setId, n) {
  if (!device) return;
  stats.mine[setId] = n; // show it right away
  render();
  try { refreshStats(await api("/rate", { setId, device, stars: n })); toast("Thanks for rating!"); }
  catch { toast("Couldn't save your rating. Try again later."); }
}

// A listen counts after 30 s of actual playback (seeking doesn't count), once per page visit.
const LISTEN_AFTER = 30;
let heard = 0, lastTick = null;
const counted = new Set();
function trackListen() {
  const t = audio.currentTime;
  if (lastTick !== null && t > lastTick && t - lastTick < 2) heard += t - lastTick;
  lastTick = t;
  if (heard >= LISTEN_AFTER && current && device && !counted.has(current.id)) {
    counted.add(current.id);
    api("/listen", { setId: current.id, device }).then(refreshStats).catch(() => counted.delete(current.id));
  }
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
  if (current) updateMomentUI();
}

// Put a set in the player without playing it. Starts where this device left off,
// unless the set was finished — then from the top.
function load(set) {
  recordPosition();
  current = set;
  heard = 0; lastTick = null;
  audio.src = sourceFor(set);
  const p = progress[set.id];
  startAt = p && !p.done && p.t > 5 ? p.t : 0;
  const d = p?.d || set.duration;
  showPosition(startAt, d);
  if (!d) $("dur").textContent = fmtTime(NaN);
  player.hidden = false;
  $("now-title").textContent = set.title;
  history.replaceState(null, "", `#${set.id}`);
  try { localStorage.setItem(LAST_KEY, set.id); } catch {}
  updateMomentUI();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: set.title,
      artist: set.authors?.join(" & ") || "MDS",
      album: [...(set.genres || []), ...(set.objectives || []).map((o) => o.label)].join(" · ") || "Vercors Stream",
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
  const shown = sets.filter(inFilter);
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
  const act = e.target.closest("[data-action]");
  if (act?.dataset.action === "save-offline") saveOffline(sets.find((s) => s.id === act.dataset.id));
  if (act?.dataset.action === "remove-offline") removeOffline(sets.find((s) => s.id === act.dataset.id));
  const chip = e.target.closest(".moment-chip");
  if (chip) playAt(sets.find((s) => s.id === chip.dataset.id), Number(chip.dataset.t));
  const star = e.target.closest(".star");
  if (star) rate(star.dataset.id, Number(star.dataset.stars));
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

$("moment")?.addEventListener("click", toggleMoment);
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
// Recover from dropped connections. Long sets are streamed over one connection for up
// to an hour, and servers sometimes cut it; reload the stream where it stopped.
let wantPlaying = false;
let recovering = false;
let stallTimer;
let attempts = 0;
async function recover() {
  if (!current || recovering || attempts >= 3) return;
  recovering = true;
  attempts++;
  startAt = audio.currentTime || startAt;
  if (!offlineUrls.has(current.id)) await refreshSets(); // the file may have been renamed since this page loaded
  audio.src = sourceFor(current);
  audio.play().catch(() => {}).finally(() => (recovering = false));
}

// Reload the list; keep the current set (matched by id) pointing at its latest file.
async function refreshSets() {
  try {
    const data = await (await fetch("sets.json", { cache: "no-cache" })).json();
    if (!data.sets?.length) return;
    sets = data.sets;
    const fresh = current && sets.find((s) => s.id === current.id);
    if (fresh) { current = fresh; $("now-title").textContent = fresh.title; }
    render();
  } catch {}
}
audio.addEventListener("play", () => (wantPlaying = true));
audio.addEventListener("pause", () => { if (!recovering) wantPlaying = false; });
audio.addEventListener("error", () => { if (wantPlaying) setTimeout(recover, 1000); });
audio.addEventListener("waiting", () => {
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => { if (wantPlaying && audio.readyState < 3) recover(); }, 8000);
});
audio.addEventListener("playing", () => { clearTimeout(stallTimer); attempts = 0; });

let lastSave = 0;
audio.addEventListener("seeking", () => (lastTick = null));
audio.addEventListener("timeupdate", () => {
  trackListen();
  if (bucketOf(audio.currentTime) !== shownBucket) updateMomentUI();
  if (Date.now() - lastSave > 5000) { lastSave = Date.now(); recordPosition(); }
  if (seeking) return;
  seek.value = Math.floor(audio.currentTime);
  $("cur").textContent = fmtTime(audio.currentTime);
});
audio.addEventListener("pause", () => recordPosition());
audio.addEventListener("ended", () => {
  wantPlaying = false;
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
  if (e.target.closest("button, a, textarea, select, [contenteditable], input:not([type=range])") || document.querySelector("dialog[open]")) return;
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

// New-set notifications (Web Push). iPhone only allows them once the site is on the
// Home Screen, so there the button first explains how to add it.
const VAPID_PUBLIC_KEY = "BJjiDXMj4aCHPZsf1L5qgLw23krlo9RmLaRr-thDlVZpsKDZjkdpenQsROZz5xdY8Zc7-30yv2uqvScbdbvP2Rg";
const notifyBtn = $("notify"), notifyLabel = $("notify-label");
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
let swReady = null;
if ("serviceWorker" in navigator) swReady = navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).catch(() => null);

const b64ToBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function currentSubscription() {
  const reg = await swReady;
  return reg ? reg.pushManager.getSubscription() : null;
}
async function showNotifyState() {
  if (pushSupported) {
    const sub = await currentSubscription().catch(() => null);
    notifyBtn.classList.toggle("on", !!sub);
    notifyLabel.textContent = sub ? "Notifications on ✓" : Notification.permission === "denied" ? "Notifications blocked" : "Notify me of new sets";
    notifyBtn.hidden = false;
  } else if (isIOS && !isInstalled) {
    notifyBtn.hidden = false; // explains the Home Screen step
  }
}

notifyBtn.addEventListener("click", async () => {
  if (!pushSupported) {
    $("install-steps").innerHTML = [
      "On iPhone, notifications only work from the Home Screen app.",
      `Tap the Share button ${SHARE_GLYPH}, then <b>Add to Home Screen</b>.`,
      "Open MDS from your Home Screen and tap <b>Notify me of new sets</b> again.",
    ].map((t) => `<li>${t}</li>`).join("");
    installHelp.showModal();
    return;
  }
  try {
    const existing = await currentSubscription();
    if (existing) { // turn off
      await api("/unsubscribe", { endpoint: existing.endpoint }).catch(() => {});
      await existing.unsubscribe();
      toast("Notifications off");
    } else {
      if ((await Notification.requestPermission()) !== "granted") {
        toast("Notifications are blocked. You can allow them in your browser settings.");
      } else {
        const reg = await swReady;
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) });
        try {
          await api("/subscribe", { endpoint: sub.endpoint });
          toast("You'll be notified of new sets");
        } catch (err) {
          await sub.unsubscribe(); // don't show "on" if the server doesn't know about this phone
          throw err;
        }
      }
    }
  } catch (err) {
    console.error(err);
    toast(`Couldn't turn on notifications (${err?.message || err}). Try again later.`);
  }
  showNotifyState();
});
showNotifyState();
// Self-repair: if this phone is subscribed, make sure the server knows (safe to repeat).
currentSubscription()
  .then((sub) => sub && api("/subscribe", { endpoint: sub.endpoint }))
  .catch((err) => console.error("Re-subscribe failed", err));

// "Listen in your podcast app": one-tap links for common apps, or copy the feed URL.
const feedUrl = new URL("feed.xml", location.href).href;
const feedNoScheme = feedUrl.replace(/^https?:\/\//, "");
$("feed-url").value = feedUrl;
$("app-apple").href = `podcast://${feedNoScheme}`;
$("app-overcast").href = `overcast://x-callback-url/add?url=${encodeURIComponent(feedUrl)}`;
$("app-antennapod").href = `https://antennapod.org/deeplink/subscribe?url=${encodeURIComponent(feedUrl)}`;
$("app-pocketcasts").href = `pktc://subscribe/${feedNoScheme}`;
$("podcast").addEventListener("click", () => $("podcast-help").showModal());
$("copy-feed").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(feedUrl); $("copy-feed").textContent = "Copied"; }
  catch { $("feed-url").select(); }
  setTimeout(() => ($("copy-feed").textContent = "Copy"), 2000);
});

addEventListener("online", render);
addEventListener("offline", render);

// Load
fetch("sets.json", { cache: "no-cache" })
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((data) => {
    sets = data.sets || [];
    api(`/stats?device=${device || ""}`).then(refreshStats).catch(() => {}); // site works without it
    return prepareOffline().catch(() => {});
  })
  .then(() => {
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
