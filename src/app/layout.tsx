import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import HeaderAuth from "@/components/HeaderAuth";
import InstallButton from "@/components/InstallButton";
import MobileNav from "@/components/MobileNav";
import { PylonWordmark } from "@/components/PylonLogo";
import ServiceWorkerRegistrar from "@/components/ServiceWorkerRegistrar";
import { SUPPORT_EMAIL, mailtoHref } from "@/lib/site/contact";
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
  // PWA metadata. The manifest is auto-served by Next.js from
  // src/app/manifest.ts at /manifest.webmanifest. iOS Safari ignores
  // manifest icons, so we point apple-touch-icon at the dedicated
  // 180×180 we generate in scripts/generate-pwa-icons.ts.
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Pylon",
    // "black-translucent" lets our content draw behind the status bar
    // when launched from the home screen — matches the standalone
    // dark theme we set in the manifest.
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

// Viewport sits in its own export in Next 14+. `themeColor` colors
// the OS chrome (Android status bar, iOS standalone status bar) and
// uses media queries so it tracks the user's light/dark preference.
// `viewportFit: "cover"` lets the app draw into the iPhone notch area
// when launched as a standalone PWA.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
  viewportFit: "cover",
};

// Auth/landing routes that render full-bleed without the site nav.
// These pages are the gate to the rest of the site, so the standard
// Rankings/Rookies/Leagues/Trade/Methodology nav (which all require
// auth anyway) would just be dead links. The middleware sets
// `x-pathname` so we can read the current path here.
const AUTH_ROUTE_PREFIXES = ["/login", "/signup", "/auth"];

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const h = await headers();
  const pathname = h.get("x-pathname") ?? "";
  const isAuthRoute = AUTH_ROUTE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <ServiceWorkerRegistrar />
        {isAuthRoute ? (
          // Full-viewport centered shell for the gate. No header, no
          // nav — just the landing card.
          <main className="flex-1 flex items-center justify-center px-3 sm:px-6 py-8 sm:py-12">
            {children}
          </main>
        ) : (
          <>
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
                {/* Desktop nav: inline horizontal links. Hidden on phones,
                    where MobileNav (below) renders a hamburger sheet
                    instead — way easier to scan + tap than a 6-link
                    side-scroller jammed under the logo. */}
                <nav className="hidden sm:flex gap-4 sm:gap-5 text-sm text-zinc-600 dark:text-zinc-400 whitespace-nowrap order-2">
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
                  <Link
                    href="/pricing"
                    className="hover:text-zinc-900 dark:hover:text-zinc-100"
                  >
                    Pricing
                  </Link>
                </nav>
                <div className="order-3 ml-auto flex items-center gap-3">
                  {/* Desktop-only "Install" link, hidden on phones (the
                      MobileNav sheet has the prominent CTA there) and
                      hidden entirely when the browser doesn't expose an
                      install path or the app is already installed. */}
                  <InstallButton variant="compact" />
                  <HeaderAuth />
                  <MobileNav />
                </div>
              </div>
            </header>
            <main className="mx-auto max-w-6xl w-full px-3 sm:px-6 py-6 sm:py-8 flex-1">
              {children}
            </main>
            <footer className="border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
              <div className="mx-auto max-w-6xl px-3 sm:px-6 py-5 flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-500">
                <div>
                  © {new Date().getFullYear()} Pylon. Dynasty values for
                  fantasy managers.
                </div>
                <nav className="flex flex-wrap gap-x-4 gap-y-1">
                  <Link
                    href="/methodology"
                    className="hover:text-zinc-900 dark:hover:text-zinc-100"
                  >
                    Methodology
                  </Link>
                  <Link
                    href="/pricing"
                    className="hover:text-zinc-900 dark:hover:text-zinc-100"
                  >
                    Pricing
                  </Link>
                  <a
                    href={mailtoHref("Pylon support")}
                    className="hover:text-zinc-900 dark:hover:text-zinc-100"
                  >
                    {SUPPORT_EMAIL}
                  </a>
                </nav>
              </div>
            </footer>
          </>
        )}
      </body>
    </html>
  );
}
