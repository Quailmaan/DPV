"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import InstallButton from "./InstallButton";

// Mobile-only nav. The desktop layout already has the inline horizontal
// nav (`hidden sm:flex` from layout.tsx). On phones we collapse that to
// a hamburger button that opens a full-width sheet menu — way easier to
// scan and tap than a side-scrolling row of 6 links jammed under the
// logo.
//
// The button + sheet both live in this client component because the
// open/close state and the route-change auto-close need React. The
// underlying Link list is shared with the desktop nav by intent only —
// keeping them in lockstep is just a manual sync, not worth abstracting
// for 6 links.

const NAV_ITEMS: { href: string; label: string }[] = [
  { href: "/", label: "Rankings" },
  { href: "/rookies", label: "Rookies" },
  { href: "/league", label: "Leagues" },
  { href: "/trade", label: "Trade" },
  { href: "/methodology", label: "Methodology" },
  { href: "/pricing", label: "Pricing" },
];

export default function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Auto-close on route change. Without this, tapping a link opens the
  // new page but the sheet stays open over it.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll while the sheet is open so the page doesn't scroll
  // beneath the overlay on iOS.
  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [open]);

  // Close on Escape — keyboard users + accessibility.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="sm:hidden inline-flex items-center justify-center w-9 h-9 rounded-md border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 active:bg-zinc-200 dark:active:bg-zinc-700"
        aria-label="Open navigation menu"
        aria-expanded={open}
      >
        {/* Hamburger icon — three lines. Inline SVG so we don't pull in
            another icon dep just for one glyph. */}
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {open && (
        <div
          className="sm:hidden fixed inset-0 z-50"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
        >
          {/* Dim backdrop. Tap anywhere outside the sheet to close. */}
          <button
            type="button"
            aria-label="Close navigation menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-zinc-900/40 dark:bg-zinc-950/60 backdrop-blur-sm"
          />
          {/* Sheet — slides in from the right. We use a plain right-aligned
              fixed div instead of an animated transition because the
              add/remove of `open` is fast enough that a transform animation
              would actually feel laggy on lower-end Android devices. */}
          <div className="absolute top-0 right-0 bottom-0 w-72 max-w-[85%] bg-white dark:bg-zinc-900 border-l border-zinc-200 dark:border-zinc-800 shadow-xl flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
              <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Menu
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex items-center justify-center w-8 h-8 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 active:bg-zinc-200 dark:active:bg-zinc-700"
                aria-label="Close menu"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto py-2">
              {NAV_ITEMS.map((item) => {
                const isActive =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname === item.href ||
                      pathname.startsWith(item.href + "/");
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`block px-4 py-3 text-base ${
                      isActive
                        ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium"
                        : "text-zinc-700 dark:text-zinc-300 active:bg-zinc-100 dark:active:bg-zinc-800"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            {/* Install CTA — pinned at the bottom of the sheet so it's
                always visible without scrolling past the nav links.
                InstallButton renders null when there's no install path
                (already installed, or unsupported browser like Firefox
                desktop), and the `empty:hidden` modifier collapses
                this whole wrapper — including the border — so the
                sheet doesn't show an empty bordered box. */}
            <div className="empty:hidden border-t border-zinc-200 dark:border-zinc-800 px-4 py-3">
              <InstallButton variant="sheet" />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
