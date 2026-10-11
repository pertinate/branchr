// Linux stream audio via PipeWire. Chromium can't capture system/app audio on Linux, so
// venmic links the chosen application outputs into a virtual microphone that the renderer
// captures with getUserMedia. Our own processes are always excluded so voice chat isn't
// echoed into the stream.
import { app } from "electron";

type PatchBayT = import("@vencord/venmic").PatchBay;

let patchbay: PatchBayT | null | undefined;

function bay(): PatchBayT | null {
  if (patchbay !== undefined) return patchbay;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PatchBay } = require("@vencord/venmic") as typeof import("@vencord/venmic");
    patchbay = PatchBay.hasPipeWire() ? new PatchBay() : null;
  } catch (e) {
    console.warn("venmic unavailable", e);
    patchbay = null;
  }
  return patchbay;
}

function ownPids(): string[] {
  return app.getAppMetrics().map((m) => String(m.pid));
}

export interface AudioApp {
  name: string;
  binary: string;
}

export const venmic = {
  available: () => process.platform === "linux" && bay() !== null,

  list(): AudioApp[] {
    const b = bay();
    if (!b) return [];
    const own = new Set(ownPids());
    const seen = new Map<string, AudioApp>();
    for (const n of b.list(["application.name", "application.process.binary", "application.process.id", "media.class"])) {
      if (own.has(n["application.process.id"])) continue;
      const name = n["application.name"];
      if (!name || seen.has(name)) continue;
      seen.set(name, { name, binary: n["application.process.binary"] ?? "" });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  },

  /** Links one application (by name) or everything except us when `appName` is null. */
  start(appName: string | null): boolean {
    const b = bay();
    if (!b) return false;
    const pids = ownPids();
    const exclude = pids.map((pid) => ({ "application.process.id": pid }));
    const common = {
      exclude,
      ignore_devices: true,
      only_speakers: true,
      only_default_speakers: true,
      // Chromium's own capture stream must not get auto-linked to the default source.
      workaround: pids.map((pid) => ({ "application.process.id": pid, "media.name": "RecordStream" })),
    };
    return appName ? b.link({ ...common, include: [{ "application.name": appName }] }) : b.link(common);
  },

  stop() {
    bay()?.unlink();
  },
};
