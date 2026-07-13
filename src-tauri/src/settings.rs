use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub close_to_tray: bool,
    pub start_minimized: bool,
    pub autostart: bool,
    pub hotkey_enabled: bool,
    pub hotkey: String,
    pub notifications: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            start_minimized: false,
            autostart: false,
            hotkey_enabled: true,
            hotkey: "CmdOrCtrl+Shift+W".to_string(),
            notifications: true,
        }
    }
}

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn settings_path(app: &AppHandle) -> tauri::Result<PathBuf> {
    let dir = app.path().app_config_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, s: &Settings) -> tauri::Result<()> {
    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(s).expect("serialize settings");
    std::fs::write(path, json)?;
    Ok(())
}

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

#[cfg(test)]
mod tests {
    use super::Settings;

    #[test]
    fn defaults_are_sane() {
        let s = Settings::default();
        assert!(s.close_to_tray);
        assert!(s.notifications);
        assert_eq!(s.hotkey, "CmdOrCtrl+Shift+W");
        assert!(!s.autostart);
    }

    #[test]
    fn partial_json_fills_defaults() {
        let s: Settings = serde_json::from_str(r#"{"autostart": true}"#).unwrap();
        assert!(s.autostart);
        assert!(s.close_to_tray);
        assert_eq!(s.hotkey, "CmdOrCtrl+Shift+W");
    }

    #[test]
    fn empty_json_is_all_defaults() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn roundtrip() {
        let s = Settings {
            autostart: true,
            hotkey: "Ctrl+Alt+W".into(),
            ..Default::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }
}
