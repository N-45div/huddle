// The Huddle button: an OceanLabz AI Explorer ESP32-S3 board that shows what's waiting for you in Huddle,
// takes your yes or no, and starts the flows you put on it, by press or by voice.
//
//   Waiting approval: press = yes, hold (about a second) = no. It says the approval aloud.
//   Nothing waiting:  tap = next flow, hold and talk = start that flow with your words (or ask the router).
//   Screen blank?     press five times quickly: it switches to the other screen wiring and restarts.
//
// It talks to Huddle over a WebSocket (/devices/ws) with its own device token. Audio is 16 kHz mono 16-bit
// PCM both ways; Huddle hears and speaks with NVIDIA's NeMo-Speech on its own machine.
//
// Pins: OceanLabz's map (github.com/ocean-labz/OceanLabz-AI-Explorer-S3-Board, pins_ai_explorer_s3.h).
// There is no schematic; the TFT's pins changed once in their repo, so both candidates are here.

#include <Adafruit_GFX.h>
#include <Adafruit_NeoPixel.h>
#include <Adafruit_ST7735.h>
#include <ArduinoJson.h>
#include <ESP_I2S.h>
#include <Preferences.h>
#include <SPI.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <vector>

#if __has_include("config.h")
#include "config.h"
#else
#error "Copy config.example.h to config.h and fill in your Wi-Fi, Huddle's address and the device token."
#endif

// ---- Pins ---------------------------------------------------------------------------------------------
constexpr int MIC_WS = 39, MIC_SCK = 40, MIC_SD = 41;       // INMP441
constexpr int AMP_LRC = 21, AMP_BCLK = 48, AMP_DIN = 47;    // MAX98357A
constexpr int LED_PIN = 14;                                  // WS2812B
constexpr int BUTTON_PIN = 0;                                // BOOT, the only button the code can read

struct TftPins {
  int8_t cs, dc, rst, bl, mosi, sclk;
};
// 1: OceanLabz's map since 25 Sep 2026 ("verified working values"). 2: their earlier one, like the silkscreen.
constexpr TftPins TFT_MAPS[2] = {{45, 1, 43, 44, 42, 38}, {45, 38, 1, 42, 43, 44}};

constexpr uint32_t RATE = 16000;
constexpr size_t MIC_FRAME = 1600;                   // 100 ms of samples
constexpr size_t PLAY_BUFFER = 16000 * 2 * 12;       // 12 s of audio, in PSRAM

// ---- State --------------------------------------------------------------------------------------------
enum class Mode { Connecting, Idle, Approval, Listening, Thinking };
enum class Mood { Idle, Waiting, Happy, Oops, Thinking };

struct Flow {
  String id, name;
};

Adafruit_ST7735 *tft = nullptr;
Adafruit_NeoPixel led(1, LED_PIN, NEO_GRB + NEO_KHZ800);
WebSocketsClient socket;
I2SClass mic, amp;
Preferences prefs;

Mode mode = Mode::Connecting;
Mood mood = Mood::Idle;
String approvalId, approvalFlow, approvalLine, approvalWarning;
int approvalMore = 0;
float spentToday = 0;
String nextFlow, nextAt;
std::vector<Flow> flows;
size_t picked = 0;
String replyFlow, replyText, heardText, note;
unsigned long moodUntil = 0, replyUntil = 0;
bool redraw = true;
int tftMap = 0;

// Playback: a ring of PCM bytes filled by the socket, played by its own task.
uint8_t *ring = nullptr;
volatile size_t ringHead = 0, ringTail = 0;
portMUX_TYPE ringLock = portMUX_INITIALIZER_UNLOCKED;

// ---- Small helpers ------------------------------------------------------------------------------------
void setLed(uint8_t r, uint8_t g, uint8_t b) {
  led.setPixelColor(0, led.Color(r, g, b));
  led.show();
}

void flushPlayback() {
  portENTER_CRITICAL(&ringLock);
  ringHead = ringTail = 0;
  portEXIT_CRITICAL(&ringLock);
}

void queueAudio(const uint8_t *data, size_t length) {
  portENTER_CRITICAL(&ringLock);
  for (size_t i = 0; i < length; i++) {
    size_t next = (ringHead + 1) % PLAY_BUFFER;
    if (next == ringTail) break;  // full: drop the rest
    ring[ringHead] = data[i];
    ringHead = next;
  }
  portEXIT_CRITICAL(&ringLock);
}

void playTask(void *) {
  static int16_t frame[320];  // 20 ms
  for (;;) {
    size_t got = 0;
    portENTER_CRITICAL(&ringLock);
    while (got < sizeof(frame) && ringTail != ringHead) {
      reinterpret_cast<uint8_t *>(frame)[got++] = ring[ringTail];
      ringTail = (ringTail + 1) % PLAY_BUFFER;
    }
    portEXIT_CRITICAL(&ringLock);
    size_t samples = got / 2;
    for (size_t i = 0; i < samples; i++) frame[i] = (int32_t)frame[i] * VOLUME / 100;
    for (size_t i = samples; i < 320; i++) frame[i] = 0;  // silence between things to say: no pops
    amp.write(reinterpret_cast<uint8_t *>(frame), sizeof(frame));
  }
}

/** Words wrapped to the screen's width (21 characters of the built-in font). */
std::vector<String> wrap(const String &text, size_t width = 21, size_t maxLines = 6) {
  std::vector<String> lines;
  String line;
  int start = 0;
  while (start <= (int)text.length() && lines.size() < maxLines) {
    int space = text.indexOf(' ', start);
    String word = text.substring(start, space < 0 ? text.length() : space);
    if (line.length() + word.length() + (line.length() ? 1 : 0) > width && line.length()) {
      lines.push_back(line);
      line = "";
    }
    line += (line.length() ? " " : "") + word;
    if (space < 0) break;
    start = space + 1;
  }
  if (line.length() && lines.size() < maxLines) lines.push_back(line);
  return lines;
}

// ---- Drawing: Hud, and what's going on ----------------------------------------------------------------
void drawHud(Mood face) {
  const int x = 64, y = 34;
  tft->fillCircle(x, y, 24, 0x5B1C);           // Hud's blue
  tft->fillRoundRect(x - 16, y - 10, 32, 18, 7, ST77XX_BLACK);  // visor
  tft->drawLine(x, y - 24, x, y - 30, 0x5B1C);  // antenna
  tft->fillCircle(x, y - 31, 2, ST77XX_YELLOW);
  switch (face) {
    case Mood::Happy:
      tft->drawLine(x - 10, y - 1, x - 7, y - 4, ST77XX_WHITE);
      tft->drawLine(x - 7, y - 4, x - 4, y - 1, ST77XX_WHITE);
      tft->drawLine(x + 4, y - 1, x + 7, y - 4, ST77XX_WHITE);
      tft->drawLine(x + 7, y - 4, x + 10, y - 1, ST77XX_WHITE);
      tft->fillCircle(x, y + 13, 4, ST77XX_WHITE);
      break;
    case Mood::Oops:
      tft->drawLine(x - 10, y - 5, x - 4, y + 1, ST77XX_WHITE);
      tft->drawLine(x - 10, y + 1, x - 4, y - 5, ST77XX_WHITE);
      tft->drawLine(x + 4, y - 5, x + 10, y + 1, ST77XX_WHITE);
      tft->drawLine(x + 4, y + 1, x + 10, y - 5, ST77XX_WHITE);
      tft->drawLine(x - 5, y + 16, x + 5, y + 13, ST77XX_WHITE);
      break;
    case Mood::Thinking:
      tft->fillCircle(x - 4, y - 4, 2, ST77XX_WHITE);
      tft->fillCircle(x + 10, y - 4, 2, ST77XX_WHITE);
      tft->drawCircle(x + 1, y + 14, 2, ST77XX_WHITE);
      break;
    case Mood::Waiting:
      tft->fillCircle(x - 7, y - 5, 2, ST77XX_WHITE);
      tft->fillCircle(x + 7, y - 5, 2, ST77XX_WHITE);
      tft->drawFastHLine(x - 5, y + 14, 10, ST77XX_WHITE);
      break;
    default:
      tft->fillCircle(x - 7, y - 2, 2, ST77XX_WHITE);
      tft->fillCircle(x + 7, y - 2, 2, ST77XX_WHITE);
      tft->drawLine(x - 5, y + 12, x, y + 15, ST77XX_WHITE);
      tft->drawLine(x, y + 15, x + 5, y + 12, ST77XX_WHITE);
  }
}

void text(int y, const String &words, uint16_t color, size_t maxLines = 6) {
  tft->setTextColor(color);
  tft->setTextSize(1);
  for (const String &line : wrap(words, 21, maxLines)) {
    tft->setCursor(1, y);
    tft->print(line);
    y += 10;
  }
}

void footer(const String &words) {
  tft->fillRect(0, 148, 128, 12, 0x2104);
  tft->setTextColor(0xBDF7);
  tft->setCursor(2, 150);
  tft->print(words);
}

void draw() {
  if (!tft) return;
  redraw = false;
  tft->fillScreen(ST77XX_BLACK);
  Mood face = mood;
  if (millis() > moodUntil) {
    face = mode == Mode::Approval ? Mood::Waiting : mode == Mode::Listening || mode == Mode::Thinking ? Mood::Thinking : Mood::Idle;
  }
  drawHud(face);
  if (mode == Mode::Connecting) {
    text(70, note.length() ? note : "Connecting to Huddle...", ST77XX_WHITE);
    footer("5 quick taps: screen");
    return;
  }
  if (mode == Mode::Listening) {
    text(76, "Listening...", ST77XX_WHITE);
    footer("let go to send");
    return;
  }
  if (mode == Mode::Thinking) {
    text(70, "You said:", 0x9CF3, 1);
    text(82, heardText.length() ? heardText : "...", ST77XX_WHITE, 6);
    footer("working on it");
    return;
  }
  if (mode == Mode::Approval) {
    String flow = approvalFlow;
    flow.toUpperCase();
    text(64, flow, 0xAD55, 1);
    text(76, approvalLine, ST77XX_WHITE, 5);
    if (approvalWarning.length()) text(128, approvalWarning, 0xFD34, 2);
    footer(approvalMore > 0 ? "yes:press no:hold +" + String(approvalMore) : "yes: press  no: hold");
    return;
  }
  if (millis() < replyUntil && replyText.length()) {
    text(64, replyFlow, 0xAD55, 1);
    text(76, replyText, ST77XX_WHITE, 7);
    footer("tap: next  hold: talk");
    return;
  }
  text(66, "Nothing needs you.", ST77XX_WHITE, 1);
  text(80, "Today: $" + String(spentToday, 4), 0xC618, 1);
  if (nextFlow.length()) text(92, "Next: " + nextFlow + " " + nextAt, 0xC618, 2);
  if (!flows.empty()) {
    text(116, "> " + flows[picked % flows.size()].name, 0x07FF, 2);
  } else {
    text(116, "Hold to ask Huddle", 0x07FF, 1);
  }
  footer("tap: next  hold: talk");
}

// ---- Talking to Huddle ---------------------------------------------------------------------------------
void sendJson(JsonDocument &doc) {
  String out;
  serializeJson(doc, out);
  socket.sendTXT(out);
}

void onMessage(uint8_t *payload, size_t length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;
  String type = doc["type"] | "";
  if (type == "hello") {
    JsonDocument hello;
    hello["type"] = "hello";
    hello["audio"] = true;
    sendJson(hello);
  } else if (type == "approval") {
    mode = Mode::Approval;
    approvalId = doc["id"] | "";
    approvalFlow = doc["flow"] | "";
    approvalLine = doc["line"] | "";
    approvalWarning = doc["warning"].isNull() ? "" : String(doc["warning"] | "");
    approvalMore = doc["more"] | 0;
    setLed(40, 20, 0);
  } else if (type == "idle") {
    if (mode != Mode::Listening && mode != Mode::Thinking) mode = Mode::Idle;
    spentToday = doc["spentTodayUsd"] | 0.0f;
    nextFlow = doc["nextRun"].isNull() ? "" : String(doc["nextRun"]["flow"] | "");
    String at = doc["nextRun"].isNull() ? "" : String(doc["nextRun"]["at"] | "");
    nextAt = at.length() >= 16 ? at.substring(11, 16) + " UTC" : "";
    flows.clear();
    for (JsonObject flow : doc["flows"].as<JsonArray>()) flows.push_back({flow["id"] | "", flow["name"] | ""});
    if (picked >= flows.size()) picked = 0;
    setLed(0, 0, 4);
  } else if (type == "heard") {
    heardText = doc["text"] | "";
    if (!heardText.length()) mode = Mode::Idle;
  } else if (type == "run") {
    String state = doc["state"] | "";
    mood = state == "done" ? Mood::Happy : state == "failed" ? Mood::Oops : Mood::Idle;
    moodUntil = millis() + 4000;
    if (!doc["answer"].isNull()) {
      replyFlow = doc["flow"] | "";
      replyText = doc["answer"] | "";
      replyUntil = millis() + 20000;
    }
    if (mode == Mode::Thinking) mode = Mode::Idle;
  } else if (type == "started") {
    replyFlow = doc["flow"] | "";
    replyText = "Started.";
    replyUntil = millis() + 8000;
    mode = Mode::Thinking;
  } else if (type == "speaking") {
    setLed(0, 30, 0);
  } else if (type == "spoken") {
    setLed(0, 0, 4);
  } else if (type == "error") {
    note = doc["message"] | "Something went wrong.";
    replyFlow = "Huddle";
    replyText = note;
    replyUntil = millis() + 8000;
    mood = Mood::Oops;
    moodUntil = millis() + 4000;
    if (mode == Mode::Thinking) mode = Mode::Idle;
    setLed(40, 0, 0);
  }
  redraw = true;
}

void onSocket(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      note = "";
      mode = Mode::Idle;
      redraw = true;
      break;
    case WStype_DISCONNECTED:
      mode = Mode::Connecting;
      note = "Huddle isn't answering. Retrying...";
      redraw = true;
      break;
    case WStype_TEXT:
      onMessage(payload, length);
      break;
    case WStype_BIN:
      queueAudio(payload, length);
      break;
    default:
      break;
  }
}

// ---- Listening ------------------------------------------------------------------------------------------
void startListening() {
  flushPlayback();
  JsonDocument listen;
  listen["type"] = "listen";
  if (!flows.empty()) listen["flow"] = flows[picked % flows.size()].id;
  sendJson(listen);
  mode = Mode::Listening;
  heardText = "";
  setLed(0, 0, 40);
  redraw = true;
}

void stopListening() {
  JsonDocument stop;
  stop["type"] = "stop";
  sendJson(stop);
  mode = Mode::Thinking;
  setLed(0, 0, 8);
  redraw = true;
}

void streamMic() {
  static int32_t raw[MIC_FRAME * 2];
  static int16_t pcm[MIC_FRAME];
  // Mono slot: one 32-bit word per sample, the INMP441's 24 bits at the top.
  size_t got = mic.readBytes(reinterpret_cast<char *>(raw), MIC_FRAME * sizeof(int32_t));
  size_t samples = got / sizeof(int32_t);
  for (size_t i = 0; i < samples; i++) {
    int32_t value = raw[i] >> 14;  // about +12 dB over a plain 16-bit cut
    pcm[i] = value > 32767 ? 32767 : value < -32768 ? -32768 : value;
  }
  if (samples) socket.sendBIN(reinterpret_cast<uint8_t *>(pcm), samples * 2);
}

// ---- The button -----------------------------------------------------------------------------------------
bool wasDown = false;
unsigned long downAt = 0;
unsigned long tapTimes[5] = {0};
int taps = 0;

void onTap() {
  // Five quick taps when nothing waits: the other screen wiring, and a restart.
  tapTimes[taps % 5] = millis();
  taps++;
  if (taps >= 5 && millis() - tapTimes[taps % 5] < 2500) {
    tftMap = 1 - tftMap;
    prefs.putInt("tft", tftMap);
    for (int i = 0; i < 6; i++) {
      setLed(i % 2 ? 0 : 40, 0, i % 2 ? 0 : 40);
      delay(150);
    }
    ESP.restart();
  }
  if (!flows.empty()) picked = (picked + 1) % flows.size();
  replyUntil = 0;
  redraw = true;
}

void readButton() {
  bool down = digitalRead(BUTTON_PIN) == LOW;
  unsigned long now = millis();
  if (down && !wasDown) downAt = now;
  unsigned long held = now - downAt;
  if (mode == Mode::Idle && down && held > 350 && socket.isConnected()) startListening();
  if (!down && wasDown) {
    if (mode == Mode::Listening) {
      stopListening();
    } else if (mode == Mode::Approval && approvalId.length()) {
      JsonDocument answer;
      answer["type"] = "answer";
      answer["id"] = approvalId;
      answer["yes"] = held < 900;
      sendJson(answer);
      flushPlayback();
      mood = held < 900 ? Mood::Happy : Mood::Idle;
      moodUntil = now + 2000;
      redraw = true;
    } else if (held > 30 && held < 350) {
      onTap();
    }
  }
  if (mode == Mode::Approval && down && held > 900 && held < 960) {
    footer("let go to say no");
  }
  wasDown = down;
}

// ---- Setup and loop -------------------------------------------------------------------------------------
void setupScreen() {
  const TftPins &p = TFT_MAPS[tftMap];
  pinMode(p.bl, OUTPUT);
  digitalWrite(p.bl, HIGH);
  SPIClass *spi = new SPIClass(FSPI);
  spi->begin(p.sclk, -1, p.mosi, p.cs);
  tft = new Adafruit_ST7735(spi, p.cs, p.dc, p.rst);
  tft->initR(INITR_BLACKTAB);
  tft->setRotation(0);
  tft->fillScreen(ST77XX_BLACK);
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  led.begin();
  led.setBrightness(60);
  prefs.begin("huddle", false);
  tftMap = prefs.getInt("tft", 0) == 1 ? 1 : 0;
  // The LED blinks the screen wiring in use (1 or 2), so a dark screen still says something.
  for (int i = 0; i <= tftMap; i++) {
    setLed(30, 0, 30);
    delay(200);
    setLed(0, 0, 0);
    delay(200);
  }
  setupScreen();
  note = "Joining " WIFI_SSID "...";
  draw();

  ring = static_cast<uint8_t *>(ps_malloc(PLAY_BUFFER));
  amp.setPins(AMP_BCLK, AMP_LRC, AMP_DIN);
  amp.begin(I2S_MODE_STD, RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
  mic.setPins(MIC_SCK, MIC_WS, -1, MIC_SD);
  mic.begin(I2S_MODE_STD, RATE, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO, MIC_RIGHT_CHANNEL ? I2S_STD_SLOT_RIGHT : I2S_STD_SLOT_LEFT);
  if (ring) xTaskCreatePinnedToCore(playTask, "play", 4096, nullptr, 2, nullptr, 0);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    readButton();
    delay(100);
  }
  note = "Connecting to Huddle...";
  redraw = true;

  static String auth = String("Authorization: Bearer ") + DEVICE_TOKEN;
#if HUDDLE_TLS
  socket.beginSSL(HUDDLE_HOST, HUDDLE_PORT, "/devices/ws");
#else
  socket.begin(HUDDLE_HOST, HUDDLE_PORT, "/devices/ws");
#endif
  socket.setExtraHeaders(auth.c_str());
  socket.onEvent(onSocket);
  socket.setReconnectInterval(3000);
  socket.enableHeartbeat(20000, 5000, 2);
}

void loop() {
  socket.loop();
  readButton();
  if (mode == Mode::Listening) streamMic();
  static unsigned long lastFace = 0;
  // Redraw on news, and when a passing mood or reply runs out.
  if (redraw || (moodUntil && millis() > moodUntil && millis() - lastFace > 1000) || (replyUntil && millis() > replyUntil && millis() - lastFace > 1000)) {
    if (moodUntil && millis() > moodUntil) moodUntil = 0;
    if (replyUntil && millis() > replyUntil) replyUntil = 0;
    lastFace = millis();
    draw();
  }
  delay(mode == Mode::Listening ? 0 : 5);
}
