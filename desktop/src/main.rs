//! 𓁹𓁹 as a desktop app.
//!
//! The window shows the pages in this repository, embedded in the binary by
//! `build.rs` and served from the app's own origin, so every tool works offline
//! just as it does from the Node server. No page is loaded from eyes.tools.
//! Share is the one tool that needs a server, for its rooms and for setting up
//! connections, so it uses eyes.tools's service for that; files still go
//! device to device, and the app meets browsers on the site and other copies
//! of the app alike. Links the pages make for other people point at
//! eyes.tools too. Links to other sites open in the system browser, and
//! downloads land in the Downloads folder.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(debug_assertions)]
mod probe;

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::window::Color;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

/// The origin Tauri serves embedded pages from.
#[cfg(debug_assertions)]
const LOCAL_ORIGIN: &str = if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" };

/// The public site: where share's service is, and where links the pages make
/// for other people point. A build for another server sets
/// `EYES_PUBLIC_ORIGIN`, that server lists the app's origins in
/// `SHARE_ALLOWED_ORIGINS`, and the CSP in `tauri.conf.json` must allow it.
const PUBLIC_ORIGIN: &str = match option_env!("EYES_PUBLIC_ORIGIN") {
    Some(origin) => origin,
    None => "https://eyes.tools",
};

/// Says what the app is rather than claiming to be a browser. Bot checks in
/// front of a site challenge clients that claim to be browsers, which the app
/// cannot answer from share's cross-origin requests; an honest client is let
/// through as any other is, and no rule has to open the service to everyone.
const USER_AGENT: &str = concat!("eyes-desktop/", env!("CARGO_PKG_VERSION"), " (+https://github.com/mzyhot/eyes.tools)");

/// `--color-paper` of the dark theme, the default, so the window never
/// flashes white before the first paint.
const PAPER: Color = Color(7, 7, 7, 255);

/// Runs before each page's own scripts: sets the configuration's
/// `publicOrigin` to [`PUBLIC_ORIGIN`] as `site.js` assigns it.
fn public_origin_script() -> String {
    format!(
        r#"(() => {{
  let site;
  Object.defineProperty(window, 'SITE', {{
    configurable: true,
    get: () => site,
    set: value => {{ site = value; if (value) value.publicOrigin = {PUBLIC_ORIGIN:?}; }}
  }});
}})();"#
    )
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            open_window(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("run the app");
}

fn open_window(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(debug_assertions)]
    let on_nav = app.clone();
    let on_download = app.clone();
    #[allow(unused_mut)]
    let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("𓁹𓁹")
        .inner_size(1100.0, 780.0)
        .min_inner_size(400.0, 480.0)
        .background_color(PAPER)
        .user_agent(USER_AGENT)
        // Let drops reach the page, where the tools' drop zones handle them.
        .disable_drag_drop_handler()
        .initialization_script(public_origin_script())
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        .on_navigation(move |url| {
            #[cfg(debug_assertions)]
            if probe::intercept(&on_nav, url) {
                return false;
            }
            follow(url)
        })
        .on_new_window(|url, _| {
            // Only the directory opens links in a new tab; they belong in the
            // system browser, like every other outside link.
            follow(&url);
            NewWindowResponse::Deny
        })
        .on_download(move |_, event| {
            match event {
                DownloadEvent::Requested { destination, .. } => {
                    let name = destination.file_name().map(OsStr::to_owned).unwrap_or_else(|| "download".into());
                    *destination = free_path(&downloads(&on_download), &name);
                    #[cfg(debug_assertions)]
                    probe::saving(&on_download, destination);
                }
                #[cfg(debug_assertions)]
                DownloadEvent::Finished { success, .. } => probe::downloaded(&on_download, success),
                _ => {}
            }
            true
        });

    #[cfg(debug_assertions)]
    if probe::start(app) {
        // Kept in front: WebKit throttles a hidden window's page, which stalls
        // share's connections mid-test.
        window = window.initialization_script(probe::SCRIPT).always_on_top(true);
    }

    #[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
    let window = window.build()?;
    #[cfg(target_os = "linux")]
    enable_webrtc(&window);
    Ok(())
}

/// WebKitGTK leaves WebRTC off unless asked, and share needs it. It applies to
/// pages loaded from now on, and the window opens on the index, not share.
#[cfg(target_os = "linux")]
fn enable_webrtc(window: &tauri::WebviewWindow) {
    use webkit2gtk::{SettingsExt, WebViewExt};
    let _ = window.with_webview(|webview| {
        if let Some(settings) = webview.inner().settings() {
            settings.set_enable_webrtc(true);
        }
    });
}

/// The navigation handler: `true` lets the webview load `url`. The app's own
/// pages load here, other sites open in the system browser.
fn follow(url: &Url) -> bool {
    match url.scheme() {
        _ if is_local(url) => true,
        "about" | "blob" | "data" => true,
        "http" | "https" | "mailto" => {
            let _ = open::that_detached(url.as_str());
            false
        }
        _ => false,
    }
}

/// Whether `url` is one of the app's own embedded pages.
fn is_local(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// The folder downloads are saved in.
fn downloads(app: &AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    if probe::running(app) {
        return std::env::temp_dir();
    }
    app.path().download_dir().unwrap_or_else(|_| std::env::temp_dir())
}

/// `dir/name`, or `name (2).ext` and so on if that is taken, as browsers do.
fn free_path(dir: &Path, name: &OsStr) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let name = Path::new(name);
    let stem = name.file_stem().unwrap_or(name.as_os_str()).to_string_lossy();
    let ext = name.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).expect("a free name")
}
