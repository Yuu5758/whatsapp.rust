const invoke = window.__TAURI__.core.invoke;
const BOOLS = ["close_to_tray", "start_minimized", "autostart", "notifications", "hotkey_enabled"];

async function load() {
  const s = await invoke("get_settings");
  for (const f of BOOLS) {
    const el = document.getElementById(f);
    if (el) el.checked = !!s[f];
  }
  document.getElementById("hotkey").value = s.hotkey || "CmdOrCtrl+Shift+W";
}

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

// --- Accounts ---

function renderAccounts(accounts) {
  const list = document.getElementById("accounts-list");
  list.textContent = "";
  const canRemove = accounts.length > 1;

  for (const a of accounts) {
    const row = document.createElement("div");
    row.className = "account-row";

    const name = document.createElement("span");
    name.className = "acct-name";
    name.textContent = a.name;
    row.appendChild(name);

    if (a.unread > 0) {
      const badge = document.createElement("span");
      badge.className = "acct-unread";
      badge.textContent = String(a.unread);
      row.appendChild(badge);
    }

    const openBtn = document.createElement("button");
    openBtn.className = "secondary";
    openBtn.textContent = "Open";
    openBtn.addEventListener("click", async () => {
      await invoke("open_account", { id: a.id });
    });
    row.appendChild(openBtn);

    const renameBtn = document.createElement("button");
    renameBtn.className = "secondary";
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", async () => {
      const next = prompt("Rename account", a.name);
      if (next && next.trim() && next.trim() !== a.name) {
        try {
          await invoke("rename_account", { id: a.id, name: next.trim() });
        } catch (e) {
          alert(String(e));
        }
        await loadAccounts();
      }
    });
    row.appendChild(renameBtn);

    const removeBtn = document.createElement("button");
    removeBtn.className = "secondary";
    removeBtn.textContent = "Remove";
    removeBtn.disabled = !canRemove;
    removeBtn.addEventListener("click", async () => {
      if (!confirm(`Remove account "${a.name}"? Its local session will be deleted.`)) return;
      try {
        await invoke("remove_account", { id: a.id });
      } catch (e) {
        alert(String(e));
      }
      await loadAccounts();
    });
    row.appendChild(removeBtn);

    list.appendChild(row);
  }
}

async function loadAccounts() {
  try {
    const accounts = await invoke("list_accounts");
    renderAccounts(accounts);
  } catch (e) {
    // ignore — listing failed
  }
}

async function addAccount() {
  const input = document.getElementById("new_account_name");
  const name = input.value.trim();
  if (!name) return;
  try {
    await invoke("add_account", { name });
    input.value = "";
    await loadAccounts();
  } catch (e) {
    const msg = String(e);
    // Only the macOS < 14 case is permanent — disable Add and surface the note.
    // Other failures (disk write, window build) are transient: report and let the user retry.
    if (msg.includes("macOS 14")) {
      const note = document.getElementById("macos-note");
      note.textContent = msg;
      note.hidden = false;
      document.getElementById("add_account").disabled = true;
      document.getElementById("new_account_name").disabled = true;
    } else {
      alert(msg);
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  load();
  loadAccounts();
  loadLock();
  wireLock();
  document.getElementById("save").addEventListener("click", save);
  document.getElementById("add_account").addEventListener("click", addAccount);
  document.getElementById("new_account_name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addAccount();
  });
  document.getElementById("record_hotkey").addEventListener("click", toggleRecording);
});

// --- App lock ---

async function loadLock() {
  let s;
  try {
    s = await invoke("get_lock_status");
  } catch (e) {
    return;
  }
  const disabled = document.getElementById("lock-disabled");
  const enabled = document.getElementById("lock-enabled");
  disabled.hidden = s.enabled;
  enabled.hidden = !s.enabled;

  if (s.enabled) {
    const row = document.getElementById("biometric_row");
    row.hidden = !s.biometric_available;
    document.getElementById("biometric_label").textContent = "Use " + s.biometric_label;
    document.getElementById("biometric_enabled").checked = s.biometric_enabled;
    document.getElementById("lock_on_launch").checked = s.lock_on_launch;
    document.getElementById("lock_on_hide").checked = s.lock_on_hide;
    document.getElementById("idle_min").value = String(Math.round(s.idle_secs / 60));
  }
}

async function saveLockOptions() {
  const idleMin = parseInt(document.getElementById("idle_min").value, 10) || 0;
  await invoke("set_app_lock_options", {
    lockOnLaunch: document.getElementById("lock_on_launch").checked,
    lockOnHide: document.getElementById("lock_on_hide").checked,
    idleSecs: Math.max(0, idleMin) * 60,
  });
}

function wireLock() {
  document.getElementById("enable_lock").addEventListener("click", async () => {
    const a = document.getElementById("lock_pw1").value;
    const b = document.getElementById("lock_pw2").value;
    try {
      await invoke("set_app_lock_password", { new: a, confirm: b });
      document.getElementById("lock_pw1").value = "";
      document.getElementById("lock_pw2").value = "";
      await loadLock();
    } catch (e) { alert(String(e)); }
  });

  document.getElementById("lock_now").addEventListener("click", async () => {
    try { await invoke("lock_app"); } catch (e) { alert(String(e)); }
  });

  document.getElementById("change_pw").addEventListener("click", async () => {
    const current = prompt("Current password:");
    if (current === null) return;
    const next = prompt("New password (min 4):");
    if (!next) return;
    try {
      await invoke("change_app_lock_password", { current, new: next, confirm: next });
      alert("Password changed.");
    } catch (e) { alert(String(e)); }
  });

  document.getElementById("disable_lock").addEventListener("click", async () => {
    const current = prompt("Enter your current password to disable the lock:");
    if (current === null) return;
    try {
      await invoke("disable_app_lock", { current });
      await loadLock();
    } catch (e) { alert(String(e)); }
  });

  document.getElementById("biometric_enabled").addEventListener("change", async (e) => {
    try {
      await invoke("set_biometric_enabled", { enabled: e.target.checked });
    } catch (err) {
      alert(String(err));
      e.target.checked = !e.target.checked; // revert on failure
    }
    await loadLock();
  });

  for (const id of ["lock_on_launch", "lock_on_hide"]) {
    document.getElementById(id).addEventListener("change", () => saveLockOptions().catch((e) => alert(String(e))));
  }
  document.getElementById("idle_min").addEventListener("change", () => saveLockOptions().catch((e) => alert(String(e))));
}

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

function onRecordBlur() { setHotkeyHint(""); stopRecording(true); }

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
