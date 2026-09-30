// MDS · Vercors Stream API (Cloudflare Worker + D1).
//
//   GET  /stats?device=…   listens and ratings for every set (+ this device's own ratings)
//   POST /listen           { setId, device }          count a listen (once per device per day)
//   POST /rate             { setId, device, stars }   rate 1–5 (one rating per device)
//   POST /moment           { setId, device, t, on }   mark/unmark a good part at t seconds (30 s windows)
//   GET  /audio/<setId>    the set's MP3 (from R2; falls back to relaying Nextcloud), with seeking
//   GET  /file/<name>      any file in the R2 bucket (covers, notes), with seeking
//   GET  /library          what's in the R2 bucket, with stable ids and dates (used by the site build)
//   POST /subscribe        { endpoint }               notify this phone of new sets
//   POST /unsubscribe      { endpoint }
//
// Every 15 minutes (cron) it checks sets.json and notifies subscribers of new sets.
// No accounts, no cookies, no IP addresses stored. `device` is a random ID the site
// keeps in the browser.

import { sendPush } from "./push.js";

const DEVICE = /^[0-9a-f-]{36}$/;
const BUCKET = 30; // seconds per "good part" window
const MAX_MOMENTS = 200; // per device per set
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

    try {
      const { pathname, searchParams } = new URL(request.url);

      if ((request.method === "GET" || request.method === "HEAD") && pathname.startsWith("/file/")) {
        const key = decodeURIComponent(pathname.slice("/file/".length));
        return (await serveObject(env, key, request, cors)) || json({ error: "Not found" }, 404);
      }

      if (request.method === "GET" && pathname === "/library") {
        return json({ files: await library(env) });
      }

      // A set's audio: from R2 if it's there, else relayed from Nextcloud (only files listed in
      // sets.json, so this is not an open proxy).
      if ((request.method === "GET" || request.method === "HEAD") && pathname.startsWith("/audio/")) {
        const id = decodeURIComponent(pathname.slice("/audio/".length));
        const row = env.AUDIO && (await env.DB.prepare("SELECT key FROM files WHERE id = ?").bind(id).first());
        const fromR2 = row && (await serveObject(env, row.key, request, cors));
        if (fromR2) return fromR2;
        const relay = async () => {
          const set = (await knownSets(env)).get(id);
          if (!set || new URL(set.url).origin === new URL(request.url).origin) return null;
          const range = request.headers.get("Range");
          return fetch(set.url, { headers: range ? { Range: range } : {} });
        };
        let upstream = await relay();
        if (upstream?.status === 404) { setCache.at = 0; upstream = await relay(); } // renamed since last check
        if (!upstream) return json({ error: "Unknown set" }, 404);
        const headers = new Headers(cors);
        for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
          const v = upstream.headers.get(h);
          if (v) headers.set(h, v);
        }
        return new Response(upstream.body, { status: upstream.status, headers });
      }

      if (request.method === "GET" && pathname === "/stats") {
        const device = searchParams.get("device");
        return json(await stats(env, DEVICE.test(device || "") ? device : null));
      }

      if (request.method !== "POST") return json({ error: "Not found" }, 404);
      const body = await request.json().catch(() => ({}));

      if (pathname === "/listen" || pathname === "/rate" || pathname === "/moment") {
        if (!DEVICE.test(body.device || "")) return json({ error: "Bad device" }, 400);
        const known = await knownSets(env);
        if (!known.has(body.setId)) return json({ error: "Unknown set" }, 400);
        if (pathname === "/moment") {
          const t = Number(body.t);
          const duration = known.get(body.setId).duration || 6 * 3600;
          if (!Number.isFinite(t) || t < 0 || t > duration + 5) return json({ error: "Bad time" }, 400);
          const bucket = Math.floor(t / BUCKET);
          if (body.on === false) {
            await env.DB.prepare("DELETE FROM moments WHERE set_id = ? AND device = ? AND bucket = ?")
              .bind(body.setId, body.device, bucket)
              .run();
          } else {
            const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM moments WHERE set_id = ? AND device = ?")
              .bind(body.setId, body.device)
              .first();
            if (n >= MAX_MOMENTS) return json({ error: "Too many marks" }, 429);
            await env.DB.prepare("INSERT OR IGNORE INTO moments (set_id, device, bucket, created) VALUES (?, ?, ?, ?)")
              .bind(body.setId, body.device, bucket, new Date().toISOString())
              .run();
          }
          return json(await stats(env, body.device));
        }
        if (pathname === "/listen") {
          await env.DB.prepare("INSERT OR IGNORE INTO listens (set_id, device, day) VALUES (?, ?, ?)")
            .bind(body.setId, body.device, new Date().toISOString().slice(0, 10))
            .run();
        } else {
          const stars = Number(body.stars);
          if (!Number.isInteger(stars) || stars < 1 || stars > 5) return json({ error: "Bad rating" }, 400);
          await env.DB.prepare(
            `INSERT INTO ratings (set_id, device, stars, updated) VALUES (?, ?, ?, ?)
             ON CONFLICT (set_id, device) DO UPDATE SET stars = excluded.stars, updated = excluded.updated`,
          )
            .bind(body.setId, body.device, stars, new Date().toISOString())
            .run();
        }
        return json(await stats(env, body.device));
      }

      if (pathname === "/subscribe" || pathname === "/unsubscribe") {
        const endpoint = String(body.endpoint || "");
        let host;
        try { host = new URL(endpoint).hostname; } catch { return json({ error: "Bad subscription" }, 400); }
        if (!endpoint.startsWith("https://") || !PUSH_HOSTS.test(host)) {
          console.log(`Rejected push endpoint host: ${host}`);
          return json({ error: "Bad subscription" }, 400);
        }
        console.log(`${pathname} from ${host}`);
        if (pathname === "/subscribe") {
          await env.DB.prepare("INSERT OR IGNORE INTO subscriptions (endpoint, created) VALUES (?, ?)")
            .bind(endpoint, new Date().toISOString())
            .run();
        } else {
          await env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ?").bind(endpoint).run();
        }
        return json({ ok: true });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "Server error" }, 500);
    }
  },

  async scheduled(_event, env) {
    await Promise.allSettled([triggerSiteUpdate(env), notifyNewSets(env)]);
  },
};

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = [env.SITE_ORIGIN, "http://localhost:8765"];
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : env.SITE_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

async function fetchSets(env) {
  const res = await fetch(`${env.SETS_URL}?t=${Date.now()}`, { cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`sets.json returned ${res.status}`);
  return (await res.json()).sets || [];
}

// Only accept listens/ratings/marks for sets that exist: Map of id → duration (s).
// Cached per Worker instance for 5 min.
let setCache = { at: 0, sets: new Map() };
async function knownSets(env) {
  if (Date.now() - setCache.at > 5 * 60 * 1000) {
    setCache = { at: Date.now(), sets: new Map((await fetchSets(env)).map((s) => [s.id, { duration: s.duration || 0, url: s.url }])) };
  }
  return setCache.sets;
}

// --- R2 bucket ------------------------------------------------------------------

const TYPES = { mp3: "audio/mpeg", m4a: "audio/mp4", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8" };
const typeOf = (key, meta) => meta?.contentType || TYPES[key.split(".").pop().toLowerCase()] || "application/octet-stream";

// "bytes=a-b" | "bytes=a-" | "bytes=-n" → { start, end } (inclusive) for a file of `size` bytes.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") return { start: Math.max(0, size - Number(m[2])), end: size - 1 };
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start <= end ? { start, end } : "invalid";
}

// Serve an R2 object, honouring Range requests (needed for seeking and podcast apps).
async function serveObject(env, key, request, cors) {
  if (!env.AUDIO) return null;
  const head = await env.AUDIO.head(key);
  if (!head) return null;
  const range = parseRange(request.headers.get("Range"), head.size);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...cors, "Content-Range": `bytes */${head.size}` } });
  }
  const obj = request.method === "HEAD"
    ? head
    : await env.AUDIO.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : {});
  if (!obj) return null;
  const headers = new Headers(cors);
  headers.set("Content-Type", typeOf(key, obj.httpMetadata));
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", obj.httpEtag);
  headers.set("Cache-Control", "public, max-age=3600");
  if (request.method === "HEAD") {
    headers.set("Content-Length", String(obj.size));
    return new Response(null, { status: 200, headers });
  }
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${obj.size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

// Everything in the bucket, with an id and date that survive renames: the `files` table
// remembers them by name, and a file seen under a new name with the same content (etag)
// keeps its old id and date.
async function library(env) {
  if (!env.AUDIO) return [];
  const objects = [];
  let cursor;
  do {
    const page = await env.AUDIO.list({ cursor, include: ["httpMetadata"] });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const known = (await env.DB.prepare("SELECT key, id, date, etag FROM files").all()).results;
  const byKey = new Map(known.map((f) => [f.key, f]));
  const byEtag = new Map(known.filter((f) => f.etag).map((f) => [f.etag, f]));
  const present = new Set(objects.map((o) => o.key));
  const usedIds = new Set();
  const writes = [];
  const files = [];

  for (const o of objects) {
    let f = byKey.get(o.key);
    if (!f) {
      const moved = byEtag.get(o.etag);
      const renamed = moved && !present.has(moved.key);
      f = { id: renamed ? moved.id : `r2-${o.etag.slice(0, 12)}`, date: renamed ? moved.date : o.uploaded.toISOString() };
      if (usedIds.has(f.id)) f.id = `${f.id}-${files.length}`; // two identical files
      if (renamed) writes.push(env.DB.prepare("DELETE FROM files WHERE key = ?").bind(moved.key));
      writes.push(env.DB.prepare("INSERT OR REPLACE INTO files (key, id, date, etag) VALUES (?, ?, ?, ?)").bind(o.key, f.id, f.date, o.etag));
    } else if (f.etag !== o.etag) {
      writes.push(env.DB.prepare("UPDATE files SET etag = ? WHERE key = ?").bind(o.etag, o.key));
    }
    usedIds.add(f.id);
    files.push({ key: o.key, id: f.id, date: f.date, size: o.size, type: typeOf(o.key, o.httpMetadata) });
  }
  if (writes.length) await env.DB.batch(writes);
  return files;
}

async function stats(env, device) {
  const [listens, ratings, mine, moments, myMoments] = await env.DB.batch([
    env.DB.prepare("SELECT set_id, COUNT(*) AS n FROM listens GROUP BY set_id"),
    env.DB.prepare("SELECT set_id, AVG(stars) AS avg, COUNT(*) AS n FROM ratings GROUP BY set_id"),
    env.DB.prepare("SELECT set_id, stars FROM ratings WHERE device = ?").bind(device || ""),
    env.DB.prepare("SELECT set_id, bucket, COUNT(*) AS n FROM moments GROUP BY set_id, bucket"),
    env.DB.prepare("SELECT set_id, bucket FROM moments WHERE device = ?").bind(device || ""),
  ]);
  const sets = {};
  const entry = (id) => (sets[id] ??= { listens: 0, rating: null, ratings: 0, moments: [] });
  for (const r of listens.results) entry(r.set_id).listens = r.n;
  for (const r of ratings.results) Object.assign(entry(r.set_id), { rating: Math.round(r.avg * 10) / 10, ratings: r.n });
  // moments: [[startSecond, count], …] per set
  for (const r of moments.results) entry(r.set_id).moments.push([r.bucket * BUCKET, r.n]);
  const myMarks = {};
  for (const r of myMoments.results) (myMarks[r.set_id] ??= []).push(r.bucket * BUCKET);
  return { sets, mine: Object.fromEntries(mine.results.map((r) => [r.set_id, r.stars])), myMoments: myMarks, bucket: BUCKET };
}

// GitHub's own schedule is best-effort (runs get delayed or skipped for hours), so this
// reliable cron starts the "Update sets" workflow that re-reads the Nextcloud folder.
// Needs the secret GITHUB_TOKEN: a fine-grained token with Actions read/write on the repo.
async function triggerSiteUpdate(env) {
  if (!env.GITHUB_TOKEN) return;
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/update-sets.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mdsstream-worker",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (res.status !== 204) {
    console.log(`Couldn't start the site update: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

async function notifyNewSets(env) {
  const sets = await fetchSets(env);
  const done = new Set((await env.DB.prepare("SELECT set_id FROM notified").all()).results.map((r) => r.set_id));
  const fresh = sets.filter((s) => !done.has(s.id));
  if (!fresh.length) return;

  const mark = (s) => env.DB.prepare("INSERT OR IGNORE INTO notified (set_id, at) VALUES (?, ?)").bind(s.id, new Date().toISOString());
  // First run: remember what's already there without notifying anyone.
  if (!done.size) {
    await env.DB.batch(fresh.map(mark));
    return;
  }

  const subs = (await env.DB.prepare("SELECT endpoint FROM subscriptions").all()).results;
  const gone = [];
  const results = [];
  for (const { endpoint } of subs) {
    const { status, detail } = await sendPush(endpoint, env).catch((err) => ({ status: 0, detail: String(err) }));
    console.log(`Push to ${endpoint.slice(0, 45)}… → ${status}${detail ? ` ${detail}` : ""}`);
    results.push({ endpoint, status: `${status}${detail ? ` ${detail}` : ""}` });
    if (status === 404 || status === 410) gone.push(endpoint); // phone unsubscribed or app removed
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    ...fresh.map(mark),
    ...results.map((r) =>
      env.DB.prepare("UPDATE subscriptions SET last_push = ?, last_status = ? WHERE endpoint = ?").bind(now, r.status.slice(0, 300), r.endpoint),
    ),
    ...gone.map((e) => env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ?").bind(e)),
  ]);
  console.log(`Notified ${subs.length - gone.length} devices about ${fresh.length} new set(s); removed ${gone.length}.`);
}
