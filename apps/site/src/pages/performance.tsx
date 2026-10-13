import { PageHead, REPO } from "@/layout";

type Row = string[];

function Table({ caption, head, rows }: { caption: string; head: string[]; rows: Row[] }) {
  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-semibold">{caption}</figcaption>
      <div className="overflow-x-auto rounded-xl border border-white/5">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-card text-xs text-muted-foreground uppercase">
            <tr>
              {head.map((h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.join()} className="border-t border-white/5">
                {r.map((c, i) => (
                  <td key={i} className="px-3 py-2 tabular-nums">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

const HIGHLIGHTS = [
  { value: "300 × 60 fps", label: "viewers of one 4 Mbps stream, p99 7.3 ms through the SFU" },
  { value: "5,000", label: "connected sessions on a 2 vCPU VPS, every message to all of them" },
  { value: "~1,100 / s", label: "chat messages on a home server, 100,000 deliveries" },
  { value: "100 people", label: "in one voice call, all speech delivered, p99 9 ms" },
];

export function PerformancePage() {
  return (
    <>
      <PageHead title="Performance">
        Measured with the load tests in the repository, on a Ryzen desktop, a 2 vCPU DigitalOcean VPS, and a real Hub on an Unraid server.{" "}
        <a className="underline hover:text-foreground" href={`${REPO}#performance`}>
          Methods and commands
        </a>
        .
      </PageHead>
      <section className="mx-auto max-w-6xl space-y-10 px-4 py-12 sm:px-6">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {HIGHLIGHTS.map((n) => (
            <div key={n.value}>
              <div className="text-3xl font-bold tracking-tight">{n.value}</div>
              <p className="mt-1 text-sm text-muted-foreground">{n.label}</p>
            </div>
          ))}
        </div>
        <Table
          caption="Streaming: one 60 fps publisher, N viewers, one SFU (8 workers, loopback, Ryzen desktop)"
          head={["Load", "Egress", "Delivered", "Latency p50 / p99", "SFU CPU"]}
          rows={[
            ["100 viewers × 4 Mbps", "408 Mbps", "60 fps all viewers, 0 gaps", "2.3 / 4.9 ms", "0.6 core"],
            ["20 viewers × 20 Mbps", "408 Mbps", "60 fps all viewers, 0 gaps", "2.5 / 20 ms", "0.4 core"],
            ["10 viewers × 50 Mbps", "510 Mbps", "60 fps all viewers, 0 gaps", "8.2 / 31 ms", "0.5 core"],
            ["300 viewers × 4 Mbps", "1.22 Gbps", "60 fps all viewers, 0 gaps", "4.3 / 7.3 ms", "2.2 cores"],
          ]}
        />
        <Table
          caption="Streaming on a 2 vCPU / 4 GB VPS, viewers across the internet (latency includes ~56 ms of network)"
          head={["Load", "Egress", "Delivered", "Latency p50 / p99", "SFU CPU"]}
          rows={[
            ["100 viewers × 4 Mbps", "412 Mbps", "60 fps all viewers, 0 gaps", "64 / 90–167 ms", "~1 vCPU"],
            ["20 viewers × 20 Mbps", "408 Mbps", "60 fps all viewers, 0 gaps", "67 / 100–149 ms", "0.7 vCPU"],
          ]}
        />
        <Table
          caption="Chat: 100 users each sending a burst of 10 messages (1,000 messages, 100,000 deliveries)"
          head={["Condition", "Messages/s", "Send p50 / p99", "Fan-out p50 / p99"]}
          rows={[
            ["Chat only", "~1,050", "94 / 134 ms", "42 / 89 ms"],
            ["While relaying a 100 viewer × 4 Mbps stream", "~900–1,000", "93–108 / 163–200 ms", "42–50 / 106–115 ms"],
            ["In a private channel (permissions checked per delivery)", "~1,100–1,200", "82–88 / 132–141 ms", "36–39 / 91–98 ms"],
          ]}
        />
        <Table
          caption="Reading history: a Hub on SQLite with 20,000 messages in a channel (polls and reactions included), measured locally"
          head={["Request", "Latency p50 / p99", "Throughput"]}
          rows={[
            ["Connect (READY)", "1.0 / 2.7 ms", ""],
            ["Newest 50 messages", "1.3 / 2.5 ms", ""],
            ["Scrolling back, 50 at a time", "1.5 / 2.1 ms", ""],
            ["Search a word, or has:link", "1.6–1.7 / 2.0–4.1 ms", ""],
            ["50 people loading pages at once", "15 / 32 ms", "~3,100 pages/s"],
          ]}
        />
        <Table
          caption="Big voice calls: everyone hears everyone; silence isn't forwarded"
          head={["Call", "Streams", "Speech delivered", "Latency p50 / p99", "SFU CPU"]}
          rows={[
            ["50 people, 5 talking", "2,450", "100%", "1.3 / 2.2 ms", "0.8 core"],
            ["100 people, 10 talking", "9,900", "100%", "1.6 / 3.5 ms", "4.1 cores"],
            ["50 people, all talking at once", "2,450", "100%", "0.7 / 2.2 ms", "3.4 cores"],
          ]}
        />
        <Table
          caption="A real self-hosted Hub (Docker on Unraid, SQLite), loaded over a gigabit LAN"
          head={["Test", "Result"]}
          rows={[
            ["Chat, 100 users, 1,000 messages", "~1,060–1,160 messages/s, fan-out p99 112–116 ms"],
            ["Gateway fan-out", "5,000 sessions: p99 51–58 ms; 10,000 sessions: p99 104–131 ms"],
            ["Voice call, 100 people / 10 talking", "100% of speech delivered, p99 9.1 ms"],
            ["Stream, 100 viewers × 2 Mbps", "60 fps for every viewer, p99 9.2 ms, no gaps"],
          ]}
        />
      </section>
    </>
  );
}
