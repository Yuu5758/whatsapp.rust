<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" alt="Whatsapp.rust app icon — a lightweight WhatsApp Web desktop client">
</p>

# Whatsapp.rust — Lightweight WhatsApp Web Desktop Client (Rust + Tauri)

**Whatsapp.rust is a free, open-source, lightweight desktop client for WhatsApp Web that runs on Linux, Windows, and macOS — a lean, native alternative to the official Electron-based WhatsApp Desktop app, built with Rust and Tauri v2. It runs multiple WhatsApp accounts at once, each in its own window with a fully isolated login.**

![Latest release](https://img.shields.io/github/v/release/Yuu5758/whatsapp.rust?label=release)
![License: MIT](https://img.shields.io/github/license/Yuu5758/whatsapp.rust)
![Platforms: Linux, Windows, macOS](https://img.shields.io/badge/platforms-Linux%20%7C%20Windows%20%7C%20macOS-informational)
![Built with Rust and Tauri v2](https://img.shields.io/badge/built%20with-Rust%20%2B%20Tauri%20v2-orange)
![GitHub stars](https://img.shields.io/github/stars/Yuu5758/whatsapp.rust?style=social)

> **Unofficial, independent project** — not affiliated with, endorsed by, or sponsored by WhatsApp or Meta. Whatsapp.rust simply loads the official `web.whatsapp.com` interface in a native system webview.

## Contents

- [What is Whatsapp.rust?](#what-is-whatsapprust)
- [Why Whatsapp.rust? A lean, native WhatsApp Desktop alternative](#why-whatsapprust-a-lean-native-whatsapp-desktop-alternative)
- [Features](#features)
- [Run multiple WhatsApp accounts](#run-multiple-whatsapp-accounts)
- [Lock the app (optional)](#lock-the-app-optional)
- [Whatsapp.rust vs the official WhatsApp Desktop (Electron)](#whatsapprust-vs-the-official-whatsapp-desktop-electron)
- [Requirements](#requirements)
- [Installation](#installation)
- [Getting started](#getting-started)
- [FAQ](#faq)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)
- [License](#license)

## What is Whatsapp.rust?

Whatsapp.rust is an open-source **WhatsApp Web desktop client** for Linux, Windows, and macOS. It wraps the official `web.whatsapp.com` in your operating system's native webview and adds the desktop conveniences a browser tab can't — a system tray, native notifications, persistent login, global shortcuts, and microphone/camera access for voice messages and calls.

It is an **unofficial, open-source WhatsApp client** and a practical **WhatsApp Desktop alternative** for people who want a fast, native app with minimal overhead instead of the heavier Electron-based official build. It is not affiliated with WhatsApp or Meta.

## Why Whatsapp.rust? A lean, native WhatsApp Desktop alternative

**Whatsapp.rust's native app shell is small — typically around 90 MB** — because it reuses the webview that already ships with your OS instead of bundling its own browser engine the way Electron apps do. That gives it a much lighter baseline than the official Electron-based WhatsApp Desktop, which ships an entire Chromium runtime on top of the same WhatsApp Web page.

The official WhatsApp Desktop app is built on Electron, which packs an entire Chromium browser inside every app. Whatsapp.rust instead renders WhatsApp Web through the OS-native webview — **WebKitGTK** on Linux, **WebView2** on Windows, and **WKWebView** on macOS — via [Tauri v2](https://tauri.app). The result is a fast, native WhatsApp desktop app with a small footprint of its own.

> **A fair caveat on total memory:** your overall RAM use is dominated by **WhatsApp Web itself** and grows with how many chats, groups, and media you keep open — commonly a few hundred MB up to ~1 GB for busy accounts. That cost is roughly the same in any browser-based client (Whatsapp.rust, the official app, or a plain Chrome tab); Whatsapp.rust's advantage is the lean native shell, not lighter web content.

## Features

- **Multiple WhatsApp accounts** — run several numbers at once, each in its own window with a fully isolated login (add, rename, and remove accounts)
- **Optional app lock** — password (Argon2id) or biometric (Windows Hello / Touch ID / Linux polkit); locks on launch, on demand, on hide-to-tray, or after idle
- **System tray** icon with **close-to-tray** and an **unread message badge**
- **Native OS notifications** for new messages
- **Persistent login** — scan the QR code once, stay signed in across restarts
- **Voice messages** everywhere, plus **voice & video calls** where the system webview ships WebRTC (Windows and macOS; most Linux distros build WebKitGTK without WebRTC, so calling isn't available on Linux)
- **Drag and drop files and images** — drop a photo, video, or document straight onto a chat to attach it
- **Launch at startup** (auto-start), optional
- **Global keyboard shortcut** to show/hide the window (default `Ctrl/Cmd+Shift+W`; record your own by pressing the keys in Settings). On **Wayland**, bind `Whatsapp.rust --toggle` to a system shortcut instead — see the FAQ.
- **Single instance** — relaunching focuses the running window; `Whatsapp.rust --toggle` from a second launch shows/hides it
- **Remembers window size and position**
- **One-line install** on every platform
- **Cross-platform**: Linux, Windows, and macOS from one Rust + Tauri codebase

## Run multiple WhatsApp accounts

Whatsapp.rust runs **multiple WhatsApp accounts at the same time** — each account opens in its **own window** with a **completely isolated session** (separate cookies, local storage, and IndexedDB), so you can stay signed in to several numbers at once without them interfering.

- **Add an account** in **Settings → Accounts** with the **+ Add** button, then scan the new QR code; you can **rename** or **remove** accounts there too.
- Each account keeps its **own login, unread badge, and notifications**; the tray shows a **combined unread count** and a one-click switcher for every account.
- Your **first (default) account keeps its existing login** when you upgrade — no need to re-scan.

> **macOS note:** running **multiple accounts requires macOS 14 (Sonoma) or later**, where the system webview supports isolated data stores. On macOS 12–13 Whatsapp.rust runs a single account. Linux and Windows have no such limit.

## Lock the app (optional)

Whatsapp.rust can require a password — or a fingerprint / Windows Hello / Touch ID where your
OS supports it — before showing your chats. Enable it under **Settings → Security**.

- **Password** works on every platform (Argon2id, stored locally).
- **Biometric** is an optional shortcut: Windows Hello on Windows, Touch ID on any Mac
  that has it, and the system fingerprint dialog on Linux where polkit/`pam_fprintd` is
  configured (native `.deb` install only; the AppImage falls back to the password).
- Lock **on launch**, **on demand** (tray → *Lock now*), **when hidden to the tray**, or
  **after an idle timeout** — each toggleable in Settings.
- Forgot your password? **Reset** from the lock screen logs out all accounts and clears
  the lock (you'll re-scan the QR). There is no backdoor.

> **What the lock does and doesn't do:** it controls who can open Whatsapp.rust's windows. It
> does **not** encrypt your data on disk — your WhatsApp session stays readable to other
> software running as your user, locked or not (the same posture as Signal Desktop). For
> at-rest protection, use full-disk encryption (FileVault / BitLocker / LUKS).

## Whatsapp.rust vs the official WhatsApp Desktop (Electron)

| Feature | Whatsapp.rust | Official WhatsApp Desktop (Electron) |
|---|---|---|
| App-shell memory overhead | Lean native shell (~90 MB), no bundled browser | Heavier — bundles a full Chromium + Node runtime |
| Total RAM (with WhatsApp Web loaded) | Dominated by WhatsApp Web (similar across clients) | Dominated by WhatsApp Web **+** Electron runtime |
| Rendering engine | OS-native webview (WebKitGTK / WebView2 / WKWebView) | Bundled Chromium (Electron) |
| Built with | Rust + Tauri v2 | Electron (Chromium + Node.js) |
| Open source | ✅ Yes | ❌ No |
| Native Linux app | ✅ Yes | ⚠️ Limited |
| Windows / macOS | ✅ Yes | ✅ Yes |
| System tray + close to tray | ✅ Yes | ⚠️ Partial |
| Unread message badge | ✅ Yes | ✅ Yes |
| Native notifications | ✅ Yes | ✅ Yes |
| Voice messages (mic/camera) | ✅ Yes | ✅ Yes |
| Voice & video calls | ⚠️ Windows/macOS (Linux webview lacks WebRTC) | ✅ Yes |
| Multiple accounts (isolated sessions) | ✅ Yes | ❌ No |
| Optional app lock (password + biometric) | ✅ Yes | ❌ No |
| Global show/hide shortcut | ✅ Yes | ❌ No |
| Launch at startup | ✅ Yes | ✅ Yes |
| Affiliated with Meta | ❌ No (unofficial) | ✅ Yes |

## Requirements

| OS | Webview engine | Notes |
|---|---|---|
| **Linux** | WebKitGTK | Requires WebKitGTK **≥ 2.46.1** (older versions hang WhatsApp's QR login). AppImage may need `libfuse2`. |
| **Windows 10/11** | WebView2 | Uses the Evergreen WebView2 runtime (preinstalled on Windows 11). |
| **macOS** | WKWebView | macOS 12+ (running **multiple accounts** needs macOS 14+); the current build is Apple Silicon (arm64). |

## Installation

**Linux / macOS** — one line:
```bash
curl -fsSL https://raw.githubusercontent.com/Yuu5758/whatsapp.rust/master/install.sh | sh
```
Installs the AppImage to `~/.local/bin` on Linux (with an application-menu entry), or the `.dmg` app into `/Applications` on macOS (Apple Silicon). The macOS build is unsigned — if it warns on first launch, right-click the app → **Open**.

**Windows** — one line (PowerShell):
```powershell
irm https://raw.githubusercontent.com/Yuu5758/whatsapp.rust/master/install.ps1 | iex
```
Downloads and runs the latest NSIS installer (`.exe`); an `.msi` is also available on the release page.

**Manual download** — grab a `.AppImage`/`.deb`, `.dmg`, `.exe`, or `.msi` from the [latest release](https://github.com/Yuu5758/whatsapp.rust/releases/latest).

<details>
<summary><b>Build from source</b> (Rust + Cargo + Tauri CLI)</summary>

```bash
# Linux build dependencies (Ubuntu/Debian)
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libhunspell-dev patchelf

cargo install tauri-cli --version "^2.0" --locked

cargo tauri dev      # run in development
cargo tauri build    # build installers for the current OS
cd src-tauri && cargo test   # run the unit tests
```
</details>

## Getting started

1. Launch Whatsapp.rust. The WhatsApp Web QR screen appears.
2. On your phone, open **WhatsApp → Linked Devices → Link a Device** and scan the QR code.
3. You're in. Login persists, so you won't need to scan again next launch.
4. Closing the window hides Whatsapp.rust to the tray (toggle this in Settings). Use the tray icon or the global shortcut to bring it back.

## FAQ

### What is Whatsapp.rust?
Whatsapp.rust is a free, open-source, lightweight WhatsApp Web desktop client built with Rust and Tauri v2 for Linux, Windows, and macOS.

### Is Whatsapp.rust an official WhatsApp app?
No. Whatsapp.rust is unofficial and independent — not affiliated with WhatsApp or Meta. It loads the official `web.whatsapp.com` in a native webview.

### How is Whatsapp.rust different from the official WhatsApp Desktop app?
Whatsapp.rust uses your OS's native webview instead of bundling a Chromium engine (as Electron does), which makes it considerably lighter. See the [comparison table](#whatsapprust-vs-the-official-whatsapp-desktop-electron).

### How much RAM does Whatsapp.rust use?
Whatsapp.rust's own native shell is small — around 90 MB. Your **total** memory use is mostly WhatsApp Web's own footprint and scales with how many chats and how much media you keep open — commonly a few hundred MB up to ~1 GB for busy accounts, similar to WhatsApp Web in a browser tab.

### Is Whatsapp.rust lighter than the official WhatsApp Desktop app?
Its native shell is lighter because it doesn't bundle a Chromium browser engine the way the Electron-based official app does, so it has less baseline overhead. The WhatsApp Web content itself uses a similar amount in either app.

### Which operating systems does Whatsapp.rust support?
Linux (WebKitGTK), Windows 10/11 (WebView2), and macOS 12+ (WKWebView).

### Is Whatsapp.rust free and open source?
Yes — Whatsapp.rust is free and open source under the MIT License. The source is on [GitHub](https://github.com/Yuu5758/whatsapp.rust).

### Do voice messages, voice calls, and video calls work in Whatsapp.rust?
Voice messages work on every platform — Whatsapp.rust grants the webview microphone and camera access. Voice and video **calls** additionally need WebRTC inside the system webview: that's there on Windows (WebView2/Chromium) and macOS (WKWebKit), but most Linux distributions build WebKitGTK **without** WebRTC, so WhatsApp correctly reports that calling isn't supported on Linux. This is an engine limitation, not a permissions problem — if your distro ships a WebRTC-enabled WebKitGTK, calls light up automatically.

### Can I use multiple WhatsApp accounts in Whatsapp.rust?
Yes. Whatsapp.rust supports **multiple WhatsApp accounts** running at the same time — each opens in its own window with a fully isolated session, so different numbers stay logged in independently. Add, rename, and remove accounts from **Settings → Accounts**. On macOS this requires macOS 14 or later; Linux and Windows have no limit.

### Does Whatsapp.rust have an app lock?

Yes. You can set a password under **Settings → Security** to require authentication before Whatsapp.rust shows your chats. Biometric unlock (Windows Hello, Touch ID, or Linux polkit with an enrolled fingerprint) is an optional shortcut where the OS supports it. The lock controls window access — it does not encrypt data on disk (same posture as Signal Desktop). For at-rest protection use full-disk encryption.

### The global show/hide shortcut doesn't work on my Linux desktop (Wayland)

Wayland blocks apps from grabbing global hotkeys, so Whatsapp.rust's built-in shortcut can't fire on a Wayland session (GNOME, KDE Plasma's Wayland, etc.) — this is a platform limitation, not specific to Whatsapp.rust. The reliable approach is to let your desktop own the keybinding and have it toggle Whatsapp.rust:

1. **Settings → Keyboard → View and Customize Shortcuts → Custom Shortcuts → +** (GNOME; KDE has an equivalent under *Custom Shortcuts*)
2. Name it `Whatsapp.rust`, set the command to `Whatsapp.rust --toggle`, and assign your key (e.g. `Ctrl+Shift+W`).

`Whatsapp.rust --toggle` shows the window if it's hidden and hides it if it's visible — a true toggle that works on Wayland. (The built-in shortcut still works on X11, Windows, and macOS.)

### Does Whatsapp.rust support the system tray and close-to-tray?
Yes. It adds a system tray icon with an unread-message badge, can close to the tray, and forwards new messages to native OS notifications.

### Do I have to log in every time I open Whatsapp.rust?
No. Login is persistent — scan the QR code once via Linked Devices and you stay signed in across restarts.

### Is Whatsapp.rust safe? Does it read my messages?
Whatsapp.rust only loads the official `web.whatsapp.com` in a native webview and adds no message-handling layer of its own. It requests only the webview, microphone, and camera access that WhatsApp Web itself needs, and it is open source, so the code can be audited.

## Limitations

- **Windows unread count**: Windows tray icons ignore text labels, so the unread *number* appears only in the hover tooltip (the icon still switches to a badged variant). macOS and Linux show the count.
- **Notification click** does not yet focus the window — use the tray icon or the global shortcut.
- **macOS** builds are unsigned and currently Apple Silicon (arm64) only.
- **Multiple accounts on macOS** require macOS 14+ (older macOS runs a single account); Linux and Windows are unrestricted.

## Contributing

Contributions to this open-source WhatsApp client are welcome — open an issue or a pull request on [GitHub](https://github.com/Yuu5758/whatsapp.rust).

## Disclaimer

Whatsapp.rust is an unofficial, independent project. It is **not affiliated with, endorsed by, or sponsored by WhatsApp LLC or Meta Platforms, Inc.** "WhatsApp" is a trademark of its respective owner. Whatsapp.rust only loads the official `web.whatsapp.com` interface in a native webview and does not modify or intercept WhatsApp's services.

## License

Released under the [MIT License](LICENSE).

## Built with

[Rust](https://www.rust-lang.org/) · [Tauri v2](https://tauri.app/) · [WhatsApp Web](https://web.whatsapp.com/)
