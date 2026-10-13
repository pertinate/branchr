import type { Status, User } from "@app/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PicturePicker } from "@/components/picture-picker";
import { MicTest } from "@/components/voice/mic-test";
import { setStatus } from "@/lib/actions";
import { api } from "@/lib/api";
import { type OwnedHost, claimServer, ownedHosts, releaseHost, signOut, startSignIn, useBranchrId } from "@/lib/branchr-id";
import { desktop } from "@/lib/desktop";
import { hostOf, instanceKey, normalizeUrl, useActive, useInstance, useInstanceList } from "@/lib/instances";
import { uploadPicture } from "@/lib/media";
import { instanceInfo, linkToBranchr } from "@/lib/server-login";
import { useApp } from "@/stores/app";
import { useAuth } from "@/stores/auth";
import { useDialogs, usePrefs } from "@/stores/ui";
import { useVoice, useVoiceSettings } from "@/stores/voice";
import { type NoiseSuppression, noiseSuppressionModes } from "@/voice/mic";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[75vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>User Settings</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="account" className="flex min-h-0 flex-1 flex-col">
          <TabsList>
            <TabsTrigger value="account">My Account</TabsTrigger>
            <TabsTrigger value="voice">Voice & Audio</TabsTrigger>
            <TabsTrigger value="perf">Streaming & Performance</TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          </TabsList>
          <TabsContent value="account" className="overflow-y-auto">
            <Account />
          </TabsContent>
          <TabsContent value="voice" className="overflow-y-auto">
            <VoiceSettings />
          </TabsContent>
          <TabsContent value="perf" className="overflow-y-auto">
            <Performance />
          </TabsContent>
          <TabsContent value="advanced" className="overflow-y-auto">
            <Advanced />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function Account() {
  const me = useApp((s) => s.me)!;
  const status = useApp((s) => s.presences[me.id] ?? "online");
  const [name, setName] = useState(me.displayName);
  const inst = useInstance();
  const applied = (u: User) => {
    useApp.getState().apply({ t: "USER_UPDATE", d: u });
    useAuth.getState().setUser(u);
  };
  const save = async () => {
    try {
      applied(await api<User>("PATCH", "/users/@me", { displayName: name }));
      toast.success("Profile updated");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const logout = async () => {
    // Only this instance: voice elsewhere stays up.
    if (useVoice.getState().instanceId === useActive.getState().id) useVoice.getState().leave();
    await api("POST", "/auth/logout").catch(() => {});
    useAuth.getState().logout();
  };
  return (
    <div className="max-w-md space-y-4 pt-4">
      <div className="space-y-2">
        <Label>Display name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
      </div>
      <PicturePicker
        label="Avatar"
        shape="circle"
        url={me.avatarUrl}
        onUpload={async (f) => applied(await uploadPicture<User>(inst, "/users/@me/avatar", f))}
        onRemove={async () => applied(await api<User>("DELETE", "/users/@me/avatar"))}
      />
      <div className="space-y-2">
        <Label>Status</Label>
        <Select value={status} onValueChange={(v) => setStatus(v as Status)}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="online">Online</SelectItem>
            <SelectItem value="idle">Idle</SelectItem>
            <SelectItem value="dnd">Do Not Disturb</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex gap-2">
        <Button onClick={save}>Save</Button>
        <Button variant="destructive" onClick={logout}>Log Out</Button>
      </div>
      <BranchrAccount />
    </div>
  );
}

/** The central branchr account (Discord sign-in), and claiming servers you host. */
function BranchrAccount() {
  const account = useBranchrId((s) => s.account);
  const serverUrl = useAuth((s) => s.serverUrl);
  const [busy, setBusy] = useState(false);
  // On servers that accept branchr accounts, a password user can link theirs.
  const info = useQuery({ queryKey: ["instance", serverUrl], queryFn: () => instanceInfo(serverUrl) });
  const federated = !!info.data && info.data.authMode !== "local";
  const link = useQuery({ queryKey: ["link", serverUrl], queryFn: () => api<{ linked: boolean }>("GET", "/auth/link"), enabled: federated });
  const doLink = async () => {
    try {
      await linkToBranchr();
      await link.refetch();
      toast.success("Linked: sign in with Discord to get back to this account");
    } catch (e) {
      toast.error("Couldn't link", { description: (e as Error).message });
    }
  };
  const [code, setCode] = useState("");
  const qc = useQueryClient();
  const claim = async () => {
    try {
      const name = await claimServer(code.trim());
      setCode("");
      void qc.invalidateQueries({ queryKey: ["owned-hosts"] });
      void qc.invalidateQueries({ queryKey: ["host-overview"] });
      toast.success(`You now own ${name}`);
    } catch (e) {
      toast.error("Couldn't claim the hub", { description: (e as Error).message });
    }
  };
  return (
    <div className="space-y-2 border-t border-border pt-4" data-testid="branchr-account">
      <Label>branchr account</Label>
      {account ? (
        <div className="flex items-center gap-3 rounded-md bg-muted p-3">
          {account.avatarUrl && <img src={account.avatarUrl} alt="" className="size-10 rounded-full" />}
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{account.displayName}</div>
            <div className="text-xs text-muted-foreground">Signed in with Discord</div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      ) : null}
      {account && federated && link.data && (
        <div className="flex items-center justify-between gap-3 text-sm">
          {link.data.linked ? (
            <span className="text-muted-foreground">This password account is linked to your branchr account.</span>
          ) : (
            <>
              <span className="text-muted-foreground">Use your branchr account to log in to this password account from now on.</span>
              <Button size="sm" variant="outline" onClick={() => void doLink()}>
                Link
              </Button>
            </>
          )}
        </div>
      )}
      {account && <OwnedHosts />}
      {account && (
        <form
          className="space-y-1"
          onSubmit={(e) => {
            e.preventDefault();
            void claim();
          }}
        >
          <Label htmlFor="claim-code" className="text-xs text-muted-foreground">
            Claim a hub you run (the code is in its log and in claim-code.txt next to its database)
          </Label>
          <div className="flex gap-2">
            <Input id="claim-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-1234" className="w-40 font-mono uppercase" />
            <Button type="submit" variant="outline" disabled={code.trim().length < 8}>
              Claim
            </Button>
          </div>
        </form>
      )}
      {account ? null : (
        <>
          <p className="text-xs text-muted-foreground">One account for every hub. Sign in with Discord; we only see your name and avatar.</p>
          <Button
            disabled={busy}
            className="bg-[#5865F2] text-white hover:bg-[#4752c4]"
            onClick={() => {
              setBusy(true);
              startSignIn()
                .catch((e: Error) => toast.error(e.message))
                // The browser takes over from here; re-enable in case they come back without finishing.
                .finally(() => setTimeout(() => setBusy(false), 3000));
            }}
          >
            Sign in with Discord
          </Button>
        </>
      )}
    </div>
  );
}

function VoiceSettings() {
  const s = useVoiceSettings();
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: async () => {
      // Labels are only exposed after a permission grant.
      await navigator.mediaDevices.getUserMedia({ audio: true }).then((st) => st.getTracks().forEach((t) => t.stop())).catch(() => {});
      return navigator.mediaDevices.enumerateDevices();
    },
    staleTime: 0,
  });
  const inputs = devices.data?.filter((d) => d.kind === "audioinput") ?? [];
  const outputs = devices.data?.filter((d) => d.kind === "audiooutput") ?? [];
  const update = (p: Parameters<typeof s.setSettings>[0]) => {
    s.setSettings(p);
    void useVoice.getState().reloadMic();
  };
  return (
    <div className="max-w-md space-y-4 pt-4">
      <div className="space-y-2">
        <Label>Input device</Label>
        <Select value={s.inputDeviceId ?? "default"} onValueChange={(v) => update({ inputDeviceId: v === "default" ? null : v })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Default</SelectItem>
            {inputs.filter((d) => d.deviceId && d.deviceId !== "default").map((d) => (
              <SelectItem key={d.deviceId} value={d.deviceId}>{d.label || "Microphone"}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Output device</Label>
        <Select value={s.outputDeviceId ?? "default"} onValueChange={(v) => s.setSettings({ outputDeviceId: v === "default" ? null : v })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Default</SelectItem>
            {outputs.filter((d) => d.deviceId && d.deviceId !== "default").map((d) => (
              <SelectItem key={d.deviceId} value={d.deviceId}>{d.label || "Speakers"}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Noise suppression</Label>
        <Select value={s.noiseSuppression} onValueChange={(v) => update({ noiseSuppression: v as NoiseSuppression })}>
          <SelectTrigger className="w-full" aria-label="Noise suppression">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {noiseSuppressionModes.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {noiseSuppressionModes.find((m) => m.value === s.noiseSuppression)?.hint} Runs on your device; nothing leaves it.
        </p>
      </div>
      <MicTest />
      {(
        [
          ["echoCancellation", "Echo cancellation"],
          ["autoGainControl", "Automatic gain control"],
        ] as const
      ).map(([k, label]) => (
        <label key={k} className="flex items-center justify-between">
          <span className="text-sm">{label}</span>
          <Switch checked={s[k]} onCheckedChange={(v) => update({ [k]: v })} />
        </label>
      ))}
    </div>
  );
}

function Performance() {
  const codecs = useQuery({
    queryKey: ["codec-support"],
    queryFn: async () => {
      const list = ["video/AV1", "video/H265", "video/VP9", "video/H264", "video/VP8"];
      const supported = new Set((RTCRtpSender.getCapabilities("video")?.codecs ?? []).map((c) => c.mimeType.toLowerCase()));
      return Promise.all(
        list.map(async (codec) => {
          const cfg = { contentType: codec, width: 2560, height: 1440, framerate: 60, bitrate: 15_000_000 };
          const [enc, dec] = await Promise.all([
            navigator.mediaCapabilities.encodingInfo({ type: "webrtc", video: cfg }).catch(() => null),
            navigator.mediaCapabilities.decodingInfo({ type: "webrtc", video: cfg }).catch(() => null),
          ]);
          return { codec, webrtc: supported.has(codec.toLowerCase()), hwEncode: !!enc?.powerEfficient, hwDecode: !!dec?.powerEfficient };
        }),
      );
    },
  });
  const gpu = useQuery({ queryKey: ["gpu"], queryFn: () => desktop?.gpuInfo() ?? null, enabled: !!desktop });
  return (
    <div className="space-y-4 pt-4 text-sm">
      <p className="text-muted-foreground">
        Codec support at 1440p60 on this machine. "Auto" streaming picks the best hardware-encoded codec so high resolution streams don't load your CPU.
      </p>
      <table className="w-full text-left">
        <thead className="text-xs text-muted-foreground uppercase">
          <tr>
            <th className="py-1">Codec</th>
            <th>WebRTC</th>
            <th>HW encode</th>
            <th>HW decode</th>
          </tr>
        </thead>
        <tbody>
          {codecs.data?.map((c) => (
            <tr key={c.codec} className="border-t border-border">
              <td className="py-1.5 font-mono">{c.codec.replace("video/", "")}</td>
              <td>{c.webrtc ? "✓" : "—"}</td>
              <td className={c.hwEncode ? "text-online" : "text-muted-foreground"}>{c.hwEncode ? "yes" : "no"}</td>
              <td className={c.hwDecode ? "text-online" : "text-muted-foreground"}>{c.hwDecode ? "yes" : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {gpu.data && (
        <div className="space-y-1">
          <div className="font-semibold">GPU features (Chromium)</div>
          <div className="grid grid-cols-2 gap-x-4 font-mono text-xs">
            {Object.entries(gpu.data.features)
              .filter(([k]) => /video|webgl|gpu_compositing|rasterization/i.test(k))
              .map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <span className="truncate">{k}</span>
                  <span className={v.startsWith("enabled") ? "text-online" : "text-muted-foreground"}>{v}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Advanced() {
  const devMode = usePrefs((s) => s.devMode);
  return (
    <div className="max-w-md space-y-4 pt-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Label htmlFor="dev-mode">Developer Mode</Label>
          <p className="mt-1 text-xs text-muted-foreground">Adds "Copy ID" to right-click menus, for bots and bug reports.</p>
        </div>
        <Switch id="dev-mode" checked={devMode} onCheckedChange={(v) => usePrefs.getState().set({ devMode: v })} />
      </div>
    </div>
  );
}

/** Hosts this branchr account has claimed: manage the ones we're connected to, connect to the rest. */
/** "seen 5 minutes ago" and friends. */
function lastSeen(at: number | null) {
  if (at === null) return "not seen lately";
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 10) return "online";
  if (mins < 120) return `seen ${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `seen ${hours} hours ago` : `seen ${Math.round(hours / 24)} days ago`;
}

function OwnedHosts() {
  const owned = useQuery({ queryKey: ["owned-hosts"], queryFn: ownedHosts });
  const connected = useInstanceList((s) => s.ids);
  const navigate = useNavigate();
  const qc = useQueryClient();
  // A hub that registered again (e.g. its data was wiped) leaves older claims for the same
  // address behind: newest first, the older ones marked so they can be released.
  const groups = new Map<string, OwnedHost[]>();
  for (const h of [...(owned.data ?? [])].reverse()) {
    const key = h.publicUrl ? normalizeUrl(h.publicUrl) : h.instanceId;
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  const hosts = [...groups.values()].map((g) => ({ ...g[0], older: g.slice(1) }));
  const release = async (list: OwnedHost[], what: string) => {
    if (!confirm(`Release your claim on ${what}? ${list.length > 1 ? "They show" : "It shows"} a claim code again, for you or someone else to claim.`)) return;
    try {
      for (const h of list) await releaseHost(h.instanceId);
      await qc.invalidateQueries({ queryKey: ["owned-hosts"] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  if (!hosts.length) return null;
  return (
    <div className="space-y-1" data-testid="owned-hosts">
      <div className="text-xs font-semibold text-muted-foreground uppercase">Your hubs</div>
      {hosts.map((h) => {
        const id = h.publicUrl ? instanceKey(normalizeUrl(h.publicUrl)) : null;
        const here = !!id && connected.includes(id);
        return (
          <div key={h.instanceId} data-testid="owned-host" className="flex flex-wrap items-center gap-3 rounded-md bg-muted px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{h.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {h.publicUrl ? hostOf(h.publicUrl) : "address unknown"} · {lastSeen(h.lastSeen)}
              </div>
            </div>
            {here ? (
              <Button size="sm" variant="outline" onClick={() => useDialogs.getState().open({ instanceId: id!, kind: "host-admin" })}>
                Manage
              </Button>
            ) : h.publicUrl ? (
              <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/login", search: { server: h.publicUrl } })}>
                Connect
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" aria-label={`Release ${h.name}`} title="Release your claim" onClick={() => void release([h], h.name)}>
              Release
            </Button>
            {h.older.length > 0 && (
              <div data-testid="old-claims" className="basis-full text-xs text-muted-foreground">
                {h.older.length} older record{h.older.length === 1 ? "" : "s"} for this address (it registered again).{" "}
                <button className="underline hover:text-foreground" onClick={() => void release(h.older, `${h.older.length} older record${h.older.length === 1 ? "" : "s"}`)}>
                  Release {h.older.length === 1 ? "it" : "them"}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
