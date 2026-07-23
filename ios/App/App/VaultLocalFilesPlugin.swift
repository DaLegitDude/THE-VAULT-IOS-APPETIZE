import Foundation
import UIKit
import Capacitor

// ---------------------------------------------------------------------------
// Vault — local-folder access for the compiled iOS app.
// ---------------------------------------------------------------------------
// The web app's usual local-folder path (window.showDirectoryPicker, the
// File System Access API) doesn't exist inside Capacitor's WKWebView on
// iOS either — same reason the Android build needed VaultLocalFilesPlugin.
// This is the iOS twin of that plugin: same four methods (pickFolder,
// getSavedFolder, listChildren, readFile), same JS-facing shape, so
// local-library.js's NativeBackend works against either platform with zero
// changes. Under the hood it uses UIDocumentPickerViewController (iOS's
// equivalent of Android's Storage Access Framework) plus a security-scoped
// bookmark so the app can reconnect to the picked folder after a relaunch
// without asking the user to pick it again.
// ---------------------------------------------------------------------------
@objc(VaultLocalFilesPlugin)
public class VaultLocalFilesPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "VaultLocalFilesPlugin"
    public let jsName = "VaultLocalFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSavedFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listChildren", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFile", returnType: CAPPluginReturnPromise)
    ]

    private static let bookmarkKey = "vaultRootBookmark"
    private static let nameKey = "vaultRootName"

    // Kept open for the lifetime of the app process once a folder is picked
    // or reconnected — the OS releases the security-scoped grant automatically
    // when the process ends, which is the normal pattern for a simple
    // document-based app like this (no explicit stopAccessing... call needed
    // mid-session since every read happens while this stays "checked out").
    private var rootURL: URL?
    private var pickCall: CAPPluginCall?

    // Same extension -> MIME map and same reasoning as the Android plugin's
    // MIME_TYPES: the WKWebView's <audio> element needs an accurate MIME type
    // on the Blob it's handed, and iOS's own UTType-based sniffing isn't
    // reliably right for every audio extension either.
    private static let mimeTypes: [String: String] = [
        "mp3": "audio/mpeg", "wav": "audio/wav", "flac": "audio/flac", "m4a": "audio/mp4",
        "mp4": "audio/mp4", "aac": "audio/aac", "ogg": "audio/ogg", "oga": "audio/ogg",
        "opus": "audio/opus", "weba": "audio/webm", "webm": "audio/webm",
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp",
    ]
    private static func mimeType(forName name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        return mimeTypes[ext] ?? "application/octet-stream"
    }

    @objc func pickFolder(_ call: CAPPluginCall) {
        call.keepAlive = true
        DispatchQueue.main.async {
            self.pickCall = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pickCall, let url = urls.first else {
            pickCall?.reject("No folder selected.")
            pickCall = nil
            return
        }
        guard url.startAccessingSecurityScopedResource() else {
            call.reject("Could not get access to the selected folder.")
            pickCall = nil
            return
        }
        do {
            let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            UserDefaults.standard.set(bookmark, forKey: Self.bookmarkKey)
            UserDefaults.standard.set(url.lastPathComponent, forKey: Self.nameKey)
        } catch {
            call.reject("Could not save folder access: \(error.localizedDescription)")
            pickCall = nil
            return
        }
        rootURL = url
        call.resolve(["uri": url.absoluteString, "name": url.lastPathComponent])
        pickCall = nil
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickCall?.reject("No folder selected.")
        pickCall = nil
    }

    // Lets the app auto-reconnect to the last-picked folder on launch —
    // mirrors the Android plugin's getSavedFolder, giving the native app
    // "remembers your folder" parity with the desktop app.
    @objc func getSavedFolder(_ call: CAPPluginCall) {
        guard let bookmark = UserDefaults.standard.data(forKey: Self.bookmarkKey) else {
            call.resolve([:])
            return
        }
        var isStale = false
        do {
            let url = try URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &isStale)
            guard url.startAccessingSecurityScopedResource() else {
                call.resolve([:])
                return
            }
            rootURL = url
            let name = UserDefaults.standard.string(forKey: Self.nameKey) ?? url.lastPathComponent
            call.resolve(["uri": url.absoluteString, "name": name])
        } catch {
            // Bookmark no longer resolves (folder moved/deleted/permission
            // revoked) — treat exactly like "nothing saved yet" so the app
            // just falls back to the normal first-run picker.
            call.resolve([:])
        }
    }

    @objc func listChildren(_ call: CAPPluginCall) {
        guard let uriStr = call.getString("uri"), let dirURL = URL(string: uriStr) else {
            call.reject("Missing uri")
            return
        }
        do {
            let contents = try FileManager.default.contentsOfDirectory(
                at: dirURL,
                includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey],
                options: [.skipsHiddenFiles]
            )
            let items: [[String: Any]] = contents.map { childURL in
                let values = try? childURL.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
                return [
                    "name": childURL.lastPathComponent,
                    "isDirectory": values?.isDirectory ?? false,
                    "uri": childURL.absoluteString,
                    "size": values?.fileSize ?? 0,
                ]
            }
            call.resolve(["items": items])
        } catch {
            call.reject("Not a folder, or Vault no longer has access to it — try reselecting your music folder in Settings.")
        }
    }

    @objc func readFile(_ call: CAPPluginCall) {
        guard let uriStr = call.getString("uri"), let fileURL = URL(string: uriStr) else {
            call.reject("Missing uri")
            return
        }
        // Optional cap on how many bytes to actually read, from the start of
        // the file — same perf fix as the Android plugin. Without this, the
        // library walk's ID3-tag-for-cover-art scan read every audio file's
        // FULL content across the JS bridge as base64 just to look at a few
        // KB of tag data, which is what made picking a folder take forever
        // (or appear to hang) on anything but a tiny library. Playback and
        // the Share feature still call this with no cap.
        let maxBytes = call.getInt("maxBytes")
        guard let stream = InputStream(url: fileURL) else {
            call.reject("Could not open file.")
            return
        }
        stream.open()
        defer { stream.close() }
        if let streamError = stream.streamError {
            call.reject("Could not read file: \(streamError.localizedDescription)")
            return
        }
        var data = Data()
        let bufferSize = 64 * 1024
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let bytesRead = stream.read(&buffer, maxLength: bufferSize)
            if bytesRead < 0 {
                call.reject("Could not read file: \(stream.streamError?.localizedDescription ?? "unknown error")")
                return
            }
            if bytesRead == 0 { break }
            data.append(buffer, count: bytesRead)
            if let cap = maxBytes, data.count >= cap { break }
        }
        call.resolve([
            "base64": data.base64EncodedString(),
            "mimeType": Self.mimeType(forName: fileURL.lastPathComponent),
        ])
    }
}
