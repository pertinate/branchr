// GTCRN: ultra-lightweight speech enhancement network (48 kHz native path, 16 ms frames).
// Stronger than RNNoise on non-stationary noise (keyboards, fans, chatter).
import { GtcrnWorkletNode, loadGtcrn } from "@sapphi-red/web-noise-suppressor";
import worklet from "@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?raw";
import wasm from "@sapphi-red/web-noise-suppressor/gtcrn.wasm?dataurl";

import { workletUrl } from "./worklet-url";

let binary: Promise<ArrayBuffer> | null = null;

export async function createNode(ctx: AudioContext): Promise<AudioWorkletNode & { destroy(): void }> {
  binary ??= loadGtcrn({ url: wasm });
  await ctx.audioWorklet.addModule(workletUrl("gtcrn", worklet));
  return new GtcrnWorkletNode(ctx, { maxChannels: 1, wasmBinary: await binary });
}
