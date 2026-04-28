import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Image from "next/image";
import Link from "next/link";
import { PylonWordmark } from "@/components/PylonLogo";
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
  title: "Pylon",
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
          <div className="mx-auto max-w-6xl px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-3 flex-wrap">
            <Link
              href="/"
              className="flex items-center gap-2 whitespace-nowrap"
            >
              {/* P-mark glyph paired with the PYLON wordmark text. Two
                  variants: -light has the white P outline recolored to
                  zinc-900 (visible on light header), -clean is the
                  original white P (visible on dark header). Both have
                  the bake-in dark background stripped to alpha. The
                  wordmark stays as text so it scales with surrounding
                  typography. */}
              <Image
                src="/pylon-logo-light.png"
                alt=""
                width={314}
                height={228}
                priority
                className="h-7 w-auto sm:h-8 dark:hidden"
              />
              <Image
                src="/pylon-logo-clean.png"
                alt=""
                width={314}
                height={228}
                priority
                className="hidden h-7 w-auto sm:h-8 dark:block"
              />
              <PylonWordmark size="md" />
            </Link>
            {/* Nav scrolls horizontally if it overflows on narrow phones rather
                than wrapping below the brand. -mx keeps the scroll edge flush
                with the screen edge so swipe affordance is clearer. */}
            <nav className="flex gap-4 sm:gap-5 text-sm text-zinc-600 dark:text-zinc-400 overflow-x-auto whitespace-nowrap -mx-3 px-3 sm:mx-0 sm:px-0">
              <Link
                href="/"
                className="hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                Rankings
              </Link>
              <Link
                href="/rookies"
                className="hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                Rookies
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
        <main className="mx-auto max-w-6xl w-full px-3 sm:px-6 py-6 sm:py-8 flex-1">
          {children}
        </main>
      </body>
    </html>
  );
}
