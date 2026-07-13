# whatRust App Lock — Design Spec

**Date:** 2026-06-01
**Status:** Approved (brainstorming → spec)
**Feature:** Optional app lock with a password baseline and per-platform biometric unlock (fingerprint / Windows Hello / Touch ID).

---

## 1. Goal & scope

Add an **optional** app lock to whatRust, enabled from Settings. When enabled, the
app requires authentication — a **password** (always) or, where the OS supports it,
a **biometric** unlock — before the user can see or interact with any account window.

This is an **access-control / shoulder-surfing** feature, **not encryption at rest**
(see §10). It gates the UI, not the bytes on disk.

### In scope
- Password baseline (Argon2id), works on Linux, Windows, macOS.
- Biometric unlock as an optional shortcut: Windows Hello, macOS Touch ID, Linux polkit (fingerprint where configured).
- Lock gate covering **all** windows (one `wa-*` per account + `settings`).
- Lock triggers: on launch, manual "Lock now", on hide-to-tray, on idle.
- Forgot-password recovery via session-wiping reset.
- Settings UI section + a dedicated lock screen.

### Out of scope (explicitly)
- **Encryption at rest** of WhatsApp session/message data. Called out so the UI does
  not imply protection it doesn't provide. May be a separate future feature.
- Per-account locks (the lock is app-wide).
- Cloud / synced password. The lock is local-only, no backdoor.

---

## 2. Research summary (grounded, adversarially verified)

Full brief produced by the `biometric-applock-research` workflow (28 agents, 22
risk-claims verified). Load-bearing conclusions:

- **No drop-in plugin.** `tauri-plugin-biometric` (official) is **mobile-only**
  (`#![cfg(mobile)]`; empty crate on desktop). `tauri-plugin-biometry` (community,
  the "y" one) covers Windows + macOS but **not Linux**.
- **`robius-authentication` is unsafe to use.** Shipped crates.io **0.1.1** has a Linux
  stub: async `authenticate()` calls `unimplemented!()` (**panics**), and
  `blocking_authenticate()` returns `Ok(())` **without verifying anything** (silent
  false-pass). The README/callback API is an unpublished 0.2.0. Repo archived
  2025-07-07. **Do not use.**
- Because the user wants Linux fingerprint too, the only viable path is **per-platform
  native code behind one Rust trait**.
- **Every OS auth path here returns yes/no, no key material** (Windows Hello, Touch ID
  via `DeviceOwnerAuthentication`, polkit, PAM, fprintd). It can gate the UI; it cannot
  decrypt anything. This is why the lock is access-control, not at-rest encryption.

Claim status (carried into this design):
- **CONFIRMED:** official plugin mobile-only; Windows needs
  `IUserConsentVerifierInterop::RequestVerificationForWindowAsync(hwnd,…)` (the UWP
  `RequestVerificationAsync` hangs); activation **factory** required (`CoCreateInstance`
  fails `0x80040154`); `CheckAvailabilityAsync` returns `Available` even for PIN-only;
  `LAPolicy::DeviceOwnerAuthentication` falls back to the login password;
  `NSFaceIDUsageDescription` not required for Touch ID; polkit `AllowUserInteraction`
  pops the DE agent dialog (Bitwarden ships this); all gates return no key; Argon2
  defaults = Argon2id; Tauri v2 capability scoping denies IPC to unmatched windows;
  `argon2 0.5.3` / `objc2-local-authentication 0.3.2` versions.
- **REFUTED:** `robius-authentication` "clean Err/None on Linux" — it panics / false-passes.
- **UNCERTAIN (verify on hardware):** that **ad-hoc** macOS signing (`codesign -s -`) is
  enough for `canEvaluatePolicy` / Touch ID. The in-app `LAContext` path is correct and
  needs no Apple signing in principle, but "ad-hoc is enough" is inferred, not Apple-
  documented. Smoke-test on a real Mac before claiming macOS support.

---

## 3. Architecture overview

```
                    ┌──────────────── locked? (LockState.unlocked == false) ───────────────┐
                    │                                                                       │
   launch ──▶ applock::load() ──▶ if enabled && lock_on_launch ──▶ lock_now()               │
                                                                     │                      │
   tray "Lock now" / hide-to-tray / idle-timeout ──────────────────▶ lock_now()             │
                                                                     │                      │
                          hide all wa-*/settings windows ; show `lock` window               │
                                                                     │                      │
                          lock.html ──invoke──▶ unlock(password)  ───┘                       │
                                          └────▶ unlock_biometric()                          │
                                          └────▶ reset_app_lock()                            │
                                                     │ on success                            │
                                          set unlocked = true ; close lock window ;          │
                                          re-show previously-visible windows  ──────────────┘
```

**The security boundary lives in the Rust backend, not the window layer.** Hiding
windows is UX only (DOM/state survive `hide()`). Tauri v2 does **not** authorize *app*
commands per-window — that is exactly why the repo already uses `is_remote(window)`
checks inside commands. We extend that same pattern (§6).

### New / changed files

| File | Change |
|---|---|
| `src-tauri/src/applock.rs` | **NEW.** Config struct, load/save, Argon2 hash/verify, reset logic, pure helpers + unit tests. |
| `src-tauri/src/biometric/mod.rs` | **NEW.** `Availability` enum, trait-style `availability()` / `authenticate()` dispatch, cfg-gated to platform modules + `compile_error!()` catch-all. |
| `src-tauri/src/biometric/windows.rs` | **NEW.** Windows Hello via `windows` crate. |
| `src-tauri/src/biometric/macos.rs` | **NEW.** Touch ID via `objc2-local-authentication`. |
| `src-tauri/src/biometric/linux.rs` | **NEW.** polkit via `zbus` + `zbus_polkit`. |
| `src-tauri/src/lock.rs` | **NEW.** `LockState`, `lock_now`, `unlock`, lock-window create/show, window hide/restore, idle watcher. |
| `src-tauri/src/commands.rs` | **EDIT.** Add lock commands; add `require_unlocked` guard to sensitive commands; suppress notification bodies while locked. |
| `src-tauri/src/tray.rs` | **EDIT.** Add "Lock now" menu item (only when lock enabled). |
| `src-tauri/src/lib.rs` | **EDIT.** `mod applock; mod biometric; mod lock;`, manage `LockState`, register commands, lock-on-launch in `setup`, gate `show_active`, spawn idle watcher. |
| `src-tauri/src/window.rs` | **EDIT.** `lock_on_hide` hook in the close-to-tray handler; `show_active` defers to the lock window when locked. |
| `src-tauri/capabilities/lock.json` | **NEW.** IPC capability for the `lock` window. |
| `src-tauri/Cargo.toml` | **EDIT.** Add `argon2`, `rand_core`/`OsRng`; per-target `windows`, `objc2-local-authentication`/`objc2-foundation`/`block2`, `zbus`/`zbus_polkit`, `user-idle`. |
| `src-tauri/tauri.conf.json` | **EDIT.** Bundle the polkit `.policy` file into the `.deb` (Linux); version bump. |
| `src-tauri/resources/com.karem.whatrust.policy` | **NEW.** polkit action definition (Linux). |
| `settings-ui/index.html` / `main.js` / `style.css` | **EDIT.** "Security" section + status wiring. |
| `settings-ui/lock.html` / `lock.js` / `lock.css` | **NEW.** Lock screen. |
| `README.md` | **EDIT.** App-lock section + honest at-rest caveat + per-platform notes. |

---

## 4. Data model & storage

New module `applock.rs`, persisted to **its own** file `app-lock.json` in
`app_config_dir()` (kept separate from `settings.json` so the password hash never
rides along with the general settings blob).

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppLockConfig {
    pub enabled: bool,             // master switch
    pub password_phc: Option<String>, // Argon2id PHC string; None when disabled
    pub biometric_enabled: bool,   // user opted in AND it was available at enable time
    pub lock_on_launch: bool,      // default true
    pub lock_on_hide: bool,        // default FALSE (user decision)
    pub idle_secs: u32,            // 0 = idle auto-lock off (default 0)
}

impl Default for AppLockConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            password_phc: None,
            biometric_enabled: false,
            lock_on_launch: true,
            lock_on_hide: false,
            idle_secs: 0,
        }
    }
}
```

- `password_phc` is the self-describing Argon2id PHC string (salt embedded). **A
  verifier is not a secret** (irreversible), so a plain file is correct — no keychain /
  Secret Service / DPAPI needed. The `keyring` crate is intentionally **not** a
  dependency; we would only need it if we stored a real secret (a decryption key), which
  is out of scope.
- `enabled` implies `password_phc.is_some()`. We never set `enabled = true` without a
  password.

**The hash never leaves the backend.** The settings/lock UIs read status through a
dedicated command (§7) that returns booleans only — never `password_phc`.

---

## 5. Password — the root of trust

- Crate: **`argon2 = "0.5.3"`** with `Argon2::default()` → Argon2id, version `0x13`,
  OWASP-baseline params (m=19456 KiB, t=2, p=1). Salt via
  `SaltString::generate(&mut OsRng)` (from `rand_core` / argon2's re-export).
- `hash_password(pw) -> String` (PHC) and `verify_password(pw, phc) -> bool`
  (`Argon2::default().verify_password`). Both pure, unit-tested.
- **Set / enable:** `set_app_lock_password(new, confirm)` — requires `new == confirm`
  and `new.chars().count() >= 4` (minimum 4 characters); stores PHC, sets
  `enabled = true`. Allowed only from a trusted, unlocked context (settings window).
- **Change:** `change_app_lock_password(current, new, confirm)` — verifies `current`.
- **Disable:** `disable_app_lock(current)` — verifies `current`, then clears
  `password_phc`, sets `enabled = false`, `biometric_enabled = false`.

---

## 6. The lock gate (security boundary)

### 6.1 State
```rust
pub struct LockState {
    pub unlocked: Mutex<bool>,        // false == locked
    pub hidden: Mutex<Vec<String>>,   // labels hidden by lock_now, to restore on unlock
}
```
Managed via `.manage(LockState::default())`. **Default `unlocked = true`** for the
common case (lock disabled). When lock is enabled, `setup` decides the initial state
(§8).

### 6.2 `lock_now(app)`
1. Set `unlocked = false`.
2. Record into `hidden` every currently-visible window whose label is `wa-*` or
   `settings`; `hide()` each.
3. Create-or-show the `lock` window (`lock.html`) with:
   `decorations(false)`, `always_on_top(true)`, `content_protected(true)` (blocks
   screen capture of the lock screen), `resizable(false)`, `skip_taskbar` left default,
   `focused(true)`. Register a `CloseRequested` handler that calls `api.prevent_close()`
   **while locked** (the X must not relaunch into an unlocked state).

### 6.3 `unlock(app)`
1. Set `unlocked = true`.
2. Close (destroy) the `lock` window.
3. Re-show each label recorded in `hidden`; clear it. If `hidden` was empty (e.g. locked
   at launch from the tray), fall back to `show_active`.

### 6.4 Command authorization (the real boundary)
Tauri v2 capability scoping governs *whether a window has IPC at all* and which
plugin/core permissions it has — it does **not** authorize app-defined commands
per-window. So, exactly like the existing `is_remote` checks:

- `is_lock_window(&window) -> bool` ≡ `window.label() == "lock"`.
- `require_unlocked(&app) -> Result<(), String>` → `Err("locked")` when
  `LockState.unlocked == false`.

Apply (four buckets):
- **Lock-screen actions** (`unlock`, `unlock_biometric`, `reset_app_lock`): callable
  **only** from the `lock` window (`is_lock_window`); these must work **while locked**,
  so they do **not** call `require_unlocked`.
- **Status read** (`get_lock_status` — booleans only, never the hash): callable from any
  non-remote window (`!is_remote`), **without** `require_unlocked`, because both the lock
  screen (while locked) and the settings window need it.
- **Sensitive commands** (`list/add/remove/rename/open_account`, `get_settings`,
  `set_settings`, `open_settings`, and all password/biometric config setters —
  `set_app_lock_password`, `change_app_lock_password`, `disable_app_lock`,
  `set_app_lock_options`, `set_biometric_enabled`): add `require_unlocked(&app)?` in
  addition to the existing `is_remote` guard. (These all run from the unlocked settings
  window; enabling the lock the first time happens while `unlocked == true`.)
- `notify` / `set_unread` (from hidden `wa-*` windows in the background): still
  processed, but `notify` **suppresses the body while locked** (§9).

### 6.5 New capability — `capabilities/lock.json`
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "lock-local",
  "description": "IPC for the app-lock screen. core:default for invoke; no remote, no account/notification perms.",
  "windows": ["lock"],
  "permissions": ["core:default"]
}
```
The lock window needs a capability so the IPC bridge exists; `core:default` is the same
grant the `settings` window already has. Per-command authorization is enforced in code
(§6.4), so this capability does not widen the attack surface.

---

## 7. Biometric — optional shortcut to the same gate

Common interface in `biometric/mod.rs`:
```rust
pub enum Availability { Available, NotConfigured, Unsupported }
pub fn availability() -> Availability;            // cheap, for showing/hiding the toggle
pub fn authenticate(reason: &str) -> Result<bool, String>; // blocking; true == verified
```
cfg-gated to one platform module each, with a `compile_error!()` catch-all (mirrors
`window.rs::apply_isolation`). Biometric is a **shortcut to the same gate** — a
successful biometric verification flips `unlocked = true` just like a correct password.
The password always remains a working fallback. Enabling biometric requires
`password_phc.is_some()` **and** one successful test `authenticate()` at enable time.

### 7.1 Windows — Windows Hello
- Crate: **`windows = "0.61"`** (matches Tauri 2.11.2's pinned `windows` so
  `window.hwnd()` HWND types unify — do **not** bump to 0.62). Features:
  `Security_Credentials_UI`, `Win32_System_WinRT`, `Win32_Foundation`, `Foundation`.
- `availability()`: `UserConsentVerifier::CheckAvailabilityAsync()?.get()?` →
  `Available` (note: `Available` even for PIN-only — acceptable, it's still a consent
  gate).
- `authenticate()`: get the active window HWND; obtain the interop factory via
  `windows::core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>()`
  (**not** `CoCreateInstance`, which fails `0x80040154`); call
  `RequestVerificationForWindowAsync(hwnd, &HSTRING::from(reason))?.get()?` and map
  `Verified` → `true`. **Must** call `CheckAvailabilityAsync` first (skipping it makes
  the verification hang). Call from a COM-initialized thread. The prompt may open behind
  the window → apply a focus/foreground nudge. Win11 build 22000+ only (older →
  `Unsupported`).

### 7.2 macOS — Touch ID
- Crates: **`objc2-local-authentication = "0.3.2"`**, `objc2-foundation`, `block2`.
- `availability()`: fresh `LAContext`, `canEvaluatePolicy(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)`
  to know if Touch ID hardware is present/enrolled (else `NotConfigured`).
- `authenticate()`: fresh `LAContext` (it caches success — never reuse), `evaluatePolicy`
  with **`LAPolicy::DeviceOwnerAuthentication`** (Touch ID **or** login-password
  fallback). The reply block runs on a **background thread** → bridge to sync via a
  `std::sync::mpsc` (or oneshot) channel. `localizedReason` must be **non-empty** (empty
  → ObjC exception → process abort). `NSFaceIDUsageDescription` not required (Touch ID,
  not Face ID). Keep `hardenedRuntime = true`. **Verify on real Mac hardware** that
  ad-hoc signing suffices (the one UNCERTAIN claim).

### 7.3 Linux — polkit
- Crates: **`zbus`**, **`zbus_polkit = "5.0.0"`**.
- Ship a polkit action file `com.karem.whatrust.unlock` to
  `/usr/share/polkit-1/actions/` (installed by the `.deb`; needs root **at install
  time**, not runtime). `<defaults>` use `auth_self` (authenticate as the current user;
  the DE's agent offers fingerprint where `pam_fprintd` is configured).
- `authenticate()`: `Connection::system()` (the **system** bus, not session); build the
  `Subject` from the current process; `Authority::check_authorization` with the
  `ALLOW_USER_INTERACTION` flag → pops the desktop's native polkit dialog; map
  `authorized == true` → `true`.
- `availability()`: `Available` if the polkit `Authority` is reachable on the system bus
  **and** the action is registered; otherwise `NotConfigured`. Realistically the system
  bus is reachable on native `.deb` installs; **Flatpak/Snap sandboxing breaks system-
  bus access**, and **AppImage never installs the `.policy`** → both report
  `NotConfigured` and the user uses the password (which always works). This best-effort
  posture is stated honestly in the UI and README.

---

## 8. Triggers

Each trigger is an independent toggle. Defaults when the lock is enabled:
`lock_on_launch = true`, `lock_on_hide = false`, `idle_secs = 0` (off). "Lock now" is an
always-available action, not a toggle.

- **On launch** (`setup`): if `enabled && lock_on_launch`, start with
  `unlocked = false`. Account windows still open (hidden) so background WhatsApp keeps
  delivering unread counts; the `lock` window is shown — **unless** the app launched
  with `--minimized` / `start_minimized`, in which case stay locked in the tray and show
  the lock window only on first reveal.
- **Manual "Lock now"** (`tray.rs`): a menu item shown only when `enabled`; calls
  `lock_now`.
- **On hide-to-tray** (`window.rs` close handler): when `enabled && lock_on_hide`, the
  close-to-tray path calls `lock_now` instead of a plain `hide()`.
- **On idle** (`lib.rs`): if `idle_secs > 0`, spawn a watcher (the **`user-idle`** crate)
  that polls system idle time on an interval and calls `lock_now` when it crosses the
  threshold. **Wayland caveat:** idle is under-reported on Wayland (may need the crate's
  `dbus` feature, or fall back to focus-based timing); documented, and mitigated by the
  off-by-default.

`show_active` (and the global-shortcut toggle, single-instance, macOS Reopen) must
defer to the lock window when `unlocked == false`: a reveal request shows/focuses the
`lock` window, never an account window.

---

## 9. Notifications & badge while locked

- **While locked, suppress notification bodies.** `notify` checks `LockState`; when
  locked it shows **nothing** (default) — no message preview leaks to the OS
  notification center or a lock screen. (Conservative default chosen with the user;
  could be relaxed to a generic "New message" title later.)
- **Keep the unread count badge.** `set_unread` continues to update the aggregate tray
  badge (a number only — no content), so the tray still reflects activity while locked.

---

## 10. Honest security framing (UI + README + this spec)

State plainly, everywhere the feature is described:

> App lock controls who can open whatRust's windows. It does **not** encrypt your data.
> Your WhatsApp session stays readable on disk to other software running as your user
> and to anyone with raw disk access, whether the app is locked or not.

- This matches Signal Desktop's posture ("at-rest encryption is not something Signal
  Desktop has ever claimed to provide").
- OS key stores wouldn't change this: DPAPI/`safeStorage` don't isolate same-user apps;
  the biometric/polkit/PAM gates return no key.
- Real at-rest protection = OS full-disk encryption (FileVault / BitLocker / LUKS), or a
  future feature where whatRust encrypts its data files with an Argon2-derived key — **out
  of scope here**, and the lock UI must not imply it.

---

## 11. Recovery — forgot password

A local lock has **no backdoor**. The lock screen offers **"Forgot password? Reset"**:
- Confirm dialog explaining it logs out **all** accounts.
- `reset_app_lock(app)` (callable only from the `lock` window): delete every account
  profile dir + the default webview store data + `accounts.json` + `app-lock.json`, then
  relaunch the app fresh (single `default` account, logged out, lock disabled).
- Security property: a thief who hits Reset gets an empty, logged-out app — no message
  access. Recovery and security are both satisfied because the data was only **gated**,
  not encrypted.
- Reset must reuse the existing `accounts::delete_profile` / profile-dir logic so paths
  stay correct. The pure path-selection logic is unit-tested against tmp dirs.

---

## 12. Settings & lock UIs

### 12.1 Settings — new "Security" section (`index.html` / `main.js`)
- **Enable app lock** → reveals password ×2 fields → `set_app_lock_password`.
- **Use biometric** toggle — rendered only when `availability() == Available`; label is
  per-OS ("Use Windows Hello" / "Use Touch ID" / "Use system authentication
  (fingerprint)"). Toggling on runs a test `authenticate()` first.
- **Trigger toggles:** lock on launch · lock on hide to tray · auto-lock when idle for
  [N] minutes (number input; 0/empty = off).
- **Lock now** button.
- **Disable app lock** → prompts for current password → `disable_app_lock`.
- The honest one-liner from §10, shown inline.
- All wired via a dedicated **`get_lock_status`** command returning
  `{ enabled, biometric_available, biometric_enabled, lock_on_launch, lock_on_hide,
  idle_secs }` — **never** the hash.

### 12.2 Lock screen (`lock.html` / `lock.js` / `lock.css`)
- App icon + title, password field, **Unlock** button.
- **Biometric** button when `biometric_enabled` — auto-triggers `unlock_biometric()` on
  load and offers a retry button.
- **"Forgot password? Reset"** link → confirm → `reset_app_lock`.
- Minimal, focused; RTL-friendly (project convention); inherits the existing style.

---

## 13. Cargo dependencies (additive)

```toml
[dependencies]
argon2 = "0.5.3"            # Argon2id password hashing (PHC strings)

[target.'cfg(target_os = "linux")'.dependencies]
zbus = "5"                 # system-bus client (zbus_polkit 5.0.0 requires zbus 5.x)
zbus_polkit = "5.0.0"      # polkit Authority.CheckAuthorization

[target.'cfg(windows)'.dependencies]
windows = { version = "0.61", features = [
  "Security_Credentials_UI", "Win32_System_WinRT", "Win32_Foundation", "Foundation",
] }                         # MUST match Tauri 2.11.2's windows version (HWND unify)

[target.'cfg(target_os = "macos")'.dependencies]
objc2-local-authentication = "0.3.2"
objc2-foundation = "0.3"   # NSString/reason
block2 = "..."             # evaluatePolicy reply block

[target.'cfg(any(target_os = "macos", windows, target_os = "linux"))'.dependencies]
user-idle = "0.6"          # idle-timeout trigger (Wayland caveat documented)
```
Exact `zbus`/`block2`/`user-idle` patch versions resolved during implementation against
the pinned tree. Version bump in `Cargo.toml` / `tauri.conf.json` / `Cargo.lock` at
release (post-implementation), not in this design.

---

## 14. Testing strategy

**Unit (pure, in-module `#[cfg(test)]`):**
- `applock`: hash→verify roundtrip; wrong password fails; PHC is Argon2id; config serde
  defaults (`lock_on_launch=true`, `lock_on_hide=false`, `idle_secs=0`); partial-JSON
  fill; `enabled` never true without a hash.
- `lock`: `require_unlocked` / `is_lock_window` predicates; hide/restore label
  bookkeeping (pure list logic).
- recovery: path-selection deletes exactly the expected set (account profiles + default
  store + accounts.json + app-lock.json) against tmp dirs — never touches anything else.
- `biometric`: `Availability` mapping for the pure branches; per-OS `availability()`
  error→`Unsupported`/`NotConfigured` mapping where testable without hardware.
- idle: threshold-crossing decision is a pure function of (idle_secs, elapsed).

**Smoke (manual, `cargo tauri dev` on Linux — the dev target):**
- Enable lock, set password, lock-now → all windows hide, lock screen shows.
- Wrong password rejected; correct password unlocks and restores windows.
- On-launch lock; hide-to-tray (toggle on); idle (set a short timeout).
- polkit dialog appears on a `.deb`-installed build with a polkit agent; password
  fallback when polkit is unavailable.
- Reset wipes sessions → fresh logged-out app.
- Verify a hidden `wa-*` window cannot reach account/settings commands while locked
  (the `require_unlocked` boundary).

**Hardware-pending (flagged, not blocking the Linux release):**
- Windows Hello prompt + fallback on Win11 22000+.
- Touch ID prompt + login-password fallback on a Mac; confirm ad-hoc signing suffices.

---

## 15. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Lock can be bypassed by force-showing a hidden window | The boundary is the in-command `require_unlocked` guard, not window visibility. |
| Lock window X relaunches unlocked | `prevent_close` while locked. |
| Message preview leaks on lock screen | Suppress notification bodies while locked (§9). |
| `windows` 0.62 HWND mismatch with Tauri 0.61 | Pin `windows = 0.61`. |
| macOS empty `localizedReason` → process abort | Always pass a non-empty reason. |
| macOS ad-hoc signing insufficient | Flagged UNCERTAIN; verify on hardware before claiming macOS support. |
| Linux: polkit unavailable (AppImage/Flatpak/Snap/no agent) | Best-effort; password always works; stated honestly. |
| User forgets password | Reset = wipe sessions, no data loss beyond logout. |
| User thinks lock = encryption | Explicit honest framing in UI/README/spec (§10). |

---

## 16. Build order (for the implementation plan)

1. `applock.rs` — config + Argon2 + tests (no UI yet).
2. `lock.rs` — `LockState`, `lock_now`/`unlock`, lock-window create/hide/restore.
3. `capabilities/lock.json` + `lock.html`/`lock.js`/`lock.css` (password-only unlock).
4. Command guards (`require_unlocked` / `is_lock_window`) + lock commands; wire
   `setup` lock-on-launch + `show_active` deferral.
5. Triggers: tray "Lock now", `lock_on_hide` hook, idle watcher.
6. Notifications-while-locked suppression.
7. Settings "Security" section + `get_lock_status`.
8. `biometric/` — Linux polkit first (dev target), then Windows, then macOS; wire
   `unlock_biometric` + enable-time test + UI toggle.
9. Recovery (`reset_app_lock`) + lock-screen reset link.
10. README + honest framing; smoke test on Linux.
