// MDS · Vercors Stream API (Cloudflare Worker + D1).
//
//   GET  /stats?device=…   listens and ratings for every set (+ this device's own ratings)
//   POST /listen           { setId, device }          count a listen (once per device per day)
//   POST /rate             { setId, device, stars }   rate 1–5 (one rating per device)
//   POST /subscribe        { endpoint }               notify this phone of new sets
//   POST /unsubscribe      { endpoint }
//
// Every 15 minutes (cron) it checks sets.json and notifies subscribers of new sets.
// No accounts, no cookies, no IP addresses stored. `device` is a random ID the site
// keeps in the browser.

import { sendPush } from "./push.js";

const DEVICE = /^[0-9a-f-]{36}$/;
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

    try {
      const { pathname, searchParams } = new URL(request.url);

      if (request.method === "GET" && pathname === "/stats") {
        const device = searchParams.get("device");
        return json(await stats(env, DEVICE.test(device || "") ? device : null));
      }

      if (request.method !== "POST") return json({ error: "Not found" }, 404);
      const body = await request.json().catch(() => ({}));

      if (pathname === "/listen" || pathname === "/rate") {
        if (!DEVICE.test(body.device || "")) return json({ error: "Bad device" }, 400);
        if (!(await setIds(env)).has(body.setId)) return json({ error: "Unknown set" }, 400);
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
        if (!endpoint.startsWith("https://") || !PUSH_HOSTS.test(host)) return json({ error: "Bad subscription" }, 400);
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
    await notifyNewSets(env);
  },
};

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = [env.SITE_ORIGIN, "http://localhost:8765"];
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : env.SITE_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

async function fetchSets(env) {
  const res = await fetch(`${env.SETS_URL}?t=${Date.now()}`, { cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`sets.json returned ${res.status}`);
  return (await res.json()).sets || [];
}

// Only accept listens/ratings for sets that exist. Cached per Worker instance for 5 min.
let setIdCache = { at: 0, ids: new Set() };
async function setIds(env) {
  if (Date.now() - setIdCache.at > 5 * 60 * 1000) {
    setIdCache = { at: Date.now(), ids: new Set((await fetchSets(env)).map((s) => s.id)) };
  }
  return setIdCache.ids;
}

async function stats(env, device) {
  const [listens, ratings, mine] = await env.DB.batch([
    env.DB.prepare("SELECT set_id, COUNT(*) AS n FROM listens GROUP BY set_id"),
    env.DB.prepare("SELECT set_id, AVG(stars) AS avg, COUNT(*) AS n FROM ratings GROUP BY set_id"),
    env.DB.prepare("SELECT set_id, stars FROM ratings WHERE device = ?").bind(device || ""),
  ]);
  const sets = {};
  const entry = (id) => (sets[id] ??= { listens: 0, rating: null, ratings: 0 });
  for (const r of listens.results) entry(r.set_id).listens = r.n;
  for (const r of ratings.results) Object.assign(entry(r.set_id), { rating: Math.round(r.avg * 10) / 10, ratings: r.n });
  return { sets, mine: Object.fromEntries(mine.results.map((r) => [r.set_id, r.stars])) };
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
  for (const { endpoint } of subs) {
    const status = await sendPush(endpoint, env).catch(() => 0);
    if (status === 404 || status === 410) gone.push(endpoint); // phone unsubscribed or app removed
  }
  await env.DB.batch([
    ...fresh.map(mark),
    ...gone.map((e) => env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ?").bind(e)),
  ]);
  console.log(`Notified ${subs.length - gone.length} devices about ${fresh.length} new set(s); removed ${gone.length}.`);
}
