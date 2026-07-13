# whatRust — Multi-Account Support (Design Spec)

**Date:** 2026-05-30
**Status:** Approved (design), pending implementation
**Branch:** `feat/multi-account`

## Goal

Let whatRust run several WhatsApp accounts at once (like the ZapZap client), each
with its own isolated login, so a user can stay signed in to multiple numbers
simultaneously. Cross-platform: Linux, Windows, macOS.

## Chosen approach

**Approach B — one native window per account (stable).** Each account is its own
`WebviewWindow` with isolated session storage. Accounts are managed dynamically
(add / rename / remove). This avoids Tauri's `unstable` multi-webview API (which
would be required for a single-window tab strip and still has an open
white-on-load bug, #10011). The trade-off — more taskbar entries instead of a
single-window tab strip — was accepted deliberately in favour of robustness.

## Background: current single-account architecture

- One `main` `WebviewWindow` loads `https://web.whatsapp.com/`
  (`WebviewUrl::External`) with the Chrome UA, `bridge.js` injection, mic/camera
  grants, the app icon, and a close-to-tray handler. (`window.rs`)
- One `settings` window loads local `index.html`. (`window.rs`)
- One tray with a single unread badge. (`tray.rs`)
- `bridge.js` (injected into web.whatsapp.com) shims `Notification`, reports the
  unread count via `document.title`, and patches client hints.
- `commands.rs`: `notify`, `set_unread` (callable from the remote page),
  `get/set/open_settings` (rejected for the remote page via
  `is_remote(window) = window.label() == "main"`).
- `settings.rs`: `Settings` struct persisted as JSON in the app config dir.
- All WhatsApp session data lives in the **default** webview store → exactly one
  account today.

## Target architecture

### 1. Data model & persistence — `accounts.rs` (new module)

```rust
struct Account { id: String, name: String, order: u32 }
struct AccountsFile { accounts: Vec<Account>, next_seq: u32 }
```

- Persisted as `accounts.json` in `app.path().app_config_dir()`.
- The migrated first account is `id = "default"`, `name = "WhatsApp"`, `order = 0`.
- New accounts get `id = format!("acct-{n}")` from the stored `next_seq` counter
  (monotonic, never reused), so a removed-then-re-added account never collides
  with a stale profile directory.
- Load: missing/blank/corrupt file → seed with a single `default` account
  (this is the seamless upgrade path for existing users).
- `serde(default)` so partial JSON fills in defaults, matching `settings.rs`.

### 2. Per-account session isolation (the crux)

`WebviewBuilder`/`WebviewWindowBuilder` expose:
- `.data_directory(PathBuf)` — honoured on **Linux & Windows**, ignored by
  WKWebView on macOS.
- `.data_store_identifier([u8; 16])` — **macOS ≥ 14 / iOS ≥ 17 only**
  (the `WKWebsiteDataStore` route).

Isolation rules:
- **`default` account** → no override → uses the default webview store →
  preserves the existing login (no re-scan on upgrade).
- **Additional accounts**:
  - Linux/Windows → `.data_directory(app_data_dir/profiles/<id>)`.
  - macOS ≥ 14 → `.data_store_identifier(uuid_bytes_from(id))`, where the 16
    bytes are derived deterministically from the account id (stable across
    launches).
- Removing an account deletes its `profiles/<id>` directory (Linux/Windows). On
  macOS the per-identifier store is left to the system (documented).

A single helper centralises this so `window.rs` stays platform-clean:
```rust
fn apply_isolation(builder, account, app) -> builder  // cfg-gated internally
```

### 3. Windows — `window.rs`

- Replace `create_main_window` with
  `open_account_window(app, &Account, start_hidden) -> Result<WebviewWindow>`:
  - label = `format!("wa-{}", account.id)` (e.g. `wa-default`, `wa-acct-2`).
  - title = `format!("whatRust — {}", account.name)`.
  - Carries everything the current window has: Chrome UA (`CHROME_UA`),
    `bridge.js` init script, `enable_webview_media`, app icon, inner/min size,
    close-to-tray handler (reads `close_to_tray` live, same as today).
  - Applies `apply_isolation` for non-default accounts.
- `show_main` → generalise to `show_account(app, &account_id)` (show + unminimize
  + focus). Keep a thin `show_active(app)` that targets the last-focused account.
- `open_settings_window` unchanged (still label `settings`).
- The window label `wa-<id>` is the single source of truth mapping any
  webview/window back to its account in all commands and the tray.

### 4. Commands & security — `commands.rs`

New **local-only** commands (callable from the `settings` window, never from a
WhatsApp page):
- `list_accounts() -> Vec<AccountView>` where
  `AccountView { id, name, order, unread: u32, open: bool }`.
- `add_account(name: String) -> Result<AccountView, String>` — append to config,
  open its window, rebuild tray. On macOS < 14 → `Err` with a clear message.
- `remove_account(id: String) -> Result<(), String>` — refuse to remove the last
  remaining account; close its window, drop config entry, delete its profile
  dir, rebuild tray.
- `rename_account(id, name) -> Result<(), String>` — update config, window title,
  tray.
- `open_account(id) -> Result<(), String>` — open (if needed) and focus.

Guard change: flip the predicate to
```rust
fn is_remote(window: &tauri::Window) -> bool { window.label().starts_with("wa-") }
```
So WhatsApp pages keep access to `notify`/`set_unread` but are denied every
account-management command; the local `settings` page is trusted.

Capability change: `capabilities/main-remote.json` `windows: ["main"]` →
`windows: ["wa-*"]` (Tauri capability glob) so every account window keeps
`notification:default`. `settings.json` unchanged.

### 5. Unread, notifications & tray

- New app state: `Mutex<HashMap<String /*account id*/, u32>>` for per-account
  unread, held via `app.manage(...)` and read in commands/tray.
- `set_unread(window, app, title)` — Tauri injects the calling `window`; map
  `window.label()` (`wa-<id>`) → account id, store the parsed count, recompute
  the aggregate (sum), then refresh the tray badge **and** the per-account counts
  in the menu. No `bridge.js` change (identification comes from the injected
  window label).
- `notify(window, app, title, body)` — prefix the account name when more than one
  account exists (`"Work: <title>"`); unchanged for a single account.
- `tray.rs`:
  - `rebuild_menu(app)` regenerates the menu from the current accounts list:
    one item per account showing its name + unread (e.g. `Work (3)`), then
    `Accounts…`, `Settings`, `Reload` (reloads the last-focused account), `Quit`.
  - Aggregate unread badge on the tray icon (sum across accounts), reusing the
    existing `badge_state` logic.
  - Called on add/remove/rename and on unread change.

### 6. Startup, migration, shortcut, single-instance — `lib.rs`

- Setup: load `accounts.json` (seed `default` if absent → seamless upgrade).
  Open **all** account windows (so every account receives messages/notifications),
  hidden to tray when *start minimized* / `--minimized`. Each window can be
  closed-to-tray and keep running, exactly like today.
- Track `active_account` (last-focused) in app state; update on window focus.
- Global shortcut + single-instance raise/toggle the active account window
  (fall back to the first account, then the settings window).
- Register the new commands in `generate_handler!`.

### 7. UI — Accounts manager (folded into the Settings window)

- `settings-ui/index.html` gains an **Accounts** section above the existing
  preferences: a list rendered from `list_accounts`, each row showing name +
  unread, with **Rename** and **Remove** (Remove confirms first); plus a
  **+ Add account** input/button. Existing preference toggles stay below.
- `settings-ui/main.js` adds the IPC calls (`list_accounts`, `add_account`,
  `rename_account`, `remove_account`, `open_account`) and re-renders on change.
- `settings-ui/style.css` gets minimal styling for the list. Keep the window
  small; allow it to grow a little taller if needed.
- On macOS < 14 the section shows a note and disables **+ Add**.

## macOS limitation (documented)

Multiple isolated accounts require **macOS 14+** (`data_store_identifier`). On
macOS 12–13, `+ Add` is disabled and the Accounts UI explains why; the single
`default` account still works. Linux & Windows have no such limit. README + FAQ
updated to state this.

## Files

**New**
- `src-tauri/src/accounts.rs` — model, persistence, id generation, isolation
  helper, per-account unread map + aggregate, migration.
- Accounts UI additions in `settings-ui/` (HTML/JS/CSS).

**Changed**
- `src-tauri/src/window.rs` — `open_account_window`, isolation, `show_account`.
- `src-tauri/src/tray.rs` — `rebuild_menu`, aggregate badge, per-account labels.
- `src-tauri/src/commands.rs` — account commands, `is_remote` prefix guard,
  per-account `set_unread`/`notify`.
- `src-tauri/src/lib.rs` — setup loads/opens accounts, app state, shortcut +
  single-instance target active account, register commands.
- `src-tauri/capabilities/main-remote.json` — `windows: ["wa-*"]`.
- `README.md` — multi-account feature + macOS caveat.

**Unchanged**
- `Cargo.toml` — no `unstable` flag (Approach B is stable).
- `settings.rs` (preferences), `unread.rs` (parser), `notify.rs`, `bridge.js`.

## Testing

**Unit (`cargo test`, in `accounts.rs` unless noted):**
- id generation: monotonic, never reused after removal.
- add → appended with correct order; remove → entry gone, others' order intact;
  rename → name updated.
- refuse to remove the last account.
- JSON (de)serialization round-trip; partial JSON fills defaults; empty/corrupt
  file → single `default` account (migration).
- profile-dir derivation is stable for a given id.
- aggregate-unread math (sum; zero when all clear) — extend tray badge tests.
- `is_remote`: `wa-*` → true, `settings` → false (in `commands.rs`).

**Build / manual:**
- `cargo build` (Linux) must succeed; existing tests stay green.
- Compile-check on all 3 OSes via the existing `check.yml` CI.
- Local Linux run: two accounts log in independently; per-account tray counts and
  aggregate badge update; rename/remove work; existing login survives the upgrade.

## Out of scope (v1 — YAGNI)

Per-account notification mute, custom avatars/colours, drag-to-reorder,
per-account "don't auto-start at login", and the single-window tab strip
(Approach A / `unstable` multi-webview). All deferrable.
