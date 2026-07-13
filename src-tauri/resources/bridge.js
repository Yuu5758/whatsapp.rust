(function () {
  "use strict";
  if (window.location.origin !== "https://web.whatsapp.com") return;

  function invoke(cmd, args) {
    var t = window.__TAURI__;
    if (t && t.core && typeof t.core.invoke === "function") {
      return t.core.invoke(cmd, args).catch(function () {});
    }
    return Promise.resolve();
  }

  // Native OS toast with short-window de-duplication. WhatsApp can raise the same alert
  // more than once in a burst (a React re-render, or one message surfacing through two
  // notification code paths), and unlike a browser (which collapses repeats by tag) a
  // native toast stacks every call as a separate visible popup. Suppress an identical
  // title+body seen within DEDUP_MS; genuinely different messages are never affected.
  // Returns true if forwarded, false if suppressed as a duplicate.
  var DEDUP_MS = 3500;
  var recentNotif = Object.create(null);
  function nativeNotify(title, body) {
    title = String(title || "WhatsApp");
    body = String(body || "");
    var now = Date.now();
    for (var k in recentNotif) {
      if (now - recentNotif[k] > DEDUP_MS) delete recentNotif[k]; // prune stale keys
    }
    var key = title + " " + body;
    if (recentNotif[key] && now - recentNotif[key] <= DEDUP_MS) return false;
    recentNotif[key] = now;
    invoke("notify", { title: title, body: body });
    return true;
  }

  // 1) Client Hints shim — navigator.userAgentData is undefined in WebKitGTK,
  //    which WhatsApp's capability check can trip over.
  try {
    if (!navigator.userAgentData) {
      Object.defineProperty(navigator, "userAgentData", {
        configurable: true,
        value: {
          brands: [
            { brand: "Chromium", version: "143" },
            { brand: "Google Chrome", version: "143" },
            { brand: "Not_A Brand", version: "24" },
          ],
          mobile: false,
          platform: "Linux",
          // Real Chrome returns the requested hints (and these fields are what WhatsApp's
          // capability/calling check reads). The previous shim omitted bitness,
          // fullVersionList and wow64 and left platformVersion empty, which a strict check
          // can treat as "not Chrome". Return the full, internally-consistent set; returning
          // hints that weren't asked for is harmless.
          getHighEntropyValues: function () {
            return Promise.resolve({
              architecture: "x86",
              bitness: "64",
              brands: [
                { brand: "Chromium", version: "143" },
                { brand: "Google Chrome", version: "143" },
                { brand: "Not_A Brand", version: "24" },
              ],
              fullVersionList: [
                { brand: "Chromium", version: "143.0.0.0" },
                { brand: "Google Chrome", version: "143.0.0.0" },
                { brand: "Not_A Brand", version: "24.0.0.0" },
              ],
              mobile: false,
              model: "",
              platform: "Linux",
              platformVersion: "6.0.0",
              uaFullVersion: "143.0.0.0",
              wow64: false,
            });
          },
        },
      });
    }
  } catch (e) {}

  // 1b) Chrome environment marker. WhatsApp Web's eligibility checks probe for
  //     `window.chrome` beyond the UA and userAgentData (both spoofed above). Add a
  //     minimal, idempotent stand-in matching what a real Chrome minimally exposes;
  //     never clobber a genuine `window.chrome` (WebView2 on Windows has a real one).
  //     NOTE: this makes the *presentation* consistent; it cannot conjure missing
  //     engine APIs. Linux distro WebKitGTK ships no WebRTC backend, so calling
  //     stays unsupported there regardless (verified: RTCPeerConnection undefined
  //     with enable-webrtc on, webkit2gtk 2.52.3).
  try {
    if (!window.chrome) {
      Object.defineProperty(window, "chrome", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: { app: { isInstalled: false }, runtime: {} },
      });
    }
  } catch (e) {}

  // 2) Notification override — forward to a native OS notification via Rust.
  try {
    function ShimNotification(title, options) {
      options = options || {};
      this.title = title;
      this.body = options.body || "";
      this.onclick = null;
      this.onclose = null;
      this.onerror = null;
      this.onshow = null;
      nativeNotify(title, options.body);
    }
    ShimNotification.prototype.close = function () {
      if (typeof this.onclose === "function") this.onclose();
    };
    ShimNotification.prototype.addEventListener = function () {};
    ShimNotification.prototype.removeEventListener = function () {};
    ShimNotification.permission = "granted";
    ShimNotification.requestPermission = function (cb) {
      if (typeof cb === "function") cb("granted");
      return Promise.resolve("granted");
    };
    window.Notification = ShimNotification;
  } catch (e) {}

  // 2b) Service-worker notification path. Modern WhatsApp Web also raises notifications
  //     via ServiceWorkerRegistration.showNotification (e.g. when the tab is backgrounded),
  //     which the window.Notification shim above does NOT intercept — so those toasts never
  //     reached the OS. Override the page-side prototype method to forward through the same
  //     native `notify` command, and report an empty list from getNotifications (we render a
  //     native toast, so there is no in-page Notification object to hand back). We can only
  //     reach the page's prototype here; notifications fired from inside the service worker's
  //     own context are out of scope for a page-injected script.
  try {
    var SWR = window.ServiceWorkerRegistration;
    if (SWR && SWR.prototype && typeof SWR.prototype.showNotification === "function") {
      SWR.prototype.showNotification = function (title, options) {
        options = options || {};
        // Route through nativeNotify so the service-worker path shares the same de-dup
        // window as window.Notification (an alert that fires on both paths shows once).
        nativeNotify(title, options.body);
        // Real API resolves Promise<undefined>; match it so callers awaiting it don't break.
        return Promise.resolve();
      };
      if (typeof SWR.prototype.getNotifications === "function") {
        SWR.prototype.getNotifications = function () {
          return Promise.resolve([]);
        };
      }
    }
  } catch (e) {}

  // 3) Unread count — forward the raw <title> string on change; Rust parses it.
  var lastTitle = "";
  function report() {
    if (document.title === lastTitle) return;
    lastTitle = document.title;
    invoke("set_unread", { title: document.title });
  }
  function start() {
    try {
      var el = document.querySelector("title");
      if (el) {
        new MutationObserver(report).observe(el, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
      setInterval(report, 2000); // fallback if <title> node is swapped
      report();
    } catch (e) {}
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  // 4) Drag-and-drop file injection.
  //    The native webview never delivers an OS file drop into this page on Linux
  //    (broken on Wayland; on X11 the GTK drop is accepted but never reaches the DOM),
  //    so Rust captures the drop (window.rs `register_drop_handler`) and calls this with
  //    the file bytes. We rebuild the File(s) and hand them to WhatsApp's own attach flow.
  //
  //    WhatsApp Web keeps a sticker-creator <input type=file> (image-only accept) ALWAYS
  //    mounted, but mounts the real "Photos & videos" input (accept includes video) and
  //    the "Document" input (accept "*") only when the attach (+) menu is opened. Targeting
  //    a file input blindly therefore lands on the sticker input — which turns photos into
  //    stickers and rejects video/documents. So we ROUTE BY TYPE: open the attach menu to
  //    mount the right input, then set its .files and fire change (React's onChange fires
  //    for synthetic bubbling events; it doesn't check isTrusted, and input.files is
  //    settable in WebKit). Images + native videos -> media input; everything else (zip,
  //    pdf, docs, webm/mkv/avi) -> document input. We never use the sticker input.
  try {
    var drop = {};
    drop.log = function (m) {
      try { console.log("[whatRust drop] " + m); } catch (e) {}
      try { invoke("dlog", { msg: String(m).slice(0, 280) }); } catch (e) {}
    };
    drop.b64ToFile = function (b64, name, type) {
      var bin = atob(b64),
        n = bin.length,
        u = new Uint8Array(n);
      for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
      return new File([u], name, { type: type || "application/octet-stream" });
    };
    drop.dataTransfer = function (files) {
      var dt = new DataTransfer();
      for (var i = 0; i < files.length; i++) dt.items.add(files[i]);
      return dt;
    };
    // Only these video types are accepted by WhatsApp's Photos & Videos input; other
    // video containers (webm/mkv/avi) are rejected there and must go as a document.
    drop.NATIVE_VIDEO = { "video/mp4": 1, "video/3gpp": 1, "video/quicktime": 1 };
    drop.isMedia = function (type) {
      return /^image\//.test(type || "") || drop.NATIVE_VIDEO[type] === 1;
    };
    drop.qs = function (sels) {
      for (var i = 0; i < sels.length; i++) {
        var e = document.querySelector(sels[i]);
        if (e) return e;
      }
      return null;
    };
    // The media input is the only file input whose accept lists a video type; the sticker
    // input is image-only, so it can never match this.
    drop.findMediaInput = function () {
      var ins = document.querySelectorAll('input[type="file"]');
      for (var i = 0; i < ins.length; i++) {
        if (/video/i.test(ins[i].accept || "")) return ins[i];
      }
      return null;
    };
    // The document input accepts everything (accept "*"/""/no image+video). The sticker
    // input (image-only) and media input (has video) are both excluded.
    drop.findDocInput = function () {
      var ins = document.querySelectorAll('input[type="file"]');
      for (var i = 0; i < ins.length; i++) {
        var a = (ins[i].accept || "").trim();
        if (a === "" || a === "*" || a === "*/*") return ins[i];
        if (!/image/i.test(a) && !/video/i.test(a)) return ins[i];
      }
      return null;
    };
    drop.openMenu = function () {
      var b = drop.qs([
        '[data-icon="plus"]',
        '[data-icon="attach-menu-plus"]',
        '[data-icon="clip"]',
        '[data-testid="clip"]',
        'button[title="Attach"]',
        '[aria-label="Attach"]',
        '[title="Attach"]',
      ]);
      if (!b) return false;
      (b.closest('button,[role="button"],div[role="button"]') || b).click();
      return true;
    };
    drop.clickMenuItem = function (kind) {
      var sels =
        kind === "media"
          ? ['[data-testid="attach-image"]', '[data-icon="media-multiple"]', '[aria-label*="Photos"]', '[aria-label*="hoto"]']
          : ['[data-testid="attach-document"]', '[data-icon="document"]', '[aria-label*="Document"]', '[aria-label*="ocument"]'];
      var e = drop.qs(sels);
      if (!e) return false;
      (e.closest('li,button,[role="button"],div[role="button"]') || e).click();
      return true;
    };
    drop.poll = function (fn, ms) {
      return new Promise(function (resolve) {
        var t0 = Date.now();
        (function p() {
          var r = fn();
          if (r) return resolve(r);
          if (Date.now() - t0 >= ms) return resolve(null);
          setTimeout(p, 60);
        })();
      });
    };
    drop.inject = function (input, files) {
      var dt = drop.dataTransfer(files);
      try {
        input.files = dt.files; // settable in WebKit + Blink (WHATWG html#2861)
      } catch (e) {
        drop.log("input.files assign threw: " + e);
        return false;
      }
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };
    // Open the attach menu (which mounts the lazily-rendered inputs) and inject into the
    // one matching `kind`. If opening the menu alone doesn't mount it, click the matching
    // submenu item to force it. No user gesture exists here, so the OS file picker can't
    // open — only the input element is mounted, which is all we need.
    drop.mountAndInject = function (kind, files) {
      var find = kind === "media" ? drop.findMediaInput : drop.findDocInput;
      var existing = find();
      if (existing) {
        drop.log(kind + " input already present");
        return Promise.resolve(drop.inject(existing, files));
      }
      drop.openMenu();
      return drop.poll(find, 1000).then(function (input) {
        if (input) return drop.inject(input, files);
        drop.clickMenuItem(kind);
        return drop.poll(find, 1000).then(function (input2) {
          if (input2) return drop.inject(input2, files);
          drop.log(kind + " input NOT found after opening attach menu");
          return false;
        });
      });
    };
    // WhatsApp opens a media/document preview composer once a file is attached; use it as
    // the success signal for diagnostics. Best-effort selectors across WA Web versions.
    drop.composerOpen = function () {
      return !!(
        document.querySelector('[data-testid="media-caption-input-container"]') ||
        document.querySelector('[data-testid="media-editor"]') ||
        document.querySelector('[data-animate-modal-body="true"]') ||
        document.querySelector('span[data-icon="send"]') ||
        document.querySelector('span[data-icon="media-cancel"]')
      );
    };
    drop.waitFor = function (pred, ms) {
      return new Promise(function (resolve) {
        var t0 = Date.now();
        (function poll() {
          if (pred()) return resolve(true);
          if (Date.now() - t0 >= ms) return resolve(false);
          setTimeout(poll, 80);
        })();
      });
    };
    // De-dupe: a given file can't be re-injected within 4s (guards eval retries).
    drop.seen = Object.create(null);
    drop.dedupe = function (list) {
      return list.filter(function (f) {
        var k = f.name + "|" + (f.b64 || "").slice(0, 24);
        if (drop.seen[k]) return false;
        drop.seen[k] = 1;
        setTimeout(function () {
          delete drop.seen[k];
        }, 4000);
        return true;
      });
    };

    window.__whatrustHandleDrop = function (fileObjs) {
      try {
        if (!Array.isArray(fileObjs) || fileObjs.length === 0) return;
        var fresh = drop.dedupe(fileObjs);
        if (fresh.length === 0) {
          drop.log("duplicate drop ignored");
          return;
        }
        var files = fresh.map(function (f) {
          return drop.b64ToFile(f.b64, f.name, f.type);
        });
        var media = files.filter(function (f) {
          return drop.isMedia(f.type);
        });
        var docs = files.filter(function (f) {
          return !drop.isMedia(f.type);
        });
        drop.log("drop: " + media.length + " media + " + docs.length + " document file(s)");

        // A single drop opens one composer, so handle one group. Media wins if both are
        // present (the rarer mixed case logs the leftover for a follow-up drop).
        var kind = media.length ? "media" : "document";
        var batch = media.length ? media : docs;
        drop.mountAndInject(kind, batch).then(function (ok) {
          drop.log(kind + " inject " + (ok ? "dispatched" : "FAILED"));
          if (media.length && docs.length) {
            drop.log("note: " + docs.length + " document(s) skipped — drop them separately");
          }
          drop.waitFor(drop.composerOpen, 1800).then(function (open) {
            drop.log("composer " + (open ? "opened" : "NOT detected") + " (" + kind + ")");
          });
        });
      } catch (e) {
        drop.log("handler error: " + e);
      }
    };
    drop.log("drop injector v2 (type-routed) ready");
  } catch (e) {}
})();
