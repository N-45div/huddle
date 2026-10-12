//! What the desktop app keeps for you in its config folder: the token Huddle answers to (made once, so the
//! apps you connect keep working), and your keys and settings, one NAME=value a line, readable only by you.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const KEYS_TEMPLATE: &str = "\
# Huddle's keys and settings, one NAME=value a line. Only you can read this file.
# Save it, then choose Restart Huddle in the tray. Lines starting with # are ignored.
#
# A model for \"describe it\", and to choose and fill in views (any OpenAI-compatible API):
# HUDDLE_LLM_URL=https://api.openai.com/v1
# HUDDLE_LLM_MODEL=gpt-5.4-mini
# HUDDLE_LLM_KEY=
#
# Keys your assistants name in their settings (keyEnv), for example:
# OPENAI_API_KEY=
# VLLM_API_KEY=
#
# Email in and out through Resend:
# RESEND_API_KEY=
# RESEND_WEBHOOK_SECRET=
# HUDDLE_OWNER_EMAILS=you@example.com
#
# Jev chooses who answers \"auto\", and how to show answers:
# TYPESAFE_API_KEY=
#
# A cap on what assistants with a price may spend:
# HUDDLE_BUDGET=20/month
#
# Something to check every hand-off first (optional): armoriq, or http for your own policy service
# HUDDLE_GUARD=
# ARMORIQ_API_KEY=
# HUDDLE_GUARD_URL=
";

/// The token Huddle answers to on this computer: made once, then kept.
pub fn token(config: &Path) -> std::io::Result<String> {
    fs::create_dir_all(config)?;
    let path = config.join("token");
    if let Ok(existing) = fs::read_to_string(&path) {
        let existing = existing.trim();
        if existing.len() >= 32 && existing.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(existing.to_string());
        }
    }
    let token: String = (0..32).map(|_| format!("{:02x}", rand::random::<u8>())).collect();
    write_private(&path, &token)?;
    Ok(token)
}

/// Your keys and settings file, made from the template the first time.
pub fn keys_file(config: &Path) -> std::io::Result<PathBuf> {
    fs::create_dir_all(config)?;
    let path = config.join("huddle.env");
    if !path.exists() {
        write_private(&path, KEYS_TEMPLATE)?;
    }
    Ok(path)
}

/// NAME=value pairs from the file: comments, blank lines and names that aren't environment-variable names
/// are skipped; quotes around a value come off.
pub fn read_env(path: &Path) -> Vec<(String, String)> {
    let Ok(text) = fs::read_to_string(path) else { return Vec::new() };
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let line = line.strip_prefix("export ").unwrap_or(line);
            let (name, value) = line.split_once('=')?;
            let name = name.trim();
            let valid = !name.is_empty()
                && name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                && !name.starts_with(|c: char| c.is_ascii_digit());
            if !valid {
                return None;
            }
            let value = value.trim();
            let value = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                .unwrap_or(value);
            if value.is_empty() {
                return None;
            }
            Some((name.to_string(), value.to_string()))
        })
        .collect()
}

fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_names_and_values_and_skips_the_rest() {
        let dir = std::env::temp_dir().join(format!("huddle-env-{}", rand::random::<u32>()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("huddle.env");
        fs::write(&path, "# comment\nOPENAI_API_KEY=sk-1\nexport HUDDLE_BUDGET=\"20/month\"\nlower=x\n9BAD=y\nEMPTY=\n HUDDLE_GUARD = 'http' \n").unwrap();
        assert_eq!(
            read_env(&path),
            vec![
                ("OPENAI_API_KEY".to_string(), "sk-1".to_string()),
                ("HUDDLE_BUDGET".to_string(), "20/month".to_string()),
                ("HUDDLE_GUARD".to_string(), "http".to_string()),
            ]
        );
    }

    #[test]
    fn keeps_the_same_token() {
        let dir = std::env::temp_dir().join(format!("huddle-token-{}", rand::random::<u32>()));
        let first = token(&dir).unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(token(&dir).unwrap(), first);
    }
}
