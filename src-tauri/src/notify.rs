use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

pub fn show(app: &AppHandle, title: &str, body: &str) {
    // NOTE: tauri-plugin-notification's `show()` dispatches the real toast on a
    // detached async task and discards its result, so the value returned here is
    // effectively always Ok — it does NOT reflect whether the OS actually
    // rendered the toast. We still log that this point was reached (issue #3
    // diagnostics): if "notify::show dispatched" appears in the log but no toast
    // shows, the failure is downstream in the Windows toast layer, not in our
    // command/IPC path. No message content is logged (PII).
    let r = app.notification().builder().title(title).body(body).show();
    crate::dlog::log(&format!("notify::show dispatched (plugin returned {r:?})"));
}
