# whatRust — Design Spec

**Date:** 2026-05-30
**Status:** Approved (design), pending implementation plan
**Author:** Karem + Claude

## 1. Summary

whatRust is a lightweight, cross-platform (Linux / Windows / macOS) desktop client
that wraps **WhatsApp Web** in a **Tauri v2** native shell. WhatsApp provides the chat
UI inside a single **system webview**; whatRust provides a fast, low-RAM native
container with system tray, native OS notifications, persistent login, autostart, and
global shortcuts.

Because Tauri uses the OS's own webview (WebKitGTK on Linux, WebView2 on Windows,
WKWebView on macOS) instead of bundling Chromium, idle RAM is typically **5–10× lower**
than the official Electron-based WhatsApp Desktop. This is the core goal: **RAM-friendly
and responsive.**

Chosen architecture: **Approach A** — direct wrapper + injected bridge + a tiny local
settings window.

### Goals
- Native desktop wrapper around WhatsApp Web, minimal RAM, snappy.
- Real native features: tray + close-to-tray + unread badge, native notifications,
  persistent login, autostart, global show/hide shortcut.
- Cross-platform (develop on Linux first; Windows/macOS via CI).

### Non-goals (v1, YAGNI)
Multi-account, custom chrome/titlebar, spellcheck config UI, themes, dock/taskbar
overlay badges (basic tray badge only), Arabic/RTL settings UI, in-app auto-update.
All are clean follow-ups.

### Definition of "responsive"
The chat UI is WhatsApp Web's own responsive layout. "Responsive" here means: the
native shell stays snappy — Rust event handlers are light and non-blocking, the title
observer is debounced, the window resizes cleanly, and the settings window is created
lazily (only when opened) and destroyed on close to save RAM.

## 2. Project structure

```
whatRust/
├─ src-tauri/
│  ├─ src/
│  │  ├─ main.rs            # entry (no-console on Windows) → lib::run()
│  │  ├─ lib.rs            # Builder: plugins, setup, run
│  │  ├─ window.rs         # main webview: UA, init-script, close-to-tray
│  │  ├─ tray.rs           # tray icon, menu, unread badge
│  │  ├─ commands.rs       # #[command] notify, set_unread, get/set_settings
│  │  ├─ settings.rs       # Settings struct + JSON persistence + side effects
│  │  ├─ notify.rs         # native notification + click-to-focus
│  │  └─ unread.rs         # pure title→count parser (unit tested)
│  ├─ capabilities/
│  │  ├─ main.json         # main window: remote-scoped to web.whatsapp.com
│  │  └─ settings.json     # settings window: local
│  ├─ resources/bridge.js  # injected into WhatsApp Web
│  ├─ icons/               # app icon + tray normal/unread
│  ├─ tauri.conf.json
│  ├─ Cargo.toml
│  └─ build.rs
├─ settings-ui/            # tiny local settings page (vanilla HTML/CSS/JS, no build step)
│  ├─ index.html
│  ├─ main.js
│  └─ style.css
├─ package.json            # @tauri-apps/cli + plugin JS packages
└─ README.md
```

Vanilla JS for the settings page (~6 toggles) keeps the bundle tiny and avoids a
frontend build toolchain. Swapping to Vite+React, and adding Arabic/RTL, are cheap
follow-ups; v1 is English-only.

## 3. Crate / plugin stack (verified against Tauri 2.9.5)

| Crate | Purpose | Notes |
|---|---|---|
| `tauri` v2 (`features = ["tray-icon", "image-png"]`) | Core, webview, tray | tray is core, not a plugin; `image-png` needed for runtime icon swap |
| `tauri-build` v2 | build-dep, context codegen | |
| `tauri-plugin-notification` v2 | native notifications | JS path needs `notification:default` capability |
| `tauri-plugin-autostart` v2 | launch at login | `MacosLauncher::LaunchAgent`; optional args `["--minimized"]` |
| `tauri-plugin-global-shortcut` v2 | show/hide hotkey | handler is 3-arg `(app, shortcut, event)`; match `event.state()` to fire once |
| `tauri-plugin-single-instance` v2 | focus existing instance | **MUST be registered first**; no capability needed |
| `tauri-plugin-window-state` v2 | remember size/position | auto-saves on exit |

Desktop-only plugins (autostart, global-shortcut, single-instance, window-state) are
gated with `#[cfg(desktop)]` and added with a target cfg so mobile builds don't break.

npm packages (for the JS API surface used by settings-ui): `@tauri-apps/cli`,
`@tauri-apps/api`, `@tauri-apps/plugin-autostart`, `@tauri-apps/plugin-global-shortcut`,
`@tauri-apps/plugin-notification`. Tray JS API is core: `@tauri-apps/api/tray`.

## 4. Loading the WhatsApp page

Main window points directly at `https://web.whatsapp.com/` via
`WebviewUrl::External(url)` with:

- `.user_agent(CHROME_UA)` — a **current desktop Chrome UA** so WhatsApp Web does not
  show "update your browser". WebKitGTK's default Safari UA is rejected.
  UA target: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)
  Chrome/<recent>.0.0.0 Safari/537.36` (per-OS string; pin to a recent stable Chrome
  major and bump occasionally).
- `.initialization_script(bridge.js)` — runs after the global object is created but
  **before** WhatsApp's scripts and before document parse. Main frame only. Origin-guarded.
- `withGlobalTauri: true` (in `tauri.conf.json`) so the API is at `window.__TAURI__` for
  the remote page (the npm package is not present inside web.whatsapp.com).
- A capability for the main window scoped to the remote origin
  (`"remote": { "urls": ["https://web.whatsapp.com/*"] }`) exposing **only** our two safe
  commands (`notify`, `set_unread`). No fs/shell/dangerous commands reachable from the
  remote page.
- `incognito` left **off** and a **stable bundle identifier** `com.karem.whatrust` →
  cookies/localStorage/IndexedDB persist across restarts automatically (login persists).
  Changing the identifier later logs the user out — keep it stable.

Documented fallback if remote-origin IPC misbehaves on a platform: taurapp's trick of a
local `index.html` that `location.replace()`s to web.whatsapp.com, keeping the app a
"local" origin for IPC.

Window creation happens in `setup()` (or an async context), **never** in a synchronous
`#[tauri::command]`, to avoid the WebView2 deadlock (wry#583).

## 5. `bridge.js` — injected glue

Only touches stable web APIs (title + Notification), never WhatsApp's DOM internals, so
WhatsApp UI changes can't break it. Whole script is origin-guarded and wrapped in
try/catch.

1. **Client-hints shim** — define `navigator.userAgentData` (undefined in WebKitGTK) so
   WhatsApp's capability check passes.
2. **Notification override** — replace `window.Notification` with a shim class that:
   - stubs `Notification.permission = 'granted'` and `requestPermission()` → `'granted'`
   - forwards `{title, body, icon?}` to `window.__TAURI__.core.invoke('notify', …)`
   - returns an object exposing `onclick`/`close()` so WhatsApp's usage doesn't error
3. **Unread observer** — `MutationObserver` on `<title>`; parse leading `(N)` from
   `document.title` (e.g. `(3) WhatsApp`); on change call
   `window.__TAURI__.core.invoke('set_unread', { count })`. Title is the stable source
   (DOM class names change frequently).

## 6. Rust side — data flow

- **notify(title, body)** → `tauri-plugin-notification` shows OS notification. Click →
  `show + unminimize + set_focus` the main window.
- **set_unread(count)** → `tray.rs`:
  - `set_title(Some(n))` (Linux/macOS) **and** `set_tooltip(Some("n unread"))`
    (Windows/macOS) — platform-asymmetric so we set both.
  - swap tray icon to a badged PNG (works on all 3 OSes); count 0 → normal icon.
- **settings** → `settings.json` in app config dir, fields:
  `closeToTray` (default true), `startMinimized` (default false), `autostart`
  (default false), `hotkeyEnabled` (default true), `hotkey`
  (default `CmdOrCtrl+Shift+W`), `notifications` (default true).
  `get_settings` returns it; `set_settings` writes it and **applies side effects
  immediately**: enable/disable autostart plugin; register/unregister global shortcut.

## 7. Lifecycle

1. `tauri-plugin-single-instance` registered **first** → a 2nd launch focuses the
   existing (possibly tray-hidden) window instead of starting a new process.
2. `setup()`:
   - load settings,
   - create the main webview window (geometry restored by window-state),
   - register tray icon + menu: **Show/Hide · Settings · Reload · Quit**,
   - register the global shortcut (if enabled),
   - sync autostart to the setting.
3. Settings window created **lazily** only when "Settings" is chosen, and destroyed on
   close (saves RAM).
4. **Close**: intercept `WindowEvent::CloseRequested` → if `closeToTray`,
   `api.prevent_close()` + `window.hide()`; else quit.
5. `--minimized` CLI arg or `startMinimized` setting → start hidden in tray.
6. Tray left-click toggles window (note: Linux does not support left-click tray events —
   rely on the tray menu there). Tray menu always works on all platforms.

## 8. Cross-platform notes

- **Linux (primary dev box, Ubuntu 24.04):** requires WebKitGTK **≥ 2.46.1** (older
  hangs the QR-login spinner — WebSocket bug). System deps: `libwebkit2gtk-4.1-dev`,
  `libayatana-appindicator3-dev`, `libxdo-dev`, `librsvg2-dev`, `libhunspell-dev`,
  plus the standard Tauri build deps. Bundles: `.deb` + AppImage. Tray needs an
  appindicator implementation.
- **Windows:** WebView2 (evergreen runtime). Create the window in `setup()` not a sync
  command (deadlock). Bundles `.msi`/NSIS — needs Windows or CI.
- **macOS:** WKWebView. Autostart via LaunchAgent. Dock badge via `set_badge_label`
  (basic v1 uses tray badge only). Bundle `.dmg` — needs a Mac or CI.
- whatRust is **developed and run on Linux first**; Windows/macOS bundles are produced
  via GitHub Actions (cross-building mac/win locally is not possible).

## 9. Error handling

- Offline / page load failure → WhatsApp Web shows its own error; whatRust adds a
  **Reload** tray item + hotkey.
- Old WebKitGTK → runtime version check warns the user (login would otherwise hang).
- `bridge.js` is origin-guarded + try/catch and only depends on stable web APIs, so a
  WhatsApp front-end change cannot crash the shell.
- Minimal, capability-scoped command surface from the remote page → security boundary.

## 10. Testing strategy

**TDD on pure logic (Rust unit tests):**
- `unread.rs`: title → count parser (`"(3) WhatsApp"` → 3, `"WhatsApp"` → 0,
  `"(99+) WhatsApp"`, malformed → 0).
- `settings.rs`: (de)serialization round-trip; defaults; setting → side-effect mapping.
- `tray.rs`: badge-state selection (count 0 → normal icon; >0 → badged + label).

**bridge.js:** extract the title-parse function and unit-test it under Node.

**Manual smoke checklist:**
- QR login persists across an app restart (no re-scan).
- New-message native notification fires; clicking it focuses the window.
- Tray unread badge updates as messages arrive / are read.
- Close-to-tray works; reopening from tray restores.
- Global show/hide hotkey works.
- Autostart toggle actually registers/unregisters at OS login.

## 11. Build / run

- Dev: `cargo tauri dev`
- Build: `cargo tauri build`
- Prereqs to install: `tauri-cli` (`cargo install tauri-cli --version "^2"`), Linux
  system deps listed in §8.

## 12. Key references (from grounding research)

- Tauri v2 WebviewWindowBuilder (user_agent, initialization_script, data_directory,
  incognito): https://docs.rs/tauri/2.9.5/tauri/webview/struct.WebviewWindowBuilder.html
- WebviewUrl / WindowEvent::CloseRequested / CloseRequestApi::prevent_close (docs.rs tauri 2.9.5)
- System tray (core): https://v2.tauri.app/learn/system-tray
- Plugins: https://v2.tauri.app/plugin/{notification,autostart,global-shortcut,single-instance,window-state}
- Config (withGlobalTauri, windows[].url/userAgent): https://v2.tauri.app/reference/config/
- Calling Rust from JS: https://v2.tauri.app/develop/calling-rust/
- Reference wrappers: WaLinux (Tauri, Chrome-UA spoof, JS notification shim), taurapp
  (local-redirect trick), eneshecan/whatsapp-for-linux (GTK feature checklist).
- wry#583 (WebView2 sync-command deadlock): https://github.com/tauri-apps/wry/issues/583
