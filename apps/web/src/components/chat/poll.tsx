import type { Message, Poll } from "@app/protocol";
import { BarChart3, Check, Plus, X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useInstance } from "@/lib/instances";
import { cn } from "@/lib/utils";

/** Time left, roughly: "3h left", "2d left". */
function left(ms: number): string {
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m}m left`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h left` : `${Math.round(h / 24)}d left`;
}

/** Re-renders when the poll closes, so it shows results without a reload. */
function useClosed(endsAt: number) {
  const [closed, setClosed] = useState(() => Date.now() >= endsAt);
  useEffect(() => {
    if (closed) return;
    const t = setTimeout(() => setClosed(true), Math.min(endsAt - Date.now(), 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [closed, endsAt]);
  return closed;
}

export const PollView = memo(function PollView({ message, poll }: { message: Message; poll: Poll }) {
  const inst = useInstance();
  const closed = useClosed(poll.endsAt);
  const [busy, setBusy] = useState(false);
  const total = poll.answers.reduce((n, a) => n + a.votes, 0);
  const voted = poll.answers.some((a) => a.me);
  const pick = async (i: number) => {
    if (closed || busy) return;
    setBusy(true);
    try {
      await inst.api(poll.answers[i].me ? "DELETE" : "PUT", `/channels/${message.channelId}/messages/${message.id}/poll/${i}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1 max-w-md rounded-lg border border-border bg-sidebar/60 p-3" data-testid="poll">
      <div className="font-semibold">{poll.question}</div>
      <div className="mb-2 text-xs text-muted-foreground">{poll.multi ? "Pick any" : "Pick one"}</div>
      <div className="space-y-1.5">
        {poll.answers.map((a, i) => {
          const pct = total ? Math.round((a.votes / total) * 100) : 0;
          const show = voted || closed;
          return (
            <button
              key={i}
              type="button"
              disabled={closed || busy}
              aria-pressed={a.me}
              onClick={() => void pick(i)}
              className={cn(
                "relative flex w-full items-center gap-2 overflow-hidden rounded-md border px-3 py-2 text-left text-sm",
                a.me ? "border-primary" : "border-border hover:border-muted-foreground",
                closed && "cursor-default",
              )}
            >
              {show && <span className="absolute inset-y-0 left-0 bg-primary/20" style={{ width: `${pct}%` }} />}
              <span className="relative flex-1 break-words">{a.text}</span>
              {show && (
                <span className="relative text-xs text-muted-foreground" data-testid="poll-votes">
                  {a.votes} · {pct}%
                </span>
              )}
              {a.me && <Check className="relative size-4 text-primary" />}
            </button>
          );
        })}
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        {total} {total === 1 ? "vote" : "votes"} · {closed ? "Poll closed" : left(poll.endsAt - Date.now())}
      </div>
    </div>
  );
});

const DURATIONS = [
  { hours: 1, label: "1 hour" },
  { hours: 4, label: "4 hours" },
  { hours: 8, label: "8 hours" },
  { hours: 24, label: "1 day" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "1 week" },
];

export function CreatePollButton({ channelId }: { channelId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="py-3 text-muted-foreground hover:text-foreground" onClick={() => setOpen(true)} aria-label="Create a poll">
        <BarChart3 className="size-6" />
      </button>
      {open && <CreatePollDialog channelId={channelId} onClose={() => setOpen(false)} />}
    </>
  );
}

function CreatePollDialog({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const inst = useInstance();
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState(["", ""]);
  const [hours, setHours] = useState("24");
  const [multi, setMulti] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = question.trim() && answers.filter((a) => a.trim()).length >= 2;
  const post = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      await inst.api("POST", `/channels/${channelId}/messages`, {
        poll: { question, answers: answers.filter((a) => a.trim()), multi, durationHours: Number(hours) },
      });
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a Poll</DialogTitle>
          <DialogDescription>Everyone in the channel can vote until it closes.</DialogDescription>
        </DialogHeader>
        <form onSubmit={post} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="poll-question">Question</Label>
            <Input id="poll-question" autoFocus value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300} placeholder="What should we play?" />
          </div>
          <div className="space-y-2">
            <Label>Answers</Label>
            {answers.map((a, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  value={a}
                  onChange={(e) => setAnswers(answers.map((x, j) => (j === i ? e.target.value : x)))}
                  maxLength={55}
                  placeholder={`Answer ${i + 1}`}
                  aria-label={`Answer ${i + 1}`}
                />
                {answers.length > 2 && (
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove answer ${i + 1}`} onClick={() => setAnswers(answers.filter((_, j) => j !== i))}>
                    <X className="size-4" />
                  </Button>
                )}
              </div>
            ))}
            {answers.length < 10 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setAnswers([...answers, ""])}>
                <Plus className="size-4" /> Add answer
              </Button>
            )}
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-2">
              <Label>Duration</Label>
              <Select value={hours} onValueChange={setHours}>
                <SelectTrigger className="w-36" aria-label="Duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATIONS.map((d) => (
                    <SelectItem key={d.hours} value={String(d.hours)}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={multi} onCheckedChange={setMulti} aria-label="Allow multiple answers" />
              Allow multiple answers
            </label>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={!ready || busy}>
              Post
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
