// Headless smoke test for the phone build's renderer logic. Same
// "fake-tree-over-real-code" approach as the Chromebook build's test/smoke.js
// (this file started as a copy of it, updated for the bottom tab bar nav):
// loads the real index.html/styles.css/app.js/local-library.js into jsdom
// with a fake window.showDirectoryPicker + FileSystemDirectoryHandle-shaped
// tree, so this exercises the actual tab bar/Home/Radio/Playlists code
// against real DOM events, with zero real filesystem or Android device.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..', 'www');
let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`); }
  else { console.log(`ok   ${msg}`); }
}

// ---------------------------------------------------------------------------
// Fake FileSystemDirectoryHandle / FileSystemFileHandle tree (same shape
// local-library.js's BrowserBackend expects: .kind, .name, async entries(),
// getFile()).
// ---------------------------------------------------------------------------
function makeFileHandle(name, bytes, mimeType, { rejectPlay = false } = {}) {
  return {
    kind: 'file',
    name,
    _rejectPlay: rejectPlay,
    async getFile() {
      const file = new File([bytes], name, { type: mimeType });
      if (rejectPlay) Object.defineProperty(file, '_vaultBroken', { value: true });
      return file;
    },
  };
}
function makeDirHandle(name, children) {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const [childName, handle] of children) yield [childName, handle];
    },
  };
}

// Hand-rolled ID3v2.3 tag with a single APIC (embedded cover) frame — enough
// to exercise local-library.js's own from-scratch ID3 reader (extractId3Cover)
// for real, rather than just handing it inert bytes. Frame sizes are plain
// big-endian in v2.3 (only the 10-byte tag header size is synchsafe).
function buildApicFrame(mime, picType, imgBytes) {
  const mimeBytes = Buffer.from(mime + '\0', 'latin1');
  const body = Buffer.concat([
    Buffer.from([0]), // text encoding = latin1
    mimeBytes,
    Buffer.from([picType]),
    Buffer.from([0]), // empty description, latin1-terminated
    Buffer.from(imgBytes),
  ]);
  const header = Buffer.alloc(10);
  header.write('APIC', 0, 'latin1');
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
function buildId3Mp3(imgBytes, mime = 'image/jpeg') {
  const frame = buildApicFrame(mime, 3, imgBytes);
  const tagHeader = Buffer.alloc(10);
  tagHeader.write('ID3', 0, 'latin1');
  tagHeader[3] = 3; // major version 2.3
  const sz = frame.length;
  tagHeader[6] = (sz >>> 21) & 0x7f;
  tagHeader[7] = (sz >>> 14) & 0x7f;
  tagHeader[8] = (sz >>> 7) & 0x7f;
  tagHeader[9] = sz & 0x7f;
  const audioTail = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]);
  return Buffer.concat([tagHeader, frame, audioTail]);
}

function buildFakeTree() {
  return makeDirHandle('My Music', [
    ['Sable Rae', makeDirHandle('Sable Rae', [
      ['cover.jpg', makeFileHandle('cover.jpg', new Uint8Array([0xff, 0xd8, 1, 2]), 'image/jpeg')],
      ['Neon Static', makeDirHandle('Neon Static', [
        ['01 - Track One.mp3', makeFileHandle('01 - Track One.mp3', new Uint8Array([1, 2, 3]), 'audio/mpeg')],
        ['02 - Track Two.mp3', makeFileHandle('02 - Track Two.mp3', new Uint8Array([4, 5, 6]), 'audio/mpeg')],
        ['03 - Corrupted.mp3', makeFileHandle('03 - Corrupted.mp3', new Uint8Array([7]), 'audio/mpeg', { rejectPlay: true })],
      ])],
      // No cover.jpg here — each track carries its OWN distinct embedded
      // APIC cover, regression-testing the per-track cover fix (previously
      // only the era's first file was ever checked, so every track in a
      // folder with no cover.jpg fell back to sharing one file's art).
      ['No Cover Folder', makeDirHandle('No Cover Folder', [
        ['01 - Red.mp3', makeFileHandle('01 - Red.mp3', buildId3Mp3(new Uint8Array([0xaa, 0x01, 0x02, 0x03])), 'audio/mpeg')],
        ['02 - Blue.mp3', makeFileHandle('02 - Blue.mp3', buildId3Mp3(new Uint8Array([0xbb, 0x04, 0x05, 0x06])), 'audio/mpeg')],
      ])],
    ])],
    ['Kilo Drift', makeDirHandle('Kilo Drift', [
      ['Drift Sessions', makeDirHandle('Drift Sessions', [
        ['01 - Alone.wav', makeFileHandle('01 - Alone.wav', new Uint8Array([9, 9]), 'audio/x-wav')],
      ])],
    ])],
    // Regression fixture for a real, concretely-described bug report: an
    // artist folder organized with an extra organizational level in
    // between the artist and the actual per-session/per-project folders
    // (Artist/Sessions/<many session folders>/track.mp3), which the walk
    // previously only ever looked exactly one level below the artist
    // folder for — "Sessions" and "Projects" themselves got scanned as two
    // empty eras and everything underneath them was silently dropped.
    ['SoFaygo', makeDirHandle('SoFaygo', [
      ['Sessions', makeDirHandle('Sessions', [
        ['Session 1', makeDirHandle('Session 1', [
          ['take1.mp3', makeFileHandle('take1.mp3', new Uint8Array([1, 1]), 'audio/mpeg')],
        ])],
        ['Session 2', makeDirHandle('Session 2', [
          ['take1.mp3', makeFileHandle('take1.mp3', new Uint8Array([2, 2]), 'audio/mpeg')],
          ['take2.mp3', makeFileHandle('take2.mp3', new Uint8Array([2, 3]), 'audio/mpeg')],
        ])],
      ])],
      ['Projects', makeDirHandle('Projects', [
        ['Project A', makeDirHandle('Project A', [
          ['demo.mp3', makeFileHandle('demo.mp3', new Uint8Array([3, 3]), 'audio/mpeg')],
        ])],
      ])],
    ])],
  ]);
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://vault.example/index.html',
  });
  const { window } = dom;

  window.Blob = Blob;
  window.File = File;
  window.URL.createObjectURL = (obj) => global.URL.createObjectURL(obj);
  window.URL.revokeObjectURL = (u) => global.URL.revokeObjectURL(u);

  const fakeIdbStore = new Map();
  function installFakeIndexedDB(win) {
    win.indexedDB = {
      open() {
        const req = {};
        setTimeout(() => {
          const db = {
            createObjectStore() {},
            transaction() {
              const tx = {
                objectStore() {
                  return {
                    put(value, key) { fakeIdbStore.set(key, value); },
                    get(key) {
                      const r = {};
                      setTimeout(() => { r.result = fakeIdbStore.get(key); r.onsuccess && r.onsuccess(); }, 0);
                      return r;
                    },
                  };
                },
                oncomplete: null,
                onerror: null,
              };
              setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
              return tx;
            },
          };
          req.result = db;
          req.onsuccess && req.onsuccess();
        }, 0);
        return req;
      },
    };
  }
  installFakeIndexedDB(window);

  const fakeRoot = buildFakeTree();
  window.showDirectoryPicker = async () => fakeRoot;
  window.HTMLMediaElement.prototype.play = function () {
    if (this.src && this.src.startsWith('blob:') && this._vaultBrokenSrc) {
      const err = new Error('The element has no supported sources.');
      err.name = 'NotSupportedError';
      return Promise.reject(err);
    }
    return Promise.resolve();
  };
  window.HTMLMediaElement.prototype.pause = () => {};
  const brokenBlobUrls = new Set();
  const realCreateObjectURL = window.URL.createObjectURL;
  window.URL.createObjectURL = (obj) => {
    const u = realCreateObjectURL(obj);
    if (obj && obj._vaultBroken) brokenBlobUrls.add(u);
    return u;
  };
  Object.defineProperty(window.HTMLMediaElement.prototype, 'src', {
    configurable: true,
    get() { return this.getAttribute('src') || ''; },
    set(v) { this.setAttribute('src', v); this._vaultBrokenSrc = brokenBlobUrls.has(v); },
  });

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.error || e.message));

  window.eval(fs.readFileSync(path.join(ROOT, 'local-library.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'));
  // Fake gofile.io — same jsdom/Node Blob-realm quirk documented in the
  // Chromebook build's test: jsdom's FormData rejects Node-native Blob/File
  // instances even when they pass `instanceof Blob`, so the real multipart
  // upload can't be exercised here. Overriding the top-level uploadToGofile()
  // (a plain function declaration in app.js, so it's already a `window`
  // property) after eval swaps in a fake for shareCurrentTrack() to call —
  // everything around it (modal, blob read via the real VaultLocalLibrary,
  // link display, copy button) still runs for real.
  window.uploadToGofile = async () => 'https://gofile.io/d/fake123';
  await new Promise((r) => setTimeout(r, 20));
  const doc = window.document;

  // ---------------- login screen ----------------
  assert(doc.querySelector('#loginScreen').hidden === false, 'login screen shows first, before any folder setup');
  assert(doc.querySelector('#setupScreen').hidden === true, 'setup screen stays hidden until login completes');

  // Wrong admin code (default role is Admin) is rejected.
  doc.querySelector('#loginName').value = 'TestAdmin';
  doc.querySelector('#loginAdminCode').value = 'wrong-code';
  doc.querySelector('#btnEnterVault').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#loginError').hidden === false, 'wrong admin code is rejected with a visible error');
  assert(doc.querySelector('#loginScreen').hidden === false, 'login screen stays up after a rejected admin code');

  // Switch to Member (no admin code required) and log in for real.
  doc.querySelector('.role-btn[data-role="member"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#adminCodeRow').style.display === 'none', 'admin code field hides once Member is selected');
  doc.querySelector('#loginName').value = 'NightOwl';
  doc.querySelector('#btnEnterVault').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#loginScreen').hidden === true, 'login screen hides after a valid login');

  // ---------------- setup screen ----------------
  assert(doc.querySelector('#setupScreen').hidden === false, 'setup screen shows before a folder is picked');
  assert(doc.querySelector('#appShell').hidden === true, 'app shell stays hidden until a folder is connected');

  doc.querySelector('#btnPickFolder').dispatchEvent(new window.Event('click', { bubbles: true }));
  // Walking the fake tree now does real per-track cover/size extraction
  // (Promise.all batches per era) across three eras instead of one flat
  // pass, so this needs more headroom than the original 80ms.
  await new Promise((r) => setTimeout(r, 250));

  assert(doc.querySelector('#setupScreen').hidden === true, 'setup screen hides after picking a folder');
  assert(doc.querySelector('#appShell').hidden === false, 'app shell shows after picking a folder');
  assert(doc.querySelector('#libraryName').textContent === 'My Music', 'topbar shows the picked folder name');
  assert(doc.querySelector('#homeGreeting').textContent === 'NightOwl', 'Home greeting shows the logged-in username, not the picked folder name (regression)');

  // ---------------- bottom tab bar navigation ----------------
  const navItems = doc.querySelectorAll('.tab-item');
  assert(navItems.length === 6, `tab bar has all 6 tabs: Home/Library/Radio/Playlists/Search/Settings (got ${navItems.length})`);
  assert(doc.querySelector('#view-home').classList.contains('active'), 'Home is the default active view');

  doc.querySelector('[data-view="library"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#view-library').classList.contains('active'), 'clicking the Library nav item switches to the Library view');
  assert(!doc.querySelector('#view-home').classList.contains('active'), '...and Home is no longer active');

  // ---------------- Home dashboard tiles ----------------
  doc.querySelector('[data-view="home"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  const tiles = doc.querySelectorAll('#dashboardTiles .dashboard-tile');
  assert(tiles.length === 4, `Home shows 4 dashboard tiles: Library/Radio/Playlists/Search (got ${tiles.length})`);
  const libTile = [...tiles].find((t) => t.querySelector('.dt-title').textContent === 'Library');
  assert(!!libTile && libTile.querySelector('.dt-sub').textContent.includes('3 artists'), 'the Library tile shows the real artist count (3)');
  libTile.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#view-library').classList.contains('active'), 'clicking the Library dashboard tile navigates to Library');
  assert(doc.querySelector('#libTitle').textContent === 'Library', '...at the library root');

  // ---------------- library drill-down ----------------
  const artistCards = doc.querySelectorAll('#libGrid .card');
  assert(artistCards.length === 3, `library root shows 3 artists (got ${artistCards.length})`);
  assert(!doc.querySelector('#libGrid').classList.contains('track-list-mode'), 'artist grid is NOT in track-list-mode (uses the auto-fill card grid)');
  const sableCard = [...artistCards].find((c) => c.querySelector('.card-name').textContent === 'Sable Rae');
  sableCard.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const eraCards = doc.querySelectorAll('#libGrid .card');
  assert(eraCards.length === 2, `Sable Rae shows both her eras (got ${eraCards.length})`);
  const neonStaticCard = [...eraCards].find((c) => c.querySelector('.card-name').textContent === 'Neon Static');
  neonStaticCard.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  // Track view is now a square-card grid (own cover art + file size per
  // track), matching the desktop app's Explorer-style redesign — no longer
  // the old flat .track-row list.
  const trackCards = doc.querySelectorAll('#libGrid .card');
  assert(trackCards.length === 3, `Neon Static shows 3 tracks (got ${trackCards.length})`);
  assert(trackCards[0].querySelector('.card-name').textContent === 'Track One', 'track numbering prefix stripped in the rendered title');
  assert(!doc.querySelector('#libGrid').classList.contains('track-list-mode'), 'track view uses the same auto-fill card grid as artists/eras, not the old list layout');
  assert(/MP3/.test(trackCards[0].querySelector('.card-sub').textContent), 'track card sub-line shows the file format');
  assert(/B$|KB$|MB$/.test(trackCards[0].querySelector('.card-sub').textContent.trim()), 'track card sub-line shows the file size');

  // ---------------- playback ----------------
  trackCards[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  assert(doc.querySelector('#player').hidden === false, 'player bar appears after picking a track');
  assert(doc.querySelector('#playerTitle').textContent === 'Track One', 'player shows the track title');
  assert(doc.querySelector('#audio').src.startsWith('blob:'), 'audio src is a blob: URL built from the real local file');

  // ---------------- share (upload to gofile.io) ----------------
  doc.querySelector('#btnShareTrack').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#modalHost').hidden === false, 'clicking Share opens the share modal');
  assert(doc.querySelector('#shareUploadStatus').textContent.includes('Uploading'), 'share modal shows an uploading state first');
  await new Promise((r) => setTimeout(r, 30));
  assert(doc.querySelector('#shareLinkInput')?.value === 'https://gofile.io/d/fake123', 'share modal shows the resulting gofile link once the (faked) upload resolves');
  doc.querySelector('#btnCopyShareLink').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#btnCopyShareLink').textContent === 'Copied!', 'copy button confirms the copy');
  doc.querySelector('#closeShareModal').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#modalHost').hidden === true, 'closing the share modal works');

  // ---------------- fullscreen player ----------------
  doc.querySelector('#playerTrackClick').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#fullscreenPlayer').hidden === false, 'clicking the player bar opens the fullscreen "now playing" view');
  assert(doc.querySelector('#fsTitle').textContent === 'Track One', 'fullscreen view shows the same track title');
  doc.querySelector('#closeFullscreen').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#fullscreenPlayer').hidden === true, 'closing the fullscreen view hides it again');

  // ---------------- playback failure surfaced ----------------
  const brokenCard = [...doc.querySelectorAll('#libGrid .card')].find((c) => c.querySelector('.card-name').textContent === 'Corrupted');
  brokenCard.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  assert(doc.querySelector('#playerTitle').textContent.includes("Couldn't play"), 'a rejected play() shows an error in the player instead of silently sitting on the pause icon');

  // ---------------- per-track embedded cover art (no folder cover.jpg) ----------------
  doc.querySelector('[data-view="library"]').dispatchEvent(new window.Event('click', { bubbles: true })); // resets Library back to the artist root
  await new Promise((r) => setTimeout(r, 20));
  const sableAgain = [...doc.querySelectorAll('#libGrid .card')].find((c) => c.querySelector('.card-name').textContent === 'Sable Rae');
  sableAgain.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const noCoverEraCard = [...doc.querySelectorAll('#libGrid .card')].find((c) => c.querySelector('.card-name').textContent === 'No Cover Folder');
  noCoverEraCard.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const noCoverTrackCards = doc.querySelectorAll('#libGrid .card');
  assert(noCoverTrackCards.length === 2, `No Cover Folder shows both tracks (got ${noCoverTrackCards.length})`);
  await new Promise((r) => setTimeout(r, 60)); // let the async per-track cover resolution finish
  const redImg = noCoverTrackCards[0].querySelector('.card-thumb img');
  const blueImg = noCoverTrackCards[1].querySelector('.card-thumb img');
  assert(!!redImg && !!blueImg, 'both tracks in a folder with no cover.jpg still resolved their own embedded cover art');
  assert(!!redImg && !!blueImg && redImg.src !== blueImg.src, "each track's embedded cover is genuinely its own, not one file's art reused for the whole folder (the original bug)");

  // ---------------- deeply nested folders (extra organizational level) ----------------
  doc.querySelector('[data-view="library"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const sofaygoCard = [...doc.querySelectorAll('#libGrid .card')].find((c) => c.querySelector('.card-name').textContent === 'SoFaygo');
  assert(!!sofaygoCard, 'SoFaygo (artist with an extra Sessions/Projects folder level) still shows up at the library root');
  sofaygoCard.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const sofaygoEraCards = doc.querySelectorAll('#libGrid .card');
  const sofaygoEraNames = [...sofaygoEraCards].map((c) => c.querySelector('.card-name').textContent);
  assert(sofaygoEraCards.length === 3, `each real session/project folder becomes its own era — 3 total, not 2 empty "Sessions"/"Projects" folders (got ${sofaygoEraCards.length}: ${sofaygoEraNames.join(', ')})`);
  assert(!sofaygoEraNames.includes('Sessions') && !sofaygoEraNames.includes('Projects'), 'the purely organizational "Sessions"/"Projects" folders do NOT themselves become (empty) eras');
  assert(sofaygoEraNames.includes('Session 1') && sofaygoEraNames.includes('Session 2') && sofaygoEraNames.includes('Project A'), 'each session/project folder becomes its own era, named after that folder, regardless of nesting depth');
  const session2Card = [...sofaygoEraCards].find((c) => c.querySelector('.card-name').textContent === 'Session 2');
  session2Card.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const session2TrackCards = doc.querySelectorAll('#libGrid .card');
  assert(session2TrackCards.length === 2, `a session folder with multiple takes gets all of them, not just the first (got ${session2TrackCards.length})`);

  // ---------------- Radio: shuffle all ----------------
  doc.querySelector('[data-view="radio"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#view-radio').classList.contains('active'), 'switched to Radio view');
  const stationCards = doc.querySelectorAll('#radioGrid .card');
  assert(stationCards.length === 3, `Radio shows one "station" card per artist (got ${stationCards.length})`);

  doc.querySelector('#btnShuffleAll').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  assert(doc.querySelector('#nowPlaying').hidden === false, 'Shuffle All shows the now-playing/queue panel');
  assert(doc.querySelector('#nowPlayingStation').textContent === 'Shuffle All', 'now-playing panel labels the station "Shuffle All"');
  assert(doc.querySelector('#player').hidden === false, 'Shuffle All actually starts playback');
  const queueRows = doc.querySelectorAll('#queueList .queue-row');
  assert(queueRows.length === 10, `queue list shows all 10 tracks in the shuffled radio queue (got ${queueRows.length})`);

  // ---------------- Playlists: create / add / play / remove / delete ----------------
  doc.querySelector('[data-view="playlists"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#playlistsEmptyHint').hidden === false, 'no playlists yet — empty hint shows');

  doc.querySelector('#btnCreatePlaylist').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#modalHost').hidden === false, 'Create Playlist opens the modal');
  doc.querySelector('#mplName').value = 'Late Night Loop';
  doc.querySelector('#mplCreate').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#modalHost').hidden === true, 'modal closes after creating the playlist');
  assert(doc.querySelector('#playlistDetail').hidden === false, 'creating a playlist opens its detail view');
  assert(doc.querySelector('#plName').textContent === 'Late Night Loop', 'the new playlist shows the entered name');

  // Add a track from the library via the cascading Artist -> Era -> Track pickers.
  const artistSel = doc.querySelector('#plAddArtist');
  const sableOption = [...artistSel.options].find((o) => o.textContent === 'Sable Rae');
  artistSel.value = sableOption.value;
  artistSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  const eraSel = doc.querySelector('#plAddEra');
  eraSel.value = [...eraSel.options].find((o) => o.textContent === 'Neon Static').value;
  eraSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  const trackSel = doc.querySelector('#plAddTrack');
  trackSel.value = [...trackSel.options].find((o) => o.textContent === 'Track Two').value;
  trackSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.querySelector('#btnAddTrackToPlaylist').dispatchEvent(new window.Event('click', { bubbles: true }));
  const plRows = doc.querySelectorAll('#plTrackList .track-row');
  assert(plRows.length === 1 && plRows[0].querySelector('.tr-title').textContent === 'Track Two', 'the picked track was added to the playlist');

  doc.querySelector('#btnPlayPlaylist').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  assert(doc.querySelector('#playerTitle').textContent === 'Track Two', 'Play on a playlist starts playing its (only) track');

  // Playlist persists across a reload (localStorage), re-resolved against the catalog.
  const dom2 = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: dom.window.location.href });
  dom2.window.localStorage.setItem('vault-mobile-playlists', window.localStorage.getItem('vault-mobile-playlists'));
  dom2.window.localStorage.setItem('vault-mobile-identity', window.localStorage.getItem('vault-mobile-identity'));
  const window2 = dom2.window;
  window2.Blob = Blob; window2.File = File;
  window2.URL.createObjectURL = (obj) => global.URL.createObjectURL(obj);
  window2.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window2.HTMLMediaElement.prototype.pause = () => {};
  installFakeIndexedDB(window2);
  window2.showDirectoryPicker = async () => fakeRoot;
  window2.eval(fs.readFileSync(path.join(ROOT, 'local-library.js'), 'utf8'));
  window2.eval(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'));
  await new Promise((r) => setTimeout(r, 20));
  const doc2 = window2.document;
  doc2.querySelector('#btnPickFolder').dispatchEvent(new window2.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  doc2.querySelector('[data-view="playlists"]').dispatchEvent(new window2.Event('click', { bubbles: true }));
  const persistedCards = doc2.querySelectorAll('#playlistsGrid .card');
  assert(persistedCards.length === 1 && persistedCards[0].querySelector('.card-name').textContent === 'Late Night Loop', 'the playlist survives a fresh page load via localStorage, with its track re-resolved against the catalog');

  // Remove the track, then delete the playlist (back on the original window).
  const removeBtn = doc.querySelector('#plTrackList .tr-remove');
  removeBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelectorAll('#plTrackList .track-row').length === 0, 'removing the track empties the playlist track list');
  doc.querySelector('#btnDeletePlaylist').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#playlistsBrowse').hidden === false, 'deleting the playlist returns to the playlists browse view');
  assert(doc.querySelectorAll('#playlistsGrid .card').length === 0, 'the deleted playlist no longer appears in the grid');

  // ---------------- search ----------------
  doc.querySelector('[data-view="search"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  doc.querySelector('#globalSearch').value = 'Alone';
  doc.querySelector('#globalSearch').dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 260));
  assert(doc.querySelector('#searchResults').innerHTML.includes('Alone'), 'search finds a track by title across the whole catalog');

  // ---------------- Settings (accent color + playback prefs) ----------------
  doc.querySelector('[data-view="settings"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#view-settings').classList.contains('active'), 'clicking the Settings nav item opens the Settings view');
  const settingsSwatches = doc.querySelectorAll('#settingsSwatches .swatch');
  assert(settingsSwatches.length === 5, `Settings shows 5 accent swatches (got ${settingsSwatches.length})`);
  assert(doc.querySelector('#toggleAutoplay').checked === true, 'Autoplay toggle reflects the default-on setting');

  const greenSwatch = doc.querySelector('.swatch[data-color="#2ea043"]');
  greenSwatch.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.documentElement.style.getPropertyValue('--accent').trim() === '#2ea043', 'picking a swatch updates the --accent CSS var immediately');
  assert(JSON.parse(window.localStorage.getItem('vault-mobile-settings')).accentColor === '#2ea043', 'accent color choice is persisted to localStorage');

  doc.querySelector('#toggleAutoplay').checked = false;
  doc.querySelector('#toggleAutoplay').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert(JSON.parse(window.localStorage.getItem('vault-mobile-settings')).autoplayNext === false, 'turning off Autoplay is persisted to localStorage');

  doc.querySelector('#defaultVolumeSlider').value = '0.35';
  doc.querySelector('#defaultVolumeSlider').dispatchEvent(new window.Event('input', { bubbles: true }));
  assert(JSON.parse(window.localStorage.getItem('vault-mobile-settings')).defaultVolume === 0.35, 'default volume choice is persisted to localStorage');

  // ---------------- queue drawer ----------------
  doc.querySelector('#btnQueueToggle').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#queueDrawer').hidden === false, 'the queue toggle opens the Up Next drawer');
  doc.querySelector('#closeQueueDrawer').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(doc.querySelector('#queueDrawer').hidden === true, 'closing the drawer hides it');

  // ---------------------------------------------------------------------
  // Native backend (the compiled Android app on a real phone) — same fake
  // Capacitor/VaultLocalFiles contract as the Chromebook build's test,
  // verifying this UI's setup flow also drives the SAF-backed native path
  // (not just the browser File System Access path exercised above).
  // ---------------------------------------------------------------------
  function buildFakeNativeTree() {
    const enc = (str) => Buffer.from(str, 'utf8').toString('base64');
    return {
      'content://tree/root': { name: 'Phone Music', isDirectory: true, children: ['content://doc/artist1'] },
      'content://doc/artist1': { name: 'Sable Rae', isDirectory: true, children: ['content://doc/era1'] },
      'content://doc/era1': { name: 'Neon Static', isDirectory: true, children: ['content://doc/t1'] },
      'content://doc/t1': { name: '01 - Native Track.mp3', isDirectory: false, mimeType: 'audio/mpeg', base64: enc('fake-native-audio-bytes') },
    };
  }
  const nativeFs = buildFakeNativeTree();
  let nativeSavedFolder = null;
  // Records every readFile() call the JS side makes against the native SAF
  // plugin, so we can regression-test the perf fix: the ID3-tag scan during
  // the folder walk must pass a bounded maxBytes, while an actual playback
  // read must NOT (it needs the whole file). Before the fix, every call —
  // scan or playback — read the entire file, which is what made picking a
  // folder take forever (or appear to hang) on anything but a tiny library.
  const nativeReadFileCalls = [];
  const fakeVaultLocalFilesPlugin = {
    async pickFolder() {
      nativeSavedFolder = { uri: 'content://tree/root', name: nativeFs['content://tree/root'].name };
      return nativeSavedFolder;
    },
    async getSavedFolder() { return nativeSavedFolder || {}; },
    async listChildren({ uri }) {
      const node = nativeFs[uri];
      if (!node) throw new Error('not found');
      return { items: (node.children || []).map((childUri) => { const c = nativeFs[childUri]; return { name: c.name, isDirectory: c.isDirectory, uri: childUri }; }) };
    },
    async readFile({ uri, maxBytes }) {
      nativeReadFileCalls.push({ uri, maxBytes });
      const node = nativeFs[uri];
      if (!node) throw new Error('not found');
      return { base64: node.base64, mimeType: node.mimeType };
    },
  };

  const dom3 = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://vault.example/index.html' });
  const window3 = dom3.window;
  window3.Blob = Blob; window3.File = File;
  window3.URL.createObjectURL = (obj) => global.URL.createObjectURL(obj);
  window3.URL.revokeObjectURL = (u) => global.URL.revokeObjectURL(u);
  window3.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window3.HTMLMediaElement.prototype.pause = () => {};
  window3.Capacitor = { isNativePlatform: () => true, Plugins: { VaultLocalFiles: fakeVaultLocalFilesPlugin } };
  window3.eval(fs.readFileSync(path.join(ROOT, 'local-library.js'), 'utf8'));
  window3.eval(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'));
  await new Promise((r) => setTimeout(r, 20));
  const doc3 = window3.document;

  assert(doc3.querySelector('#loginScreen').hidden === false, 'native app: login screen shows first here too');
  doc3.querySelector('.role-btn[data-role="member"]').dispatchEvent(new window3.Event('click', { bubbles: true }));
  doc3.querySelector('#loginName').value = 'PhoneUser';
  doc3.querySelector('#btnEnterVault').dispatchEvent(new window3.Event('click', { bubbles: true }));
  assert(doc3.querySelector('#loginScreen').hidden === true, 'native app: login completes before folder setup');

  doc3.querySelector('#btnPickFolder').dispatchEvent(new window3.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  assert(doc3.querySelector('#appShell').hidden === false, 'native app: picking a folder via the SAF plugin loads the library');
  assert(doc3.querySelector('#libraryName').textContent === 'Phone Music', 'native app: topbar shows the SAF-picked folder name');
  const nativeArtistCards = doc3.querySelectorAll('#libGrid .card');
  assert(nativeArtistCards.length === 1 && nativeArtistCards[0].querySelector('.card-name').textContent === 'Sable Rae', 'native app: artist walked via listChildren renders in the tab-bar UI too');

  nativeArtistCards[0].dispatchEvent(new window3.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  doc3.querySelector('#libGrid .card').dispatchEvent(new window3.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const nativeTrackCard = doc3.querySelector('#libGrid .card');
  nativeTrackCard.dispatchEvent(new window3.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  assert(doc3.querySelector('#audio').src.startsWith('blob:'), "native app: readFile()'s base64 payload gets turned into a real playable blob: URL through the new UI");

  // ---------------- bounded ID3-scan read (perf fix regression) ----------------
  const scanCall = nativeReadFileCalls.find((c) => c.uri === 'content://doc/t1' && c.maxBytes === 3 * 1024 * 1024);
  assert(!!scanCall, 'native app: the ID3-tag scan during the folder walk requests a bounded (3MB) read, not the whole file');
  const playbackCall = nativeReadFileCalls.find((c) => c.uri === 'content://doc/t1' && c.maxBytes === undefined);
  assert(!!playbackCall, 'native app: the actual playback read requests the full file with no maxBytes cap');

  if (errors.length) {
    console.error(`\n${errors.length} uncaught error(s):`);
    errors.forEach((e) => console.error(' -', (e && e.stack) || e));
    failures += errors.length;
  }
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Harness crashed:', e); process.exit(1); });
