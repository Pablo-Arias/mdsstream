const $ = (id) => document.getElementById(id);
const list = $("sets"), statusEl = $("status"), audio = $("audio"), player = $("player");
const seek = $("seek");

const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';

let sets = [];
let current = null;
let filter = "all";

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
      return el("li", { class: `set${isCurrent ? " is-current" : ""}`, id: `set-${s.id}` },
        el("button", {
          class: "set-play", type: "button", "data-id": s.id,
          "aria-label": `${playing ? "Pause" : "Play"} ${s.title}`,
          html: playing ? ICON_PAUSE : ICON_PLAY,
        }),
        el("div", {},
          el("p", { class: "set-title" }, s.title),
          el("p", { class: "set-meta" },
            s.objectiveLabel && el("span", { class: `badge ${s.objective}` }, s.objectiveLabel),
            s.genre && el("span", {}, s.genre),
            s.bpm && el("span", {}, `${s.bpm} BPM`),
            s.category && el("span", {}, s.category),
            el("span", {}, fmtDate(s.date)),
          ),
        ),
      );
    }),
  );
  statusEl.textContent = sets.length && !shown.length ? "No sets of this type yet." : "";
}

function play(set) {
  if (current && current.id === set.id) {
    audio.paused ? audio.play() : audio.pause();
    return;
  }
  current = set;
  audio.src = set.url;
  audio.play().catch(() => {});
  player.hidden = false;
  $("now-title").textContent = set.title;
  history.replaceState(null, "", `#${set.id}`);
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: set.title,
      artist: "MDFS",
      album: [set.genre, set.objectiveLabel].filter(Boolean).join(" · ") || "Vercors Stream",
      artwork: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
    });
  }
  render();
}

// Events
list.addEventListener("click", (e) => {
  const btn = e.target.closest(".set-play");
  if (btn) play(sets.find((s) => s.id === btn.dataset.id));
});

document.querySelector(".filters").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  filter = btn.dataset.filter;
  for (const b of e.currentTarget.children) b.setAttribute("aria-pressed", String(b === btn));
  render();
});

$("toggle").addEventListener("click", () => (audio.paused ? audio.play() : audio.pause()));
$("back").addEventListener("click", () => (audio.currentTime = Math.max(0, audio.currentTime - 15)));
$("fwd").addEventListener("click", () => (audio.currentTime += 30));

let seeking = false;
seek.addEventListener("input", () => { seeking = true; $("cur").textContent = fmtTime(+seek.value); });
seek.addEventListener("change", () => { audio.currentTime = +seek.value; seeking = false; });

audio.addEventListener("loadedmetadata", () => {
  seek.max = Math.floor(audio.duration) || 0;
  $("dur").textContent = fmtTime(audio.duration);
});
audio.addEventListener("timeupdate", () => {
  if (seeking) return;
  seek.value = Math.floor(audio.currentTime);
  $("cur").textContent = fmtTime(audio.currentTime);
});
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
  ms.setActionHandler("seekto", (d) => (audio.currentTime = d.seekTime));
}

// Load
fetch("sets.json", { cache: "no-cache" })
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((data) => {
    sets = data.sets || [];
    statusEl.textContent = sets.length ? "" : "No sets yet — come back soon.";
    render();
    // A shared link like …/#1198364518 highlights that set (autoplay is blocked by browsers).
    const linked = sets.find((s) => `#${s.id}` === location.hash);
    if (linked) {
      current = linked;
      $("now-title").textContent = linked.title;
      audio.src = linked.url;
      player.hidden = false;
      render();
      $(`set-${linked.id}`)?.scrollIntoView({ block: "center" });
    }
  })
  .catch(() => (statusEl.textContent = "Couldn't load the sets. Try again in a moment."));
