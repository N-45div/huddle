/**
 * Audio for the virtual Huddle button, in the same format the real one uses: 16 kHz mono 16-bit PCM.
 * The microphone goes to Huddle's own speech server (NVIDIA NeMo-Speech on the Huddle machine), never to
 * the browser's speech service; what Huddle says back is played as it arrives.
 */

const RATE = 16_000;

/** Plays 16 kHz PCM frames one after another, as they arrive. */
export class PcmPlayer {
  private context: AudioContext | null = null;
  private next = 0;

  play(frame: ArrayBuffer): void {
    this.context ??= new AudioContext({ sampleRate: RATE });
    const context = this.context;
    if (context.state === "suspended") void context.resume();
    const samples = new Int16Array(frame);
    const buffer = context.createBuffer(1, samples.length, RATE);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index++) channel[index] = samples[index]! / 32_768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    // A small lead keeps frames that arrive together from clicking at the joins.
    const at = Math.max(this.next, context.currentTime + 0.05);
    source.start(at);
    this.next = at + buffer.duration;
  }

  /** Stops what's playing (a newer thing to say, or you started talking). */
  stop(): void {
    void this.context?.close();
    this.context = null;
    this.next = 0;
  }
}

// Turns the browser's float samples into 16-bit PCM, in frames of about 100 ms.
const WORKLET = `
class Pcm16 extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Int16Array(1600); this.length = 0; }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this.buffer[this.length++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.length === this.buffer.length) {
        this.port.postMessage(this.buffer.buffer.slice(0));
        this.length = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm16", Pcm16);
`;

/** Opens the microphone at 16 kHz and hands each ~100 ms of 16-bit PCM to onFrame until stopped. */
export async function openMic(onFrame: (pcm: ArrayBuffer) => void): Promise<{ stop(): void }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const context = new AudioContext({ sampleRate: RATE });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "pcm16");
  node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => onFrame(event.data);
  source.connect(node);
  return {
    stop() {
      source.disconnect();
      node.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close();
    },
  };
}
