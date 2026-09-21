//! The desktop build's smoke test, compiled into debug builds only.
//!
//!     EYES_PROBE=1 cargo run
//!
//! Opens the index and every embedded page in turn, then saves a download.
//! Each page must finish assembling (`s.js` sets `body[data-ready]`) on the
//! tool it should, in a secure context, without a script error, a failed load
//! or a blocked request. Prints one line per step and exits non-zero if any
//! failed.
//!
//! With `EYES_PROBE_PEER` set, it opens share instead and waits for another
//! device — a browser on the same service and network — to appear, sends it
//! "from the app", and expects `EYES_PROBE_PEER`'s value back. The screen must
//! be awake: WebKit suspends a hidden page, and its connections with it.
//!
//! The page reports by navigating to `eyes-probe://report?…`, which the
//! navigation handler hands to `intercept` instead of loading.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url};

use crate::LOCAL_ORIGIN;

/// Injected into every page while the probe runs.
pub const SCRIPT: &str = r#"
(() => {
  if (window.top !== window) return;
  const errors = [];
  addEventListener('error', e => {
    const t = e.target;
    errors.push(t && t !== window ? 'failed to load ' + (t.src || t.href || t.tagName) : String(e.message));
  }, true);
  addEventListener('unhandledrejection', e => errors.push('unhandled rejection: ' + ((e.reason && e.reason.message) || e.reason)));
  document.addEventListener('securitypolicyviolation', e => errors.push('blocked ' + e.blockedURI + ' by ' + e.violatedDirective));
  const started = Date.now();
  const wait = () => {
    const ready = !!document.body && document.body.dataset.ready === '1';
    if (!ready && Date.now() - started < 8000) return setTimeout(wait, 50);
    if (ready && location.hash === '#probe-download') return E.download('probe', 'eyes-probe.txt', 'text/plain');
    if (ready && location.hash === '#probe-peer') return peer().then(report, e => { errors.push(e.message); report(''); });
    setTimeout(() => report(''), 300);
    function report(received) {
      location.href = 'eyes-probe://report?' + new URLSearchParams({
        tool: (document.body && document.body.dataset.tool) || '',
        ready: ready ? '1' : '',
        secure: isSecureContext ? '1' : '',
        errors: errors.join('\n'),
        received
      });
    }
  };
  /* Share's connection attempts, printed if the peer step fails. */
  const iceLog = [];
  if (location.hash === '#probe-peer' && window.RTCPeerConnection) {
    const Native = RTCPeerConnection;
    window.RTCPeerConnection = function (...args) {
      const pc = new Native(...args);
      pc.addEventListener('icecandidate', e => iceLog.push('cand ' + (e.candidate ? e.candidate.candidate : 'end')));
      pc.addEventListener('iceconnectionstatechange', () => iceLog.push('ice ' + pc.iceConnectionState));
      pc.addEventListener('icegatheringstatechange', () => iceLog.push('gather ' + pc.iceGatheringState));
      return pc;
    };
    window.RTCPeerConnection.prototype = Native.prototype;
  }
  const until = async (what, test) => {
    for (const end = Date.now() + 40000; !test(); await new Promise(r => setTimeout(r, 100))) {
      if (Date.now() > end) throw new Error('no ' + what + ' (' + document.querySelector('#status').textContent + '; ' + document.querySelector('#err').textContent + ')\n' + iceLog.join('\n'));
    }
    return test();
  };
  async function peer() {
    await until('device ready', () => [...document.querySelectorAll('.device__action')].some(e => e.textContent === 'ready'));
    document.querySelector('[aria-label^="send text to"]').click();
    document.querySelector('#text').value = 'from the app';
    document.querySelector('#send-text').click();
    return (await until('text received', () => document.querySelector('.received-files pre'))).textContent;
  }
  document.addEventListener('DOMContentLoaded', wait);
})();
"#;

struct Step {
    /// What this step is called in the output.
    name: String,
    /// Where to go. `None` for the page the window opens on.
    go: Option<Url>,
    expect: Expect,
}

enum Expect {
    /// A page assembled on this tool (`""` for the index).
    Page(String),
    /// Share, having exchanged text with another device, which sent this.
    Peer(String),
    /// A saved download.
    Download,
}

struct Probe {
    steps: Mutex<VecDeque<Step>>,
    failed: Mutex<usize>,
    /// Where the download is being saved; WebKit does not say when it finishes.
    saving: Mutex<Option<PathBuf>>,
}

/// Starts the probe if `EYES_PROBE` is set. Returns whether it did.
pub fn start(app: &AppHandle) -> bool {
    if std::env::var_os("EYES_PROBE").is_none() {
        return false;
    }
    let local = |path: &str| Url::parse(LOCAL_ORIGIN).and_then(|o| o.join(path)).ok();

    let mut steps = VecDeque::from([Step { name: "index".into(), go: None, expect: Expect::Page(String::new()) }]);
    if let Ok(text) = std::env::var("EYES_PROBE_PEER") {
        // Straight to share, so the other device is not left talking to a
        // session the probe has already moved on from.
        steps.push_back(Step { name: "share with a peer".into(), go: local("/share#probe-peer"), expect: Expect::Peer(text) });
    } else {
        for pair in env!("EYES_PAGES").split(',') {
            let (slug, tool) = pair.split_once(':').expect("slug:tool");
            steps.push_back(Step { name: slug.into(), go: local(slug), expect: Expect::Page(tool.into()) });
        }
        steps.push_back(Step { name: "download".into(), go: local("/#probe-download"), expect: Expect::Download });
    }

    app.manage(Probe { steps: Mutex::new(steps), failed: Mutex::new(0), saving: Mutex::new(None) });
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(240));
        eprintln!("FAIL  timed out");
        std::process::exit(2);
    });
    true
}

pub fn running(app: &AppHandle) -> bool {
    app.try_state::<Probe>().is_some()
}

/// Handles a page's report. Returns whether `url` was one.
pub fn intercept(app: &AppHandle, url: &Url) -> bool {
    if url.scheme() != "eyes-probe" {
        return false;
    }
    let Some(probe) = app.try_state::<Probe>() else { return true };
    let Some(step) = probe.steps.lock().unwrap().pop_front() else { return true };

    let field = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned()).unwrap_or_default();
    let mut problems = Vec::new();
    match &step.expect {
        Expect::Peer(text) => {
            problems.extend(field("errors").lines().map(str::to_owned));
            if problems.is_empty() && field("received") != *text {
                problems.push(format!("received {:?}, not {text:?}", field("received")));
            }
        }
        Expect::Page(tool) => {
            if field("tool") != *tool {
                problems.push(format!("assembled {:?}, not {tool:?}", field("tool")));
            }
            if field("ready").is_empty() {
                problems.push("never finished assembling".into());
            }
            if field("secure").is_empty() {
                problems.push("not a secure context".into());
            }
            problems.extend(field("errors").lines().map(str::to_owned));
        }
        Expect::Download => problems.push("loaded the page instead of downloading".into()),
    }
    record(app, &step, problems);
    true
}

/// Notes where the download is going.
pub fn saving(app: &AppHandle, path: &Path) {
    if let Some(probe) = app.try_state::<Probe>() {
        *probe.saving.lock().unwrap() = Some(path.to_owned());
    }
}

/// Handles a finished download.
pub fn downloaded(app: &AppHandle, success: bool) {
    let Some(probe) = app.try_state::<Probe>() else { return };
    let Some(step) = probe.steps.lock().unwrap().pop_front() else { return };
    let path = probe.saving.lock().unwrap().take();

    let mut problems = Vec::new();
    match (&step.expect, path) {
        (Expect::Download, Some(path)) if success => {
            if std::fs::read_to_string(&path).ok().as_deref() != Some("probe") {
                problems.push(format!("saved {} without the expected contents", path.display()));
            }
            let _ = std::fs::remove_file(path);
        }
        (Expect::Download, _) => problems.push("the download failed".into()),
        (Expect::Page(_) | Expect::Peer(_), _) => problems.push("downloaded something instead of loading".into()),
    }
    record(app, &step, problems);
}

/// Prints a step's result and moves on to the next, or exits after the last.
fn record(app: &AppHandle, step: &Step, problems: Vec<String>) {
    let probe = app.state::<Probe>();
    if problems.is_empty() {
        println!("ok    {}", step.name);
    } else {
        *probe.failed.lock().unwrap() += 1;
        println!("FAIL  {}", step.name);
        for problem in problems {
            println!("        {problem}");
        }
    }

    let next = probe.steps.lock().unwrap().front().and_then(|s| s.go.clone());
    match next {
        // Navigating from inside the navigation handler would re-enter the
        // webview, so the next page loads once this one has been cancelled.
        Some(url) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.navigate(url);
                }
            });
        }
        None => {
            let failed = *probe.failed.lock().unwrap();
            println!("{}", if failed == 0 { "all steps passed".to_owned() } else { format!("{failed} failed") });
            // `app.exit` does not carry the code out of the event loop on macOS.
            app.cleanup_before_exit();
            std::process::exit(i32::from(failed > 0));
        }
    }
}
