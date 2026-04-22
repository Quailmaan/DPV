import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "DPV — Dynasty Player Valuation",
  description:
    "Data-driven dynasty fantasy football values with historical comps and market calibration.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
            <Link href="/" className="font-semibold tracking-tight text-lg">
              DPV <span className="text-zinc-400 font-normal">/ Dynasty Values</span>
            </Link>
            <nav className="flex gap-5 text-sm text-zinc-600 dark:text-zinc-400">
              <Link
                href="/"
                className="hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                Rankings
              </Link>
              <Link
                href="/league"
                className="hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                Leagues
              </Link>
              <Link
                href="/trade"
                className="hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                Trade
              </Link>
              <Link
                href="/methodology"
                className="hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                Methodology
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl w-full px-6 py-8 flex-1">
          {children}
        </main>
      </body>
    </html>
  );
}
