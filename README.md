# Vault Mobile (Android, Capacitor)

The full-featured Vault build for a phone: Home, Library, Radio, Playlists,
Search, and Settings, navigated with a bottom tab bar instead of the
Chromebook build's mouse-and-keyboard sidebar. Same app.js logic and feature
set as that build — the only real difference is navigation chrome and CSS
tuned for a narrow, full-screen phone view.

Reads a real local music folder — no Google Drive, no backend server, no
API keys. Same `Artist/Era/track.mp3` folder convention as the desktop app,
including "messy" folders: loose files with no Era subfolder get a catch-all
"Singles" era, loose files at the library root get grouped by their own ID3
tag, and — as of this build — any extra organizational folder level between
the artist and the actual tracks (e.g. `Artist/Sessions/<many session
folders>/track.mp3`) gets walked to any depth instead of only ever looking
exactly one level below the artist folder.

## What's here vs. the Chromebook app

Same local-folder engine (`local-library.js`, including the Storage Access
Framework native plugin for real folder access — see `VaultLocalFilesPlugin.java`),
same feature set, different navigation:

- **Bottom tab bar** (Home / Library / Radio / Playlists / Search / Settings)
  instead of a sidebar — the standard one-handed phone navigation pattern.
- **Home** dashboard tiles, sized for 2-column phone widths.
- **Library** — Artist → Era → Track drill-down, square cards with each
  track's own embedded cover art and file size.
- **Radio** — shuffle your whole library, or shuffle one artist as a
  "station."
- **Playlists** — create, add/remove tracks, play. Persisted with
  `localStorage` on-device.
- **Settings** — accent color and playback preferences (autoplay, default
  volume), also `localStorage`-persisted.
- **Fullscreen "now playing" view** and an **Up Next** queue drawer (full
  width bottom sheet on phone, instead of a docked side panel).

Not included (same reasoning as the Chromebook app): no login/roles, no
admin panel, no member requests, no Discord presence — all of those need
either a real backend or an OS integration this sandboxed build doesn't have.

This app has its own package ID (`fun.thevaulthub.vault.mobile`) and app
name ("Vault"), so it installs side-by-side with the Chromebook build if you
have both.

## Getting a real .apk file

This repo includes `.github/workflows/build-apk.yml`, which builds a real
`.apk` automatically using GitHub's own servers. The Android SDK, Gradle,
and Maven downloads this needs are blocked in the sandbox that generated
this project (no outbound access to `dl.google.com`, `maven.google.com`,
Maven Central, or Gradle's own distribution server), so a compiled `.apk`
couldn't be produced directly here — GitHub Actions is the path to an
actual installable file:

1. Push this folder to a new GitHub repo (or upload it via the GitHub web
   UI — Add file → Upload files).
2. Go to the repo's **Actions** tab. The workflow runs automatically on
   push, or click **Run workflow** to trigger it manually.
3. Once it finishes (a few minutes), open the run and download the
   **vault-mobile-debug-apk** artifact — that's your `.apk`.
4. On the phone: enable installing from unknown sources / turn on ADB
   debugging (see in-app prompts on modern Android), then either sideload
   the `.apk` directly (open it from Files/Downloads) or push it via
   `adb install` over USB.

## Testing without a phone

`npm test` runs a headless smoke test (jsdom + a fake local-folder tree)
against the real `app.js`/`local-library.js` — covers the setup flow,
library drill-down, Home tiles, Radio shuffle, Playlists (create/add/
remove/play), Settings, Search, playback, per-track cover art, and the
deeply-nested-folder fix, with zero real Android device needed.
