import { Link, useParams } from "@tanstack/react-router";
import { Folder as FolderIcon, FolderMinus, FolderPlus, Settings, Volume2 } from "lucide-react";
import { memo, useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { guildInitials } from "@/components/guild/guild-badge";
import { MentionBadge } from "@/components/mention-badge";
import { GuildMenuItems, Menu } from "@/components/menus";
import { Button } from "@/components/ui/button";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { compareIds } from "@/lib/ids";
import { InstanceProvider, hostOf, instance, useInstance, useInstanceList } from "@/lib/instances";
import { useMediaUrl } from "@/lib/media";
import { type DropTarget, FOLDER_COLORS, type Folder, type GuildRef, type RailItem, guildRef, itemKey, parseRef, useRailLayout } from "@/lib/rail-layout";
import { cn } from "@/lib/utils";
import { type AppState, useApp } from "@/stores/app";
import { useVoice } from "@/stores/voice";

export function guildUnread(s: AppState, guildId: string) {
  return Object.values(s.channels).some(
    (c) => c.guildId === guildId && (c.kind === "text" || c.kind === "thread") && c.lastMessageId && (!s.lastRead[c.id] || compareIds(c.lastMessageId, s.lastRead[c.id]) > 0),
  );
}

export function guildPings(s: AppState, guildId: string) {
  let n = 0;
  for (const [cid, count] of Object.entries(s.pings)) if (s.channels[cid]?.guildId === guildId) n += count;
  return n;
}

/** Keeps the layout in step with one host's servers once it's connected. */
function HostSync() {
  const inst = useInstance();
  const ready = useApp((s) => s.connection === "ready");
  const order = useApp((s) => s.guildOrder);
  useEffect(() => {
    if (ready) useRailLayout.getState().sync(inst.id, order);
  }, [inst.id, ready, order]);
  return null;
}

// What's being dragged (dataTransfer can't be read during dragover).
let dragging: string | null = null;

/** One draggable spot in the rail; shows where a drop would land. */
function Slot({
  slotKey,
  canInto,
  hint,
  setHint,
  className,
  children,
}: {
  slotKey: string;
  canInto: boolean;
  hint: DropTarget | null;
  setHint: (h: DropTarget | null) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const mine = hint?.key === slotKey ? hint.zone : null;
  return (
    <div
      data-rail-item={slotKey}
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        dragging = slotKey;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/x-branchr-rail", slotKey);
      }}
      onDragEnd={() => {
        dragging = null;
        setHint(null);
      }}
      onDragOver={(e) => {
        if (!dragging || dragging === slotKey) return;
        e.preventDefault();
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        const y = (e.clientY - r.top) / r.height;
        const into = canInto && !dragging.startsWith("folder:");
        const zone = into ? (y < 0.25 ? "before" : y > 0.75 ? "after" : "into") : y < 0.5 ? "before" : "after";
        if (mine !== zone) setHint({ key: slotKey, zone });
      }}
      onDragLeave={(e) => {
        if (mine && !e.currentTarget.contains(e.relatedTarget as Node)) setHint(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (dragging && hint?.key === slotKey) useRailLayout.getState().move(dragging, hint);
        dragging = null;
        setHint(null);
      }}
      className={cn("relative flex w-full shrink-0 flex-col items-center", className)}
    >
      {mine === "before" && <span className="absolute -top-1.5 left-1/2 h-1 w-10 -translate-x-1/2 rounded bg-primary" />}
      {mine === "after" && <span className="absolute -bottom-1.5 left-1/2 h-1 w-10 -translate-x-1/2 rounded bg-primary" />}
      {mine === "into" && <span className="pointer-events-none absolute inset-y-0 left-1/2 z-10 w-12 -translate-x-1/2 rounded-2xl ring-2 ring-primary" />}
      {children}
    </div>
  );
}

const GuildIcon = memo(function GuildIcon({ guildId, active, inFolder }: { guildId: string; active: boolean; inFolder: boolean }) {
  const inst = useInstance();
  const instanceId = inst.id;
  const guild = useApp((s) => s.guilds[guildId]);
  const icon = useMediaUrl(guild?.iconUrl);
  const unread = useApp((s) => guildUnread(s, guildId));
  const pings = useApp((s) => guildPings(s, guildId));
  const inVoice = useVoice((s) => s.guildId === guildId && s.instanceId === instanceId);
  const severalHosts = useInstanceList((s) => s.ids.length > 1);
  const ref = guildRef(instanceId, guildId);
  if (!guild) return null;
  return (
    <Tooltip>
      <Menu
        items={
          <>
            {inFolder ? (
              <ContextMenuItem onSelect={() => useRailLayout.getState().unfolder(ref)}>
                Remove from Folder <FolderMinus className="ml-auto" />
              </ContextMenuItem>
            ) : (
              <ContextMenuItem onSelect={() => useRailLayout.getState().newFolder(ref)}>
                Add to New Folder <FolderPlus className="ml-auto" />
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <GuildMenuItems guildId={guildId} />
          </>
        }
      >
        <TooltipTrigger asChild>
          <Link
            to="/$instance/$guildId"
            params={{ instance: instanceId, guildId }}
            aria-label={guild.name}
            draggable={false}
            className="group relative flex w-full justify-center"
          >
            <span
              className={cn(
                "absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-all",
                active ? "h-10" : unread ? "h-2 group-hover:h-5" : "h-0 group-hover:h-5",
              )}
            />
            <div
              className={cn(
                "grid size-12 place-items-center overflow-hidden text-sm font-semibold transition-all",
                active ? "rounded-2xl bg-primary text-white" : "rounded-3xl bg-background group-hover:rounded-2xl group-hover:bg-primary group-hover:text-white",
              )}
            >
              {icon ? <img src={icon} alt="" draggable={false} className="size-full object-cover" /> : guildInitials(guild.name)}
            </div>
            {pings > 0 && <MentionBadge count={pings} className="absolute right-1 bottom-0 border-4 border-rail" />}
            {inVoice && !pings && (
              <span className="absolute -right-0 bottom-0 grid size-5 place-items-center rounded-full border-4 border-rail bg-online">
                <Volume2 className="size-2.5 text-white" />
              </span>
            )}
          </Link>
        </TooltipTrigger>
      </Menu>
      <TooltipContent side="right">
        {guild.name}
        {severalHosts && <div className="text-xs text-muted-foreground">{hostOf(inst.url)}</div>}
      </TooltipContent>
    </Tooltip>
  );
});

/** A server in the rail, on its own host. */
function RailGuild({ ref_, active, inFolder }: { ref_: GuildRef; active: boolean; inFolder: boolean }) {
  const { instanceId, guildId } = parseRef(ref_);
  const inst = instance(instanceId);
  if (!inst) return null;
  return (
    <InstanceProvider instance={inst}>
      <GuildIcon guildId={guildId} active={active} inFolder={inFolder} />
    </InstanceProvider>
  );
}

/** Pings and unread across a folder's servers, which can be on several hosts. */
function useFolderStatus(refs: GuildRef[]) {
  const key = refs.join("|");
  const subscribe = useCallback(
    (cb: () => void) => {
      const hosts = [...new Set(key.split("|").map((r) => parseRef(r).instanceId))];
      const offs = hosts.flatMap((h) => {
        const inst = instance(h);
        return inst ? [inst.app.subscribe(cb)] : [];
      });
      return () => offs.forEach((off) => off());
    },
    [key],
  );
  const snapshot = useCallback(() => {
    let pings = 0;
    let unread = false;
    for (const r of key.split("|")) {
      const { instanceId, guildId } = parseRef(r);
      const s = instance(instanceId)?.app.getState();
      if (!s) continue;
      pings += guildPings(s, guildId);
      unread ||= guildUnread(s, guildId);
    }
    // One number, so unchanged status doesn't re-render.
    return pings * 2 + (unread ? 1 : 0);
  }, [key]);
  const packed = useSyncExternalStore(subscribe, snapshot);
  return { pings: packed >> 1, unread: (packed & 1) === 1 };
}

function MiniIcon({ ref_ }: { ref_: GuildRef }) {
  const { instanceId, guildId } = parseRef(ref_);
  const inst = instance(instanceId);
  return inst ? (
    <InstanceProvider instance={inst}>
      <MiniIconInner guildId={guildId} />
    </InstanceProvider>
  ) : (
    <span />
  );
}

function MiniIconInner({ guildId }: { guildId: string }) {
  const guild = useApp((s) => s.guilds[guildId]);
  const icon = useMediaUrl(guild?.iconUrl);
  if (!guild) return <span />;
  return (
    <span className="grid size-[18px] place-items-center overflow-hidden rounded-full bg-background text-[7px] font-semibold">
      {icon ? <img src={icon} alt="" draggable={false} className="size-full object-cover" /> : guildInitials(guild.name)}
    </span>
  );
}

/** The guild names in a folder, for its tooltip when it has no name. */
function useFolderNames(refs: GuildRef[]) {
  return refs
    .map((r) => {
      const { instanceId, guildId } = parseRef(r);
      return instance(instanceId)?.app.getState().guilds[guildId]?.name;
    })
    .filter(Boolean)
    .join(", ");
}

function RailFolder({
  folder,
  activeRef,
  hint,
  setHint,
  onSettings,
}: {
  folder: Folder;
  activeRef: GuildRef | null;
  hint: DropTarget | null;
  setHint: (h: DropTarget | null) => void;
  onSettings: () => void;
}) {
  const { pings, unread } = useFolderStatus(folder.guilds);
  const names = useFolderNames(folder.guilds);
  const color = folder.color ?? FOLDER_COLORS[0];
  const label = folder.name || "Community Folder";
  const holdsActive = !!activeRef && folder.guilds.includes(activeRef);
  const toggle = () => useRailLayout.getState().updateFolder(folder.id, { open: !folder.open });
  const menu = (
    <>
      <ContextMenuItem onSelect={onSettings}>
        Folder Settings <Settings className="ml-auto" />
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => useRailLayout.getState().ungroup(folder.id)}>
        Remove Folder <FolderMinus className="ml-auto" />
      </ContextMenuItem>
    </>
  );
  const head = (
    <Slot slotKey={`folder:${folder.id}`} canInto hint={hint} setHint={setHint}>
      <Tooltip>
        <Menu items={menu}>
          <TooltipTrigger asChild>
            <button
              onClick={toggle}
              aria-label={label}
              aria-expanded={folder.open}
              data-testid="rail-folder"
              className="group relative flex w-full justify-center"
            >
              {!folder.open && (
                <span
                  className={cn(
                    "absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-all",
                    holdsActive ? "h-10" : unread ? "h-2 group-hover:h-5" : "h-0 group-hover:h-5",
                  )}
                />
              )}
              <div
                className="grid size-12 place-items-center rounded-2xl transition-all"
                style={{ backgroundColor: `color-mix(in srgb, ${color} ${folder.open ? 0 : 35}%, transparent)` }}
              >
                {folder.open ? (
                  <FolderIcon className="size-6" style={{ color }} fill={color} />
                ) : (
                  <div className="grid grid-cols-2 gap-1">
                    {folder.guilds.slice(0, 4).map((r) => (
                      <MiniIcon key={r} ref_={r} />
                    ))}
                  </div>
                )}
              </div>
              {!folder.open && pings > 0 && <MentionBadge count={pings} className="absolute right-1 bottom-0 border-4 border-rail" />}
            </button>
          </TooltipTrigger>
        </Menu>
        <TooltipContent side="right">{folder.name || names || label}</TooltipContent>
      </Tooltip>
    </Slot>
  );
  if (!folder.open) return head;
  return (
    <div className="flex w-full shrink-0 flex-col items-center">
      <div className="flex w-full flex-col items-center gap-2 rounded-2xl pb-2" style={{ backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)`, width: 56 }}>
        {head}
        {folder.guilds.map((r) => (
          <Slot key={r} slotKey={r} canInto={false} hint={hint} setHint={setHint}>
            <RailGuild ref_={r} active={r === activeRef} inFolder />
          </Slot>
        ))}
      </div>
    </div>
  );
}

function FolderSettings({ folder, onClose }: { folder: Folder | null; onClose: () => void }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  useEffect(() => {
    if (folder) {
      setName(folder.name);
      setColor(folder.color);
    }
  }, [folder]);
  return (
    <Dialog open={!!folder} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Folder Settings</DialogTitle>
          <DialogDescription>Folders are kept on this device.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (folder) useRailLayout.getState().updateFolder(folder.id, { name: name.trim().slice(0, 40), color });
            onClose();
          }}
        >
          <label className="flex flex-col gap-1.5 text-xs font-semibold text-muted-foreground uppercase">
            Folder name
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Community Folder" maxLength={40} aria-label="Folder name" />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-muted-foreground uppercase">Folder colour</span>
            <div className="flex flex-wrap gap-2">
              {FOLDER_COLORS.map((c, i) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Colour ${i + 1}`}
                  onClick={() => setColor(i === 0 ? null : c)}
                  className={cn("size-8 rounded-full ring-offset-2 ring-offset-background", (color ?? FOLDER_COLORS[0]) === c && "ring-2 ring-foreground")}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
          <Button type="submit">Done</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Every host's servers, in the user's order, with folders. */
export function RailList() {
  const ids = useInstanceList((s) => s.ids);
  const items = useRailLayout((s) => s.items);
  const params = useParams({ strict: false }) as { instance?: string; guildId?: string };
  const activeRef = params.instance && params.guildId ? guildRef(params.instance, params.guildId) : null;
  const [hint, setHint] = useState<DropTarget | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    // Hosts we logged out of take their servers with them.
    if (ids.length) useRailLayout.getState().prune(ids);
  }, [ids]);
  const editingFolder = items.flatMap((i) => ("folder" in i && i.folder.id === editing ? [i.folder] : []))[0] ?? null;
  return (
    <>
      {ids.map((id) => {
        const inst = instance(id);
        return inst ? (
          <InstanceProvider key={id} instance={inst}>
            <HostSync />
          </InstanceProvider>
        ) : null;
      })}
      {items.map((item: RailItem) =>
        "folder" in item ? (
          <RailFolder key={itemKey(item)} folder={item.folder} activeRef={activeRef} hint={hint} setHint={setHint} onSettings={() => setEditing(item.folder.id)} />
        ) : (
          <Slot key={item.guild} slotKey={item.guild} canInto hint={hint} setHint={setHint}>
            <RailGuild ref_={item.guild} active={item.guild === activeRef} inFolder={false} />
          </Slot>
        ),
      )}
      <FolderSettings folder={editingFolder} onClose={() => setEditing(null)} />
    </>
  );
}
