/** Bridge exposed by the Electron preload script (absent in a plain browser). */
export interface DesktopSource {
  id: string;
  name: string;
  thumbnail: string;
  appIcon: string | null;
  kind: "screen" | "window";
}

export interface DesktopBridge {
  platform: string;
  /** True when the OS (Wayland portal) shows its own picker. */
  systemPicker: boolean;
  getSources: () => Promise<DesktopSource[]>;
  /** Chooses the source the next getDisplayMedia() call resolves with. */
  selectSource: (id: string | null) => Promise<void>;
  setBadge: (count: number) => void;
  notify: (title: string, body: string) => void;
  window: { minimize: () => void; maximize: () => void; close: () => void };
  /** Seconds since any input on the system (absent in older builds). */
  idleSeconds?: () => Promise<number>;
  gpuInfo: () => Promise<{ hwEncode: string[]; hwDecode: string[]; features: Record<string, string> }>;
  /** `branchr://auth/callback` links from finishing sign-in in the browser. */
  auth?: {
    onCallback: (cb: (url: string) => void) => void;
    /** A link that arrived before we were listening (e.g. it launched the app). */
    pending: () => Promise<string | null>;
  };
  /** Linux stream audio through a PipeWire virtual mic (venmic). */
  audio: {
    available: () => Promise<boolean>;
    list: () => Promise<{ name: string; binary: string }[]>;
    /** One application by name, or everything except this app when null. */
    start: (appName: string | null) => Promise<boolean>;
    stop: () => Promise<void>;
  };
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export const desktop = typeof window !== "undefined" ? window.desktop : undefined;
export const isDesktop = !!desktop;
