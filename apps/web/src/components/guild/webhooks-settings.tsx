import type { Webhook } from "@app/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, RefreshCw, Trash2, Webhook as WebhookIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { copy } from "@/lib/actions";
import { useInstance } from "@/lib/instances";
import { useApp } from "@/stores/app";

/** Server Settings → Webhooks: URLs that post into a channel. Their secret shows once. */
export function WebhooksSettings({ guildId }: { guildId: string }) {
  const inst = useInstance();
  const qc = useQueryClient();
  const key = ["webhooks", inst.id, guildId];
  const hooks = useQuery({ queryKey: key, queryFn: () => inst.api<Webhook[]>("GET", `/guilds/${guildId}/webhooks`) });
  const channels = useApp(useShallow((s) => Object.values(s.channels).filter((c) => c.guildId === guildId && c.kind === "text").sort((a, b) => a.position - b.position)));
  const [name, setName] = useState("");
  const [channelId, setChannelId] = useState<string | undefined>(undefined);
  // The URL with its secret, right after creating or resetting (it can't be read back later).
  const [fresh, setFresh] = useState<Record<string, string>>({});
  const target = channelId ?? channels[0]?.id;

  const remember = (w: Webhook) => {
    if (w.token) setFresh((f) => ({ ...f, [w.id]: `${inst.url}/api/webhooks/${w.id}/${w.token}` }));
  };
  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      <p className="text-sm text-muted-foreground">
        A webhook posts into a channel from outside (CI, alerts, bots) with <code className="rounded bg-muted px-1">POST</code> and{" "}
        <code className="rounded bg-muted px-1">{'{"content": "…"}'}</code>. Anyone with its URL can post, so keep it secret.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!target || !name.trim()) return;
          void run(async () => {
            remember(await inst.api<Webhook>("POST", `/channels/${target}/webhooks`, { name: name.trim() }));
            setName("");
          });
        }}
      >
        <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs font-semibold text-muted-foreground uppercase">
          Name
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Deploy bot" aria-label="Webhook name" />
        </label>
        <label className="flex w-48 flex-col gap-1 text-xs font-semibold text-muted-foreground uppercase">
          Channel
          <Select value={target} onValueChange={setChannelId}>
            <SelectTrigger aria-label="Webhook channel" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {channels.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  #{c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <Button type="submit" disabled={!name.trim() || !target}>
          New Webhook
        </Button>
      </form>
      {hooks.data?.length === 0 && <p className="text-sm text-muted-foreground">No webhooks yet.</p>}
      <ul className="flex flex-col gap-2">
        {hooks.data?.map((w) => (
          <li key={w.id} data-testid="webhook" className="flex flex-col gap-2 rounded-lg bg-sidebar p-3">
            <div className="flex items-center gap-2">
              <WebhookIcon className="size-5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate font-semibold">{w.name}</span>
              <Select value={w.channelId} onValueChange={(cid) => void run(() => inst.api("PATCH", `/webhooks/${w.id}`, { channelId: cid }))}>
                <SelectTrigger aria-label={`${w.name} channel`} className="h-8 w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      #{c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="icon"
                variant="ghost"
                title="New URL (the old one stops working)"
                aria-label={`Reset ${w.name} URL`}
                onClick={() => void run(async () => remember(await inst.api<Webhook>("PATCH", `/webhooks/${w.id}`, { resetToken: true })))}
              >
                <RefreshCw />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="text-destructive"
                aria-label={`Delete ${w.name}`}
                onClick={() => confirm(`Delete the webhook "${w.name}"? Its URL stops working.`) && void run(() => inst.api("DELETE", `/webhooks/${w.id}`))}
              >
                <Trash2 />
              </Button>
            </div>
            {fresh[w.id] && (
              <div className="flex items-center gap-2">
                <Input readOnly value={fresh[w.id]} aria-label={`${w.name} URL`} className="font-mono text-xs" />
                <Button size="sm" variant="secondary" onClick={() => void copy(fresh[w.id], "Copied webhook URL")}>
                  <Copy /> Copy
                </Button>
              </div>
            )}
            {fresh[w.id] && <p className="text-xs text-muted-foreground">Copy it now: it won't be shown again. Lost it? Reset for a new one.</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
