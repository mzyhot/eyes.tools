//! Copies the site into `dist/` before Tauri embeds it.
//!
//! The app publishes exactly what the Node server does: the root files named
//! in `public-files.mjs`, and every page in `t/`. Pages are written to the top
//! of `dist/` as `<slug>.html` because Tauri resolves `/json` to `json.html`,
//! which gives the app the same clean addresses as the site.
//!
//! Nothing here needs editing when a tool is added or removed.

use std::fs;
use std::path::Path;

fn main() {
    let desktop = Path::new(env!("CARGO_MANIFEST_DIR"));
    let site = desktop.parent().expect("desktop/ sits inside the repository");
    let dist = desktop.join("dist");

    let _ = fs::remove_dir_all(&dist);
    fs::create_dir_all(&dist).expect("create dist/");

    let list = site.join("public-files.mjs");
    println!("cargo:rerun-if-changed={}", list.display());
    for name in public_root_files(&fs::read_to_string(&list).expect("read public-files.mjs")) {
        let from = site.join(&name);
        let to = dist.join(&name);
        println!("cargo:rerun-if-changed={}", from.display());
        // An entry may sit in a folder, as self-hosted fonts in `fonts/` do.
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).unwrap_or_else(|e| panic!("create {}: {e}", parent.display()));
        }
        fs::copy(&from, &to).unwrap_or_else(|e| panic!("copy {name}: {e}"));
    }

    // slug:tool pairs for the smoke test: the tool a page should end up on,
    // which differs from the slug only for the compatibility redirects.
    let mut pages = Vec::new();
    let tools = site.join("t");
    println!("cargo:rerun-if-changed={}", tools.display());
    for entry in fs::read_dir(&tools).expect("read t/") {
        let path = entry.expect("read t/").path();
        let Some(slug) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".html")) else { continue };
        let html = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {slug}: {e}"));
        let lands_on = attribute(&html, "data-to=\"").unwrap_or(slug).to_owned();
        fs::write(dist.join(format!("{slug}.html")), html).unwrap_or_else(|e| panic!("copy {slug}: {e}"));
        pages.push(format!("{slug}:{lands_on}"));
    }
    pages.sort();
    println!("cargo:rustc-env=EYES_PAGES={}", pages.join(","));
    println!("cargo:rerun-if-env-changed=EYES_PUBLIC_ORIGIN");

    tauri_build::build();
}

/// The quoted names in `PUBLIC_ROOT_FILES = [ … ]`, skipping `/* comments */`.
fn public_root_files(source: &str) -> Vec<String> {
    let start = source.find("PUBLIC_ROOT_FILES").expect("public-files.mjs names PUBLIC_ROOT_FILES");
    let body = &source[start..];
    let body = &body[body.find('[').expect("an array")..body.find(']').expect("a closed array")];

    let mut names = Vec::new();
    let mut rest = body;
    while let Some(i) = rest.find(['"', '/']) {
        rest = &rest[i..];
        if let Some(after) = rest.strip_prefix("/*") {
            rest = &after[after.find("*/").expect("a closed comment") + 2..];
        } else if let Some(after) = rest.strip_prefix('"') {
            let end = after.find('"').expect("a closed string");
            names.push(after[..end].to_owned());
            rest = &after[end + 1..];
        } else {
            rest = &rest[1..];
        }
    }
    assert!(names.iter().any(|n| n == "index.html"), "public-files.mjs lists index.html");
    names
}

/// The value after `prefix` up to the next quote, if the prefix appears.
fn attribute<'a>(html: &'a str, prefix: &str) -> Option<&'a str> {
    let value = &html[html.find(prefix)? + prefix.len()..];
    Some(&value[..value.find('"')?])
}
