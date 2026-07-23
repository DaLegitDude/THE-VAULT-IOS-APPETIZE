// ---------------------------------------------------------------------------
// Vault Mobile — local-folder library (replaces the old Google Drive source)
// ---------------------------------------------------------------------------
// Reads a real folder on the device, laid out the same way as the desktop
// app: <root>/<Artist>/<Era>/<tracks>. Two backends, picked automatically:
//
//   - Browser backend: the File System Access API (window.showDirectoryPicker).
//     Supported by desktop Chrome/Edge AND by ChromeOS's own Chrome browser
//     (a Chromebook opened at the web app's URL) — this is what gives the
//     "works just like the Windows app" folder picker on a Chromebook.
//     NOT supported by Android's Chrome/WebView (including inside a compiled
//     Android app run via ARC++ on a Chromebook), which is a browser-platform
//     limitation, not something fixable from JS.
//
//   - Native backend: a small Capacitor plugin (VaultLocalFiles, see the
//     Android project's MainActivity/VaultLocalFilesPlugin.kt) that uses
//     Android's own Storage Access Framework folder picker. This is what
//     gives the compiled .apk itself real local-folder access, independent
//     of the browser-only File System Access API.
//
// Both backends expose the same shape (listChildren/readAsBlob/getPlayableUrl)
// so the Artist/Era/Track walk below only has to be written once.
// ---------------------------------------------------------------------------
(function (global) {
  // Kept in sync with the desktop app's AUDIO_EXT (main.js) — everything
  // Chromium's <audio> element can actually decode.
  const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.m4a', '.mp4', '.aac', '.ogg', '.oga', '.opus', '.weba', '.webm']);
  const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

  // How much of a file to actually read when the library walk is only
  // scanning for an embedded ID3 cover, not playing the track — an ID3v2
  // tag (and any embedded art in it) always sits at the very start of the
  // file, and real-world embedded covers are essentially never bigger than
  // this. Generous enough to virtually never truncate a real cover, tiny
  // enough that scanning a library of hundreds of songs stays fast instead
  // of reading every full audio file just to peek at its tag.
  const ID3_SCAN_MAX_BYTES = 3 * 1024 * 1024;

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i === -1 ? '' : name.slice(i).toLowerCase();
  }

  // ---------------- environment detection ----------------
  function isNative() {
    return !!(global.Capacitor && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform());
  }
  function nativePluginAvailable() {
    return !!(global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.VaultLocalFiles);
  }
  function browserSupported() {
    return typeof global.showDirectoryPicker === 'function';
  }
  function isSupported() {
    return isNative() ? nativePluginAvailable() : browserSupported();
  }

  // ---------------- browser backend (File System Access API) ----------------
  const BrowserBackend = {
    async pickFolder() {
      const handle = await global.showDirectoryPicker({ mode: 'read' });
      return { kind: 'browser', handle, name: handle.name };
    },
    async listChildren(node) {
      const out = [];
      for await (const [name, h] of node.handle.entries()) {
        out.push({ name, isDirectory: h.kind === 'directory', node: { kind: 'browser', handle: h } });
      }
      return out;
    },
    async readAsBlob(node, maxBytes) {
      const file = await node.handle.getFile(); // a File is already a Blob
      // .slice() on a File is lazy — it doesn't read anything until the
      // result is consumed, so this bound is nearly free here. Kept for
      // symmetry with NativeBackend, where the equivalent cap is the whole
      // point (see readFile()'s comment there).
      return maxBytes ? file.slice(0, maxBytes) : file;
    },
    async getPlayableUrl(node) {
      const file = await node.handle.getFile();
      return URL.createObjectURL(file);
    },
    async getSize(node) {
      // A File's .size is metadata the browser already has — this does not
      // read the file's actual bytes, same cost profile as the native
      // backend's DocumentFile.length() below.
      const file = await node.handle.getFile();
      return file.size;
    },
  };

  // ---------------- native backend (Capacitor SAF plugin) ----------------
  const NativeBackend = {
    async pickFolder() {
      const res = await global.Capacitor.Plugins.VaultLocalFiles.pickFolder();
      if (!res || !res.uri) throw new Error('No folder selected.');
      return { kind: 'native', uri: res.uri, name: res.name || 'Library' };
    },
    async listChildren(node) {
      const res = await global.Capacitor.Plugins.VaultLocalFiles.listChildren({ uri: node.uri });
      return (res.items || []).map((it) => ({
        name: it.name,
        isDirectory: !!it.isDirectory,
        node: { kind: 'native', uri: it.uri, size: typeof it.size === 'number' ? it.size : null },
      }));
    },
    async readAsBlob(node, maxBytes) {
      // maxBytes bounds how much the native side actually reads off disk
      // and bridges over as base64 — see readFile()'s comment in
      // VaultLocalFilesPlugin.java. Omit it (playback, Share) to get the
      // whole file; pass it (ID3 tag scanning during the library walk) to
      // avoid reading multi-MB audio files start-to-finish just to peek at
      // a few KB of tag data at the front.
      const args = { uri: node.uri };
      if (maxBytes) args.maxBytes = maxBytes;
      const res = await global.Capacitor.Plugins.VaultLocalFiles.readFile(args);
      const byteChars = atob(res.base64);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      return new Blob([bytes], { type: res.mimeType || 'application/octet-stream' });
    },
    async getPlayableUrl(node) {
      const blob = await NativeBackend.readAsBlob(node);
      return URL.createObjectURL(blob);
    },
    async getSize(node) {
      // Already came back from listChildren (DocumentFile.length(), no
      // content read) — nothing further to fetch here.
      return typeof node.size === 'number' ? node.size : 0;
    },
  };

  function backend() {
    return isNative() ? NativeBackend : BrowserBackend;
  }

  // ---------------- persistence ----------------
  // Browser: the FileSystemDirectoryHandle itself is structured-cloneable, so
  // IndexedDB can store it directly; re-requesting permission still needs a
  // user gesture (a click), which app.js handles with a "Reconnect" button.
  // Native: the SAF plugin persists the grant itself (takePersistableUriPermission)
  // and remembers the last-picked URI, so this is a no-op there.
  const DB_NAME = 'vault-local-library';
  const STORE = 'handles';
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = global.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function saveHandle(handle) {
    if (isNative()) return;
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, 'root');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function loadSavedHandle() {
    if (isNative()) {
      // Android's SAF persisted permission survives an app restart without
      // needing a fresh user gesture (unlike a browser's
      // FileSystemDirectoryHandle), so the native app can reconnect fully
      // automatically here rather than needing a "Reconnect" click.
      if (!nativePluginAvailable()) return null;
      try {
        const res = await global.Capacitor.Plugins.VaultLocalFiles.getSavedFolder();
        if (res && res.uri) return { kind: 'native', uri: res.uri, name: res.name || 'My Library' };
        return null;
      } catch {
        return null;
      }
    }
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get('root');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  // ---------------- ID3v2 APIC (embedded cover) extraction, MP3 only ----------------
  // A from-scratch, dependency-free reader for the ID3v2.3/2.4 header looking
  // for an APIC (attached picture) frame. This is the browser-side analog of
  // the desktop app's cover-extractor.js (which uses music-metadata) — kept
  // deliberately small since the whole point is running with zero npm deps
  // in a plain <script> mobile page. FLAC/M4A embedded art isn't handled here
  // (folder cover.* images still work for those; a real cover.jpg next to the
  // files remains the most reliable option for non-MP3 libraries).
  // Shared by extractId3Cover and extractId3Tags — walks past the 10-byte
  // ID3v2 header into the frame list and hands each frame to `onFrame`,
  // stopping as soon as it returns a truthy value (used as the "found it"
  // signal) or the frames run out.
  async function walkId3Frames(blob, onFrame) {
    try {
      const head = await blob.slice(0, 10).arrayBuffer();
      const dv = new DataView(head);
      if (dv.getUint8(0) !== 0x49 || dv.getUint8(1) !== 0x44 || dv.getUint8(2) !== 0x33) return null; // "ID3"
      const major = dv.getUint8(3);
      const synchsafe = (b0, b1, b2, b3) => ((b0 & 0x7f) << 21) | ((b1 & 0x7f) << 14) | ((b2 & 0x7f) << 7) | (b3 & 0x7f);
      const tagSize = synchsafe(dv.getUint8(6), dv.getUint8(7), dv.getUint8(8), dv.getUint8(9));
      if (!tagSize || tagSize > 20 * 1024 * 1024) return null; // sanity cap

      const tagBuf = await blob.slice(10, 10 + tagSize).arrayBuffer();
      const tag = new DataView(tagBuf);
      let offset = 0;
      while (offset < tagBuf.byteLength - 10) {
        const id = String.fromCharCode(tag.getUint8(offset), tag.getUint8(offset + 1), tag.getUint8(offset + 2), tag.getUint8(offset + 3));
        let frameSize;
        if (major >= 4) frameSize = synchsafe(tag.getUint8(offset + 4), tag.getUint8(offset + 5), tag.getUint8(offset + 6), tag.getUint8(offset + 7));
        else frameSize = tag.getUint32(offset + 4, false);
        if (!/^[A-Z0-9]{4}$/.test(id) || frameSize <= 0 || offset + 10 + frameSize > tagBuf.byteLength) break;

        const result = onFrame(id, tagBuf, tag, offset + 10, frameSize);
        if (result) return result;
        offset += 10 + frameSize;
      }
      return null;
    } catch {
      return null;
    }
  }

  async function extractId3Cover(blob) {
    return walkId3Frames(blob, (id, tagBuf, tag, bodyStart, frameSize) => {
      if (id !== 'APIC') return null;
      let p = bodyStart;
      const textEncoding = tag.getUint8(p);
      p += 1;
      let mimeEnd = p;
      while (mimeEnd < tagBuf.byteLength && tag.getUint8(mimeEnd) !== 0) mimeEnd++;
      const mime = String.fromCharCode(...new Uint8Array(tagBuf, p, mimeEnd - p)) || 'image/jpeg';
      p = mimeEnd + 1;
      p += 1; // picture type byte
      if (textEncoding === 1 || textEncoding === 2) {
        while (p < tagBuf.byteLength - 1 && !(tag.getUint8(p) === 0 && tag.getUint8(p + 1) === 0)) p += 2;
        p += 2;
      } else {
        while (p < tagBuf.byteLength && tag.getUint8(p) !== 0) p++;
        p += 1;
      }
      const imgBytes = tagBuf.slice(p, bodyStart + frameSize);
      if (imgBytes.byteLength < 1) return null;
      return new Blob([imgBytes], { type: mime });
    });
  }

  // Decodes an ID3v2 text-frame body (TPE1 = artist, TIT2 = title). The first
  // byte is the text encoding: 0 = Latin-1, 3 = UTF-8 (both null-terminated,
  // single-byte), 1 = UTF-16 with a BOM, 2 = UTF-16BE (both null-terminated,
  // double-byte). Good enough for the common real-world tag shapes without
  // pulling in a dependency, mirroring the desktop app's music-metadata-based
  // readBasicTags() for the one thing this from-scratch parser needs it for:
  // grouping loose root-level files that have no folder name to go by.
  function decodeId3TextFrame(tagBuf, bodyStart, frameSize) {
    const bytes = new Uint8Array(tagBuf, bodyStart, frameSize);
    if (!bytes.length) return null;
    const encoding = bytes[0];
    let str;
    if (encoding === 1 || encoding === 2) {
      const hasBom = encoding === 1 && bytes.length >= 3 && ((bytes[1] === 0xff && bytes[2] === 0xfe) || (bytes[1] === 0xfe && bytes[2] === 0xff));
      const little = !(hasBom && bytes[1] === 0xfe);
      const start = hasBom ? 3 : 1;
      const codeUnits = [];
      for (let i = start; i + 1 < bytes.length; i += 2) {
        const u = little ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
        if (u === 0) break;
        codeUnits.push(u);
      }
      str = String.fromCharCode(...codeUnits);
    } else {
      let end = 1;
      while (end < bytes.length && bytes[end] !== 0) end++;
      str = String.fromCharCode(...bytes.slice(1, end));
    }
    return str.trim() || null;
  }

  // Only handles MP3/ID3v2 (same scope as extractId3Cover) — a file with no
  // readable artist tag just falls back to "Unknown Artist" rather than
  // failing the whole import, same philosophy as the cover-art fallback.
  async function extractId3Tags(blob) {
    const artist = await walkId3Frames(blob, (id, tagBuf, tag, bodyStart, frameSize) => (id === 'TPE1' ? decodeId3TextFrame(tagBuf, bodyStart, frameSize) || true : null));
    const title = await walkId3Frames(blob, (id, tagBuf, tag, bodyStart, frameSize) => (id === 'TIT2' ? decodeId3TextFrame(tagBuf, bodyStart, frameSize) || true : null));
    return {
      artist: typeof artist === 'string' ? artist : null,
      title: typeof title === 'string' ? title : null,
    };
  }

  // ---------------- tree walker: <root>/<Artist>/<Era>/<tracks> ----------------
  // Same convention as desktop main.js's importLibraryTree(): folder cover.*
  // wins, falling back to an embedded MP3 cover, falling back to the
  // artist's own cover for eras that have neither.
  function findFolderCoverEntry(children) {
    return children.find((c) => !c.isDirectory && /^cover\./i.test(c.name) && IMAGE_EXT.has(extOf(c.name))) || null;
  }

  // Best-effort ID3 artist/title lookup for a loose file with no folder to
  // name it after — MP3-only (same scope as the cover-art fallback above);
  // anything else (or an unreadable/untagged MP3) just falls back to
  // "Unknown Artist" so it still shows up instead of getting dropped.
  async function readLooseFileTags(entry) {
    if (extOf(entry.name || '') !== '.mp3') return { artist: null, title: null };
    try {
      const blob = await backend().readAsBlob(entry.node, ID3_SCAN_MAX_BYTES);
      return await extractId3Tags(blob);
    } catch {
      return { artist: null, title: null };
    }
  }

  // Real music folders are rarely perfectly organized, so besides the normal
  // <root>/<Artist>/<Era>/<tracks> walk, this also tolerates two "messy"
  // shapes instead of silently dropping those files (the same gap the
  // desktop app's importLibraryTree() had — see library-importer.js there):
  //   - audio files sitting directly inside an Artist folder, with no Era
  //     subfolder — grouped into a catch-all "Singles" era for that artist.
  //   - audio files sitting directly at the library root, not inside any
  //     Artist folder at all — grouped by their own ID3 artist tag (falling
  //     back to "Unknown Artist" if untagged/non-MP3), since there's no
  //     folder name to use instead.
  async function walkLocalLibrary(rootNode, { onArtist, onEra, onTrack } = {}) {
    const b = backend();
    const rootChildren = await b.listChildren(rootNode);
    const artistEntries = rootChildren.filter((e) => e.isDirectory);
    const rootLooseFiles = rootChildren.filter((e) => !e.isDirectory && AUDIO_EXT.has(extOf(e.name)));
    let trackCount = 0;
    let artistCount = 0;
    const artistRefByName = new Map(); // lowercased name -> { ref, coverNode } — lets root-loose grouping reuse a folder-based artist of the same name instead of duplicating it

    for (const ad of artistEntries) {
      const artistChildren = await b.listChildren(ad.node);
      const artistCoverEntry = findFolderCoverEntry(artistChildren);
      let artistCoverNode = artistCoverEntry ? artistCoverEntry.node : null;
      const artistRef = onArtist ? onArtist({ name: ad.name, coverNode: artistCoverNode }) : null;
      artistCount++;
      artistRefByName.set(ad.name.toLowerCase(), { ref: artistRef, get coverNode() { return artistCoverNode; }, set coverNode(v) { artistCoverNode = v; } });

      const eraEntries = artistChildren.filter((e) => e.isDirectory);
      const artistLooseFiles = artistChildren.filter((e) => !e.isDirectory && AUDIO_EXT.has(extOf(e.name)));

      // Recursively walks a folder (and everything beneath it) looking for
      // folders that directly contain audio files — each of those becomes
      // its own Era, named after that folder. This mirrors the fix applied
      // to the desktop app's importLibraryTree(): previously this only ever
      // looked exactly one level below the artist folder, so an extra
      // organizational folder in between (e.g. an artist who splits their
      // archive into "Sessions"/"Projects" before the real per-session
      // subfolders — Artist/Sessions/<19 session folders>/track.mp3) meant
      // "Sessions" got scanned as one single (empty) era and all 19 real
      // sessions underneath it were silently never visited. A folder with
      // no audio files directly inside it produces no era of its own and
      // the walk just continues into its subfolders instead.
      async function walkEraSubtree(node, name, inheritedCover) {
        const children = await b.listChildren(node);
        const subDirs = children.filter((e) => e.isDirectory);
        const trackEntries = children.filter((e) => !e.isDirectory && AUDIO_EXT.has(extOf(e.name)));
        const folderCoverEntry = findFolderCoverEntry(children);
        const folderCover = folderCoverEntry ? folderCoverEntry.node : inheritedCover;

        if (trackEntries.length) {
          // Per-track embedded cover extraction (MP3 only) — previously
          // only the era's FIRST file was ever checked for embedded art,
          // so every track in an era fell back to showing that one file's
          // cover (or a blank thumbnail) instead of its own. Skipped only
          // when an explicit folder cover.jpg already wins for this folder.
          let trackCoverNodes = trackEntries.map(() => null);
          if (!folderCoverEntry) {
            trackCoverNodes = await Promise.all(trackEntries.map(async (tf) => {
              if (extOf(tf.name) !== '.mp3') return null;
              try {
                const blob = await b.readAsBlob(tf.node, ID3_SCAN_MAX_BYTES);
                const coverBlob = await extractId3Cover(blob);
                return coverBlob ? { kind: 'blob', blob: coverBlob } : null;
              } catch {
                return null; // best-effort — a missing/unreadable cover just means no art, not a failure
              }
            }));
          }
          let eraCoverNode = folderCover || trackCoverNodes.find(Boolean) || null;
          if (!artistCoverNode && eraCoverNode) artistCoverNode = eraCoverNode;

          const eraRef = onEra ? onEra({ artistRef, name, coverNode: eraCoverNode }) : null;

          // File size (used by the track-card grid) — cheap metadata-only
          // lookup on both backends, see getSize() above.
          const trackSizes = await Promise.all(trackEntries.map((tf) => b.getSize(tf.node).catch(() => null)));

          trackEntries.forEach((tf, i) => {
            const ext = extOf(tf.name);
            const title = tf.name.slice(0, tf.name.length - ext.length).replace(/^\d+\s*-\s*/, '');
            onTrack?.({
              eraRef, title, node: tf.node, format: ext.replace('.', '').toUpperCase(),
              coverNode: trackCoverNodes[i] || eraCoverNode,
              sizeBytes: trackSizes[i],
            });
            trackCount++;
          });
        }

        // A folder can have both loose audio files of its own AND further
        // subfolders of eras beneath it (rare, but no reason to silently
        // drop one or the other) — always recurse regardless of whether
        // trackEntries.length was truthy above.
        for (const sd of subDirs) {
          await walkEraSubtree(sd.node, sd.name, folderCover);
        }
      }

      for (const ed of eraEntries) {
        await walkEraSubtree(ed.node, ed.name, artistCoverNode);
      }

      // Loose files directly inside the artist folder — no Era subfolder to
      // name the group after, so they get a generic catch-all era.
      if (artistLooseFiles.length) {
        const singlesCoverNodes = await Promise.all(artistLooseFiles.map(async (tf) => {
          if (extOf(tf.name) !== '.mp3') return null;
          try {
            const blob = await b.readAsBlob(tf.node, ID3_SCAN_MAX_BYTES);
            const coverBlob = await extractId3Cover(blob);
            return coverBlob ? { kind: 'blob', blob: coverBlob } : null;
          } catch {
            return null; // best-effort
          }
        }));
        const singlesCover = artistCoverNode || singlesCoverNodes.find(Boolean) || null;
        if (!artistCoverNode && singlesCover) artistCoverNode = singlesCover;
        const singlesEraRef = onEra ? onEra({ artistRef, name: 'Singles', coverNode: singlesCover }) : null;
        const singlesSizes = await Promise.all(artistLooseFiles.map((tf) => b.getSize(tf.node).catch(() => null)));
        artistLooseFiles.forEach((tf, i) => {
          const ext = extOf(tf.name);
          const title = tf.name.slice(0, tf.name.length - ext.length).replace(/^\d+\s*-\s*/, '');
          onTrack?.({
            eraRef: singlesEraRef, title, node: tf.node, format: ext.replace('.', '').toUpperCase(),
            coverNode: singlesCoverNodes[i] || singlesCover,
            sizeBytes: singlesSizes[i],
          });
          trackCount++;
        });
      }
    }

    // Loose files at the library root — no folder name at all to go on, so
    // group them by their own tag's artist (or "Unknown Artist").
    if (rootLooseFiles.length) {
      const groups = new Map(); // lowercased artist name -> { displayName, files: [{ name, node, title }] }
      for (const f of rootLooseFiles) {
        const tags = await readLooseFileTags(f);
        const displayName = tags.artist || 'Unknown Artist';
        const key = displayName.toLowerCase();
        if (!groups.has(key)) groups.set(key, { displayName, files: [] });
        groups.get(key).files.push({ name: f.name, node: f.node, title: tags.title });
      }
      for (const { displayName, files } of groups.values()) {
        const key = displayName.toLowerCase();
        let entry = artistRefByName.get(key);
        if (!entry) {
          const ref = onArtist ? onArtist({ name: displayName, coverNode: null }) : null;
          artistCount++;
          entry = { ref, coverNode: null };
          artistRefByName.set(key, entry);
        }
        const fileCoverNodes = await Promise.all(files.map(async (f) => {
          if (extOf(f.name) !== '.mp3') return null;
          try {
            const blob = await b.readAsBlob(f.node, ID3_SCAN_MAX_BYTES);
            const coverBlob = await extractId3Cover(blob);
            return coverBlob ? { kind: 'blob', blob: coverBlob } : null;
          } catch {
            return null; // best-effort
          }
        }));
        const eraCover = entry.coverNode || fileCoverNodes.find(Boolean) || null;
        if (!entry.coverNode && eraCover) entry.coverNode = eraCover;
        const eraRef = onEra ? onEra({ artistRef: entry.ref, name: 'Singles', coverNode: eraCover }) : null;
        const fileSizes = await Promise.all(files.map(({ node }) => b.getSize(node).catch(() => null)));
        files.forEach(({ name, node, title }, i) => {
          const ext = extOf(name);
          onTrack?.({
            eraRef, title: title || name.slice(0, name.length - ext.length).replace(/^\d+\s*-\s*/, ''), node, format: ext.replace('.', '').toUpperCase(),
            coverNode: fileCoverNodes[i] || eraCover,
            sizeBytes: fileSizes[i],
          });
          trackCount++;
        });
      }
    }

    return { artistCount, trackCount };
  }

  async function coverNodeToUrl(coverNode) {
    if (!coverNode) return null;
    if (coverNode.kind === 'blob') return URL.createObjectURL(coverNode.blob);
    return backend().getPlayableUrl(coverNode);
  }

  async function trackNodeToUrl(node) {
    return backend().getPlayableUrl(node);
  }

  // Reads a track's actual audio bytes as a Blob — used by the Share
  // feature to upload the file to gofile.io. Deliberately the FULL file
  // (no maxBytes bound), unlike the ID3-scan call sites above.
  async function trackNodeToBlob(node) {
    return backend().readAsBlob(node);
  }

  global.VaultLocalLibrary = {
    isSupported,
    isNative,
    pickFolder: (...a) => backend().pickFolder(...a),
    saveHandle,
    loadSavedHandle,
    walkLocalLibrary,
    coverNodeToUrl,
    trackNodeToUrl,
    trackNodeToBlob,
    AUDIO_EXT,
    IMAGE_EXT,
  };
})(typeof window !== 'undefined' ? window : this);
