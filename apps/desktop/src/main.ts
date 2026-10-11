import { cpSync, existsSync } from "node:fs";
import path from "node:path";

import {
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  Tray,
  app,
  clipboard,
  desktopCapturer,
  ipcMain,
  nativeImage,
  session,
  shell,
} from "electron";

import { handleArgv, registerProtocol, setupDeepLinks } from "./deeplink";
import { venmic } from "./venmic";

const isWayland = process.platform === "linux" && (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY);
const devUrl = process.env.DEV_URL;

/** Test mode: synthetic camera/mic/screen instead of real devices and the portal picker. */
const fakeMedia = process.env.BRANCHR_FAKE_MEDIA === "1";
if (fakeMedia) {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}

// --- Chromium tuning -----------------------------------------------------------------------
// Must run before `app.ready`.
{
  const features = [
    // PipeWire screen capture (required on Wayland, better than X11 capture too).
    "WebRTCPipeWireCapturer",
    // VA-API hardware video encode/decode on Linux (AMD/Intel; NVIDIA via nvidia-vaapi-driver).
    "AcceleratedVideoEncoder",
    "AcceleratedVideoDecodeLinuxGL",
    "AcceleratedVideoDecodeLinuxZeroCopyGL",
    "VaapiVideoEncoder",
    "VaapiVideoDecoder",
    "VaapiIgnoreDriverChecks",
    // HEVC for WebRTC (hardware encoders on most GPUs since ~2016).
    "PlatformHEVCEncoderSupport",
    "WebRtcAllowH265Send",
    "WebRtcAllowH265Receive",
    // Native Wayland window decorations when we're not frameless.
    "WaylandWindowDecorations",
  ];
  app.commandLine.appendSwitch("enable-features", features.join(","));
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  app.commandLine.appendSwitch("enable-zero-copy");
  // A streaming/voice app must keep encoding and playing audio when minimized or occluded.
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  // Desktop app: allow audio to start without a click.
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
}

app.setName("branchr");
migrateProfile();
// Separate profile (and single-instance lock) for tests or multiple accounts.
if (process.env.BRANCHR_PROFILE) app.setPath("userData", process.env.BRANCHR_PROFILE);
if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;
setupDeepLinks(() => win);
let tray: Tray | null = null;
let quitting = false;
/** Source chosen in our own picker (X11); consumed by the next getDisplayMedia call. */
let selectedSource: string | null = null;

/**
 * The app used to be called "Discord Clone": carry that profile (login, settings, server
 * address) over to the new name once, skipping caches and the old instance lock.
 */
function migrateProfile() {
  if (process.env.BRANCHR_PROFILE) return;
  // Not app.getPath("userData"): that creates the directory, so it would always "exist".
  const next = path.join(app.getPath("appData"), app.getName());
  const old = path.join(app.getPath("appData"), "Discord Clone");
  if (existsSync(next) || !existsSync(old)) return;
  const skip = new Set(["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "SingletonLock", "SingletonCookie", "SingletonSocket"]);
  try {
    cpSync(old, next, { recursive: true, filter: (src) => !skip.has(path.basename(src)) });
  } catch (e) {
    console.warn("profile migration failed", e);
  }
}

function iconPath() {
  return app.isPackaged ? path.join(process.resourcesPath, "icon.png") : path.join(__dirname, "..", "build", "icon.png");
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 940,
    minHeight: 560,
    frame: false,
    backgroundColor: "#1e1f22",
    show: false,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: true,
    },
  });

  win.once("ready-to-show", () => win?.show());
  win.on("close", (e) => {
    // Closing the window keeps you in voice, like Discord; quit from the tray.
    if (!quitting && tray) {
      e.preventDefault();
      win?.hide();
    }
  });

  // External links open in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith("file:");
    if (!allowed) {
      e.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });

  // The app shows its own menus for messages, people, channels…; anything it leaves alone
  // (text boxes, selected text, plain links) gets the usual native one.
  win.webContents.on("context-menu", (_e, p) => {
    const items: MenuItemConstructorOptions[] = [];
    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => win?.webContents.replaceMisspelling(s) });
      if (!p.dictionarySuggestions.length) items.push({ label: "No suggestions", enabled: false });
      items.push(
        { label: "Add to Dictionary", click: () => win?.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) },
        { type: "separator" },
      );
    }
    if (p.linkURL && /^https?:/.test(p.linkURL)) {
      items.push(
        { label: "Open Link", click: () => void shell.openExternal(p.linkURL) },
        { label: "Copy Link", click: () => clipboard.writeText(p.linkURL) },
        { type: "separator" },
      );
    }
    if (p.isEditable) {
      items.push(
        { role: "cut", enabled: p.editFlags.canCut },
        { role: "copy", enabled: p.editFlags.canCopy },
        { role: "paste", enabled: p.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll" },
      );
    } else if (p.selectionText.trim()) {
      items.push({ role: "copy" });
    }
    while (items.at(-1)?.type === "separator") items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win ?? undefined });
  });

  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(__dirname, "..", "web", "index.html"));
}

function setupSession() {
  const ses = session.defaultSession;
  const allowed = new Set(["media", "display-capture", "notifications", "clipboard-sanitized-write", "fullscreen", "speaker-selection"]);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  if (fakeMedia) return; // Chromium's fake capture handles getDisplayMedia.
  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        // On Wayland this opens the xdg-desktop-portal picker and returns the user's choice.
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
        const source = sources.find((s) => s.id === selectedSource) ?? sources[0];
        selectedSource = null;
        if (!source) return callback({});
        // "loopback" system audio is only implemented on Windows; on Linux Chromium ignores it.
        callback({ video: source, audio: request.audioRequested && process.platform === "win32" ? "loopback" : undefined });
      } catch (e) {
        console.error("display media request failed", e);
        callback({});
      }
    },
    { useSystemPicker: false },
  );
}

function setupIpc() {
  ipcMain.handle("desktop:get-sources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      appIcon: s.appIcon?.toDataURL() ?? null,
      kind: s.id.startsWith("screen") ? "screen" : "window",
    }));
  });
  ipcMain.handle("desktop:select-source", (_e, id: string | null) => {
    selectedSource = id;
  });
  ipcMain.on("desktop:badge", (_e, count: number) => {
    app.setBadgeCount(count);
  });
  ipcMain.on("desktop:notify", (_e, title: string, body: string) => {
    if (win?.isFocused()) return;
    const n = new Notification({ title, body, icon: iconPath(), silent: false });
    n.on("click", () => {
      win?.show();
      win?.focus();
    });
    n.show();
  });
  ipcMain.on("desktop:window", (_e, action: "minimize" | "maximize" | "close") => {
    if (!win) return;
    if (action === "minimize") win.minimize();
    else if (action === "maximize") (win.isMaximized() ? win.unmaximize() : win.maximize());
    else win.close();
  });
  ipcMain.handle("desktop:audio-available", () => venmic.available());
  ipcMain.handle("desktop:audio-list", () => venmic.list());
  ipcMain.handle("desktop:audio-start", (_e, appName: string | null) => venmic.start(appName));
  ipcMain.handle("desktop:audio-stop", () => venmic.stop());
  ipcMain.handle("desktop:gpu-info", async () => {
    const info = (await app.getGPUInfo("complete")) as {
      auxAttributes?: Record<string, unknown>;
      videoEncodeAcceleratorSupportedProfile?: { profile: string }[];
      videoDecodeAcceleratorSupportedProfile?: { profile: string }[];
    };
    return {
      features: app.getGPUFeatureStatus() as unknown as Record<string, string>,
      hwEncode: (info.videoEncodeAcceleratorSupportedProfile ?? []).map((p) => String(p.profile)),
      hwDecode: (info.videoDecodeAcceleratorSupportedProfile ?? []).map((p) => String(p.profile)),
    };
  });
}

function setupTray() {
  const image = nativeImage.createFromPath(iconPath()).resize({ width: 22, height: 22 });
  tray = new Tray(image);
  tray.setToolTip("branchr");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open", click: () => win?.show() },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => (win?.isVisible() ? win.hide() : win?.show()));
}

app.on("second-instance", (_e, argv) => {
  // A branchr:// link (sign-in finishing in the browser) arrives as the new copy's argv.
  handleArgv(argv);
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.on("before-quit", () => {
  quitting = true;
  venmic.stop();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  setupSession();
  setupIpc();
  registerProtocol();
  createWindow();
  try {
    setupTray();
  } catch (e) {
    // Some desktops have no tray; closing the window then quits.
    console.warn("tray unavailable", e);
  }
});

app.on("window-all-closed", () => app.quit());

export const platformInfo = { isWayland };
