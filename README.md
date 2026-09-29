# Vercors Stream

MDS streaming analog and electronic music sporadically from the Vercors natural park, in HQ, for free.

A static site on GitHub Pages. The audio lives in a public Nextcloud folder. An hourly GitHub Action lists that folder and writes `sets.json` (for the site) and `feed.xml` (a podcast feed).

## Publishing a set

Drop an MP3 into the cloud folder. It shows up on the site within an hour (or immediately via **Actions → Update sets → Run workflow**). The date comes from the file itself.

File names:

```
Artist - Genre - Objective - BPM - Description.mp3
Artist_Genre_Objective_BPM_Description.mp3
```

Examples:

```
MDS - Modular techno - Let's go - 135 - Modular exploration after 909 integration.mp3
MDS_Ambient techno_Focus_120_Atmospheric and polyrhythmic snippet.mp3
```

- **Objective** is one of `Let's go`, `Focus`, `Experimentation` (any case).
- **Several values in one field**: separate them with ` - ` (spaces around the dash), e.g. `Dub - Dub techno` or `Focus - Experimentation` (the set then shows under both filters), or `MDS - Guest` for two artists.
- **BPM** is a number. If it isn't, it's shown as a free-text category instead.
- If the name contains `_`, only `_` separates fields, so ` - ` can be used inside one (`Dub - Dub techno`). Otherwise ` - ` separates them.
- Files that don't follow the pattern still appear, with the file name as the title.

### Notes and covers (optional)

Put them next to the MP3 in the cloud folder, with **exactly the same name**:

```
MDS_Dub techno_Focus_90_First dub session.mp3
MDS_Dub techno_Focus_90_First dub session.txt   ← notes, shown under the set
MDS_Dub techno_Focus_90_First dub session.jpg   ← cover (.jpg, .png or .webp)
cover.jpg                                        ← default cover for sets without one
```

Covers also show on the phone's lock screen and in podcast apps (square, 1400×1400 or more is ideal for those).

## Setup (once)

1. Push this repo to GitHub.
2. **Settings → Pages**: deploy from branch `main`, folder `/ (root)`.
3. **Settings → Actions → General → Workflow permissions**: *Read and write*.

GitHub pauses scheduled workflows after 60 days without commits to the repo. If that happens, re-enable it in the Actions tab.

## Changing the site's code

After editing `app.js` or `style.css`, run `scripts/stamp-assets.sh` before committing. It
updates the `?v=` in `index.html`, so visitors never get a new page with an old cached script.

## Local

```sh
node scripts/build-sets.mjs   # Node 20+
python3 -m http.server 8000   # then open http://localhost:8000
```

## Listen counts, stars and notifications (Cloudflare Worker)

`worker/` is a small Cloudflare Worker with a D1 database, live at
`https://mdsstream-api.mdsstream.workers.dev`. It stores listen counts (once per device per
day, after 30 s of playback), 1–5 star ratings (one per device) and push subscriptions.
No accounts, cookies or IP addresses: the site sends an anonymous random device ID.
Every 15 minutes it checks `sets.json` and notifies subscribers of new sets.

```sh
cd worker
npx wrangler deploy                                        # after changing the code
npx wrangler d1 execute mdsstream --remote --command "SELECT * FROM ratings"
npx wrangler tail                                          # live logs
```

The push signing key is the Worker secret `VAPID_PRIVATE_JWK`; its public half is in
`worker/wrangler.toml` and `app.js`. Replacing the key pair unsubscribes every phone.
