import { contextBridge, ipcRenderer } from "electron";

const isWayland = process.platform === "linux" && (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY);

contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  systemPicker: isWayland,
  getSources: () => ipcRenderer.invoke("desktop:get-sources"),
  selectSource: (id: string | null) => ipcRenderer.invoke("desktop:select-source", id),
  setBadge: (count: number) => ipcRenderer.send("desktop:badge", count),
  notify: (title: string, body: string) => ipcRenderer.send("desktop:notify", title, body),
  window: {
    minimize: () => ipcRenderer.send("desktop:window", "minimize"),
    maximize: () => ipcRenderer.send("desktop:window", "maximize"),
    close: () => ipcRenderer.send("desktop:window", "close"),
  },
  gpuInfo: () => ipcRenderer.invoke("desktop:gpu-info"),
  idleSeconds: () => ipcRenderer.invoke("desktop:idle-seconds"),
  auth: {
    onCallback: (cb: (url: string) => void) => ipcRenderer.on("desktop:auth-callback", (_e, url: string) => cb(url)),
    pending: () => ipcRenderer.invoke("desktop:auth-pending"),
  },
  audio: {
    available: () => ipcRenderer.invoke("desktop:audio-available"),
    list: () => ipcRenderer.invoke("desktop:audio-list"),
    start: (appName: string | null) => ipcRenderer.invoke("desktop:audio-start", appName),
    stop: () => ipcRenderer.invoke("desktop:audio-stop"),
  },
});
