# whatRust Shortcut Recorder — Design Spec

**Date:** 2026-06-01
**Status:** Approved (brainstorming → spec)
**Branch:** builds on `feat/app-lock`
**Feature:** Set the global show/hide shortcut by **pressing the key combo** ("record"), instead of typing the Tauri accelerator string by hand.

---

## 1. Goal & scope

whatRust has one global show/hide shortcut, configured today by typing an accelerator
string (e.g. `CmdOrCtrl+Shift+W`) into a text field in Settings. This feature adds a
**Record** button: click it, press your combo, and it's captured and written into the
field in the correct accelerator format. It also surfaces shortcut **registration
failures**, which are currently swallowed.

### In scope
- A "Record" button beside the existing `#hotkey` field (the field stays, editable).
- Capture a key combo in the trusted settings webview and convert it to Tauri's
  accelerator syntax.
- Validation: accept a combo only if it has ≥1 modifier, or the key is a function key.
- Surface register failures on Save (instead of silently ignoring them).

### Out of scope
- Multiple shortcuts, per-account shortcuts, or in-app (non-global) shortcuts.
- Changing what the shortcut does (it still toggles show/hide of the active account).
- A native OS-level key recorder (we capture in the webview).

### Current state (what we build on)
- `settings-ui/index.html:30-33` — `<input type="text" id="hotkey" …>`.
- `settings-ui/main.js` — `load()` reads `s.hotkey` into the field; `save()` writes the
  field back to `s.hotkey` and calls `set_settings`.
- `src-tauri/src/settings.rs::apply` — on desktop, `gs.unregister_all()` then, if
  `hotkey_enabled` and non-empty, `let _ = gs.register(s.hotkey.as_str())` — **the
  register result is discarded.** `apply` returns `()`.
- `settings.rs::Settings.hotkey` defaults to `"CmdOrCtrl+Shift+W"`.

---

## 2. Recording UX (`index.html`, `main.js`, `style.css`)

- Wrap the existing Shortcut field and a new **`#record_hotkey`** button in a row.
- **Idle → recording:** clicking Record sets a `recording` flag, changes the button
  label to `Press keys… (Esc to cancel)`, remembers the field's prior value, and adds a
  **capture-phase** `keydown` listener on `window` that calls `preventDefault()` +
  `stopPropagation()` on every event while recording (so the combo can't trigger save,
  navigation, or anything else).
- **On `keydown` while recording:**
  - If the key is a bare modifier (`Control`/`Shift`/`Alt`/`Meta`) → ignore, keep
    waiting.
  - If `event.key === "Escape"` → cancel: restore the prior field value, exit recording.
  - Otherwise it's a candidate combo: build the accelerator from the modifier flags +
    `event.code` (§3) and validate (§4).
    - Valid → write it into `#hotkey`, exit recording.
    - Invalid (no modifier and not a function key) → show inline hint
      `Add a modifier (Ctrl / Alt / Shift)`, stay in recording.
    - Unmapped key → show inline hint `Unsupported key — try another`, stay in recording.
- **Exit recording** (any path): remove the listener, restore the button label
  (`Record`), clear the `recording` flag. Also exit/cancel on the settings window losing
  focus (`blur`) so a half-recorded state can't get stuck.
- Recording only fills the field; the user clicks **Save** to persist (unchanged flow).

---

## 3. Accelerator formatting — pure function `comboToAccelerator(mods, code)`

Pure, side-effect-free, testable. Input: `mods = {ctrl, alt, shift, meta}` (booleans)
and `code` (a `KeyboardEvent.code` string). Output: a Tauri accelerator string, or
`null` if the key is unmapped.

Use **`event.code`** (physical key), NOT `event.key` — so `Shift+1` records as `Shift+1`,
not `Shift+!`, independent of keyboard layout.

**Modifier tokens, emitted in this stable order:**
| Flag | Token | Notes |
|---|---|---|
| `ctrl` | `CmdOrCtrl` | Portable — maps to Cmd on macOS, Ctrl elsewhere (matches the default). |
| `alt` | `Alt` | |
| `shift` | `Shift` | |
| `meta` | `Super` | The Super/Win/Command key. |

**Key mapping (`event.code` → token):**
| `code` pattern | Token |
|---|---|
| `KeyA`…`KeyZ` | `A`…`Z` (strip `Key`) |
| `Digit0`…`Digit9` | `0`…`9` (strip `Digit`) |
| `F1`…`F24` | `F1`…`F24` (used as-is) |
| `ArrowUp/Down/Left/Right` | `Up/Down/Left/Right` |
| `Space` | `Space` |
| anything else | `null` (→ "unsupported key" hint) |

Result = modifiers (in order) + key, joined with `+`. Example: `{ctrl:true, shift:true}`
+ `KeyW` → `CmdOrCtrl+Shift+W`. `{}` + `F8` → `F8`.

---

## 4. Validation rule

A built accelerator is **accepted** iff:
- it has at least one modifier (`ctrl || alt || shift || meta`), **or**
- the key is a function key (`code` matches `^F([1-9]|1[0-9]|2[0-4])$`).

Otherwise it is **rejected** in the UI (inline hint, stay recording). Per the user's
choice, **Shift counts as a modifier** — so `Shift+W` passes UI validation. Note that
some OSes reject Shift-only global shortcuts at *registration* time; that path is handled
by §5 (the register-failure warning), so the UI doesn't need to second-guess it.

---

## 5. Register-failure feedback (`settings.rs`, `commands.rs`, `main.js`)

Today `apply` discards the register result. Change the plumbing so Save can report it:

- `settings::apply` → **`pub fn apply(app: &AppHandle, s: &Settings) -> Option<String>`**.
  Keep the autostart side effect. For the shortcut: `unregister_all()`, then if enabled +
  non-empty, `match gs.register(s.hotkey.as_str()) { Ok(_) => None, Err(e) => Some(e.to_string()) }`.
  If the shortcut is disabled/empty, return `None`. On `#[cfg(not(desktop))]`, return `None`.
- `commands::set_settings` → return **`Result<Option<String>, String>`**: after `save`,
  return `Ok(crate::settings::apply(&app, &settings))`. (Keep the `is_remote` +
  `require_unlocked` guards exactly as they are.)
- `lib.rs` `setup` calls `settings::apply(handle, &s)` at startup — change to
  `let _ = settings::apply(handle, &s);` (ignore the result there).
- `main.js` `save()`: `const warn = await invoke("set_settings", { settings: s });`
  then `note.textContent = warn ? ("Saved — shortcut not registered (may be in use): " + warn) : "Saved ✓";`
  Timing: the plain "Saved ✓" auto-clears after the existing 1.5s; the warning is left
  visible for **6s** (longer, so the user actually reads it).

---

## 6. Files

| File | Change |
|---|---|
| `settings-ui/index.html` | Wrap `#hotkey` + a new `#record_hotkey` button in a row; add a `#hotkey_hint` element for inline hints. |
| `settings-ui/main.js` | `comboToAccelerator` (pure), recording state machine, button wiring; `save()` handles the `set_settings` warning return. |
| `settings-ui/style.css` | Row layout for field+button; a `.recording` button style; `#hotkey_hint` style. |
| `src-tauri/src/settings.rs` | `apply` returns `Option<String>` (the register error). |
| `src-tauri/src/commands.rs` | `set_settings` returns `Result<Option<String>, String>`. |
| `src-tauri/src/lib.rs` | startup `apply` call ignores the return. |
| `settings-ui/comboToAccelerator.test.mjs` | **NEW** — a tiny `node` assertion script for the pure formatter. |

To make `comboToAccelerator` testable in `node` without a DOM or a bundler (the project
has no build step), and to avoid a drifting duplicate of the logic, it lives in **one
place**: `settings-ui/hotkey.js`. That file defines `comboToAccelerator(mods, code)`,
`isValidCombo(mods, code)`, and the function-key regex, and assigns them to
**`globalThis.HotkeyFmt`** (it must NOT reference `window`, which is undefined in node).
In the browser `globalThis === window`, so the page reads them as `window.HotkeyFmt`
after `<script src="hotkey.js">` (included before `main.js`); in node the test reads the
same `globalThis.HotkeyFmt`. One source, consumed by both — no aliasing, no duplication.

---

## 7. Error handling & edge cases

- Capture-phase `preventDefault`/`stopPropagation` while recording → the combo never
  leaks to other handlers (no accidental Save on Enter, no page scroll on Space/arrows).
- Bare modifiers ignored; Esc cancels; window `blur` cancels (no stuck state).
- Unmapped key → hint, stay recording (don't write a broken value).
- Invalid (no modifier, not F-key) → hint, stay recording.
- Register failure → non-blocking warning on Save; the value is still saved (the user can
  retry a different combo). Disabling the shortcut (`hotkey_enabled` off) → `apply`
  returns `None`, no warning.
- Only one recording session at a time (the button is the only entry point; re-clicking
  while recording cancels/restarts — define as: re-click cancels back to idle).

---

## 8. Testing

- **`comboToAccelerator` / `isValidCombo`** — pure; covered by `comboToAccelerator.test.mjs`
  run with `node settings-ui/comboToAccelerator.test.mjs` (exit non-zero on failure).
  Cases: `Ctrl+Shift+W → CmdOrCtrl+Shift+W`; bare `F8 → F8` (valid, no modifier);
  `Digit1`+Shift `→ Shift+1` (code-based, not `!`); `Meta`+`KeyK` `→ Super+K`; bare
  `KeyW` → built string `W` but `isValidCombo` false; unmapped `Comma` → `null`; modifier
  order is stable (`Ctrl+Alt+Shift+KeyP → CmdOrCtrl+Alt+Shift+P`).
- **Rust** — the `apply`/`set_settings` signature change compiles and the existing 45
  tests still pass. (No new Rust unit test: the register result needs a live `AppHandle`
  / OS shortcut service; covered by smoke.)
- **Smoke (Linux, `cargo tauri dev` or built binary)** — open Settings: Record →
  `Ctrl+Shift+W` fills `CmdOrCtrl+Shift+W`; Record → `F8` fills `F8`; Record → bare `A`
  shows the modifier hint and doesn't fill; Esc cancels and restores; Save with a valid
  combo → "Saved ✓" and the global shortcut toggles the window; Save with a deliberately
  bogus/again-registered combo → the "shortcut not registered" warning appears.

---

## 9. Build order (for the implementation plan)

1. `settings-ui/hotkey.js` — `comboToAccelerator` + `isValidCombo` + function-key regex
   (assigned to `globalThis.HotkeyFmt`; read as `window.HotkeyFmt` in the page).
2. `settings-ui/comboToAccelerator.test.mjs` — node assertion script; make it pass.
3. `index.html` — field+button row + hint element; include `hotkey.js` before `main.js`.
4. `main.js` — recording state machine wired to the button using `window.HotkeyFmt`.
5. `settings.rs` `apply` → `Option<String>`; `lib.rs` startup call ignores it.
6. `commands.rs` `set_settings` → `Result<Option<String>, String>`; `main.js` `save()`
   shows the warning.
7. `style.css` — row + recording + hint styles.
8. Smoke test on Linux.
