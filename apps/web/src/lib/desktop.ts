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
  gpuInfo: () => Promise<{ hwEncode: string[]; hwDecode: string[]; features: Record<string, string> }>;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export const desktop = typeof window !== "undefined" ? window.desktop : undefined;
export const isDesktop = !!desktop;
