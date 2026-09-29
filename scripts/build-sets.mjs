// Reads the public Nextcloud folder and writes sets.json + feed.xml.
// Runs in GitHub Actions (see .github/workflows/update-sets.yml) or locally:
//   node scripts/build-sets.mjs
// Needs Node 20+ (built-in fetch). No dependencies.

import { writeFile, readFile } from "node:fs/promises";

const SHARE_URL = process.env.SHARE_URL || "https://cloud.univ-grenoble-alpes.fr/s/6j9ZEg7zqb85SLi";
const SITE_URL = (process.env.SITE_URL || siteUrlFromRepo() || "https://pablo-arias.github.io/mdsstream").replace(/\/$/, "");
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i;

const { origin, pathname } = new URL(SHARE_URL);
const token = pathname.split("/").filter(Boolean).pop();
const davBase = `${origin}/public.php/dav/files/${token}`;

function siteUrlFromRepo() {
  const repo = process.env.GITHUB_REPOSITORY; // "owner/name"
  if (!repo) return null;
  const [owner, name] = repo.split("/");
  return `https://${owner.toLowerCase()}.github.io/${name}`;
}

// --- Nextcloud listing ------------------------------------------------------

// Public WebDAV only answers once we hold the share page's session cookie.
async function openSession() {
  const res = await fetch(SHARE_URL, { redirect: "manual" });
  if (!res.ok) throw new Error(`Share page returned ${res.status}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const html = await res.text();
  const requestToken = html.match(/data-requesttoken="([^"]+)"/)?.[1] ?? "";
  return { cookie, requestToken };
}

async function listFiles() {
  const { cookie, requestToken } = await openSession();
  const body = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:getlastmodified/><d:getcontentlength/><d:getcontenttype/><d:getetag/>
    <nc:creation_time/><nc:upload_time/><oc:fileid/>
  </d:prop>
</d:propfind>`;
  const res = await fetch(`${davBase}/`, {
    method: "PROPFIND",
    headers: {
      Depth: "1",
      "Content-Type": "application/xml",
      "X-Requested-With": "XMLHttpRequest",
      requesttoken: requestToken,
      cookie,
    },
    body,
  });
  if (res.status !== 207) throw new Error(`PROPFIND returned ${res.status}`);
  const xml = await res.text();

  const tag = (block, name) => block.match(new RegExp(`<[a-z]+:${name}>([^<]*)</[a-z]+:${name}>`))?.[1];
  return xml
    .split(/<d:response>/)
    .slice(1)
    .map((block) => {
      const href = tag(block, "href");
      const fileName = decodeURIComponent(href.split("/").filter(Boolean).pop());
      return {
        fileName,
        fileId: tag(block, "fileid"),
        size: Number(tag(block, "getcontentlength") || 0),
        type: tag(block, "getcontenttype") || "",
        etag: (tag(block, "getetag") || "").replace(/&quot;|"/g, ""),
        created: Number(tag(block, "creation_time") || 0),
        uploaded: Number(tag(block, "upload_time") || 0),
        modified: Date.parse(tag(block, "getlastmodified") || "") / 1000 || 0,
      };
    })
    .filter((f) => AUDIO_EXT.test(f.fileName));
}

// --- File name convention ---------------------------------------------------
// Author _ Genre _ Objective _ BPM _ Description   ("_" as separator, or " - " when there's no "_")
// Anything that doesn't match still shows up, with the file name as its title.

const OBJECTIVES = [
  { id: "lets-go", label: "Let's go", test: /^let'?s ?go$/i },
  { id: "focus", label: "Focus", test: /^focus$/i },
  { id: "experimentation", label: "Experimentation", test: /^experiment(ation|al)?$/i },
];

export function parseName(fileName) {
  const base = fileName.replace(AUDIO_EXT, "").trim();
  // With "_" in the name, " - " is free to appear inside a field (e.g. "Dub - Dub techno").
  const parts = base.split(base.includes("_") ? /_/ : /\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 5) return { title: base };

  const [author, genre, objectiveRaw, fourth, ...rest] = parts;
  const objective = OBJECTIVES.find((o) => o.test.test(objectiveRaw));
  const bpm = fourth.match(/^(\d{2,3}(?:\.\d+)?)\s*(?:bpm)?$/i);
  return {
    title: rest.join(" - "),
    author,
    genre,
    objective: objective ? objective.id : objectiveRaw.toLowerCase(),
    objectiveLabel: objective ? objective.label : objectiveRaw,
    ...(bpm ? { bpm: Number(bpm[1]) } : { category: fourth }),
  };
}

// --- Outputs ----------------------------------------------------------------

const escapeXml = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

function buildFeed(sets) {
  const items = sets
    .map((s) => {
      const desc = [s.genre, s.objectiveLabel, s.bpm && `${s.bpm} BPM`, s.category].filter(Boolean).join(" · ");
      return `    <item>
      <title>${escapeXml(s.title)}</title>
      <description>${escapeXml(desc || s.title)}</description>
      <guid isPermaLink="false">${escapeXml(s.id)}</guid>
      <pubDate>${new Date(s.date).toUTCString()}</pubDate>
      <enclosure url="${escapeXml(s.url)}" length="${s.size}" type="${escapeXml(s.type || "audio/mpeg")}"/>
      <link>${SITE_URL}/#${encodeURIComponent(s.id)}</link>
    </item>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>MDS · Vercors Stream</title>
    <link>${SITE_URL}/</link>
    <description>MDS streaming sporadically from the Vercors natural park.</description>
    <language>en</language>
    <itunes:author>MDS</itunes:author>
    <itunes:image href="${SITE_URL}/icon.svg"/>
    <itunes:category text="Music"/>
    <itunes:explicit>false</itunes:explicit>
${items}
  </channel>
</rss>
`;
}

async function writeIfChanged(path, content) {
  const old = await readFile(path, "utf8").catch(() => null);
  if (old === content) return false;
  await writeFile(path, content);
  return true;
}

const files = await listFiles();
const sets = files
  .map((f) => {
    const seconds = f.created || f.uploaded || f.modified;
    return {
      id: f.fileId || f.fileName,
      fileName: f.fileName,
      url: `${davBase}/${encodeURIComponent(f.fileName)}`,
      date: new Date(seconds * 1000).toISOString(),
      size: f.size,
      type: f.type,
      ...parseName(f.fileName),
    };
  })
  .sort((a, b) => b.date.localeCompare(a.date));

// No timestamp in the JSON, so the file (and the git history) only changes when the sets change.
const changedJson = await writeIfChanged("sets.json", JSON.stringify({ sets }, null, 2) + "\n");
const changedFeed = await writeIfChanged("feed.xml", buildFeed(sets));
console.log(`${sets.length} sets · sets.json ${changedJson ? "updated" : "unchanged"} · feed.xml ${changedFeed ? "updated" : "unchanged"}`);
