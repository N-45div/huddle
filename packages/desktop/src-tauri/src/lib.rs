//! Huddle for Linux. The app starts Huddle's server on this computer and shows its canvas; closing the window
//! keeps it running in the tray, so schedules, email and other triggers carry on. Ctrl+Alt+H opens a quick-ask
//! box; approvals arrive as notifications you can answer; it starts when you log in.
//!
//!   huddle            opens Huddle (or brings its window back, if it's running)
//!   huddle --quick    opens the quick-ask box: bind it to a shortcut where Ctrl+Alt+H can't be had (Wayland)
//!   huddle --restart  restarts Huddle's server, to pick up changed keys and settings
//!   huddle --hidden   starts in the background (how it starts at login)

mod approvals;
mod server;
mod settings;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

use server::{Paths, Server};

const PORT: u16 = 7700;
const QUICK_SIZE: (f64, f64) = (700.0, 480.0);

/// Everything the app keeps while it runs.
struct Desktop {
    paths: Paths,
    port: u16,
    token: String,
    version: String,
    /// The server answers (so the canvas and the quick box can open).
    ready: AtomicBool,
    /// Orders for the thread that owns the server.
    orders: Mutex<Option<Sender<Order>>>,
    approvals_item: Mutex<Option<MenuItem<Wry>>>,
    /// The quick window hides when it loses focus, but not in the moment after it's shown.
    quick_shown: Mutex<Instant>,
    /// When the app opened: the opening screen plays out before the canvas takes over.
    opened: Instant,
    /// The desktop shows tray icons; without one, closing the window minimizes it instead of hiding it.
    has_tray: bool,
    /// Closing minimized the main window (there's no tray).
    minimized: AtomicBool,
    /// Started with --quick: open the quick-ask box once the server answers.
    quick_at_start: AtomicBool,
}

/// What the server's thread can be told.
enum Order {
    Restart,
    Stop,
}

impl Desktop {
    fn url(&self, route: &str) -> Url {
        Url::parse(&format!("http://127.0.0.1:{}/{route}", self.port)).expect("a valid address")
    }

    /// Hands the canvas its token before its scripts run, on Huddle's own address only.
    fn token_script(&self) -> String {
        format!(
            "if (location.origin === 'http://127.0.0.1:{port}') {{ try {{ localStorage.setItem('huddle.token', '{token}'); }} catch (e) {{}} }}",
            port = self.port,
            token = self.token
        )
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        // Running huddle again talks to the copy that's running.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|arg| arg == "--quick") {
                toggle_quick(app);
            } else if args.iter().any(|arg| arg == "--restart") {
                restart(app);
            } else {
                show_main(app, None);
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_quick(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config = app.path().app_config_dir()?;
            let resources = app.path().resource_dir()?;
            let exe = std::env::current_exe()?;
            let paths = Paths {
                node: exe.parent().map(|dir| dir.join("huddle-node")).unwrap_or_else(|| "huddle-node".into()),
                script: resources.join("server").join("huddle.mjs"),
                web: resources.join("web"),
                data: app.path().app_data_dir()?,
                keys: settings::keys_file(&config)?,
            };
            let first_run = !config.join("token").exists();
            let quick = std::env::args().any(|arg| arg == "--quick");
            let hidden = quick || std::env::args().any(|arg| arg == "--hidden");
            let desktop = Desktop {
                paths,
                port: server::pick_port(PORT),
                token: settings::token(&config)?,
                version: app.package_info().version.to_string(),
                ready: AtomicBool::new(false),
                orders: Mutex::new(None),
                approvals_item: Mutex::new(None),
                quick_shown: Mutex::new(Instant::now()),
                opened: Instant::now(),
                has_tray: tray_host(),
                minimized: AtomicBool::new(false),
                quick_at_start: AtomicBool::new(quick),
            };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Huddle")
                .inner_size(1280.0, 860.0)
                .min_inner_size(420.0, 520.0)
                .initialization_script(&desktop.token_script())
                .visible(!hidden)
                .build()?;
            eprintln!("[huddle] tray: {}", if desktop.has_tray { "shown" } else { "none here, so closing the window minimizes it" });
            app.manage(desktop);

            // Always on is the point: start at login, from the first run on (the tray can turn it off).
            if first_run {
                let _ = app.autolaunch().enable();
            }
            build_tray(app.handle())?;
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyH);
            if let Err(error) = app.global_shortcut().register(shortcut) {
                // Wayland sessions keep global shortcuts to themselves; the tray's Quick ask still works.
                eprintln!("[huddle] Ctrl+Alt+H isn't available here ({error}); use Quick ask in the tray.");
            }

            // One thread owns the server for the app's whole life: on Linux the server is told to stop when the
            // thread that started it ends, so it mustn't be a thread that finishes.
            let (orders, inbox) = mpsc::channel();
            *app.state::<Desktop>().orders.lock().unwrap() = Some(orders);
            let handle = app.handle().clone();
            thread::spawn(move || run_server(&handle, inbox));
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing the window keeps Huddle running: in the tray, or minimized where there's no tray.
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" || window.label() == "quick" => {
                api.prevent_close();
                let desktop = window.state::<Desktop>();
                if window.label() == "main" && !desktop.has_tray {
                    desktop.minimized.store(true, Ordering::SeqCst);
                    let _ = window.minimize();
                } else {
                    let _ = window.hide();
                }
            }
            WindowEvent::Focused(false) if window.label() == "quick" => {
                let desktop = window.state::<Desktop>();
                let shown = *desktop.quick_shown.lock().unwrap();
                if shown.elapsed() > Duration::from_millis(600) {
                    let _ = window.hide();
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("Huddle couldn't start");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            let desktop = app.state::<Desktop>();
            if let Some(orders) = desktop.orders.lock().unwrap().as_ref() {
                let _ = orders.send(Order::Stop);
            }
            // A moment for the server to finish what it's writing.
            let deadline = Instant::now() + Duration::from_secs(3);
            while desktop.ready.load(Ordering::SeqCst) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(50));
            }
        }
    });
}

/// Owns the server: starts it, shows the canvas, starts it again if it stops on its own (three times in five
/// minutes, then says so), and does what it's told from the tray.
fn run_server(app: &AppHandle, inbox: mpsc::Receiver<Order>) {
    let desktop = app.state::<Desktop>();
    let mut first = true;
    let mut crashes: Vec<Instant> = Vec::new();
    loop {
        let mut server = match Server::start(&desktop.paths, desktop.port, &desktop.token, &desktop.version) {
            Ok(server) => server,
            Err(problem) => {
                failed(app, &problem);
                // Wait for Restart Huddle (or quitting).
                match inbox.recv() {
                    Ok(Order::Restart) => continue,
                    _ => return,
                }
            }
        };
        desktop.ready.store(true, Ordering::SeqCst);
        if let Some(main) = app.get_webview_window("main") {
            // Let the huddle gather (about two and a half seconds) the first time, when the window is showing.
            if first && main.is_visible().unwrap_or(false) {
                thread::sleep(Duration::from_millis(2600).saturating_sub(desktop.opened.elapsed()));
            }
            let _ = main.navigate(desktop.url("#/flows"));
        }
        if first {
            watch_approvals(app);
            if desktop.quick_at_start.swap(false, Ordering::SeqCst) {
                toggle_quick(app);
            }
            first = false;
        }
        loop {
            match inbox.recv_timeout(Duration::from_secs(2)) {
                Ok(Order::Restart) => {
                    desktop.ready.store(false, Ordering::SeqCst);
                    server.stop();
                    break;
                }
                Ok(Order::Stop) | Err(RecvTimeoutError::Disconnected) => {
                    server.stop();
                    desktop.ready.store(false, Ordering::SeqCst);
                    return;
                }
                Err(RecvTimeoutError::Timeout) if !server.alive() => {
                    desktop.ready.store(false, Ordering::SeqCst);
                    crashes.retain(|at| at.elapsed() < Duration::from_secs(300));
                    crashes.push(Instant::now());
                    if crashes.len() > 3 {
                        let log = server::tail(&desktop.paths.log(), 20);
                        failed(app, &format!("Huddle's server kept stopping. The end of its log:\n\n{log}"));
                        match inbox.recv() {
                            Ok(Order::Restart) => {
                                crashes.clear();
                                break;
                            }
                            _ => return,
                        }
                    }
                    break;
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
    }
}

/// Shows why the server couldn't start, on the opening screen.
fn failed(app: &AppHandle, problem: &str) {
    let Some(main) = app.get_webview_window("main") else { return };
    let _ = main.show();
    if main.url().map(|url| url.scheme() != "tauri").unwrap_or(true) {
        let _ = main.navigate(Url::parse("tauri://localhost/index.html").expect("a valid address"));
        thread::sleep(Duration::from_millis(900));
    }
    let _ = main.eval(&format!("window.huddleFailed && window.huddleFailed({})", serde_json::to_string(problem).unwrap_or_default()));
}

/// Stops and starts the server, to pick up changed keys and settings.
fn restart(app: &AppHandle) {
    if let Some(orders) = app.state::<Desktop>().orders.lock().unwrap().as_ref() {
        let _ = orders.send(Order::Restart);
    }
}

fn watch_approvals(app: &AppHandle) {
    let desktop = app.state::<Desktop>();
    let (port, token) = (desktop.port, desktop.token.clone());
    let counter = app.clone();
    let notifier = app.clone();
    approvals::watch(
        port,
        token.clone(),
        move |count| {
            let label = approvals::label(count);
            if let Some(item) = counter.state::<Desktop>().approvals_item.lock().unwrap().as_ref() {
                let _ = item.set_text(&label);
            }
            if let Some(tray) = counter.tray_by_id("huddle") {
                let _ = tray.set_tooltip(Some(if count == 0 { "Huddle".to_string() } else { format!("Huddle: {label}") }));
                let _ = tray.set_title(if count == 0 { None } else { Some(count.to_string()) });
            }
        },
        move |approval| {
            let app = notifier.clone();
            let token = token.clone();
            let held_url = approval.held_by.as_ref().map(|held| held.url.clone());
            let id = approval.id.clone();
            approvals::notify(&approval, move |choice| match choice {
                "yes" | "no" => {
                    if let Err(problem) = approvals::answer(port, &token, &id, choice == "yes") {
                        eprintln!("[huddle] couldn't answer approval {id}: {problem}");
                        show_main(&app, Some("#/approvals"));
                    }
                }
                "held" => {
                    if let Some(url) = held_url {
                        let _ = app.opener().open_url(url, None::<&str>);
                    }
                }
                _ => show_main(&app, Some("#/approvals")),
            });
        },
    );
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Huddle", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "Quick ask   (Ctrl+Alt+H)", true, None::<&str>)?;
    let waiting = MenuItem::with_id(app, "approvals", approvals::label(0), true, None::<&str>)?;
    let login = CheckMenuItem::with_id(app, "login", "Start when I log in", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
    let keys = MenuItem::with_id(app, "keys", "Keys and settings…", true, None::<&str>)?;
    let again = MenuItem::with_id(app, "restart", "Restart Huddle", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Huddle", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &quick, &waiting, &PredefinedMenuItem::separator(app)?, &login, &keys, &again, &PredefinedMenuItem::separator(app)?, &quit],
    )?;
    *app.state::<Desktop>().approvals_item.lock().unwrap() = Some(waiting);
    let login_item = login.clone();
    TrayIconBuilder::with_id("huddle")
        .icon(app.default_window_icon().cloned().expect("the app's icon"))
        .tooltip("Huddle")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_main(app, None),
            "quick" => toggle_quick(app),
            "approvals" => show_main(app, Some("#/approvals")),
            "login" => {
                let launcher = app.autolaunch();
                let on = launcher.is_enabled().unwrap_or(false);
                let _ = if on { launcher.disable() } else { launcher.enable() };
                let _ = login_item.set_checked(launcher.is_enabled().unwrap_or(!on));
            }
            "keys" => {
                let keys = app.state::<Desktop>().paths.keys.clone();
                let _ = app.opener().open_path(keys.to_string_lossy(), None::<&str>);
            }
            "restart" => restart(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Whether the desktop shows tray icons (something answers for StatusNotifierWatcher on the session bus).
/// Stock GNOME without the AppIndicator extension, and WSLg, have none.
#[cfg(target_os = "linux")]
fn tray_host() -> bool {
    let Ok(bus) = zbus::blocking::Connection::session() else { return false };
    let Ok(dbus) = zbus::blocking::fdo::DBusProxy::new(&bus) else { return false };
    let Ok(name) = zbus::names::BusName::try_from("org.kde.StatusNotifierWatcher") else { return false };
    dbus.name_has_owner(name).unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
fn tray_host() -> bool {
    true
}

/// Brings the main window up, on a route of the canvas if given.
fn show_main(app: &AppHandle, route: Option<&str>) {
    let Some(main) = app.get_webview_window("main") else { return };
    if let Some(route) = route {
        let desktop = app.state::<Desktop>();
        if desktop.ready.load(Ordering::SeqCst) {
            let _ = main.navigate(desktop.url(route));
        }
    }
    // Wayland gives an app no way to un-minimize its own window, but a window shown afresh always appears.
    if app.state::<Desktop>().minimized.swap(false, Ordering::SeqCst) {
        let _ = main.hide();
    }
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
}

/// Opens the quick-ask box, or hides it if it's showing.
fn toggle_quick(app: &AppHandle) {
    let desktop = app.state::<Desktop>();
    if !desktop.ready.load(Ordering::SeqCst) {
        show_main(app, None);
        return;
    }
    if let Some(quick) = app.get_webview_window("quick") {
        if quick.is_visible().unwrap_or(false) {
            let _ = quick.hide();
        } else {
            *desktop.quick_shown.lock().unwrap() = Instant::now();
            let _ = quick.center();
            let _ = quick.show();
            let _ = quick.set_focus();
        }
        return;
    }
    *desktop.quick_shown.lock().unwrap() = Instant::now();
    // Escape hides the box (the one thing this window may ask of the app).
    let escape = "document.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.__TAURI_INTERNALS__?.invoke('plugin:window|hide', { label: 'quick' }).catch(() => {}); });";
    let built = WebviewWindowBuilder::new(app, "quick", WebviewUrl::External(desktop.url("#/quick")))
        .title("Ask Huddle")
        .inner_size(QUICK_SIZE.0, QUICK_SIZE.1)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .focused(true)
        .initialization_script(&format!("{}\n{escape}", desktop.token_script()))
        .build();
    if let Err(error) = built {
        eprintln!("[huddle] couldn't open quick ask: {error}");
    }
}
