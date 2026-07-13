# Shortcut Recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user set the global show/hide shortcut by pressing the key combo ("Record"), and surface shortcut-registration failures instead of swallowing them.

**Architecture:** A "Record" button in the settings webview captures a `keydown` (capture-phase, `preventDefault`) and converts the modifier flags + `event.code` into a Tauri accelerator string via a pure `comboToAccelerator` function (in `settings-ui/hotkey.js`, shared with a node test). The recorded value fills the existing `#hotkey` field; Save persists it. The Rust `settings::apply` is changed to return the global-shortcut registration error, which `set_settings` returns so the UI can warn.

**Tech Stack:** Vanilla JS (no build step), `node` for one pure-function test, Rust + Tauri v2, `tauri-plugin-global-shortcut`.

**Spec:** `docs/superpowers/specs/2026-06-01-shortcut-recorder-design.md`
**Branch:** continue on `feat/app-lock` (stacking on the app-lock work). Run `cargo` from `src-tauri/`.

---

### Task 1: `hotkey.js` — pure accelerator formatter + node test

**Files:**
- Create: `settings-ui/hotkey.js`
- Create: `settings-ui/comboToAccelerator.test.mjs`

- [ ] **Step 1: Write the failing node test**

Create `settings-ui/comboToAccelerator.test.mjs`:

```js
// Zero-dependency assertion script for the pure hotkey formatter.
// Run: node settings-ui/comboToAccelerator.test.mjs   (exit non-zero on failure)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// hotkey.js assigns globalThis.HotkeyFmt; run it in this global scope.
(0, eval)(readFileSync(join(here, "hotkey.js"), "utf8"));
const { comboToAccelerator, isValidCombo } = globalThis.HotkeyFmt;

let failures = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL ${label}: got ${a}, want ${e}`); failures++; }
  else { console.log(`ok   ${label}`); }
}
const M = (o = {}) => ({ ctrl: false, alt: false, shift: false, meta: false, ...o });

eq(comboToAccelerator(M({ ctrl: true, shift: true }), "KeyW"), "CmdOrCtrl+Shift+W", "Ctrl+Shift+W");
eq(comboToAccelerator(M(), "F8"), "F8", "bare F8");
eq(comboToAccelerator(M({ shift: true }), "Digit1"), "Shift+1", "Shift+Digit1 stays 1 (code-based)");
eq(comboToAccelerator(M({ meta: true }), "KeyK"), "Super+K", "Meta+K -> Super+K");
eq(comboToAccelerator(M({ ctrl: true, alt: true, shift: true }), "KeyP"), "CmdOrCtrl+Alt+Shift+P", "modifier order");
eq(comboToAccelerator(M({ ctrl: true }), "ArrowUp"), "CmdOrCtrl+Up", "Ctrl+ArrowUp -> CmdOrCtrl+Up");
eq(comboToAccelerator(M(), "Comma"), null, "unmapped key -> null");

eq(isValidCombo(M(), "KeyW"), false, "bare letter invalid");
eq(isValidCombo(M({ shift: true }), "KeyW"), true, "Shift+letter valid (Shift counts)");
eq(isValidCombo(M(), "F8"), true, "bare F-key valid");
eq(isValidCombo(M({ ctrl: true }), "KeyW"), true, "Ctrl+letter valid");

if (failures) { console.error(`\n${failures} failing assertion(s)`); process.exit(1); }
console.log("\nall hotkey tests passed");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node settings-ui/comboToAccelerator.test.mjs`
Expected: FAIL — `hotkey.js` doesn't exist yet (`ENOENT` reading the file, or `Cannot read properties of undefined` for `globalThis.HotkeyFmt`). Non-zero exit.

- [ ] **Step 3: Implement `hotkey.js`**

Create `settings-ui/hotkey.js`:

```js
// Pure helpers: turn a captured key combo into a Tauri accelerator string.
// Assigned to globalThis.HotkeyFmt so the page (window.HotkeyFmt, since
// window === globalThis in a browser) and the node test share ONE source.
// MUST NOT reference `window` (undefined under node).
(function () {
  const FN_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

  function keyToken(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);   // KeyW -> W
    if (/^Digit[0-9]$/.test(code)) return code.slice(5); // Digit1 -> 1
    if (FN_KEY.test(code)) return code;                  // F8 -> F8
    switch (code) {
      case "ArrowUp": return "Up";
      case "ArrowDown": return "Down";
      case "ArrowLeft": return "Left";
      case "ArrowRight": return "Right";
      case "Space": return "Space";
      default: return null;                              // unmapped
    }
  }

  // mods: {ctrl, alt, shift, meta}; code: KeyboardEvent.code.
  // Returns the accelerator string, or null if the key is unmapped.
  function comboToAccelerator(mods, code) {
    const key = keyToken(code);
    if (key === null) return null;
    const parts = [];
    if (mods.ctrl) parts.push("CmdOrCtrl");
    if (mods.alt) parts.push("Alt");
    if (mods.shift) parts.push("Shift");
    if (mods.meta) parts.push("Super");
    parts.push(key);
    return parts.join("+");
  }

  // Accept only if there is a modifier, or the key itself is a function key.
  function isValidCombo(mods, code) {
    if (mods.ctrl || mods.alt || mods.shift || mods.meta) return true;
    return FN_KEY.test(code);
  }

  globalThis.HotkeyFmt = { comboToAccelerator, isValidCombo, FN_KEY };
})();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node settings-ui/comboToAccelerator.test.mjs`
Expected: PASS — all `ok` lines, `all hotkey tests passed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add settings-ui/hotkey.js settings-ui/comboToAccelerator.test.mjs
git commit -m "feat(hotkey): pure combo->accelerator formatter + node test"
```

---

### Task 2: Settings markup + styles for the recorder

**Files:**
- Modify: `settings-ui/index.html`
- Modify: `settings-ui/style.css`

- [ ] **Step 1: Update the Shortcut field markup**

In `settings-ui/index.html`, replace the current Shortcut field block (lines ~30-33):

```html
    <label class="field">
      <span>Shortcut</span>
      <input type="text" id="hotkey" placeholder="CmdOrCtrl+Shift+W" />
    </label>
```

with a field+button row and a hint element:

```html
    <label class="field">
      <span>Shortcut</span>
      <div class="hotkey-row">
        <input type="text" id="hotkey" placeholder="CmdOrCtrl+Shift+W" />
        <button type="button" id="record_hotkey" class="secondary">Record</button>
      </div>
    </label>
    <p id="hotkey_hint" class="hotkey-hint" hidden></p>
```

- [ ] **Step 2: Include `hotkey.js` before `main.js`**

In `settings-ui/index.html`, the scripts at the bottom must load `hotkey.js` first so `window.HotkeyFmt` exists when `main.js` runs. Replace:

```html
    <script src="main.js"></script>
```

with:

```html
    <script src="hotkey.js"></script>
    <script src="main.js"></script>
```

- [ ] **Step 3: Add styles**

Append to `settings-ui/style.css`:

```css
.hotkey-row { display: flex; gap: 8px; align-items: center; }
.hotkey-row #hotkey { flex: 1; min-width: 0; }
#record_hotkey.recording { background: #f0a500; color: #1a1a1a; }
.hotkey-hint { font-size: 12px; color: #f0a500; margin: 4px 0 0; }
```

- [ ] **Step 4: Verify the crate still builds (assets embed)**

Run: `cd src-tauri && cargo build`
Expected: builds (no Rust change; this confirms the embedded-asset build is unaffected). Use `dangerouslyDisableSandbox: true` (foreground) if a sandbox/permission error appears.

- [ ] **Step 5: Commit**

```bash
git add settings-ui/index.html settings-ui/style.css
git commit -m "feat(hotkey): Record button + hint markup and styles"
```

---

### Task 3: Recording state machine in `main.js`

**Files:**
- Modify: `settings-ui/main.js`

- [ ] **Step 1: Add the recorder logic**

Append to `settings-ui/main.js` (after the existing functions, before the
`DOMContentLoaded` handler — or anywhere at module scope):

```js
// --- Shortcut recorder ---

let recordingHotkey = false;
let hotkeyPrev = "";
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

function setHotkeyHint(msg) {
  const hint = document.getElementById("hotkey_hint");
  if (!msg) { hint.hidden = true; hint.textContent = ""; }
  else { hint.textContent = msg; hint.hidden = false; }
}

function stopRecording(restore) {
  if (!recordingHotkey) return;
  recordingHotkey = false;
  window.removeEventListener("keydown", onRecordKeydown, true);
  window.removeEventListener("blur", onRecordBlur, true);
  const btn = document.getElementById("record_hotkey");
  btn.textContent = "Record";
  btn.classList.remove("recording");
  if (restore) document.getElementById("hotkey").value = hotkeyPrev;
}

function onRecordBlur() { stopRecording(true); }

function onRecordKeydown(e) {
  e.preventDefault();
  e.stopPropagation();
  if (MODIFIER_KEYS.has(e.key)) return;            // ignore bare modifiers
  if (e.key === "Escape") { setHotkeyHint(""); stopRecording(true); return; }
  const mods = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
  const accel = window.HotkeyFmt.comboToAccelerator(mods, e.code);
  if (accel === null) { setHotkeyHint("Unsupported key — try another."); return; }
  if (!window.HotkeyFmt.isValidCombo(mods, e.code)) {
    setHotkeyHint("Add a modifier (Ctrl / Alt / Shift).");
    return;
  }
  document.getElementById("hotkey").value = accel;
  setHotkeyHint("");
  stopRecording(false);
}

function toggleRecording() {
  if (recordingHotkey) { setHotkeyHint(""); stopRecording(true); return; }
  recordingHotkey = true;
  hotkeyPrev = document.getElementById("hotkey").value;
  const btn = document.getElementById("record_hotkey");
  btn.textContent = "Press keys… (Esc to cancel)";
  btn.classList.add("recording");
  setHotkeyHint("");
  window.addEventListener("keydown", onRecordKeydown, true);
  window.addEventListener("blur", onRecordBlur, true);
}
```

- [ ] **Step 2: Wire the button in the existing `DOMContentLoaded` handler**

In `settings-ui/main.js`, inside the existing `window.addEventListener("DOMContentLoaded", () => { ... })` handler, add:

```js
  document.getElementById("record_hotkey").addEventListener("click", toggleRecording);
```

- [ ] **Step 3: Verify build**

Run: `cd src-tauri && cargo build`
Expected: builds (no Rust change). (sandbox-disable foreground if needed.)

- [ ] **Step 4: Commit**

```bash
git add settings-ui/main.js
git commit -m "feat(hotkey): keydown recording state machine wired to Record button"
```

---

### Task 4: Surface shortcut registration failures (Rust + Save)

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `settings-ui/main.js`

- [ ] **Step 1: `settings::apply` returns the registration error**

In `src-tauri/src/settings.rs`, replace the whole `apply` function:

```rust
/// Apply side effects of settings (autostart + global shortcut). Returns the global-
/// shortcut registration error as `Some(msg)` if registering failed; `None` if it
/// registered successfully, or the shortcut is disabled/empty, or on non-desktop.
pub fn apply(app: &AppHandle, s: &Settings) -> Option<String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let autostart = app.autolaunch();
        if s.autostart {
            let _ = autostart.enable();
        } else {
            let _ = autostart.disable();
        }

        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let gs = app.global_shortcut();
        let _ = gs.unregister_all();
        if s.hotkey_enabled && !s.hotkey.trim().is_empty() {
            return match gs.register(s.hotkey.as_str()) {
                Ok(_) => None,
                Err(e) => Some(e.to_string()),
            };
        }
        None
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, s);
        None
    }
}
```

- [ ] **Step 2: Update the startup `apply` call in `lib.rs`**

In `src-tauri/src/lib.rs`, in `setup`, the line `settings::apply(handle, &s);` now returns a value — discard it:

```rust
            let _ = settings::apply(handle, &s);
```

- [ ] **Step 3: `set_settings` returns the warning**

In `src-tauri/src/commands.rs`, change `set_settings` to return `Result<Option<String>, String>` (keep the existing `is_remote` + `require_unlocked` guards):

```rust
#[tauri::command]
pub fn set_settings(
    window: tauri::Window,
    app: tauri::AppHandle,
    settings: Settings,
) -> Result<Option<String>, String> {
    if is_remote(&window) {
        return Err("forbidden".into());
    }
    lock::require_unlocked(&app)?;
    crate::settings::save(&app, &settings).map_err(|e| e.to_string())?;
    Ok(crate::settings::apply(&app, &settings))
}
```

- [ ] **Step 4: Build + test (Rust unchanged behavior, signatures compile)**

Run: `cd src-tauri && cargo build && cargo test --lib`
Expected: builds; all 45 existing tests pass. (sandbox-disable foreground if needed.)

- [ ] **Step 5: `save()` shows the warning**

In `settings-ui/main.js`, replace the body of `save()` from the `await invoke("set_settings"...)` line onward. The full new `save()`:

```js
async function save() {
  const s = await invoke("get_settings");
  for (const f of BOOLS) {
    const el = document.getElementById(f);
    if (el) s[f] = el.checked;
  }
  const hk = document.getElementById("hotkey").value.trim();
  s.hotkey = hk || "CmdOrCtrl+Shift+W";
  const note = document.getElementById("note");
  try {
    const warn = await invoke("set_settings", { settings: s });
    if (warn) {
      note.textContent = "Saved — shortcut not registered (may be in use): " + warn;
      setTimeout(() => (note.textContent = ""), 6000);
    } else {
      note.textContent = "Saved ✓";
      setTimeout(() => (note.textContent = ""), 1500);
    }
  } catch (e) {
    note.textContent = String(e);
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/settings.rs src-tauri/src/lib.rs src-tauri/src/commands.rs settings-ui/main.js
git commit -m "feat(hotkey): surface global-shortcut registration failures on Save"
```

---

### Task 5: Smoke test on Linux

**Files:** none (manual verification).

- [ ] **Step 1: Run the app (isolated profile so real data is untouched)**

```bash
cd "/home/karem/side projects/whatRust"
node settings-ui/comboToAccelerator.test.mjs   # quick: formatter still green
```
Then launch the built binary or `cargo tauri dev`. Open Settings (tray → Settings).

- [ ] **Step 2: Record a normal combo**
- Click **Record** → button shows "Press keys… (Esc to cancel)".
- Press **Ctrl+Shift+W** → field shows `CmdOrCtrl+Shift+W`, button returns to "Record".

- [ ] **Step 3: Record a function key**
- Click **Record**, press **F8** → field shows `F8` (no modifier needed).

- [ ] **Step 4: Validation + cancel**
- Click **Record**, press a bare letter (e.g. **A**) → hint "Add a modifier (Ctrl / Alt / Shift)", field unchanged, still recording.
- Press **Esc** → recording cancels, field restored to its prior value.

- [ ] **Step 5: Save + register**
- With a valid combo (e.g. `CmdOrCtrl+Shift+W`) and "Enable global show/hide shortcut" on, click **Save** → "Saved ✓"; pressing the combo toggles the active window.
- Set a likely-rejected combo (e.g. record `Shift+Space` or a combo already taken by the desktop), Save → the "Saved — shortcut not registered (may be in use): …" warning appears (and persists ~6s).

- [ ] **Step 6: Final commit (if any fixups)**

```bash
git add -A && git commit -m "test(hotkey): smoke-test fixups"
```
