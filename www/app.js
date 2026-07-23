// ---------------------------------------------------------------------------
// Vault — phone build. Same local-folder reading/playback core and feature
// set as the Chromebook build (Home, Library, Radio, Playlists, Search,
// Settings) — this file is intentionally near-identical to that build's
// app.js, since none of the actual app logic depends on screen size. The
// only real difference from the Chromebook build is navigation chrome: a
// bottom tab bar (#tabbar / .tab-item) instead of a sidebar, since this
// runs full-screen on a phone rather than in a resizable windowed app with
// a mouse and keyboard.
//
// What's deliberately NOT here, and why: no Discord presence, no admin
// panel, no member requests — those need either a real backend or a
// desktop-only OS integration this sandboxed Android WebView doesn't have.
// There IS a login screen (name + Admin/Member role, matching desktop's),
// but it's purely a device-local identity — no backend to check the role
// against, so it's really just "what do I call myself" plus an admin-code
// gate for symmetry with desktop. Nothing in this build is currently
// admin-only; the role exists mainly so the greeting/identity feels the
// same as the other builds and is ready for real admin-only mobile
// features later.
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}
function shuffleCopy(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const PLAYLISTS_KEY = 'vault-mobile-playlists';
const SETTINGS_KEY = 'vault-mobile-settings';
const IDENTITY_KEY = 'vault-mobile-identity';
const DEFAULT_SETTINGS = { accentColor: '#e0223a', autoplayNext: true, defaultVolume: 0.8 };
// Same default as the desktop app, so one community can share a single
// code across platforms. There's no Settings UI to change it here yet
// (no admin-only feature depends on it today) — that'd be a follow-up if
// this build grows real admin-only functionality.
const ADMIN_CODE = 'THEVAULTISAWESOME!';

const state = {
  me: null, // { username, role } — device-local identity, see loginScreen
  artists: [], eras: [], tracks: [], // full catalog, flat, built from one folder walk
  libLevel: 'artists', libArtist: null, libEra: null,
  currentTracks: [], currentTrackIndex: -1,
  playContextLabel: '',
  rootNode: null,
  playlists: [],
  currentPlaylistId: null,
  settings: { ...DEFAULT_SETTINGS },
};
let currentTrack = null;
let currentObjectUrl = null; // revoked before creating the next one, so we don't leak blob: URLs
const audio = $('#audio');

// =========================================================================
// Settings (accent color + playback prefs, localStorage-persisted — same
// pattern as playlists, since this build has no login/backend to store
// per-user settings against)
// =========================================================================
function loadSettingsFromStorage() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    state.settings = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    state.settings = { ...DEFAULT_SETTINGS };
  }
}
function saveSettingsToStorage() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch { /* storage full/unavailable — settings still work for this session */ }
}
function applyAccent(color, persist) {
  document.documentElement.style.setProperty('--accent', color);
  document.querySelectorAll('#settingsSwatches .swatch').forEach((s) => s.classList.toggle('selected', s.dataset.color === color));
  if (persist) {
    state.settings.accentColor = color;
    saveSettingsToStorage();
  }
}
function loadSettingsView() {
  applyAccent(state.settings.accentColor, false);
  $('#toggleAutoplay').checked = state.settings.autoplayNext !== false;
  $('#defaultVolumeSlider').value = String(state.settings.defaultVolume ?? 0.8);
}
document.querySelectorAll('#settingsSwatches .swatch').forEach((btn) => {
  btn.addEventListener('click', () => applyAccent(btn.dataset.color, true));
});
$('#toggleAutoplay').addEventListener('change', (e) => {
  state.settings.autoplayNext = e.target.checked;
  saveSettingsToStorage();
});
$('#defaultVolumeSlider').addEventListener('input', (e) => {
  state.settings.defaultVolume = Number(e.target.value);
  saveSettingsToStorage();
});

// =========================================================================
// Login / identity (device-local — see the comment at the top of this file)
// =========================================================================
let selectedRole = 'admin';
function loadIdentityFromStorage() {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveIdentityToStorage(identity) {
  try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity)); } catch { /* ignore */ }
}
function updateAdminCodeVisibility() {
  $('#adminCodeRow').style.display = selectedRole === 'admin' ? '' : 'none';
}
document.querySelectorAll('#roleToggle .role-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedRole = btn.dataset.role;
    document.querySelectorAll('#roleToggle .role-btn').forEach((b) => b.classList.toggle('active', b === btn));
    updateAdminCodeVisibility();
    $('#loginError').hidden = true;
  });
});
$('#btnEnterVault').addEventListener('click', () => {
  const name = $('#loginName').value.trim() || (selectedRole === 'admin' ? 'You' : 'Guest');
  const code = $('#loginAdminCode').value;
  if (selectedRole === 'admin' && code !== ADMIN_CODE) {
    $('#loginError').hidden = false;
    $('#loginError').textContent = 'Incorrect admin code.';
    return;
  }
  state.me = { username: name, role: selectedRole };
  saveIdentityToStorage(state.me);
  $('#loginError').hidden = true;
  $('#loginAdminCode').value = '';
  $('#loginScreen').hidden = true;
  continueBootAfterLogin();
});
$('#btnSwitchIdentity').addEventListener('click', () => {
  $('#appShell').hidden = true;
  $('#setupScreen').hidden = true;
  $('#loginScreen').hidden = false;
});
function updateIdentityDisplays() {
  if (!state.me) return;
  const label = `${state.me.username} · ${state.me.role}`;
  const el = $('#settingsIdentityDisplay');
  if (el) el.textContent = label;
}

// =========================================================================
// Setup / folder picking
// =========================================================================
async function boot() {
  loadSettingsFromStorage();
  applyAccent(state.settings.accentColor, false);
  audio.volume = state.settings.defaultVolume ?? 0.8;
  $('#volume').value = String(audio.volume);
  loadPlaylistsFromStorage();

  const identity = loadIdentityFromStorage();
  if (!identity) {
    $('#loginScreen').hidden = false;
    return; // continueBootAfterLogin() picks up once #btnEnterVault is clicked
  }
  state.me = identity;
  await continueBootAfterLogin();
}

async function continueBootAfterLogin() {
  updateIdentityDisplays();
  if (!VaultLocalLibrary.isSupported()) {
    $('#setupScreen').hidden = false;
    $('#btnPickFolder').hidden = true;
    $('#setupUnsupported').hidden = false;
    return;
  }
  $('#setupScreen').hidden = false;
  const saved = await VaultLocalLibrary.loadSavedHandle();
  if (!saved) return;
  if (VaultLocalLibrary.isNative()) {
    // Android's SAF-persisted permission survives an app restart without
    // needing a fresh user gesture, so the app reconnects fully
    // automatically — matches how the desktop app remembers your folder.
    await connectToNode(saved);
    return;
  }
  $('#btnPickFolder').hidden = true;
  $('#btnReconnectFolder').hidden = false;
  state.pendingSavedHandle = saved;
}

async function connectToNode(node) {
  $('#setupScreen').hidden = true;
  $('#appShell').hidden = false;
  $('#libLoadingHint').hidden = false;
  $('#libEmptyHint').hidden = true;
  try {
    $('#libraryName').textContent = node.name || 'My Library';
    state.rootNode = node;
    await loadCatalog(node);
    if (node.kind === 'browser') await VaultLocalLibrary.saveHandle(node.handle);
  } catch (err) {
    $('#libLoadingHint').hidden = true;
    $('#appShell').hidden = true;
    $('#setupScreen').hidden = false;
    $('#setupError').hidden = false;
    $('#setupError').textContent = err?.message || 'Could not read that folder.';
    return;
  }
  $('#libLoadingHint').hidden = true;
  loadHome();
  loadLibraryArtists();
  renderRadioGrid();
  populatePlaylistPickerArtists();
}

$('#btnPickFolder').addEventListener('click', async () => {
  $('#setupError').hidden = true;
  try {
    const node = await VaultLocalLibrary.pickFolder();
    await connectToNode(node);
  } catch (err) {
    if (err?.name === 'AbortError') return; // user cancelled the picker — not an error
    $('#setupError').hidden = false;
    $('#setupError').textContent = err?.message || 'Could not access that folder.';
  }
});
$('#btnReconnectFolder').addEventListener('click', async () => {
  $('#setupError').hidden = true;
  const saved = state.pendingSavedHandle;
  if (!saved) return;
  try {
    if ((await saved.queryPermission({ mode: 'read' })) !== 'granted') {
      const perm = await saved.requestPermission({ mode: 'read' });
      if (perm !== 'granted') throw new Error('Permission to read that folder was not granted.');
    }
    await connectToNode({ kind: 'browser', handle: saved, name: saved.name });
  } catch (err) {
    $('#setupError').hidden = false;
    $('#setupError').textContent = err?.message || 'Could not reconnect to that folder.';
    $('#btnPickFolder').hidden = false;
  }
});
$('#btnChangeFolder').addEventListener('click', async () => {
  try {
    const node = await VaultLocalLibrary.pickFolder();
    await connectToNode(node);
  } catch (err) {
    if (err?.name !== 'AbortError') console.error(err);
  }
});

async function loadCatalog(rootNode) {
  state.artists = []; state.eras = []; state.tracks = [];
  let nextId = 1;
  await VaultLocalLibrary.walkLocalLibrary(rootNode, {
    onArtist: ({ name, coverNode }) => {
      const a = { id: `a${nextId++}`, name, coverNode, coverUrl: null, trackCount: 0 };
      state.artists.push(a);
      return a;
    },
    onEra: ({ artistRef, name, coverNode }) => {
      const e = { id: `e${nextId++}`, artistId: artistRef.id, name, coverNode: coverNode || artistRef.coverNode, coverUrl: null, trackCount: 0 };
      state.eras.push(e);
      return e;
    },
    onTrack: ({ eraRef, title, node, format, coverNode, sizeBytes }) => {
      const era = state.eras.find((x) => x.id === eraRef.id);
      const artist = state.artists.find((x) => x.id === era.artistId);
      era.trackCount++; artist.trackCount++;
      state.tracks.push({
        id: `t${nextId++}`, eraId: era.id, artistId: artist.id, artistName: artist.name, eraName: era.name,
        // A track's own embedded cover wins; otherwise fall back to the
        // era's cover (folder cover.jpg or the artist's) — same priority
        // order as the desktop app.
        title, node, coverNode: coverNode || era.coverNode, format, sizeBytes: sizeBytes ?? null,
      });
    },
  });
}

async function resolveCoverUrl(item) {
  if (item.coverUrl) return item.coverUrl;
  if (!item.coverNode) return null;
  item.coverUrl = await VaultLocalLibrary.coverNodeToUrl(item.coverNode);
  return item.coverUrl;
}

// =========================================================================
// Bottom tab bar navigation
// =========================================================================
document.querySelectorAll('.tab-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    switchView(btn.dataset.view);
    // Clicking a nav item (as opposed to drilling in from within a view)
    // resets that section back to its root, same as clicking a Home tile —
    // otherwise Playlists in particular would show a stale/empty grid since
    // nothing else re-renders it on a plain view switch.
    if (btn.dataset.view === 'library') loadLibraryArtists();
    if (btn.dataset.view === 'playlists') showPlaylistsBrowse();
    if (btn.dataset.view === 'settings') loadSettingsView();
  });
});
function switchView(name) {
  document.querySelectorAll('.tab-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
}

// =========================================================================
// Home / dashboard
// =========================================================================
const HOME_TILES = [
  { view: 'library', color: '#2f81f7', icon: '<svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="8"/><circle cx="11" cy="11" r="2.4"/></svg>', title: 'Library', sub: () => `${state.artists.length} artist${state.artists.length === 1 ? '' : 's'} • ${state.tracks.length} track${state.tracks.length === 1 ? '' : 's'}`, go: () => { switchView('library'); loadLibraryArtists(); } },
  { view: 'radio', color: '#e0223a', icon: '<svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="11" cy="14" r="1.6" fill="currentColor" stroke="none"/><path d="M7.5 14a3.5 3.5 0 0 1 7 0"/><path d="M4.8 14a6.2 6.2 0 0 1 12.4 0"/><path d="M11 8V3"/><path d="M8.5 3h5"/></svg>', title: 'Radio', sub: () => 'Shuffle your whole library', go: () => switchView('radio') },
  { view: 'playlists', color: '#a371f7', icon: '<svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 6h11"/><path d="M4 11h11"/><path d="M4 16h6"/><circle cx="17" cy="16" r="2.2"/><path d="M19.2 16V6l-2.2 1"/></svg>', title: 'Playlists', sub: () => `${state.playlists.length} playlist${state.playlists.length === 1 ? '' : 's'}`, go: () => { switchView('playlists'); showPlaylistsBrowse(); } },
  { view: 'search', color: '#f0883e', icon: '<svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10" cy="10" r="6.2"/><path d="m19 19-4.5-4.5"/></svg>', title: 'Search', sub: () => 'Find anything instantly', go: () => switchView('search') },
];
function loadHome() {
  $('#homeGreeting').textContent = state.me?.username || 'Vault';
  const wrap = $('#dashboardTiles'); wrap.innerHTML = '';
  for (const t of HOME_TILES) {
    const tile = el('div', 'dashboard-tile');
    tile.style.setProperty('--tile-c', t.color);
    tile.appendChild(el('div', 'dt-icon', t.icon));
    tile.appendChild(el('div', 'dt-title', t.title));
    tile.appendChild(el('div', 'dt-sub', t.sub()));
    tile.addEventListener('click', t.go);
    wrap.appendChild(tile);
  }
}

// =========================================================================
// Library (Artist -> Era -> Track)
// =========================================================================
function loadLibraryArtists() {
  state.libLevel = 'artists';
  $('#libTitle').textContent = 'Library';
  renderLibCrumbs([{ label: 'Library', go: loadLibraryArtists }]);
  renderArtistGrid(state.artists);
}
function openArtist(artist) {
  state.libLevel = 'eras'; state.libArtist = artist;
  const eras = state.eras.filter((e) => e.artistId === artist.id);
  $('#libTitle').textContent = artist.name;
  renderLibCrumbs([{ label: 'Library', go: loadLibraryArtists }, { label: artist.name, go: () => openArtist(artist) }]);
  renderEraGrid(eras);
}
function openEra(era, artist) {
  state.libLevel = 'tracks'; state.libEra = era;
  const tracks = state.tracks.filter((t) => t.eraId === era.id);
  $('#libTitle').textContent = era.name;
  renderLibCrumbs([
    { label: 'Library', go: loadLibraryArtists },
    { label: artist.name, go: () => openArtist(artist) },
    { label: era.name, go: () => openEra(era, artist) },
  ]);
  renderTrackRows(tracks, { label: `${era.name} — ${artist.name}` });
}
function renderLibCrumbs(trail) {
  const wrap = $('#libCrumbs'); wrap.innerHTML = '';
  trail.forEach((c, i) => {
    const span = el('span', null, escapeHtml(c.label));
    span.addEventListener('click', c.go);
    wrap.appendChild(span);
    if (i < trail.length - 1) wrap.appendChild(el('span', 'sep', '/'));
  });
}
function renderArtistGrid(artists, filterText = '') {
  const grid = $('#libGrid'); grid.classList.remove('track-list-mode'); grid.innerHTML = '';
  const f = filterText.trim().toLowerCase();
  const visible = artists.filter((a) => a.name.toLowerCase().includes(f));
  $('#libEmptyHint').hidden = visible.length > 0;
  for (const artist of visible) {
    const card = el('div', 'card');
    const thumb = el('div', 'card-thumb', '&#127908;');
    card.appendChild(thumb);
    card.appendChild(el('div', 'card-name', escapeHtml(artist.name)));
    card.appendChild(el('div', 'card-sub', `${artist.trackCount} track${artist.trackCount === 1 ? '' : 's'}`));
    card.addEventListener('click', () => openArtist(artist));
    grid.appendChild(card);
    resolveCoverUrl(artist).then((url) => {
      if (!url) return;
      const img = el('img'); img.src = url;
      thumb.innerHTML = ''; thumb.appendChild(img);
    });
  }
}
function renderEraGrid(eras, filterText = '') {
  const grid = $('#libGrid'); grid.classList.remove('track-list-mode'); grid.innerHTML = '';
  const f = filterText.trim().toLowerCase();
  const visible = eras.filter((e) => e.name.toLowerCase().includes(f));
  $('#libEmptyHint').hidden = visible.length > 0;
  for (const era of visible) {
    const card = el('div', 'card');
    const thumb = el('div', 'card-thumb', '&#128191;');
    card.appendChild(thumb);
    card.appendChild(el('div', 'card-name', escapeHtml(era.name)));
    card.appendChild(el('div', 'card-sub', `${era.trackCount} track${era.trackCount === 1 ? '' : 's'}`));
    card.addEventListener('click', () => openEra(era, state.libArtist));
    grid.appendChild(card);
    resolveCoverUrl(era).then((url) => {
      if (!url) return;
      const img = el('img'); img.src = url;
      thumb.innerHTML = ''; thumb.appendChild(img);
    });
  }
}
function renderTrackRows(tracks, playContext, filterText = '') {
  // Square-card grid, one card per track with its own cover art and file
  // size — matches the desktop app's track view (a Windows-Explorer-style
  // icon grid) instead of the old flat list of rows.
  const grid = $('#libGrid'); grid.classList.remove('track-list-mode'); grid.innerHTML = '';
  const f = filterText.trim().toLowerCase();
  const visible = tracks.filter((t) => t.title.toLowerCase().includes(f));
  $('#libEmptyHint').hidden = visible.length > 0;
  visible.forEach((track) => {
    const card = el('div', 'card');
    card.dataset.id = track.id;
    const thumb = el('div', 'card-thumb', '&#127908;');
    card.appendChild(thumb);
    card.appendChild(el('div', 'card-name', escapeHtml(track.title)));
    const sizeLabel = track.sizeBytes != null ? formatBytes(track.sizeBytes) : '';
    card.appendChild(el('div', 'card-sub', [track.format, sizeLabel].filter(Boolean).join(' · ')));
    card.addEventListener('click', () => {
      state.currentTracks = tracks;
      state.playContextLabel = playContext.label;
      playTrackByRef(track);
    });
    grid.appendChild(card);
    resolveCoverUrl(track).then((url) => {
      if (!url) return;
      const img = el('img'); img.src = url;
      thumb.innerHTML = ''; thumb.appendChild(img);
    });
  });
}
$('#libFilter').addEventListener('input', (e) => {
  const v = e.target.value;
  if (state.libLevel === 'artists') renderArtistGrid(state.artists, v);
  else if (state.libLevel === 'eras') renderEraGrid(state.eras.filter((x) => x.artistId === state.libArtist.id), v);
  else renderTrackRows(state.tracks.filter((x) => x.eraId === state.libEra.id), { label: state.playContextLabel || '' }, v);
});

// =========================================================================
// Radio — shuffle everything, or shuffle one artist ("station")
// =========================================================================
function renderRadioGrid() {
  const grid = $('#radioGrid'); grid.innerHTML = '';
  for (const artist of state.artists) {
    const card = el('div', 'card station-card');
    const thumb = el('div', 'card-thumb', '&#128225;');
    card.appendChild(thumb);
    card.appendChild(el('div', 'card-name', escapeHtml(artist.name)));
    card.appendChild(el('div', 'card-sub', `${artist.trackCount} track${artist.trackCount === 1 ? '' : 's'}`));
    card.addEventListener('click', () => {
      const tracks = state.tracks.filter((t) => t.artistId === artist.id);
      startRadio(tracks, artist.name);
    });
    grid.appendChild(card);
    resolveCoverUrl(artist).then((url) => {
      if (!url) return;
      const img = el('img'); img.src = url;
      thumb.innerHTML = ''; thumb.appendChild(img);
    });
  }
}
function startRadio(tracks, label) {
  if (!tracks.length) return;
  state.currentTracks = shuffleCopy(tracks);
  state.currentTrackIndex = -1;
  state.playContextLabel = label;
  $('#nowPlaying').hidden = false;
  $('#nowPlayingStation').textContent = label;
  renderQueueLists();
  playTrackByRef(state.currentTracks[0]);
}
$('#btnShuffleAll').addEventListener('click', () => startRadio(state.tracks, 'Shuffle All'));
$('#btnShuffleStation').addEventListener('click', () => {
  if (!state.currentTracks.length) return;
  const label = state.playContextLabel;
  state.currentTracks = shuffleCopy(state.currentTracks);
  state.playContextLabel = label;
  renderQueueLists();
  playTrackByRef(state.currentTracks[0]);
});
function renderQueueInto(container) {
  container.innerHTML = '';
  state.currentTracks.forEach((t, i) => {
    const row = el('div', `queue-row${i === state.currentTrackIndex ? ' active' : ''}`);
    row.appendChild(el('span', 'qi'));
    row.appendChild(el('span', 'qn', escapeHtml(t.title)));
    row.addEventListener('click', () => playTrackByRef(t));
    container.appendChild(row);
  });
}
function renderQueueLists() {
  renderQueueInto($('#queueList'));
  renderQueueInto($('#drawerQueueList'));
}
$('#btnQueueToggle').addEventListener('click', () => {
  renderQueueInto($('#drawerQueueList'));
  $('#queueDrawer').hidden = !$('#queueDrawer').hidden;
});
$('#closeQueueDrawer').addEventListener('click', () => { $('#queueDrawer').hidden = true; });

// =========================================================================
// Playlists (persisted to localStorage; tracks re-resolved against the
// current catalog by artist/era/title each time, so nothing breaks if a
// FileSystemFileHandle/content:// node can't itself survive a JSON round
// trip — only the lightweight identifying info does)
// =========================================================================
function loadPlaylistsFromStorage() {
  try {
    const raw = localStorage.getItem(PLAYLISTS_KEY);
    state.playlists = raw ? JSON.parse(raw) : [];
  } catch {
    state.playlists = [];
  }
}
function savePlaylistsToStorage() {
  try {
    localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(state.playlists));
  } catch { /* storage full/unavailable — playlist still works for this session */ }
}
function resolvePlaylistTracks(playlist) {
  const resolved = [];
  let missing = 0;
  for (const ref of playlist.tracks) {
    const match = state.tracks.find((t) => t.artistName === ref.artistName && t.eraName === ref.eraName && t.title === ref.title);
    if (match) resolved.push(match); else missing++;
  }
  return { resolved, missing };
}
function showPlaylistsBrowse() {
  state.currentPlaylistId = null;
  $('#playlistsBrowse').hidden = false;
  $('#playlistDetail').hidden = true;
  renderPlaylistsGrid();
}
function renderPlaylistsGrid() {
  const grid = $('#playlistsGrid'); grid.innerHTML = '';
  $('#playlistsEmptyHint').hidden = state.playlists.length > 0;
  for (const pl of state.playlists) {
    const { resolved } = resolvePlaylistTracks(pl);
    const card = el('div', 'card');
    card.appendChild(el('div', 'card-thumb', '&#127911;'));
    card.appendChild(el('div', 'card-name', escapeHtml(pl.name)));
    card.appendChild(el('div', 'card-sub', `${resolved.length} track${resolved.length === 1 ? '' : 's'}`));
    card.addEventListener('click', () => openPlaylist(pl.id));
    grid.appendChild(card);
  }
}
function openPlaylist(id) {
  const pl = state.playlists.find((p) => p.id === id);
  if (!pl) return;
  state.currentPlaylistId = id;
  $('#playlistsBrowse').hidden = true;
  $('#playlistDetail').hidden = false;
  $('#plName').textContent = pl.name;
  $('#plDesc').textContent = pl.desc || '';
  renderPlaylistDetail(pl);
  populatePlaylistPickerArtists();
}
function renderPlaylistDetail(pl) {
  const { resolved } = resolvePlaylistTracks(pl);
  const list = $('#plTrackList'); list.innerHTML = '';
  resolved.forEach((track, i) => {
    const row = el('div', 'track-row');
    row.appendChild(el('div', 'tr-thumb'));
    row.appendChild(el('div', 'tr-title', escapeHtml(track.title)));
    const removeBtn = el('button', 'tr-remove', '&#10005;');
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pl.tracks = pl.tracks.filter((r) => !(r.artistName === track.artistName && r.eraName === track.eraName && r.title === track.title));
      savePlaylistsToStorage();
      renderPlaylistDetail(pl);
    });
    row.appendChild(removeBtn);
    row.addEventListener('click', () => {
      state.currentTracks = resolved;
      state.playContextLabel = pl.name;
      playTrackByRef(track);
    });
    list.appendChild(row);
  });
}
$('#btnCreatePlaylist').addEventListener('click', () => {
  openModal(`
    <h2>New playlist</h2>
    <label>Name<input id="mplName" placeholder="e.g. Late Night Loop" /></label>
    <label>Description (optional)<input id="mplDesc" placeholder="" /></label>
    <div class="modal-actions">
      <button id="mplCancel" class="ghost-btn">Cancel</button>
      <button id="mplCreate" class="primary-btn">Create</button>
    </div>
  `);
  $('#mplCancel').addEventListener('click', closeModal);
  $('#mplCreate').addEventListener('click', () => {
    const name = $('#mplName').value.trim();
    if (!name) return;
    const pl = { id: `pl${Date.now()}`, name, desc: $('#mplDesc').value.trim(), tracks: [] };
    state.playlists.push(pl);
    savePlaylistsToStorage();
    closeModal();
    renderPlaylistsGrid();
    openPlaylist(pl.id);
  });
});
$('#btnDeletePlaylist').addEventListener('click', () => {
  state.playlists = state.playlists.filter((p) => p.id !== state.currentPlaylistId);
  savePlaylistsToStorage();
  showPlaylistsBrowse();
});
$('#btnBackToPlaylists').addEventListener('click', showPlaylistsBrowse);
$('#btnPlayPlaylist').addEventListener('click', () => {
  const pl = state.playlists.find((p) => p.id === state.currentPlaylistId);
  if (!pl) return;
  const { resolved } = resolvePlaylistTracks(pl);
  if (!resolved.length) return;
  state.currentTracks = resolved;
  state.playContextLabel = pl.name;
  playTrackByRef(resolved[0]);
});
function populatePlaylistPickerArtists() {
  const sel = $('#plAddArtist');
  sel.innerHTML = '<option value="">Artist…</option>';
  for (const a of state.artists) sel.appendChild(new Option(a.name, a.id));
  $('#plAddEra').innerHTML = '<option value="">Era…</option>';
  $('#plAddTrack').innerHTML = '<option value="">Track…</option>';
}
$('#plAddArtist').addEventListener('change', (e) => {
  const eraSel = $('#plAddEra'); eraSel.innerHTML = '<option value="">Era…</option>';
  $('#plAddTrack').innerHTML = '<option value="">Track…</option>';
  if (!e.target.value) return;
  state.eras.filter((era) => era.artistId === e.target.value).forEach((era) => eraSel.appendChild(new Option(era.name, era.id)));
});
$('#plAddEra').addEventListener('change', (e) => {
  const trackSel = $('#plAddTrack'); trackSel.innerHTML = '<option value="">Track…</option>';
  if (!e.target.value) return;
  state.tracks.filter((t) => t.eraId === e.target.value).forEach((t) => trackSel.appendChild(new Option(t.title, t.id)));
});
$('#btnAddTrackToPlaylist').addEventListener('click', () => {
  const trackId = $('#plAddTrack').value;
  if (!trackId) return;
  const track = state.tracks.find((t) => t.id === trackId);
  const pl = state.playlists.find((p) => p.id === state.currentPlaylistId);
  if (!track || !pl) return;
  const already = pl.tracks.some((r) => r.artistName === track.artistName && r.eraName === track.eraName && r.title === track.title);
  if (!already) pl.tracks.push({ artistName: track.artistName, eraName: track.eraName, title: track.title });
  savePlaylistsToStorage();
  renderPlaylistDetail(pl);
});

// =========================================================================
// Generic modal
// =========================================================================
function openModal(html) {
  $('#modalCard').innerHTML = html;
  $('#modalHost').hidden = false;
}
function closeModal() { $('#modalHost').hidden = true; }
$('#modalHost').addEventListener('click', (e) => { if (e.target.id === 'modalHost') closeModal(); });

// =========================================================================
// Search
// =========================================================================
let searchDebounce = null;
$('#globalSearch').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const q = e.target.value;
  searchDebounce = setTimeout(() => runSearch(q), 200);
});
function runSearch(q) {
  const box = $('#searchResults');
  const query = q.trim().toLowerCase();
  if (!query) { box.innerHTML = ''; return; }
  const artists = state.artists.filter((a) => a.name.toLowerCase().includes(query));
  const tracks = state.tracks.filter((t) => t.title.toLowerCase().includes(query));
  const sections = [];
  if (artists.length) sections.push(`<div class="section-eyebrow" style="margin-top:6px">ARTISTS</div><div class="grid">${artists.map((a) => cardHtml(a)).join('')}</div>`);
  if (tracks.length) sections.push(`<div class="section-eyebrow" style="margin-top:14px">TRACKS</div><div class="grid">${tracks.map((t) => cardHtml(t, true)).join('')}</div>`);
  box.innerHTML = sections.length ? sections.join('') : '<div class="empty-hint">No results.</div>';
  box.querySelectorAll('[data-kind]').forEach((node) => {
    node.addEventListener('click', () => {
      const id = node.dataset.id;
      if (node.dataset.kind === 'artist') {
        switchView('library');
        openArtist(state.artists.find((a) => a.id === id));
      } else {
        const t = state.tracks.find((x) => x.id === id);
        state.currentTracks = [t];
        state.playContextLabel = t.artistName;
        playTrackByRef(t);
      }
    });
  });
}
function cardHtml(item, isTrack) {
  const name = isTrack ? item.title : item.name;
  return `<div class="card" data-kind="${isTrack ? 'track' : 'artist'}" data-id="${item.id}">
    <div class="card-thumb">&#127908;</div>
    <div class="card-name">${escapeHtml(name)}</div>
    ${isTrack ? `<div class="card-sub">${escapeHtml(item.artistName)}</div>` : ''}
  </div>`;
}

// =========================================================================
// Player (footer bar + fullscreen "now playing" overlay share the same state)
// =========================================================================
function showPlaybackError(track, reason) {
  $('#playerTitle').textContent = `Couldn't play "${track.title}"`;
  $('#playerArtist').textContent = reason;
  setPlayIcon(false);
}
async function playTrackByRef(track) {
  currentTrack = track;
  state.currentTrackIndex = state.currentTracks.findIndex((t) => t.id === track.id);
  $('#player').hidden = false;
  $('#playerTitle').textContent = track.title;
  $('#playerArtist').textContent = track.artistName || state.playContextLabel || '';
  $('#fsTitle').textContent = track.title;
  $('#fsArtist').textContent = track.artistName || state.playContextLabel || '';
  $('#playerCover').src = '';
  $('#playerCover').style.opacity = '0.3';
  $('#fsCover').src = '';
  markPlayingRows();
  if (state.currentTracks.length > 1) renderQueueLists();

  let url;
  try {
    url = await VaultLocalLibrary.trackNodeToUrl(track.node);
  } catch (err) {
    if (currentTrack !== track) return;
    showPlaybackError(track, 'Could not read this file — it may have been moved or deleted.');
    return;
  }
  if (currentTrack !== track) { URL.revokeObjectURL(url); return; } // user picked another track while this one was loading

  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = url;
  audio.src = url;

  resolveCoverUrl(track).then((coverUrl) => {
    if (currentTrack !== track) return;
    $('#playerCover').src = coverUrl || '';
    $('#playerCover').style.opacity = coverUrl ? '1' : '0.3';
    $('#fsCover').src = coverUrl || '';
  });

  audio.play().then(() => {
    if (currentTrack === track) setPlayIcon(true);
  }).catch((err) => {
    if (currentTrack !== track) return;
    showPlaybackError(track, err?.name === 'NotSupportedError' ? 'Unsupported audio format.' : 'Playback failed.');
  });
}
function setPlayIcon(isPlaying) {
  $('#btnPlay').innerHTML = isPlaying ? '&#10074;&#10074;' : '&#9654;';
  $('#fsPlay').innerHTML = isPlaying ? '&#10074;&#10074;' : '&#9654;';
}
function markPlayingRows() {
  document.querySelectorAll('#libGrid .card[data-id], .track-row').forEach((r) => r.classList.toggle('playing', !!currentTrack && r.dataset.id === currentTrack.id));
}
function togglePlayPause() {
  if (!currentTrack) return;
  if (audio.paused) { audio.play(); setPlayIcon(true); } else { audio.pause(); setPlayIcon(false); }
}
$('#btnPlay').addEventListener('click', togglePlayPause);
$('#fsPlay').addEventListener('click', togglePlayPause);
function stepTrack(delta) {
  if (!state.currentTracks.length) return;
  let idx = state.currentTrackIndex + delta;
  if (idx < 0) idx = state.currentTracks.length - 1;
  if (idx >= state.currentTracks.length) idx = 0;
  playTrackByRef(state.currentTracks[idx]);
}
$('#btnNext').addEventListener('click', () => stepTrack(1));
$('#btnPrev').addEventListener('click', () => stepTrack(-1));
$('#fsNext').addEventListener('click', () => stepTrack(1));
$('#fsPrev').addEventListener('click', () => stepTrack(-1));
audio.addEventListener('ended', () => { if (state.settings.autoplayNext !== false) stepTrack(1); });

// -- share (uploads the currently playing track's audio file to gofile.io) --
// Runs entirely client-side in the WebView — no backend of any kind, same
// no-server philosophy as the rest of this build. Needs the device to have
// a real internet connection; gofile's guest upload API needs no account.
$('#btnShareTrack').addEventListener('click', () => shareCurrentTrack());
$('#fsShare')?.addEventListener('click', () => shareCurrentTrack());
async function uploadToGofile(blob, fileName) {
  const serverRes = await fetch('https://api.gofile.io/servers');
  if (!serverRes.ok) throw new Error(`gofile server lookup failed (HTTP ${serverRes.status})`);
  const serverJson = await serverRes.json();
  const server = serverJson?.data?.servers?.[0]?.name;
  if (!server) throw new Error('gofile did not return an upload server — its API may have changed.');

  const form = new FormData();
  // Re-wrap defensively: a Blob/File handed in from a different realm
  // (e.g. the native SAF plugin bridge) can fail FormData's Blob check even
  // though it's duck-type identical — cheap insurance for a music file.
  const safeBlob = blob instanceof Blob ? blob : new Blob([await blob.arrayBuffer()], { type: blob.type || 'application/octet-stream' });
  form.append('file', safeBlob, fileName);
  const uploadRes = await fetch(`https://${server}.gofile.io/contents/uploadfile`, { method: 'POST', body: form });
  if (!uploadRes.ok) throw new Error(`gofile upload failed (HTTP ${uploadRes.status})`);
  const uploadJson = await uploadRes.json();
  const link = uploadJson?.data?.downloadPage;
  if (!link) throw new Error('gofile did not return a share link — its API may have changed.');
  return link;
}
async function shareCurrentTrack() {
  if (!currentTrack) return;
  openModal(`
    <h2>Share "${escapeHtml(currentTrack.title)}"</h2>
    <p class="field-desc" id="shareUploadStatus" style="margin-bottom:14px">Uploading to gofile.io…</p>
    <div class="modal-actions">
      <button class="ghost-btn" id="closeShareModal">Close</button>
    </div>
  `);
  $('#closeShareModal').addEventListener('click', closeModal);
  const track = currentTrack;
  let link;
  try {
    const blob = await VaultLocalLibrary.trackNodeToBlob(track.node);
    link = await uploadToGofile(blob, track.title || 'track');
  } catch (err) {
    const statusEl = $('#shareUploadStatus');
    if (statusEl) statusEl.textContent = err?.message || 'Upload failed — check your internet connection and try again.';
    return;
  }
  const statusEl = $('#shareUploadStatus');
  if (!statusEl) return; // modal was closed before the upload finished
  statusEl.innerHTML = `Link ready:<div style="display:flex; gap:8px; margin-top:8px;">
    <input id="shareLinkInput" class="filter" style="margin-bottom:0; flex:1" value="${escapeHtml(link)}" readonly />
    <button class="ghost-btn" id="btnCopyShareLink">Copy</button>
  </div>`;
  $('#btnCopyShareLink').addEventListener('click', () => {
    $('#shareLinkInput').select();
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).catch(() => {});
    $('#btnCopyShareLink').textContent = 'Copied!';
  });
}
audio.addEventListener('error', () => {
  if (!currentTrack) return;
  const codeMap = { 1: 'Playback aborted.', 2: 'Network error while loading.', 3: "This file is corrupt or the format isn't supported.", 4: 'File not found or unreadable.' };
  showPlaybackError(currentTrack, codeMap[audio.error?.code] || 'Playback failed.');
});
audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  $('#seek').value = pct;
  $('#fsSeek').value = pct;
  $('#timeCur').textContent = formatTime(audio.currentTime);
  $('#timeDur').textContent = formatTime(audio.duration);
  $('#fsTimeCur').textContent = formatTime(audio.currentTime);
  $('#fsTimeDur').textContent = formatTime(audio.duration);
});
$('#seek').addEventListener('input', (e) => { if (audio.duration) audio.currentTime = (Number(e.target.value) / 100) * audio.duration; });
$('#fsSeek').addEventListener('input', (e) => { if (audio.duration) audio.currentTime = (Number(e.target.value) / 100) * audio.duration; });
$('#volume').addEventListener('input', (e) => { audio.volume = Number(e.target.value); });
// Initial audio.volume/#volume value is set from stored settings in boot(),
// which runs at the bottom of this file — nothing to default here.

$('#playerTrackClick').addEventListener('click', () => { if (currentTrack) $('#fullscreenPlayer').hidden = false; });
$('#closeFullscreen').addEventListener('click', () => { $('#fullscreenPlayer').hidden = true; });

boot();
