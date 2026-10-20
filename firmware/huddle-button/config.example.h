// setup.mjs writes config.h for you (node firmware/huddle-button/setup.mjs). By hand: copy this file to config.h
// and fill it in. config.h stays out of git: it holds your Wi-Fi password and the token.

// Your Wi-Fi (2.4 GHz: the ESP32-S3 can't join 5 GHz networks, and laptops are often on the 5 GHz one).
#define WIFI_SSID "your-wifi-name"
#define WIFI_PASSWORD "your-wifi-password"

// The computer running Huddle, as seen from the Wi-Fi (its LAN address, not localhost), and Huddle's port.
// Huddle must listen beyond this machine for the button to reach it: HUDDLE_HOST=0.0.0.0 with HUDDLE_TOKEN set.
#define HUDDLE_HOST "192.168.1.20"
#define HUDDLE_PORT 7700
// 1 when Huddle is behind https (a hosted Huddle); 0 on your own network.
#define HUDDLE_TLS 0

// The device token from Huddle's Devices page ("Add and make a token"), shown once.
#define DEVICE_TOKEN "hdl_d_paste-yours-here"

// How loud it speaks, 0 to 100.
#define VOLUME 70
// The INMP441 sends on one I2S channel, and which one isn't documented for this board. At start-up the button
// listens to its own chime on both and keeps the one that hears (and remembers it). This is what it uses
// until a channel has heard the chime once.
#define MIC_RIGHT_CHANNEL 0
