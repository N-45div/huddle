//! On Omarchy, Huddle wears the desktop's theme: its colours come from the theme's palette
//! (colors.toml), and change with it when you switch themes. Anywhere else this finds no palette and
//! Huddle keeps its own colours.

use std::collections::HashMap;
use std::path::PathBuf;

/// Where the current theme's palette is: Omarchy 4 keeps it in its state folder, Omarchy 3 in its config.
fn palette_file() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    [".local/state/omarchy/current/theme/colors.toml", ".config/omarchy/current/theme/colors.toml"]
        .iter()
        .map(|path| home.join(path))
        .find(|path| path.is_file())
}

/// The palette as it is now, to notice a theme switch (by what it says: stock themes' files can share a time).
pub fn stamp() -> Option<(PathBuf, String)> {
    let file = palette_file()?;
    let text = std::fs::read_to_string(&file).ok()?;
    Some((file, text))
}

type Rgb = (u8, u8, u8);

fn hex(value: &str) -> Option<Rgb> {
    let digits = value.strip_prefix('#')?;
    if digits.len() != 6 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let part = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).ok();
    Some((part(0)?, part(2)?, part(4)?))
}

fn css((r, g, b): Rgb) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// `from` moved `amount` of the way to `to`.
fn mix(from: Rgb, to: Rgb, amount: f64) -> Rgb {
    let blend = |a: u8, b: u8| (a as f64 * (1.0 - amount) + b as f64 * amount).round() as u8;
    (blend(from.0, to.0), blend(from.1, to.1), blend(from.2, to.2))
}

fn luminance((r, g, b): Rgb) -> f64 {
    (0.2126 * r as f64 + 0.7152 * g as f64 + 0.0722 * b as f64) / 255.0
}

/// The palette's keys, as Omarchy reads them: `key = "value"` lines, with its older short names accepted.
fn parse(text: &str) -> HashMap<String, String> {
    let mut keys = HashMap::new();
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim().trim_matches(|c| c == '"' || c == '\'');
        if key.is_empty() || key.starts_with('#') {
            continue;
        }
        let value = value.trim();
        let value = match value.strip_prefix(['"', '\'']) {
            Some(rest) => rest.split(['"', '\'']).next().unwrap_or(""),
            None => value,
        };
        keys.insert(key.to_string(), value.to_string());
    }
    for (name, short) in [("background", "bg"), ("foreground", "fg"), ("dark_background", "dark_bg")] {
        if !keys.contains_key(name) {
            if let Some(value) = keys.get(short).cloned() {
                keys.insert(name.to_string(), value);
            }
        }
    }
    keys
}

/// Huddle's colours from a palette: its own tokens, worked out from the theme's few colours.
fn tokens(palette: &HashMap<String, String>, light_marker: bool) -> Option<Vec<(&'static str, String)>> {
    let colour = |key: &str| palette.get(key).and_then(|value| hex(value));
    let bg = colour("background")?;
    let fg = colour("foreground")?;
    let accent = colour("accent").or_else(|| colour("blue"))?;
    let light = match palette.get("mode").or_else(|| palette.get("theme_type")).map(String::as_str) {
        Some("light") => true,
        Some("dark") => false,
        _ => light_marker || luminance(bg) > 0.5,
    };
    let (white, black) = ((255, 255, 255), (0, 0, 0));
    let toward = |amount: f64| css(mix(bg, fg, amount));
    let soft = |rgb: Rgb| css(mix(bg, rgb, if light { 0.14 } else { 0.2 }));
    let mut out: Vec<(&'static str, String)> = vec![
        ("--bg", css(bg)),
        ("--surface", if light { css(mix(bg, white, 0.6)) } else { toward(0.05) }),
        ("--surface-2", toward(if light { 0.04 } else { 0.09 })),
        ("--surface-3", toward(if light { 0.08 } else { 0.13 })),
        ("--canvas", toward(if light { 0.03 } else { 0.02 })),
        ("--border", toward(if light { 0.12 } else { 0.16 })),
        ("--border-strong", toward(if light { 0.22 } else { 0.26 })),
        ("--dots", toward(0.14)),
        ("--edge", toward(0.4)),
        ("--text", css(fg)),
        ("--muted", css(mix(fg, bg, 0.3))),
        ("--faint", css(mix(fg, bg, 0.48))),
        ("--accent", css(accent)),
        ("--accent-hover", css(if light { mix(accent, black, 0.12) } else { mix(accent, white, 0.15) })),
        ("--accent-soft", soft(accent)),
        ("--accent-contrast", if luminance(accent) > 0.55 { css(mix(bg, black, 0.5)) } else { "#ffffff".to_string() }),
        ("--kind-condition", css(mix(fg, bg, 0.3))),
        ("--chart-1", css(accent)),
        ("--chart-5", css(mix(fg, bg, 0.4))),
        ("color-scheme", (if light { "light" } else { "dark" }).to_string()),
    ];
    for (token, key) in [("--ok", "green"), ("--warn", "yellow"), ("--danger", "red")] {
        if let Some(rgb) = colour(key) {
            out.push((token, css(rgb)));
            out.push((
                match token {
                    "--ok" => "--ok-soft",
                    "--warn" => "--warn-soft",
                    _ => "--danger-soft",
                },
                soft(rgb),
            ));
        }
    }
    for (token, key) in [
        ("--kind-approval", "yellow"),
        ("--kind-memory", "green"),
        ("--chart-2", "cyan"),
        ("--chart-3", "orange"),
        ("--chart-4", "magenta"),
        ("--chart-6", "yellow"),
    ] {
        if let Some(rgb) = colour(key) {
            out.push((token, css(rgb)));
        }
    }
    Some(out)
}

/// Every property this can set, so switching away from Omarchy's palette puts Huddle's own colours back.
const ALL: &[&str] = &[
    "--bg", "--surface", "--surface-2", "--surface-3", "--canvas", "--border", "--border-strong", "--dots", "--edge", "--text",
    "--muted", "--faint", "--accent", "--accent-hover", "--accent-soft", "--accent-contrast", "--kind-condition",
    "--kind-approval", "--kind-memory", "--ok", "--ok-soft", "--warn", "--warn-soft", "--danger", "--danger-soft", "--chart-1",
    "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6", "color-scheme",
];

/// A script that dresses Huddle's pages (on its own address only) in the current theme, or in Huddle's own
/// colours when there's no palette. Every value is a colour this worked out, never text from the file.
pub fn theme_script(port: u16) -> String {
    let tokens = stamp().and_then(|(file, text)| {
        let light_marker = file.with_file_name("light.mode").is_file();
        tokens(&parse(&text), light_marker)
    });
    let set: HashMap<&str, String> = tokens.unwrap_or_default().into_iter().collect();
    let json = serde_json::to_string(&set).unwrap_or_else(|_| "{}".to_string());
    let all = serde_json::to_string(ALL).unwrap_or_else(|_| "[]".to_string());
    format!(
        "if (location.origin === 'http://127.0.0.1:{port}') {{ (function (set, all) {{ var style = document.documentElement.style; all.forEach(function (name) {{ if (set[name]) style.setProperty(name, set[name]); else style.removeProperty(name); }}); }})({json}, {all}); }}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKYO_NIGHT: &str = "mode = \"dark\"\n\naccent = \"#7aa2f7\"\nbackground = \"#1a1b26\"\nforeground = \"#a9b1d6\"\ngreen = \"#9ece6a\"\n# a comment\nred = '#f7768e' # inline\n";

    #[test]
    fn reads_a_palette() {
        let palette = parse(TOKYO_NIGHT);
        assert_eq!(palette["accent"], "#7aa2f7");
        assert_eq!(palette["red"], "#f7768e");
        let set: HashMap<_, _> = tokens(&palette, false).unwrap().into_iter().collect();
        assert_eq!(set["--bg"], "#1a1b26");
        assert_eq!(set["--accent"], "#7aa2f7");
        assert_eq!(set["--danger"], "#f7768e");
        assert_eq!(set["color-scheme"], "dark");
        assert!(!set.contains_key("--warn"), "no yellow in the palette, so Huddle's own stays");
    }

    #[test]
    fn light_themes_and_short_names() {
        let palette = parse("bg = \"#eff1f5\"\nfg = \"#4c4f69\"\naccent = \"#1e66f5\"\n");
        let set: HashMap<_, _> = tokens(&palette, false).unwrap().into_iter().collect();
        assert_eq!(set["color-scheme"], "light", "worked out from how bright the background is");
        assert_eq!(set["--bg"], "#eff1f5");
    }

    #[test]
    fn nothing_but_colours_gets_through() {
        let palette = parse("background = \"red; } body { display: none\"\nforeground = \"#ffffff\"\naccent = \"#000000\"\n");
        assert!(tokens(&palette, false).is_none(), "a background that isn't a colour means no theme");
        let palette = parse("background = \"#000000\"\nforeground = \"#ffffff\"\naccent = \"#123\"\nblue = \"#0000ff\"\ngreen = \"url(x)\"\n");
        let set: HashMap<_, _> = tokens(&palette, false).unwrap().into_iter().collect();
        assert_eq!(set["--accent"], "#0000ff", "a short accent isn't read; blue stands in");
        assert!(!set.contains_key("--ok"));
    }
}
