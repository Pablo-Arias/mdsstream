# Vercors Stream

MDS streaming sporadically from the Vercors natural park on this website.

A static site on GitHub Pages. The audio lives in a public Nextcloud folder. An hourly GitHub Action lists that folder and writes `sets.json` (for the site) and `feed.xml` (a podcast feed).

## Publishing a set

Drop an MP3 into the cloud folder. It shows up on the site within an hour (or immediately via **Actions → Update sets → Run workflow**). The date comes from the file itself.

File names:

```
Author - Genre - Objective - BPM - Description.mp3
Author_Genre_Objective_BPM_Description.mp3
```

Examples:

```
MDS - Modular techno - Let's go - 135 - Modular exploration after 909 integration.mp3
MDS_Ambient techno_Focus_120_Atmospheric and polyrhythmic snippet.mp3
```

- **Objective** is one of `Let's go`, `Focus`, `Experimentation` (any case).
- **BPM** is a number. If it isn't, it's shown as a free-text category instead.
- If the name contains `_`, only `_` separates fields, so ` - ` can be used inside one (`Dub - Dub techno`). Otherwise ` - ` separates them.
- Files that don't follow the pattern still appear, with the file name as the title.

## Setup (once)

1. Push this repo to GitHub.
2. **Settings → Pages**: deploy from branch `main`, folder `/ (root)`.
3. **Settings → Actions → General → Workflow permissions**: *Read and write*.

GitHub pauses scheduled workflows after 60 days without commits to the repo. If that happens, re-enable it in the Actions tab.

## Local

```sh
node scripts/build-sets.mjs   # Node 20+
python3 -m http.server 8000   # then open http://localhost:8000
```
