# whatRust Multi-Account — Authoritative Build Plan

Derived from the approved design spec (`2026-05-30-multi-account-design.md`) after a
de-risk pass that verified every risky Tauri API assumption against the **pinned**
versions (tauri 2.11.2, wry 0.55.1, tauri-plugin-window-state 2.4.1) and the
**vendored tauri source**. These corrections **override** the spec/blueprint where
they differ — implement exactly as written here.

## Corrections that override the spec (READ FIRST)

1. **macOS `data_store_identifier` MUST be a non-nil UUID.** `WKWebsiteDataStore.dataStoreForIdentifier:`
   raises `NSInvalidArgumentException` on the all-zeros UUID and wry does **not** guard it.
   → Each non-default account gets a **persisted** `store_uuid: Option<[u8;16]>` in
   `accounts.json`, generated once at creation with RFC-4122 v4 bits set
   (`b[6]=(b[6]&0x0F)|0x40; b[8]=(b[8]&0x3F)|0x80`), `debug_assert!(b != [0;16])`,
   and force `b[0]=1` if degenerate. **No `DefaultHasher`** (avoids nil-UUID *and*
   cross-Rust hash-instability). `default` account keeps `store_uuid: None`.

2. **`objc2-foundation` is required for the macOS<14 check** — the only `Cargo.toml`
   change. Add under `[target.'cfg(target_os = "macos")'.dependencies]`:
   `objc2-foundation = { version = "0.3", features = ["NSProcessInfo"] }`
   (already resolved at 0.3.2 in Cargo.lock — no new download; the feature must be
   explicit). Use `NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(...)`,
   **not** a `sw_vers` subprocess.

3. **`WebviewWindowBuilder` has THREE generic params:** `WebviewWindowBuilder<'a, R, M>`.
   `apply_isolation` must use `WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle<tauri::Wry>>`
   (`AppHandle<R>: Manager<R>`). The two-param form would not compile.

4. **`data_directory` / `data_store_identifier` are NOT cfg-gated in tauri** — both
   compile on every platform (only the runtime effect is platform-specific).
   `apply_isolation` cfg-gates *which* method to call (behavior), plus a
   `compile_error!()` catch-all arm so a future platform can't silently skip isolation.

5. **`lib.rs` global-shortcut handler hardcodes `get_webview_window("main")`** — replace
   with active-account logic via `window::show_active`. `show_main` becomes a
   `show_active` shim, so single-instance + macOS `Reopen` need no further change.

6. **`tray.rs` `toggle()`/`setup()` hardcode `"main"` and a `show` menu id** — replace
   with `show_active` + per-account `acct:<id>` items. Keep `badge_state` + its tests.

7. **`window.rs`**: remove the blueprint's dead double-binding of `url`; use the existing
   `let url = "...".parse().expect("valid url"); WebviewUrl::External(url)`. Bump the
   **settings window** `inner_size(440,560) → (440,680)` to fit the Accounts section.

8. **Deadlock avoidance**: `set_unread` must drop all `UnreadMap` guards (block scopes)
   **before** calling `tray::rebuild_menu` (which re-locks `UnreadMap`).

9. **Focus listener** for `ActiveAccount` is registered **inside** `open_account_window`
   (one helper), so startup *and* dynamically-added windows get it exactly once.

Confirmed-OK (no change): capability `windows: ["wa-*"]` glob (idiomatic); `IsMenuItem<R>`
is object-safe (the `Vec<Box<dyn IsMenuItem<Wry>>>` menu pattern compiles); window-state
tolerates dynamic labels (stale entries for removed accounts are benign; monotonic
`next_seq` prevents id reuse); IPC injects the calling `wa-<id>` window label into commands.

## Ordered steps (each must keep the crate compiling)

1. **`src-tauri/src/accounts.rs` (new)** — `Account { id, name, order, store_uuid: Option<[u8;16]> }`;
   `AccountsFile { accounts, next_seq }` with `#[serde(default)]`, `Default` = one
   `{id:"default", name:"WhatsApp", order:0, store_uuid:None}`, `next_seq:1`. Types
   `pub type UnreadMap = Mutex<HashMap<String,u32>>`, `pub type ActiveAccount = Mutex<String>`.
   Persistence mirrors `settings.rs` (`app_config_dir()/accounts.json`, mkdir -p, load-or-default, save).
   Pure mutations: `add(f,name)->Account` (`id=acct-{next_seq}`, `next_seq+=1`, `order=max+1`,
   `store_uuid=Some(gen_store_uuid())`); `remove(f,id)->Result<Account,String>` (Err if `len<=1`
   or not found); `rename(f,id,name)->Result<(),String>`. Helpers: `window_label(id)="wa-{id}"`,
   `id_from_label(label)=strip_prefix("wa-")`, `profile_dir(app,id)=app_data_dir()/profiles/<id>`,
   `delete_profile(app,id)` (cfg(not macos) `remove_dir_all`; macos no-op), `gen_store_uuid()->[u8;16]`
   (SystemTime nanos XOR thread-local counter; set v4 bits; non-nil guaranteed; **no DefaultHasher**),
   `aggregate_unread(&HashMap<String,u32>)->u32`. Add `#[cfg(test)]` tests (see test list). Run
   `cargo test --lib accounts` green before continuing.
2. **`lib.rs`** — add `mod accounts;` only. `cargo check`.
3. **`Cargo.toml`** — add the macOS `objc2-foundation` dep (correction #2). Inert on Linux.
4. **`commands.rs`** — `is_remote = label.starts_with("wa-")` + a `is_remote_label(&str)->bool`
   delegate for tests. Rewrite `set_unread` (per-account insert → aggregate → `update_badge`
   → `rebuild_menu`, guards dropped first). Rewrite `notify` (prefix `"<name>: "` when `>1`
   account). Add `AccountView{id,name,order,unread,open}` + the 5 local-only commands
   (`list_accounts/add_account/remove_account/rename_account/open_account`), each guarded by
   `is_remote`. `add_account` runs the macOS<14 `NSProcessInfo` guard first. `cargo check`.
5. **`window.rs`** — replace `create_main_window` with `open_account_window(app,&Account,start_hidden)`
   (label `wa-<id>`; reuse existing window if present; UA/bridge/icon/sizes as today; `apply_isolation`
   before `.build()`; close-to-tray + `register_focus_listener` + `enable_webview_media` after).
   Add `apply_isolation` (3-param generics, cfg-gated method choice, compile_error catch-all),
   `register_focus_listener`, `show_account(app,label)`, `show_active(app)`, `show_main` shim.
   Bump settings window to `(440,680)`. `cargo check`.
6. **`tray.rs`** — keep `BadgeState`/`badge_state`/icons/tests. Add `rebuild_menu(app)`
   (per-account `acct:<id>` items with `name (n)`, then `accounts/settings/reload/quit`;
   drop the `UnreadMap` guard before building static items). Rewrite `setup` (placeholder
   menu; `on_menu_event` handles `acct:` prefix → `show_account`, else the static ids;
   `reload` targets active account; left-click → `show_active`). `update_badge` unchanged.
   `cargo check`.
7. **`lib.rs` (full)** — single-instance + global-shortcut → `show_active`/active label;
   `.manage(UnreadMap::default())` + `.manage(ActiveAccount::new("wa-default".into()))`;
   register the 5 new commands; `setup`: load accounts, **backfill** missing `store_uuid`
   for non-default accounts (save if changed), open a window per account, `tray::setup` +
   `tray::rebuild_menu`, `settings::apply`. `cargo build`.
8. **`capabilities/main-remote.json`** — `windows: ["main"] → ["wa-*"]`; everything else
   unchanged. `settings.json` stays `["settings"]`. `cargo build` (ACL recompiles).
9. **`settings-ui/style.css`** — append accounts-UI rules (don't modify existing).
10. **`settings-ui/index.html`** — Accounts section (title, `#accounts-list`, add-row,
    hidden macOS note, divider) above a new Preferences title; existing rows unchanged.
11. **`settings-ui/main.js`** — `loadAccounts()` + `renderAccounts()` (open/rename/remove,
    Remove disabled when `len<=1`, macOS-14 error → disable add + show note); call
    `loadAccounts()` in `DOMContentLoaded`; keep `load()/save()`.
12. **Full `cargo test --lib` + `cargo build`** (all 12 existing tests stay green; new tests pass),
    then Linux smoke test (default login preserved; add/rename/remove; isolated profile dir;
    aggregate badge + per-account menu counts; last-account removal refused).

## Unit test list

`accounts::tests`: default_file_has_single_default_account; add_increments_seq_and_order;
added_account_has_non_nil_store_uuid; gen_store_uuid_is_non_nil_and_v4_shaped;
gen_store_uuid_differs_across_calls; remove_works_and_preserves_others;
cannot_remove_last_account; remove_unknown_id_is_err; rename_updates_name;
rename_unknown_id_is_err; json_roundtrip; partial_json_fills_defaults; empty_json_gives_default;
default_account_store_uuid_is_none_after_roundtrip; window_label_format; id_from_label_round_trips;
aggregate_unread_sums_all; aggregate_unread_zero_when_all_clear.

`commands::tests`: is_remote_wa_prefix_is_true; is_remote_wa_acct_is_true; is_remote_settings_is_false.

Existing (must stay green): `tray::tests` (2), `settings::tests` (4), `unread::tests` (6).

## Open questions (macOS, non-blocking on Linux/Windows)

- The macOS paths (`objc2-foundation` NSProcessInfo, `.data_store_identifier()`, the macOS<14
  add guard) can only be **code-reviewed** here (Linux build host) — validate on a macOS 14+
  machine before any macOS release. cfg-gating keeps the Linux/Windows builds clean.
- `store_uuid` backfill (step 7) gives any pre-existing extra account a fresh persisted UUID →
  one-time re-login on macOS. Acceptable: the feature has not shipped, so no such accounts exist
  in the wild.
