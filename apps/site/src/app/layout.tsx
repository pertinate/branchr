import type { Metadata } from "next";

import { Footer, Header } from "@/components/chrome";

import "./globals.css";

export const metadata: Metadata = {
  title: "branchr: chat, voice and streaming you run yourself",
  description: "Self-hostable chat, voice and uncapped low-latency streaming. Run your own hub; sign in with Discord.",
  icons: { icon: "/icon.svg" },
};

// Links from before the app moved to /app/ (invites, sign-in returns) carry on there.
const OLD_LINKS = 'if (location.hash.startsWith("#/")) location.replace("/app/" + location.search + location.hash);';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: OLD_LINKS }} />
      </head>
      <body>
        <div className="flex min-h-svh flex-col bg-[oklch(0.2_0.008_264)] text-foreground">
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
        </div>
      </body>
    </html>
  );
}
