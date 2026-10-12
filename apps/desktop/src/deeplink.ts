/**
 * `branchr://` links. Sign-in finishes in the system browser, which hands the result back
 * to the app as `branchr://auth/callback?code=…&state=…`.
 *
 * The OS starts a second copy of the app with the link in its argv; the single-instance
 * lock forwards that to us as `second-instance`. On a cold start the link is in our own argv.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { BrowserWindow, app, ipcMain } from "electron";

const SCHEME = "branchr";
const CALLBACK = "branchr://auth/callback";

/** A link that arrived before the renderer was listening. */
let pending: string | null = null;
let window: () => BrowserWindow | null = () => null;

const linkIn = (argv: string[]) => argv.find((a) => a.startsWith(CALLBACK));

function deliver(url: string) {
  if (!url.startsWith(CALLBACK)) return;
  const w = window();
  if (!w || w.webContents.isLoading()) {
    pending = url;
    return;
  }
  w.webContents.send("desktop:auth-callback", url);
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

/** Call before `app.ready` (macOS delivers links through `open-url` early). */
export function setupDeepLinks(getWindow: () => BrowserWindow | null) {
  window = getWindow;
  pending = linkIn(process.argv) ?? null;
  app.on("open-url", (e, url) => {
    e.preventDefault();
    deliver(url);
  });
  ipcMain.handle("desktop:auth-pending", () => {
    const p = pending;
    pending = null;
    return p;
  });
}

/** Whether `url` starts a branchr sign-in that comes back to the app. */
export function isAppSignIn(url: string) {
  try {
    const u = new URL(url);
    return u.pathname === "/authorize" && u.searchParams.get("redirect_uri") === CALLBACK;
  } catch {
    return false;
  }
}

/**
 * Dev builds aren't the system's `branchr://` handler, so sign-in runs in a window of our own
 * and we catch the redirect back to the app ourselves.
 */
export function signInWindow(url: string, parent: BrowserWindow | null) {
  const w = new BrowserWindow({
    width: 520,
    height: 760,
    parent: parent ?? undefined,
    title: "Sign in to branchr",
    autoHideMenuBar: true,
    webPreferences: { partition: "persist:signin", sandbox: true, contextIsolation: true },
  });
  const catchCallback = (e: { preventDefault: () => void }, target: string) => {
    if (!target.startsWith(CALLBACK)) return;
    e.preventDefault();
    deliver(target);
    w.close();
  };
  w.webContents.on("will-redirect", catchCallback);
  w.webContents.on("will-navigate", catchCallback);
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void w.loadURL(url);
}

/** For `second-instance`: the argv of the copy the OS started for a link. */
export function handleArgv(argv: string[]) {
  const url = linkIn(argv);
  if (url) deliver(url);
}

/** Makes this app the handler for `branchr://`. Only for installed builds, not dev. */
export function registerProtocol() {
  if (!app.isPackaged) return;
  app.setAsDefaultProtocolClient(SCHEME);
  // An AppImage has no installed .desktop file for the desktop to find, so write one.
  if (process.platform === "linux" && process.env.APPIMAGE) registerLinux(process.env.APPIMAGE);
}

function registerLinux(appImage: string) {
  const dir = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "applications");
  const name = "branchr-url-handler.desktop";
  const file = path.join(dir, name);
  // Desktop Entry spec: inside quotes, ", `, $ and \ are escaped with a backslash.
  const exec = `"${appImage.replace(/(["`$\\])/g, "\\$1")}" %u`;
  const content = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=branchr",
    `Exec=${exec}`,
    "Terminal=false",
    "NoDisplay=true",
    `MimeType=x-scheme-handler/${SCHEME};`,
    "",
  ].join("\n");
  try {
    // The AppImage may have moved since last time; rewrite only when something changed.
    if (readFileSync(file, "utf8") === content) return;
  } catch {
    /* not written yet */
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content);
    execFile("xdg-mime", ["default", name, `x-scheme-handler/${SCHEME}`], (e) => e && console.warn("xdg-mime", e.message));
    execFile("update-desktop-database", [dir], () => {});
  } catch (e) {
    console.warn("couldn't register branchr:// links", e);
  }
}
