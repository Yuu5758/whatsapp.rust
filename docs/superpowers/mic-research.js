export const meta = {
  name: 'winmac-mic-research',
  description: 'Research Windows WebView2 + macOS WKWebView microphone/getUserMedia enabling for wry 0.55 / Tauri v2',
  phases: [
    { title: 'Research', detail: 'Windows + macOS approaches in parallel' },
    { title: 'Synthesize', detail: 'reconcile into version-correct implementation' },
  ],
}

const VERSIONS = [
  'Installed (from Cargo.lock, must match): wry 0.55.1, tauri 2.11.2.',
  'Windows: webview2-com 0.38.2, webview2-com-sys 0.38.2, windows 0.61.3, windows-core 0.61.2.',
  'macOS: objc2 0.6.4, objc2-web-kit 0.3.2, objc2-foundation 0.3.2, objc2-app-kit 0.3.2, block2 0.6.2.',
].join(' ')

const base = [
  'Context: a Tauri v2 app (whatRust) wraps web.whatsapp.com in the system webview. On Linux (WebKitGTK) we already fixed microphone access by calling win.with_webview(|w| ...) and, on the webkit2gtk::WebView, enabling enable-media-stream/enable-webrtc and connecting permission-request to auto-allow. We now need the equivalent for Windows (WebView2) and macOS (WKWebView). The goal: voice messages + calls work (getUserMedia for mic, ideally camera too).',
  VERSIONS,
  'Tauri v2 exposes win.with_webview(|webview: tauri::webview::PlatformWebview| { ... }) on desktop. On Windows PlatformWebview has .controller() -> ICoreWebView2Controller (webview2-com types). On macOS PlatformWebview has .inner() -> the WKWebView (objc2 / *mut object) and .ns_window()/.controller(). Verify these against wry 0.55 / tauri 2.11 docs.',
  'Use WebFetch on docs.rs (tauri 2.11 webview PlatformWebview, webview2-com 0.38, objc2-web-kit 0.3) and v2.tauri.app, and WebSearch for known Tauri/wry getUserMedia microphone Windows/macOS solutions and GitHub issues. Be concrete; cite URLs. Provide code that compiles against the EXACT versions above.',
].join('\n')

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    platform: { type: 'string' },
    default_behavior: { type: 'string', description: 'What WebView2/WKWebView does for getUserMedia with NO custom handling (prompt? deny silently? work?)' },
    needs_code: { type: 'boolean' },
    needs_config: { type: 'boolean' },
    config_changes: { type: 'string', description: 'Exact Info.plist keys / tauri.conf.json / Cargo.toml changes, or "none"' },
    code_snippet: { type: 'string', description: 'Exact Rust to put inside with_webview (or "none"); must compile against the pinned versions; include use-statements' },
    cargo_deps: { type: 'string', description: 'Exact [target] dependency lines to add, with versions, or "none"' },
    gotchas: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['platform', 'default_behavior', 'needs_code', 'needs_config', 'config_changes', 'code_snippet', 'cargo_deps', 'confidence'],
}

phase('Research')
const [win, mac] = await parallel([
  () => agent([
    'PLATFORM: Windows (WebView2).',
    base,
    'Answer: (1) By default, when a page calls getUserMedia in WebView2, does it prompt the user (native dialog), deny silently, or allow? (2) To AUTO-allow mic/camera, use ICoreWebView2 add_PermissionRequested. Show exact Rust inside tauri with_webview: obtain the controller via the PlatformWebview, get CoreWebView2(), create a webview2_com::PermissionRequestedEventHandler, in it read PermissionKind() and if MICROPHONE or CAMERA call SetState(ALLOW). Give EXACT use-paths for webview2-com 0.38.2 (e.g. webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW, ICoreWebView2_*}) and windows 0.61 (windows::core::Interface for casts, windows_core::BOOL). (3) Exact Cargo.toml [target.\'cfg(windows)\'.dependencies] lines (webview2-com = \"0.38\", windows = { version = \"0.61\", features=[...] }). (4) Confirm tauri PlatformWebview::controller() return type for tauri 2.11/wry 0.55. Note any handler-closure signature details and the event-token argument.',
  ].join('\n'), { label: 'research:windows', phase: 'Research', schema: SCHEMA }),
  () => agent([
    'PLATFORM: macOS (WKWebView).',
    base,
    'Answer: (1) On macOS 12+ with wry 0.55 WKWebView, what happens when WhatsApp calls getUserMedia by default — native prompt, silent denial, or crash? (2) Is NSMicrophoneUsageDescription (and NSCameraUsageDescription) in Info.plist REQUIRED (app crashes without it on mic access)? How do you add Info.plist keys in a Tauri v2 app — does Tauri merge a src-tauri/Info.plist, or is there a tauri.conf.json bundle.macOS field, or build script? Give the EXACT mechanism + the exact keys/values. (3) Does WKWebView need a WKUIDelegate implementing webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler: to grant, and does wry already set a UIDelegate (so hooking it is fragile)? If delegate code via objc2 0.6 / objc2-web-kit 0.3 is REQUIRED, outline it; if just the Info.plist (and WKWebView auto-prompts) suffices, say so clearly and prefer that. (4) Any entitlements (com.apple.security.device.audio-input) needed for the default non-sandboxed Tauri build? (5) Cargo deps if any. Prefer the LEAST-code solution that actually works.',
  ].join('\n'), { label: 'research:macos', phase: 'Research', schema: SCHEMA }),
])

phase('Synthesize')
const synthesis = await agent([
  'You are the integrator. Two researchers investigated enabling microphone/getUserMedia for a Tauri v2 (wry 0.55) WhatsApp-Web wrapper on Windows (WebView2) and macOS (WKWebView).',
  VERSIONS,
  'WINDOWS FINDINGS:',
  JSON.stringify(win, null, 2),
  'MACOS FINDINGS:',
  JSON.stringify(mac, null, 2),
  'Produce the FINAL, minimal, version-correct implementation plan. For each platform give: exact files to change, exact code (with use-statements) to add — for Windows inside the existing enable_webview_media() with_webview closure under #[cfg(target_os = \"windows\")]; for macOS the Info.plist mechanism + any code. Flag anything that cannot be verified without compiling on that OS (we will verify via CI). Prefer config-only where it works. Call out version-mismatch risks against the pinned crates. Be concrete and implementation-ready.',
].join('\n'), { label: 'synthesize', phase: 'Synthesize' })

return { windows: win, macos: mac, synthesis }
