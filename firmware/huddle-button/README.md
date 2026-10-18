# The Huddle button

An [OceanLabz AI Explorer ESP32-S3](https://github.com/ocean-labz/OceanLabz-AI-Explorer-S3-Board) board (1.8"
screen, INMP441 mic, MAX98357A speaker amp, one BOOT button) as a gadget for Huddle:

- **Something waiting for you:** it shows the approval as one line and says it aloud. Press for yes, hold
  (about a second) for no.
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
   refuses to listen beyond your machine without a token. Allow its port (7700) through your firewall for
   your private network.
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
3. **A token for the button:** in the canvas, go to **Devices** and use **Add and make a token**. Copy the
   token; it's shown once.

## Flash the board

1. `cp config.example.h config.h`, then fill in your Wi-Fi (2.4 GHz), Huddle's LAN address and port, and
   the token.
2. Compile and upload with [arduino-cli](https://arduino.github.io/arduino-cli/). You need the ESP32 core
   3.3.12 and these libraries: Adafruit ST7735 and ST7789, Adafruit GFX, Adafruit NeoPixel, ArduinoJson,
   and WebSockets (Markus Sattler).

   ```bash
   FQBN="esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,DebugLevel=none"
   arduino-cli compile --fqbn "$FQBN" firmware/huddle-button
   arduino-cli upload --fqbn "$FQBN" -p COM5 firmware/huddle-button   # your board's port
   ```

## If something's off

- **Blank screen:** OceanLabz's repo changed the screen's pins once, and there's no schematic. Tap the button
  five times quickly: it switches to the other wiring and restarts. The LED blinks once or twice at start-up
  to say which wiring is in use.
- **It never hears you:** set `MIC_RIGHT_CHANNEL` to `1`. Which channel the onboard mic uses isn't documented.
- **Too loud or too quiet:** change `VOLUME`.
- **Won't boot with an SD card in:** GPIO 3 and 46 (the SD slot) are strapping pins, so take the card out.
- **The screen** connects with 8 female-to-female jumper wires from the board's TFT header to the module.
  No soldering is needed.
