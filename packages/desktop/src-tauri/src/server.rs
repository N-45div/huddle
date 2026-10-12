//! Huddle's server, run by the app: the bundled script on the bundled Node, on this computer only, with its
//! data in the app's own folder. It stops when the app does, even if the app is killed.

use std::fs::{self, File};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::settings;

/// Where everything the server needs is.
#[derive(Clone)]
pub struct Paths {
    pub node: PathBuf,
    pub script: PathBuf,
    pub web: PathBuf,
    pub data: PathBuf,
    pub keys: PathBuf,
}

impl Paths {
    pub fn log(&self) -> PathBuf {
        self.data.join("huddle.log")
    }
}

pub struct Server {
    child: Child,
}

/// The port Huddle usually has (so the apps you connect keep working), or a free one if it's taken.
pub fn pick_port(preferred: u16) -> u16 {
    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    TcpListener::bind(("127.0.0.1", 0)).and_then(|listener| listener.local_addr()).map(|address| address.port()).unwrap_or(preferred)
}

impl Server {
    /// Starts the server and waits until it answers, up to 30 seconds.
    pub fn start(paths: &Paths, port: u16, token: &str, version: &str) -> Result<Server, String> {
        fs::create_dir_all(&paths.data).map_err(|error| format!("Couldn't make Huddle's data folder {}: {error}", paths.data.display()))?;
        let log = File::options().create(true).append(true).open(paths.log()).map_err(|error| format!("Couldn't open Huddle's log: {error}"))?;
        let mut command = Command::new(&paths.node);
        command
            .arg(&paths.script)
            .current_dir(&paths.data)
            .env("HUDDLE_DB", paths.data.join("huddle.db"))
            .env("HUDDLE_HOST", "127.0.0.1")
            .env("HUDDLE_PORT", port.to_string())
            .env("HUDDLE_PUBLIC_URL", format!("http://127.0.0.1:{port}"))
            .env("HUDDLE_TOKEN", token)
            .env("HUDDLE_WEB", &paths.web)
            .env("HUDDLE_VERSION", version)
            .env("NODE_NO_WARNINGS", "1")
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|error| error.to_string())?)
            .stderr(log);
        // Your keys and settings; HUDDLE_PORT and the rest above stay the app's.
        for (name, value) in settings::read_env(&paths.keys) {
            if !matches!(name.as_str(), "HUDDLE_DB" | "HUDDLE_HOST" | "HUDDLE_PORT" | "HUDDLE_TOKEN" | "HUDDLE_WEB" | "HUDDLE_PUBLIC_URL") {
                command.env(name, value);
            }
        }
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::process::CommandExt;
            // If the app dies, so does the server, rather than holding the port.
            unsafe {
                command.pre_exec(|| {
                    libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                    Ok(())
                });
            }
        }
        let mut child = command.spawn().map_err(|error| format!("Couldn't start Huddle's server ({}): {error}", paths.node.display()))?;
        let deadline = Instant::now() + Duration::from_secs(30);
        let info = format!("http://127.0.0.1:{port}/api/info");
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("Huddle's server stopped as it started ({status}). The end of its log:\n\n{}", tail(&paths.log(), 20)));
            }
            if ureq::get(&info).timeout(Duration::from_secs(2)).call().is_ok() {
                return Ok(Server { child });
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                return Err(format!("Huddle's server didn't answer within 30 seconds. The end of its log:\n\n{}", tail(&paths.log(), 20)));
            }
            sleep(Duration::from_millis(250));
        }
    }

    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn stop(&mut self) {
        #[cfg(unix)]
        unsafe {
            // A moment to finish what it's writing, then gone.
            libc::kill(self.child.id() as i32, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if !self.alive() {
                return;
            }
            sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The last lines of a file.
pub fn tail(path: &PathBuf, lines: usize) -> String {
    let text = fs::read_to_string(path).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}
