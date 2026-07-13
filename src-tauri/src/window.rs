use crate::accounts::{self, Account, ActiveAccount};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Recent desktop Chrome UA. WhatsApp Web rejects the default WebKitGTK/Safari UA.
/// Bump the major version occasionally, and keep it in sync with the client-hints
/// shim in `resources/bridge.js` (brands/fullVersionList/uaFullVersion).
///
/// NOTE (Linux): setting this alone is NOT enough — WebKitGTK's site-specific
/// quirks override the embedder UA for web.whatsapp.com with a fake macOS Safari
/// string. `enable_webview_media` turns quirks off so this UA actually reaches
/// the site.
pub const CHROME_UA: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const BRIDGE_JS: &str = include_str!("../resources/bridge.js");
const APP_ICON: &[u8] = include_bytes!("../icons/128x128.png");

/// Open (or focus, if it already exists) the window for `account`. The label is
/// `wa-<id>`; everything the single-account window carried is preserved (Chrome UA,
/// `bridge.js`, app icon, sizes, close-to-tray), plus per-account session isolation
/// for non-default accounts.
pub fn open_account_window(
    app: &AppHandle,
    account: &Account,
    start_hidden: bool,
) -> tauri::Result<WebviewWindow> {
    let label = accounts::window_label(&account.id);

    // Reuse the existing window if it is already open.
    if let Some(w) = app.get_webview_window(&label) {
        return Ok(w);
    }

    let url = "https://web.whatsapp.com/".parse().expect("valid url");
    let icon = tauri::image::Image::from_bytes(APP_ICON)?;

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(format!("Whatsapp.rust — {}", account.name))
        .inner_size(1100.0, 800.0)
        .min_inner_size(560.0, 480.0)
        .icon(icon)?
        .user_agent(CHROME_UA)
        .initialization_script(BRIDGE_JS)
        // Drag-and-drop is done by capturing the OS drop in Rust and injecting the file
        // into the page (see `register_drop_handler` + bridge.js `__whatrustHandleDrop`).
        // We deliberately KEEP Tauri's drag-drop handler enabled: on Linux/webkit2gtk the
        // native webview never delivers a file drop into the page DOM (broken on Wayland;
        // on X11 the GTK drop is accepted — the "+" cursor shows — but it still never
        // reaches WhatsApp Web), so relying on in-page HTML5 drop simply does not work
        // there. The handler is what hands us the dropped paths via `WindowEvent::DragDrop`.
        // Belt-and-braces: cancel any `file://` navigation so a stray drop can never
        // navigate the window away and tear down the live WhatsApp session.
        .on_navigation(|url| url.scheme() != "file")
        // Downloads: with NO handler registered, wry never wires up the platform's
        // download machinery at all — on Linux nobody answers WebKit's
        // `decide-destination` and the engine cancels every download, so WhatsApp's
        // "Download" button (videos, images, documents) silently did nothing.
        // Accept every download into the user's Downloads folder (wry pre-fills a
        // de-duplicated absolute path on Linux/Windows; the fallback covers a
        // platform handing us an empty/relative destination) and toast on finish.
        .on_download(|webview, event| {
            match event {
                tauri::webview::DownloadEvent::Requested { url, destination } => {
                    ensure_download_destination(
                        destination,
                        webview.app_handle().path().download_dir().ok(),
                    );
                    // Log routing only — never the file name (matches dlog's no-PII rule).
                    crate::dlog::log(&format!(
                        "download: requested scheme={} dest_abs={}",
                        url.scheme(),
                        destination.is_absolute()
                    ));
                }
                tauri::webview::DownloadEvent::Finished { path, success, .. } => {
                    crate::dlog::log(&format!(
                        "download: finished success={success} path_known={}",
                        path.is_some()
                    ));
                    let app = webview.app_handle();
                    if success {
                        let body = match path.as_ref().and_then(|p| p.file_name()) {
                            Some(n) => {
                                format!("{} — saved to your Downloads folder.", n.to_string_lossy())
                            }
                            // macOS never reports the final path; the folder is still right.
                            None => "Saved to your Downloads folder.".to_string(),
                        };
                        crate::notify::show(app, "Download complete", &body);
                    } else {
                        crate::notify::show(
                            app,
                            "Download failed",
                            "The file could not be downloaded. Please try again.",
                        );
                    }
                }
                _ => {}
            }
            true
        })
        .visible(!start_hidden);

    #[cfg(target_os = "windows")]
    let builder = builder.additional_browser_args(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"
    );

    let builder = apply_isolation(builder, account, app);
    let win = builder.build()?;

    #[cfg(target_os = "windows")]
    set_memory_usage_level(&win, start_hidden);

    // Close-to-tray (reads the live setting so the toggle takes effect without a restart).
    let app_handle = app.clone();
    let label_for_close = label.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if crate::settings::load(&app_handle).close_to_tray {
                let lc = crate::applock::load(&app_handle);
                if lc.is_active() && lc.lock_on_hide {
                    crate::lock::lock_now(&app_handle);
                } else if let Some(w) = app_handle.get_webview_window(&label_for_close) {
                    let _ = w.hide();
                    #[cfg(target_os = "windows")]
                    set_memory_usage_level(&w, true);
                }
                api.prevent_close();
            }
        }
    });

    register_focus_listener(app, &win);
    register_drop_handler(&win);
    enable_webview_media(&win);
    Ok(win)
}

/// Largest single dropped file we will inline-inject into the page. base64 over `eval`
/// is ~1.33x the byte size and held in memory, so keep it bounded; larger files are
/// skipped (with a log line) rather than risking an OOM or a long UI stall.
const MAX_DROP_FILE_BYTES: u64 = 100 * 1024 * 1024;
/// Cap how many files one drop can inject (WhatsApp itself limits a batch anyway).
const MAX_DROP_FILES: usize = 30;

/// Capture OS file drops and inject them into WhatsApp Web.
///
/// On Linux the webview never delivers the drop into the page DOM, so Tauri's
/// drag-drop handler (kept enabled in the builder) is our only source of the dropped
/// paths. We read the files off the UI thread, base64-encode them, and `eval` a call
/// to the page-side `__whatrustHandleDrop` (defined in bridge.js), which rebuilds the
/// `File`s and hands them to WhatsApp's own attach flow. Every boundary is logged to
/// the diagnostic log (see dlog.rs) so a failure can be pinpointed without a console.
fn register_drop_handler(win: &WebviewWindow) {
    let win = win.clone();
    win.clone().on_window_event(move |event| {
        let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) = event
        else {
            return;
        };
        crate::dlog::log(&format!(
            "dragdrop: Drop {} path(s) at ({:.0},{:.0})",
            paths.len(),
            position.x,
            position.y
        ));
        let paths = paths.clone();
        let (x, y) = (position.x, position.y);
        let w = win.clone();
        // Read + encode off the UI thread: a large video would otherwise stall the window.
        std::thread::spawn(move || match build_drop_payload(&paths) {
            Some(json) if json != "[]" => {
                let js = format!(
                    "window.__whatrustHandleDrop&&window.__whatrustHandleDrop({json},{x},{y});"
                );
                match w.eval(&js) {
                    Ok(()) => crate::dlog::log("dragdrop: injection dispatched to page"),
                    Err(e) => crate::dlog::log(&format!("dragdrop: eval failed: {e}")),
                }
            }
            _ => crate::dlog::log("dragdrop: nothing injectable (empty/too large/unreadable)"),
        });
    });
}

/// Read the dropped files into a JSON array `[{name,type,b64}]` for the page-side
/// injector. Skips anything too large, non-regular, or unreadable (logging each skip).
///
/// Memory: each file's base64 is streamed straight into the shared output buffer (see
/// [`append_file_base64`]), reading the file in bounded chunks. A large video is therefore
/// never simultaneously resident as raw bytes *and* a base64 `String` *and* a
/// `serde_json::Value` *and* the serialized output (the old path held ~4 full copies — a
/// 100 MB drop peaked near half a gigabyte). Peak extra allocation is now ~1.33x the base64
/// of the single largest file (the transport itself) plus a fixed 48 KiB read buffer.
fn build_drop_payload(paths: &[std::path::PathBuf]) -> Option<String> {
    let mut out = String::from("[");
    let mut wrote_any = false;
    for p in paths.iter().take(MAX_DROP_FILES) {
        let name = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("file")
            .to_string();
        let meta = match std::fs::metadata(p) {
            Ok(m) => m,
            Err(e) => {
                crate::dlog::log(&format!("dragdrop: stat '{name}' failed: {e}"));
                continue;
            }
        };
        if !meta.is_file() {
            crate::dlog::log(&format!("dragdrop: skip '{name}': not a regular file"));
            continue;
        }
        if meta.len() > MAX_DROP_FILE_BYTES {
            crate::dlog::log(&format!(
                "dragdrop: skip '{name}': {} bytes over the {MAX_DROP_FILE_BYTES} cap",
                meta.len()
            ));
            continue;
        }
        // Rollback point: if the file read fails partway through streaming its base64, we
        // truncate the half-written object (and its leading separator) so `out` stays valid
        // JSON. serde_json escapes the name/type strings; base64's alphabet (A-Za-z0-9+/=)
        // needs no JSON escaping, so it is written raw between the quotes.
        let mark = out.len();
        if wrote_any {
            out.push(',');
        }
        out.push_str("{\"name\":");
        out.push_str(&serde_json::to_string(&name).unwrap_or_else(|_| "\"file\"".to_string()));
        out.push_str(",\"type\":");
        out.push_str(
            &serde_json::to_string(mime_for(&name))
                .unwrap_or_else(|_| "\"application/octet-stream\"".to_string()),
        );
        out.push_str(",\"b64\":\"");
        match append_file_base64(&mut out, p) {
            Ok(n) => {
                out.push_str("\"}");
                wrote_any = true;
                crate::dlog::log(&format!("dragdrop: read '{name}' ({n} bytes)"));
            }
            Err(e) => {
                out.truncate(mark);
                crate::dlog::log(&format!("dragdrop: read '{name}' failed: {e}"));
            }
        }
    }
    out.push(']');
    Some(out)
}

/// Best-effort MIME from the file extension, so WhatsApp routes images/videos/docs to
/// the right composer. Unknown types fall back to a generic binary type (still sends).
///
/// Why the image list matters: bridge.js routes anything whose MIME starts with `image/`
/// to the Photos & Videos composer (a photo); anything else goes to the Document composer.
/// A modern phone photo (AVIF, HEIF/HEIC) that fell through to `application/octet-stream`
/// was therefore attached as a *file* instead of a *photo* — covering those extensions
/// fixes the routing. We deliberately do NOT route niche raster formats (TIFF, ICO, APNG)
/// as images: WhatsApp's photo composer may reject them, which would be worse than the
/// current behaviour of sending them as a document — so they stay documents. Non-native
/// video containers also still go as a document (only mp4/3gpp/quicktime are accepted by
/// the media input), but get a correct label rather than a generic one.
fn mime_for(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        // Images (image/* -> routed to the Photos & Videos composer by bridge.js). Limited to
        // formats WhatsApp's photo composer accepts, so nothing regresses to "not supported".
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "heif" => "image/heif",
        // Video. Only mp4/3gpp/quicktime are accepted by WhatsApp's media input (bridge.js
        // NATIVE_VIDEO); the rest still send, as a document, but with a correct label.
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "3gp" => "video/3gpp",
        "3g2" => "video/3gpp2",
        "avi" => "video/x-msvideo",
        "mpeg" | "mpg" => "video/mpeg",
        "mts" | "m2ts" => "video/mp2t",
        "ogv" => "video/ogg",
        "flv" => "video/x-flv",
        // Audio (sent as a document; correct labels help WhatsApp render an audio preview).
        "mp3" => "audio/mpeg",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "weba" => "audio/webm",
        "amr" => "audio/amr",
        "mid" | "midi" => "audio/midi",
        // Documents / archives / text.
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "rtf" => "application/rtf",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "odp" => "application/vnd.oasis.opendocument.presentation",
        "epub" => "application/epub+zip",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        "tar" => "application/x-tar",
        "gz" => "application/gzip",
        "apk" => "application/vnd.android.package-archive",
        _ => "application/octet-stream",
    }
}

/// Append the standard base64 (RFC 4648, with `=` padding) of `data` to `out`. Hand-rolled
/// to avoid pulling a crate into this otherwise lean dependency tree.
///
/// Encodes per 3-byte group, padding only a final partial group. Callers that feed data
/// across multiple calls (streaming) MUST pass whole 3-byte groups on every call except the
/// last — otherwise an interior partial group would be padded mid-stream. [`append_file_base64`]
/// upholds that contract via a small carry buffer.
fn base64_encode_into(out: &mut String, data: &[u8]) {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    out.reserve(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
}

/// Standard base64 of `data` as an owned `String`. Thin wrapper over [`base64_encode_into`].
/// Only the streaming `append_file_base64` is used in production now, so this whole-buffer
/// form is exercised by the tests (as the parity oracle) — hence `cfg(test)`.
#[cfg(test)]
fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    base64_encode_into(&mut out, data);
    out
}

/// Append the base64 of the file at `path` to `out`, reading in bounded 48 KiB chunks so the
/// file is never fully resident in memory — the key to dropping a large *video* without a
/// half-gigabyte spike. Returns the number of bytes read.
///
/// base64 must be emitted in whole 3-byte groups (only the final group is padded), but a
/// `read` can return any number of bytes, so a 0–2 byte `carry` holds the bytes that don't
/// yet complete a group and rolls them into the next read; the EOF flush pads whatever
/// remains. Every encode call but the EOF flush is therefore a multiple of three bytes.
///
/// The 48 KiB stack buffer is already large, so we read the `File` directly rather than
/// wrapping it in a `BufReader` (which would only add a redundant intermediate copy here).
fn append_file_base64(out: &mut String, path: &std::path::Path) -> std::io::Result<u64> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut buf = [0u8; 48 * 1024]; // 49152 = an exact number of 3-byte groups
    let mut carry = [0u8; 3];
    let mut carry_len = 0usize;
    let mut total: u64 = 0;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        let data = &buf[..n];
        let mut i = 0;
        // 1) Top up a carried partial group from the front of this read, then flush it.
        while carry_len > 0 && carry_len < 3 && i < n {
            carry[carry_len] = data[i];
            carry_len += 1;
            i += 1;
        }
        if carry_len == 3 {
            base64_encode_into(out, &carry); // a full group → no padding
            carry_len = 0;
        }
        // 2) Bulk-encode the complete 3-byte groups remaining in this read.
        let remaining = n - i;
        let groups = remaining - (remaining % 3);
        if groups > 0 {
            base64_encode_into(out, &data[i..i + groups]);
        }
        // 3) Stash the trailing 0–2 bytes as the new carry.
        for &b in &data[i + groups..n] {
            carry[carry_len] = b;
            carry_len += 1;
        }
    }
    // EOF: encode whatever is left in the carry, padding the final partial group.
    base64_encode_into(out, &carry[..carry_len]);
    Ok(total)
}

/// Make sure a platform-suggested download `destination` is usable: keep an
/// absolute path with a file name as-is; otherwise rebuild it as
/// `<download_dir>/<file name>` (file name defaulting to "download", directory
/// defaulting to the temp dir if the platform can't name a Downloads folder).
fn ensure_download_destination(
    destination: &mut std::path::PathBuf,
    download_dir: Option<std::path::PathBuf>,
) {
    if destination.is_absolute() && destination.file_name().is_some() {
        return;
    }
    let name = destination
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_else(|| "download".into());
    let mut dir = download_dir.unwrap_or_else(std::env::temp_dir);
    dir.push(name);
    *destination = dir;
}

/// Track the last-focused account window in `ActiveAccount`. Registered once per
/// window inside `open_account_window`, so startup *and* dynamically-added windows
/// get it exactly once.
fn register_focus_listener(app: &AppHandle, win: &WebviewWindow) {
    let app_handle = app.clone();
    let label = win.label().to_string();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(true) = event {
            if let Some(active) = app_handle.try_state::<ActiveAccount>() {
                *active.lock().unwrap() = label.clone();
            }
        }
    });
}

/// Apply per-account session isolation to a window builder.
///
/// The `default` account uses the default webview store (no override) so the
/// pre-multi-account login is preserved. Additional accounts get an isolated store:
/// `data_directory` on Linux/Windows, `data_store_identifier` (the persisted v4 UUID)
/// on macOS. `data_directory`/`data_store_identifier` compile on every platform in
/// tauri; only *which* one is called is cfg-gated, with a `compile_error!()` catch-all
/// so a future platform can't silently skip isolation.
fn apply_isolation<'a>(
    builder: WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle<tauri::Wry>>,
    account: &Account,
    app: &AppHandle,
) -> WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle<tauri::Wry>> {
    // The default account always uses the shared default store.
    if account.id == "default" {
        return builder;
    }

    #[cfg(any(target_os = "linux", windows))]
    {
        let _ = app;
        if let Ok(dir) = accounts::profile_dir(app, &account.id) {
            let _ = std::fs::create_dir_all(&dir);
            return builder.data_directory(dir);
        }
        builder
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        // Non-default accounts carry a persisted, non-nil v4 UUID. Fall back to a
        // freshly generated non-nil UUID rather than risk the nil-UUID exception.
        let uuid = account.store_uuid.unwrap_or_else(accounts::gen_store_uuid);
        builder.data_store_identifier(uuid)
    }
    #[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
    {
        let _ = (builder, account, app);
        compile_error!("per-account session isolation is not implemented for this platform");
    }
}

/// Whether the platform can isolate additional accounts. macOS needs >= 14 for
/// `data_store_identifier`. Linux/Windows always can. Returns an `Err` message
/// suitable for surfacing in the Accounts UI.
pub fn ensure_isolation_supported() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSOperatingSystemVersion, NSProcessInfo};
        // data_store_identifier requires macOS >= 14.
        let required = NSOperatingSystemVersion {
            majorVersion: 14,
            minorVersion: 0,
            patchVersion: 0,
        };
        let ok = NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(required);
        if ok {
            Ok(())
        } else {
            Err("Multiple accounts require macOS 14 or newer.".into())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

/// Grant microphone/camera + media settings to WhatsApp Web, and make sure the
/// site actually sees our Chrome UA. The system webview denies getUserMedia by
/// default, which blocks voice messages (the "Allow microphone" prompt). We
/// enable the media settings and auto-approve the webview's permission requests
/// for the WhatsApp window.
///
/// Reality check (verified against webkit2gtk 2.52.3 on this distro): the
/// library is built WITHOUT a WebRTC backend — `RTCPeerConnection` stays
/// undefined even with `enable-webrtc` on (the setting is kept as a harmless
/// forward-compat no-op). Voice/video CALLS therefore cannot work in the Linux
/// system webview no matter what we spoof; WhatsApp's "your browser doesn't
/// support calling" is, on Linux, literally true. Calls can work on Windows
/// (WebView2 is Chromium and ships WebRTC).
fn enable_webview_media(win: &WebviewWindow) {
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::glib::prelude::ObjectExt;
        use webkit2gtk::{PermissionRequestExt, WebViewExt};
        let _ = win.with_webview(|webview| {
            let wv = webview.inner();
            if let Some(settings) = WebViewExt::settings(&wv) {
                settings.set_property("enable-media-stream", true);
                settings.set_property("enable-mediasource", true);
                settings.set_property("enable-webrtc", true);
                settings.set_property("enable-encrypted-media", true);
                // CRITICAL: WebKitGTK hardcodes per-site UA quirks, and
                // web.whatsapp.com is on the list — with quirks enabled (the
                // default) the engine REPLACES our Chrome UA with a fake macOS
                // Safari string ("... Version/60.5 Safari/605.1.15"), which
                // WhatsApp reads as an ancient Safari and answers by disabling
                // video sending and calling ("please update your browser").
                // Turning quirks off lets CHROME_UA through unmodified.
                settings.set_property("enable-site-specific-quirks", false);
                // Opt-in inspector for live diagnosis: run `WHATRUST_DEVTOOLS=1
                // whatrust` and right-click > Inspect Element.
                if std::env::var_os("WHATRUST_DEVTOOLS").is_some() {
                    settings.set_property("enable-developer-extras", true);
                }
            }
            wv.connect_permission_request(|_wv, req| {
                req.allow();
                true
            });
            // The initial navigation was issued before this callback ran, i.e.
            // with the quirked UA still active. Reload once so the session is
            // consistently Chrome from the very first request WhatsApp sees.
            wv.reload();
            crate::dlog::log(
                "webview: media settings applied, site-specific quirks OFF, reloaded with Chrome UA",
            );
        });
    }
    #[cfg(target_os = "windows")]
    {
        let _ = win.with_webview(enable_media_windows);
    }
    #[cfg(target_os = "macos")]
    {
        // wry already installs a WKUIDelegate that auto-grants requestMediaCapturePermission;
        // mic/camera are gated only by the Info.plist usage-description keys (see src-tauri/Info.plist).
        let _ = win;
    }
}

/// Windows (WebView2): auto-allow microphone/camera permission requests so WhatsApp
/// voice messages and calls work without a prompt (and can't be wedged by a prior "Block").
#[cfg(target_os = "windows")]
fn enable_media_windows(webview: tauri::webview::PlatformWebview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2PermissionRequestedEventArgs, COREWEBVIEW2_PERMISSION_KIND,
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    // SAFETY: with_webview runs on the UI thread where the WebView2 controller lives;
    // these are standard WebView2 COM calls.
    unsafe {
        let controller = webview.controller();
        let core: ICoreWebView2 = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(_) => return,
        };
        let handler = PermissionRequestedEventHandler::create(Box::new(
            move |_wv: Option<ICoreWebView2>,
                  args: Option<ICoreWebView2PermissionRequestedEventArgs>|
                  -> windows_core::Result<()> {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;
                    if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                        || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                    {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                    }
                }
                Ok(())
            },
        ));
        let mut token: i64 = 0;
        let _ = core.add_PermissionRequested(&handler, &mut token);
    }
}

/// Set target memory usage level for WebView2 on Windows (no-op on other platforms).
#[cfg(target_os = "windows")]
pub fn set_memory_usage_level(win: &WebviewWindow, is_low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;

    let _ = win.with_webview(move |webview| {
        // SAFETY: with_webview runs on the UI thread where the WebView2 controller lives;
        // these are standard WebView2 COM calls.
        unsafe {
            let controller = webview.controller();
            let core: ICoreWebView2 = match controller.CoreWebView2() {
                Ok(c) => c,
                Err(_) => return,
            };
            if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                let target_level = if is_low {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                };
                let _ = core19.SetMemoryUsageTargetLevel(target_level);
            }
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn set_memory_usage_level(_win: &WebviewWindow, _is_low: bool) {}

/// Show + unminimize + focus an account window by its `wa-<id>` label.
pub fn show_account(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        #[cfg(target_os = "windows")]
        set_memory_usage_level(&w, false);
    }
}

/// Show the active (last-focused) account window. Falls back to the first existing
/// account window, then the settings window.
pub fn show_active(app: &AppHandle) {
    // If the app is locked, any "reveal" request shows the lock screen, never an
    // account window. Covers tray click, global shortcut, single-instance, macOS Reopen.
    if !crate::lock::is_unlocked(app) {
        crate::lock::show_lock_window(app);
        return;
    }
    if let Some(active) = app.try_state::<ActiveAccount>() {
        let label = active.lock().unwrap().clone();
        if app.get_webview_window(&label).is_some() {
            show_account(app, &label);
            return;
        }
    }
    // Fall back to any account window.
    if let Some(label) = app
        .webview_windows()
        .keys()
        .find(|l| l.starts_with("wa-"))
        .cloned()
    {
        show_account(app, &label);
        return;
    }
    // Last resort: the settings window.
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Backwards-compatible shim: single-instance + macOS Reopen call this; it now
/// targets the active account.
pub fn show_main(app: &AppHandle) {
    show_active(app);
}

/// What a toggle should do given the active window's visibility.
#[derive(Debug, PartialEq, Eq)]
pub enum ToggleAct {
    Hide,
    Show,
}

/// Pure toggle decision: a visible active window is hidden; anything else (a hidden
/// window, or no active window at all → `None`) is shown.
pub fn toggle_decision(active_visible: Option<bool>) -> ToggleAct {
    match active_visible {
        Some(true) => ToggleAct::Hide,
        _ => ToggleAct::Show,
    }
}

/// Toggle the active account window: hide it if visible, otherwise show + focus it.
/// The "show" path goes through `show_active`, which defers to the lock screen when
/// the app is locked — so a toggle (e.g. an OS-bound `whatrust --toggle` on Wayland,
/// where in-process global hotkeys can't fire) can NEVER reveal an account window
/// while locked. The "hide" path only triggers when an account window is visible,
/// which cannot happen while locked.
pub fn toggle_active(app: &AppHandle) {
    let label = app
        .try_state::<ActiveAccount>()
        .map(|a| a.lock().unwrap().clone());
    let visible = label
        .as_ref()
        .and_then(|l| app.get_webview_window(l))
        .map(|w| w.is_visible().unwrap_or(false));
    match toggle_decision(visible) {
        ToggleAct::Hide => {
            if let Some(l) = label {
                if let Some(w) = app.get_webview_window(&l) {
                    let _ = w.hide();
                    #[cfg(target_os = "windows")]
                    set_memory_usage_level(&w, true);
                }
            }
        }
        ToggleAct::Show => show_active(app),
    }
}

/// Opens (or focuses) the local settings window.
pub fn open_settings_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let builder = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title("Whatsapp.rust — Settings")
        .inner_size(440.0, 680.0)
        .resizable(false);

    #[cfg(target_os = "windows")]
    let builder = builder.additional_browser_args(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"
    );

    if let Ok(win) = builder.build() {
        #[cfg(target_os = "windows")]
        set_memory_usage_level(&win, true);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        append_file_base64, base64_encode, build_drop_payload, ensure_download_destination,
        mime_for, toggle_decision, ToggleAct, CHROME_UA,
    };

    #[test]
    fn chrome_ua_and_bridge_client_hints_agree_on_the_version() {
        // The UA header (Rust) and the client-hints shim (bridge.js) must present the
        // same Chrome major version, or WhatsApp sees an inconsistent browser.
        let major = CHROME_UA
            .split("Chrome/")
            .nth(1)
            .and_then(|s| s.split('.').next())
            .expect("CHROME_UA carries a Chrome/<major> token");
        let bridge = include_str!("../resources/bridge.js");
        assert!(
            bridge.contains(&format!("version: \"{major}\"")),
            "bridge.js client hints must advertise Chrome {major}"
        );
        assert!(
            bridge.contains(&format!("uaFullVersion: \"{major}.0.0.0\"")),
            "bridge.js uaFullVersion must advertise Chrome {major}"
        );
    }

    #[test]
    fn absolute_download_destination_is_kept() {
        #[cfg(not(target_os = "windows"))]
        let mut d = std::path::PathBuf::from("/home/user/Downloads/video.mp4");
        #[cfg(target_os = "windows")]
        let mut d = std::path::PathBuf::from("C:\\home\\user\\Downloads\\video.mp4");

        let elsewhere = if cfg!(target_os = "windows") {
            std::path::PathBuf::from("C:\\elsewhere")
        } else {
            std::path::PathBuf::from("/elsewhere")
        };

        let expected = d.clone();
        ensure_download_destination(&mut d, Some(elsewhere));
        assert_eq!(d, expected);
    }

    #[test]
    fn empty_download_destination_falls_back_to_download_dir() {
        let mut d = std::path::PathBuf::new();
        ensure_download_destination(&mut d, Some(std::path::PathBuf::from("/dl")));
        assert_eq!(d, std::path::PathBuf::from("/dl/download"));
    }

    #[test]
    fn relative_download_destination_moves_into_download_dir() {
        let mut d = std::path::PathBuf::from("clip.mp4");
        ensure_download_destination(&mut d, Some(std::path::PathBuf::from("/dl")));
        assert_eq!(d, std::path::PathBuf::from("/dl/clip.mp4"));
    }

    #[test]
    fn missing_download_dir_falls_back_to_temp() {
        let mut d = std::path::PathBuf::from("clip.mp4");
        ensure_download_destination(&mut d, None);
        assert_eq!(d, std::env::temp_dir().join("clip.mp4"));
    }

    #[test]
    fn base64_matches_rfc4648_vectors() {
        // The canonical RFC 4648 test vectors, including every padding case.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_handles_high_bytes() {
        assert_eq!(base64_encode(&[0xff, 0xff, 0xff]), "////");
        assert_eq!(base64_encode(&[0x00]), "AA==");
    }

    // Write `bytes` to a unique temp file and return its path. Caller removes it.
    fn write_temp(tag: &str, bytes: &[u8]) -> std::path::PathBuf {
        use std::io::Write;
        let p = std::env::temp_dir().join(format!(
            "whatrust_test_{}_{}_{tag}",
            std::process::id(),
            bytes.len()
        ));
        std::fs::File::create(&p).unwrap().write_all(bytes).unwrap();
        p
    }

    #[test]
    fn streaming_base64_matches_oneshot_across_chunk_boundary() {
        // append_file_base64 reads in 48 KiB chunks and carries 0..2 bytes between reads.
        // Exercise a size just past one chunk for each length-mod-3 case so the carry/padding
        // path is covered, and confirm it byte-for-byte matches the one-shot encoder.
        for extra in [0usize, 1, 2] {
            let len = 48 * 1024 + 3 + extra;
            let data: Vec<u8> = (0..len)
                .map(|i| (i.wrapping_mul(31).wrapping_add(7)) as u8)
                .collect();
            let path = write_temp(&format!("stream{extra}.bin"), &data);
            let mut streamed = String::from("prefix:"); // also proves it APPENDS, not overwrites
            let n = append_file_base64(&mut streamed, &path).unwrap();
            let _ = std::fs::remove_file(&path);
            assert_eq!(n, len as u64);
            assert_eq!(
                streamed,
                format!("prefix:{}", base64_encode(&data)),
                "mismatch at extra={extra}"
            );
        }
    }

    #[test]
    fn empty_file_streams_to_empty_base64() {
        let path = write_temp("empty.bin", b"");
        let mut s = String::new();
        let n = append_file_base64(&mut s, &path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(n, 0);
        assert_eq!(s, "");
    }

    #[test]
    fn build_drop_payload_roundtrips_name_type_b64() {
        // A small image + a video spanning the read-chunk boundary: the JSON must parse, and
        // each entry's name/type/b64 must round-trip (b64 == one-shot encoding of the bytes).
        let img_bytes: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5];
        let vid_bytes: Vec<u8> = (0..(48 * 1024 + 5)).map(|i| (i % 251) as u8).collect();
        let img = write_temp("shot.png", &img_bytes);
        let vid = write_temp("clip.mp4", &vid_bytes);
        let json = build_drop_payload(&[img.clone(), vid.clone()]).unwrap();
        let _ = std::fs::remove_file(&img);
        let _ = std::fs::remove_file(&vid);

        let v: serde_json::Value = serde_json::from_str(&json).expect("payload must be valid JSON");
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["type"], "image/png");
        assert_eq!(arr[0]["b64"], base64_encode(&img_bytes));
        assert!(arr[0]["name"].as_str().unwrap().ends_with(".png"));
        assert_eq!(arr[1]["type"], "video/mp4");
        assert_eq!(arr[1]["b64"], base64_encode(&vid_bytes));
        assert!(arr[1]["name"].as_str().unwrap().ends_with(".mp4"));
    }

    #[test]
    fn build_drop_payload_empty_for_no_files() {
        assert_eq!(build_drop_payload(&[]).unwrap(), "[]");
    }

    #[test]
    fn mime_is_extension_and_case_insensitive() {
        assert_eq!(mime_for("Photo.JPG"), "image/jpeg");
        assert_eq!(mime_for("clip.mp4"), "video/mp4");
        assert_eq!(mime_for("doc.pdf"), "application/pdf");
        assert_eq!(mime_for("noext"), "application/octet-stream");
        assert_eq!(mime_for("archive.unknownext"), "application/octet-stream");
    }

    #[test]
    fn modern_image_types_resolve_to_image_so_they_route_as_photos() {
        // The routing fix: bridge.js sends anything `image/*` to the Photos composer. These
        // used to fall through to octet-stream and were mis-attached as documents.
        for n in ["pic.avif", "IMG_1.HEIF", "shot.heic"] {
            assert!(
                mime_for(n).starts_with("image/"),
                "{n} should resolve to an image/* type, got {}",
                mime_for(n)
            );
        }
        // Niche raster formats are deliberately NOT routed as photos (WhatsApp's photo
        // composer may reject them) — they stay documents, which always sends.
        for n in ["scan.tiff", "icon.ico", "frames.apng"] {
            assert_eq!(
                mime_for(n),
                "application/octet-stream",
                "{n} should stay a document"
            );
        }
    }

    #[test]
    fn new_av_and_doc_types_have_specific_labels() {
        assert_eq!(mime_for("song.flac"), "audio/flac");
        assert_eq!(mime_for("clip.aac"), "audio/aac");
        assert_eq!(mime_for("movie.mpeg"), "video/mpeg");
        assert_eq!(mime_for("notes.md"), "text/markdown");
        assert_eq!(mime_for("data.json"), "application/json");
        assert_eq!(mime_for("Archive.7Z"), "application/x-7z-compressed");
        assert_eq!(mime_for("book.epub"), "application/epub+zip");
        // Unknown extensions still fall back so the file always sends.
        assert_eq!(mime_for("mystery.qwerty"), "application/octet-stream");
    }

    #[test]
    fn visible_active_window_is_hidden() {
        assert_eq!(toggle_decision(Some(true)), ToggleAct::Hide);
    }

    #[test]
    fn hidden_active_window_is_shown() {
        assert_eq!(toggle_decision(Some(false)), ToggleAct::Show);
    }

    #[test]
    fn no_active_window_is_shown() {
        assert_eq!(toggle_decision(None), ToggleAct::Show);
    }
}
