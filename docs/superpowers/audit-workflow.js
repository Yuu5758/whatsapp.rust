export const meta = {
  name: 'whatrust-final-audit',
  description: 'Exhaustive multi-lens audit of whatRust + adversarial verification of findings',
  phases: [
    { title: 'Audit', detail: '5 independent review lenses over the committed code' },
    { title: 'Verify', detail: 'adversarial skeptics refute each Critical/Important finding' },
  ],
}

const REPO = '/home/karem/side projects/whatRust'

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    summary: { type: 'string', description: 'one-paragraph overall assessment for this lens' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['Critical', 'Important', 'Minor', 'Nit'] },
          file: { type: 'string' },
          location: { type: 'string', description: 'function / line-ish' },
          title: { type: 'string' },
          detail: { type: 'string', description: 'why it is a problem, concretely' },
          proposed_fix: { type: 'string', description: 'specific code-level fix' },
        },
        required: ['severity', 'file', 'title', 'detail', 'proposed_fix'],
      },
    },
  },
  required: ['lens', 'summary', 'findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    real: { type: 'boolean', description: 'true only if this is a genuine issue in THIS codebase given installed dep versions and real runtime; default false if uncertain' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    fix_correct: { type: 'boolean', description: 'is the proposed fix correct and safe?' },
    reasoning: { type: 'string' },
  },
  required: ['real', 'confidence', 'fix_correct', 'reasoning'],
}

const ctx = [
  'whatRust is a Tauri v2 desktop wrapper around WhatsApp Web. Installed versions: tauri 2.9.x; plugins single-instance 2.x, notification 2.x, autostart 2.5.1, global-shortcut 2.3.2, window-state 2.4.1.',
  'The main window loads the REMOTE page https://web.whatsapp.com via WebviewUrl::External with a spoofed Chrome UA and an injected initialization_script (src-tauri/resources/bridge.js). withGlobalTauri is true.',
  'A capability (src-tauri/capabilities/main-remote.json) scopes IPC to that remote origin (permissions core:default + notification:default).',
  'bridge.js forwards window.Notification calls to invoke("notify") and document.title changes to invoke("set_unread").',
  'Settings commands (get_settings/set_settings/open_settings) are guarded in commands.rs so the remote "main" window cannot call them (only the local "settings" window may; guard checks window.label()).',
  'Targets Linux (dev box: WebKitGTK 2.52.3, Ubuntu) + Windows + macOS, built via GitHub Actions.',
  'Files: src-tauri/src/{lib,window,tray,commands,settings,notify,unread}.rs, resources/bridge.js, capabilities/*.json, tauri.conf.json, Cargo.toml, settings-ui/{index.html,main.js,style.css}, .github/workflows/release.yml, README.md.',
  'Repo root: "' + REPO + '". HEAD is the latest commit (clean tree). cargo test = 12 pass, cargo build = warning-free.',
  'Read files directly. For dependency/API/runtime questions you cannot determine from the code, use WebFetch on docs.rs and v2.tauri.app and WebSearch. Be concrete and cite file:location.',
  'Do NOT report style nits as Important. Do NOT propose adding features beyond hardening/correctness.',
].join(' ')

const LENSES = [
  {
    key: 'security-ipc',
    prompt: [
      'LENS: Security and IPC boundary.',
      ctx,
      'Scrutinize specifically:',
      '- The settings-command guard in src-tauri/src/commands.rs (is_remote / window.label() == "main"). Is it airtight? Can the remote WhatsApp page reach get_settings/set_settings/open_settings any other way (a child frame whose label differs, an iframe, a popup the page opens, or a navigation)? Could the label "main" ever be spoofed by remote JS? Are notify/set_unread (intentionally remote-callable) safe, or can their args cause harm?',
      '- main-remote.json grants core:default to the remote origin. Enumerate what core:default actually exposes (use WebFetch on v2.tauri.app core-permissions reference). Does it give the remote WhatsApp page anything dangerous (event emit/listen on internal channels, path, app, webview, window manipulation, resources)? Should it be narrowed below core:default?',
      '- tauri.conf.json security.csp is null. Implications for the LOCAL settings window. Is a CSP warranted?',
      '- Any other command/IPC exposure or capability over-grant.',
      'Return findings with concrete fixes.',
    ].join('\n'),
  },
  {
    key: 'lifecycle-windowing',
    prompt: [
      'LENS: Lifecycle and windowing correctness.',
      ctx,
      'Trace and scrutinize:',
      '- The window-state fix in lib.rs (StateFlags::all() with VISIBLE removed via bitwise-not-and). Is this correct flag arithmetic for plugin v2.4.1, and does it still restore size/position? Confirm against the plugin StateFlags definition (WebFetch docs.rs/tauri-plugin-window-state).',
      '- start_minimized / --minimized path: the window is built with visible(false). Does anything else still show it? The single-instance callback calls show_main unconditionally on a 2nd launch; is that correct when the user wanted it hidden?',
      '- close-to-tray: the CloseRequested handler is attached to the main window only. Confirm the settings window closing is NOT hidden/prevented and is properly destroyed and recreated. Any event-handler leak.',
      '- tray badge: update_badge correctness; set_unread receives the raw title and parses it; any race.',
      '- global-shortcut: fires only on Pressed (no double toggle)? unregister_all then register on every settings save is safe?',
      '- Any panic risk (unwrap/expect) on a realistic runtime path (window.rs url parse expect, settings serialize expect, create_main_window in setup).',
      'Return findings with concrete fixes.',
    ].join('\n'),
  },
  {
    key: 'cross-platform',
    prompt: [
      'LENS: Cross-platform portability (Windows + macOS paths, which were NOT runtime-tested; only Linux was).',
      ctx,
      'Use WebFetch/WebSearch on v2.tauri.app and docs.rs for the installed plugin versions where needed. Scrutinize:',
      '- Tray (tauri core tray-icon): set_title is NOT supported on Windows; set_tooltip is NOT supported on Linux. update_badge in tray.rs sets BOTH plus swaps the icon. Confirm the icon-swap badge works on all 3 OSes and that calling an unsupported set_* just no-ops (does not panic). Is the unread badge visible on Windows (which ignores set_title) and macOS?',
      '- autostart plugin init(MacosLauncher::LaunchAgent, Some(vec of "--minimized")). Confirm the arg type matches autostart v2.5.1 on all platforms and LaunchAgent is right for macOS. Does autostart work on Windows (registry) and Linux (.desktop)?',
      '- Confirm autostart and the other desktop plugins are gated for desktop and that the Cargo.toml target-cfg deps cover all 3 desktop OSes.',
      '- Windows WebView2: creating the window in setup() (not a sync command) avoids the wry#583 deadlock. Does the External-URL + initialization_script + withGlobalTauri IPC path behave the same on WebView2 and WKWebView as on WebKitGTK?',
      '- macOS: no activation-policy handling; when hidden to tray with no visible windows, will the app behave (dock, reopen)? Real gap or acceptable for v1?',
      '- Icon set completeness for Windows (.ico) and macOS (.icns) bundling.',
      'Return findings with concrete fixes; mark real cross-platform breakers Important/Critical and acceptable-v1-gaps Minor.',
    ].join('\n'),
  },
  {
    key: 'bridge-resilience',
    prompt: [
      'LENS: bridge.js correctness and resilience against WhatsApp Web.',
      ctx,
      'Read src-tauri/resources/bridge.js carefully. Scrutinize:',
      '- Notification shim completeness: WhatsApp Web constructs Notifications and uses properties/methods like onclick, onclose, addEventListener("click"), tag, close(), and sometimes reads Notification.permission or calls Notification.requestPermission(). Does the shim implement ENOUGH that WhatsApp code will not throw a TypeError (which could break message handling)? Specifically: does it handle construction via the new operator, return an object with the expected fields, and not break if WhatsApp calls addEventListener? Is notification click-to-focus (clicking the OS notification should focus the app) met or silently dropped?',
      '- The shim forwards only title and body. WhatsApp passes options.icon, options.tag, options.data; dropping these is fine, but confirm no crash.',
      '- Client-hints (navigator.userAgentData) shim completeness (brands, mobile, platform, getHighEntropyValues) for WhatsApp checks. Could a missing field throw?',
      '- Does WhatsApp Web Content-Security-Policy block or interfere with the injected initialization_script? Could WhatsApp own code or a service worker replace window.Notification AFTER our shim and clobber it?',
      '- Title observer: MutationObserver on title node + 2s setInterval fallback + dedupe on raw string. Robust if WhatsApp replaces the title node? Is 2s polling wasteful? Any way it spams invoke?',
      '- Origin guard correctness; try/catch coverage; could any uncaught throw in the init script break WhatsApp page load?',
      'Return findings with concrete fixes.',
    ].join('\n'),
  },
  {
    key: 'packaging-ci-docs',
    prompt: [
      'LENS: Packaging, CI, config, and docs.',
      ctx,
      'Read .github/workflows/release.yml, tauri.conf.json, Cargo.toml, README.md, .gitignore. Use WebSearch/WebFetch to verify current facts. Scrutinize:',
      '- release.yml installs libwebkit2gtk-4.1-dev on ubuntu-22.04. Is that package actually available on Ubuntu 22.04 (jammy)? This is a known pain point (22.04 historically shipped 4.0; Tauri v2 needs 4.1). VERIFY and recommend the correct runner/package (e.g. ubuntu-22.04 vs ubuntu-24.04/latest).',
      '- Is tauri-apps/tauri-action@v0 with the tagName/releaseName config correct for BOTH tag-push and workflow_dispatch? On workflow_dispatch there is no tag, so tagName = github.ref_name would be a branch name; will that break release creation? Are permissions sufficient?',
      '- tauri.conf.json: bundle.targets "all" per platform; identifier com.karem.whatrust stable (login persistence depends on it); any missing required v2 config given windows are created programmatically (empty windows array).',
      '- Cargo.toml: crate-type, target-cfg dependency block correctness, profile (no release LTO/opt; note size/perf), rust-version.',
      '- README accuracy vs actual behavior (AppImage claim, WebKitGTK >=2.46.1 note, default shortcut).',
      '- .gitignore completeness (target/, gen/, node_modules relevance; runtime settings.json location).',
      'Return findings with concrete fixes.',
    ].join('\n'),
  },
]

phase('Audit')
const audits = await parallel(
  LENSES.map((l) => () =>
    agent(l.prompt, { label: 'audit:' + l.key, phase: 'Audit', schema: FINDINGS_SCHEMA })
  )
)

const okAudits = audits.filter(Boolean)
const allFindings = []
for (const a of okAudits) {
  for (const f of a.findings || []) {
    allFindings.push(Object.assign({}, f, { lens: a.lens }))
  }
}
const toVerify = allFindings.filter((f) => f.severity === 'Critical' || f.severity === 'Important')
const minorNits = allFindings.filter((f) => f.severity === 'Minor' || f.severity === 'Nit')

log('Audit done: ' + allFindings.length + ' findings (' + toVerify.length + ' Critical/Important to verify, ' + minorNits.length + ' Minor/Nit).')

phase('Verify')
const verified = await parallel(
  toVerify.map((f) => () =>
    parallel(
      [0, 1, 2].map((i) => () =>
        agent(
          [
            'You are skeptic #' + (i + 1) + '. Adversarially assess whether this audit finding is a REAL, actionable issue in the whatRust codebase, or a false positive / non-issue. Default to real=false if not convinced. Verify against the ACTUAL code and installed dependency versions (read files in "' + REPO + '"; use WebFetch for API/version facts).',
            ctx,
            'FINDING (' + f.severity + ', lens=' + f.lens + '):',
            'title: ' + f.title,
            'file: ' + f.file + ' @ ' + (f.location || '?'),
            'detail: ' + f.detail,
            'proposed_fix: ' + f.proposed_fix,
            'Decide: is it real? is the proposed fix correct and safe? Be rigorous and concrete.',
          ].join('\n'),
          { label: 'verify:' + f.lens + ':' + (i + 1), phase: 'Verify', schema: VERDICT_SCHEMA }
        )
      )
    ).then((verdicts) => {
      const v = verdicts.filter(Boolean)
      const realVotes = v.filter((x) => x.real).length
      const fixVotes = v.filter((x) => x.fix_correct).length
      return {
        finding: f,
        verdicts: v,
        confirmed: realVotes >= 2,
        fix_endorsed: fixVotes >= 2,
        real_votes: realVotes,
        fix_votes: fixVotes,
      }
    })
  )
)

const confirmed = verified.filter(Boolean).filter((r) => r.confirmed)
log('Verification done: ' + confirmed.length + '/' + toVerify.length + ' Critical/Important findings confirmed by >=2/3 skeptics.')

return {
  confirmed_critical_important: confirmed.map((r) => ({
    severity: r.finding.severity,
    lens: r.finding.lens,
    title: r.finding.title,
    file: r.finding.file,
    location: r.finding.location,
    detail: r.finding.detail,
    proposed_fix: r.finding.proposed_fix,
    real_votes: r.real_votes,
    fix_endorsed: r.fix_endorsed,
  })),
  rejected_critical_important: verified
    .filter(Boolean)
    .filter((r) => !r.confirmed)
    .map((r) => ({ title: r.finding.title, lens: r.finding.lens, real_votes: r.real_votes })),
  minor_and_nits: minorNits.map((f) => ({ severity: f.severity, lens: f.lens, title: f.title, file: f.file, proposed_fix: f.proposed_fix })),
  lens_summaries: okAudits.map((a) => ({ lens: a.lens, summary: a.summary })),
}
