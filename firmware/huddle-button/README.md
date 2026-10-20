# The Huddle button

An [OceanLabz AI Explorer ESP32-S3](https://github.com/ocean-labz/OceanLabz-AI-Explorer-S3-Board) board (1.8"
screen, INMP441 mic, MAX98357A speaker amp, one BOOT button) as a gadget for Huddle:

- **Something waiting for you:** it shows the approval as one line and says it aloud. Hold the button for a
  second for yes: a bar fills, and letting go says yes. A quick press is no. Yes takes the deliberate
  gesture, so a knock never approves anything.
- **Nothing waiting:** it shows today's spend, the next scheduled run, and the flows you've put on the button
  (a flow's trigger: "From my Huddle button"). Tap to pick one; hold and talk to start it with your words.
  With no flows on it, holding and talking asks Huddle's router.
- **Voice stays home:** Huddle hears you with NVIDIA Nemotron 3.5 ASR and speaks with Magpie TTS, both on
  your own machine through NeMo-Speech. Only the words go on to your assistants, and each run's receipt
  says your voice was heard on this machine.

It talks to Huddle over a WebSocket (`/devices/ws`) with its own token. The canvas's **Devices** page has a
virtual button that works the same way, to try it without the hardware.

## Set up Huddle

1. **Let the button reach Huddle:** start Huddle with `HUDDLE_HOST=0.0.0.0` and a `HUDDLE_TOKEN`. Huddle
   refuses to listen beyond your machine without a token. Then allow its port through your firewall for
   your private network. On Windows, once, in an Administrator PowerShell:

   ```powershell
   New-NetFirewallRule -DisplayName "Huddle 7700" -Direction Inbound -Protocol TCP -LocalPort 7700 -Action Allow -Profile Private
   ```

   Your Wi-Fi also has to be a **Private** network in Windows' settings. To check, open
   `http://<this computer's address>:7700/api/info` on your phone, on the same Wi-Fi.
2. **Voice (optional):** run [NVIDIA NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp) and point
   Huddle at it.

   ```bash
   nemo-speech serve --asr-model nemotron-3.5 --tts-model magpie --device vulkan:1 --port 8090 --no-ui
   HUDDLE_SPEECH_URL=http://127.0.0.1:8090
   ```

   `--device cpu` works too: listening stays quick, and speaking is about real time. On Windows, keep the
   model folder's path short (`NEMO_SPEECH_MODEL_DIR=C:\nsm`).

   The models have their own licences, and you download them yourself:
   - Nemotron 3.5 ASR: OpenMDW-1.1.
   - Magpie TTS and NanoCodec: the NVIDIA Open Model License.

## Flash the board

1. **Write `config.h`** with the setup script, from the repository's root, while Huddle is running:

   ```bash
   HUDDLE_TOKEN=<your token> node firmware/huddle-button/setup.mjs                 # bash
   $env:HUDDLE_TOKEN="<your token>"; node firmware/huddle-button/setup.mjs         # PowerShell
   ```

   It does the following:
   - makes the button's device token;
   - finds this computer's address on your Wi-Fi;
   - asks for the Wi-Fi name and password (the password is typed hidden);
   - on Windows, warns if that network is 5 GHz;
   - prints the start, firewall and upload commands for your machine.

   Add `--huddle http://127.0.0.1:7760` if Huddle isn't on port 7700.

   To do it by hand instead: copy `config.example.h` to `config.h`, and make the token in the canvas
   (**Devices**, then **Add and make a token**; it's shown once).
2. **Compile and upload** with [arduino-cli](https://arduino.github.io/arduino-cli/). You need the ESP32 core
   3.3.12 and these libraries: Adafruit ST7735 and ST7789, Adafruit GFX, Adafruit NeoPixel, ArduinoJson,
   and WebSockets (Markus Sattler).

   ```bash
   FQBN="esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,DebugLevel=none"
   arduino-cli compile --fqbn "$FQBN" firmware/huddle-button
   arduino-cli upload --fqbn "$FQBN" -p COM5 firmware/huddle-button   # your board's port: arduino-cli board list
   ```

   If the upload can't find the board, hold BOOT, tap RESET, let go of BOOT, and upload again.

## The first start

The button checks itself before it joins anything, and logs every step on USB:

```bash
arduino-cli monitor -p COM5 -c baudrate=115200
```

1. **Screen:** "Checking myself", the screen wiring in use and the memory it found.
2. **Speaker and mic:** it plays a two-note chime and listens to it on both mic channels. It draws the two
   levels, keeps the channel that heard the chime, and remembers it for the next start.
3. **Wi-Fi:** it joins the network in `config.h` and logs its address and signal strength.
4. **Huddle:** it connects. Then it logs each message from Huddle, what it heard you say, and each answer
   you gave.

## If something's off

- **Blank screen:** OceanLabz's repo changed the screen's pins once, and there's no schematic. Tap the button
  five times quickly (with no approval waiting): it switches to the other wiring and restarts. The LED blinks
  once or twice at start-up to say which wiring is in use.
- **No chime:** check the speaker's plug and `VOLUME`. If the log says "no PSRAM", compile with the FQBN
  above (`PSRAM=opi`).
- **It never hears you:** watch the mic levels at start-up. If neither channel hears the chime, it uses the
  channel that heard last time, or `MIC_RIGHT_CHANNEL` if none has yet, so try `1`.
- **Stuck joining Wi-Fi:** it needs a 2.4 GHz network. Laptops are often on the router's 5 GHz name, and the
  button can't join that one. The router's 2.4 GHz network is still the same network as your laptop.
- **"Can't reach Huddle":** check these, in order:
  - Huddle runs with `HUDDLE_HOST=0.0.0.0`;
  - the firewall rule is in, and the Wi-Fi is a Private network;
  - `HUDDLE_HOST` in `config.h` is this computer's current address (`ipconfig`);
  - the token is the one Huddle made for this button.
- **Too loud or too quiet:** change `VOLUME`.
- **Won't boot with an SD card in:** GPIO 3 and 46 (the SD slot) are strapping pins, so take the card out.
- **The screen** connects with 8 female-to-female jumper wires from the board's TFT header to the module.
  No soldering is needed.
