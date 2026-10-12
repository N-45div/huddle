//! What's waiting for you, brought to you: the tray counts it, and each new one is a notification you can
//! answer from (Yes / No), or, when ArmorIQ holds it, open where it's approved.

use std::collections::HashSet;
use std::thread;
use std::time::Duration;

use serde::Deserialize;

#[derive(Deserialize, Clone)]
pub struct HeldBy {
    pub by: String,
    pub url: String,
}

#[derive(Deserialize, Clone)]
pub struct Waiting {
    pub id: String,
    #[serde(rename = "flowName")]
    pub flow_name: String,
    pub message: String,
    #[serde(rename = "heldBy")]
    pub held_by: Option<HeldBy>,
}

fn waiting(port: u16, token: &str) -> Result<Vec<Waiting>, String> {
    ureq::get(&format!("http://127.0.0.1:{port}/api/approvals"))
        .set("authorization", &format!("Bearer {token}"))
        .timeout(Duration::from_secs(5))
        .call()
        .map_err(|error| error.to_string())?
        .into_json()
        .map_err(|error| error.to_string())
}

/// Says yes or no to an approval, as you would in Huddle.
pub fn answer(port: u16, token: &str, id: &str, yes: bool) -> Result<(), String> {
    ureq::post(&format!("http://127.0.0.1:{port}/api/approvals/{id}"))
        .set("authorization", &format!("Bearer {token}"))
        .timeout(Duration::from_secs(5))
        .send_json(serde_json::json!({ "yes": yes }))
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Checks every few seconds for as long as the app runs: `count` gets how many are waiting, `arrived`
/// each one that wasn't there before (none for those already waiting when the app started).
pub fn watch(port: u16, token: String, count: impl Fn(usize) + Send + 'static, arrived: impl Fn(Waiting) + Send + 'static) {
    thread::spawn(move || {
        let mut seen: Option<HashSet<String>> = None;
        loop {
            if let Ok(list) = waiting(port, &token) {
                count(list.len());
                let ids: HashSet<String> = list.iter().map(|approval| approval.id.clone()).collect();
                if let Some(before) = &seen {
                    for approval in list.iter().filter(|approval| !before.contains(&approval.id)) {
                        arrived(approval.clone());
                    }
                }
                seen = Some(ids);
            }
            thread::sleep(Duration::from_secs(3));
        }
    });
}

/// A notification for one approval; what you press comes back to `chose` ("yes", "no", "held", "open").
#[cfg(target_os = "linux")]
pub fn notify(approval: &Waiting, chose: impl FnOnce(&str) + Send + 'static) {
    use notify_rust::{Hint, Notification, Timeout};
    // Where the body is read as markup, a flow's "<b>" or "&" must show as written.
    let markup = notify_rust::get_capabilities().map(|caps| caps.iter().any(|cap| cap == "body-markup")).unwrap_or(false);
    let body = if markup { escape(&approval.message) } else { approval.message.clone() };
    let mut notification = Notification::new();
    notification
        .appname("Huddle")
        .summary(&format!("{} is waiting for you", approval.flow_name))
        .body(&body)
        .icon("huddle")
        .timeout(Timeout::Never)
        // Omarchy's notifications show no buttons; a click runs this instead, even from its history.
        .hint(Hint::Custom("omarchy-exec-argv".into(), serde_json::json!([own_command(), "--approvals"]).to_string()));
    match &approval.held_by {
        Some(held) => {
            notification.action("held", &format!("Approve in {}", held.by));
            notification.action("no", "No");
        }
        None => {
            notification.action("yes", "Yes");
            notification.action("no", "No");
        }
    }
    notification.action("default", "Open Huddle");
    let Ok(handle) = notification.show() else { return };
    thread::spawn(move || {
        handle.wait_for_action(|action| match action {
            "yes" | "no" | "held" => chose(action),
            "default" => chose("open"),
            _ => {}
        });
    });
}

/// How to run this app again: the AppImage itself (its insides vanish when it quits), else this program.
#[cfg(target_os = "linux")]
fn own_command() -> String {
    std::env::var("APPIMAGE")
        .ok()
        .filter(|path| !path.is_empty())
        .or_else(|| std::env::current_exe().ok().map(|path| path.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "huddle".to_string())
}

/// Text that shows as written where notifications read markup.
#[cfg(target_os = "linux")]
fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[cfg(not(target_os = "linux"))]
pub fn notify(_approval: &Waiting, _chose: impl FnOnce(&str) + Send + 'static) {}

/// What a tray line says about what's waiting.
pub fn label(count: usize) -> String {
    match count {
        0 => "Nothing waiting for you".to_string(),
        1 => "1 approval waiting".to_string(),
        n => format!("{n} approvals waiting"),
    }
}

