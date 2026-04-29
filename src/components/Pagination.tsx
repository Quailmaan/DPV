import Link from "next/link";

// Server-component-friendly pagination control. The parent owns URL
// state — we just take a `buildHref(page)` and render the chrome.
//
// Design notes:
//   - Always renders even at totalPages === 1, but as a static "Showing
//     N of N" line with no page numbers. The caller can still drop us
//     entirely when totalItems === 0.
//   - Page list collapses with ellipses past 7 pages so the row stays a
//     single line on mobile. Pattern: 1 … (current-1) current (current+1) … last.
//   - Prev/Next link to current ± 1 and disable at the edges. Disabled
//     state is a non-link span so screen readers don't announce a stale
//     control.

type Props = {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  buildHref: (page: number) => string;
  /** Optional label for the units in "Showing X-Y of Z players". Defaults to "results". */
  itemLabel?: string;
};

export function Pagination({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  buildHref,
  itemLabel = "results",
}: Props) {
  if (totalItems === 0) return null;

  const safePage = Math.min(Math.max(1, currentPage), Math.max(1, totalPages));
  const start = (safePage - 1) * pageSize + 1;
  const end = Math.min(safePage * pageSize, totalItems);

  const pages = pageList(safePage, totalPages);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mt-4 px-1">
      <div className="text-xs text-zinc-500 tabular-nums">
        Showing <span className="text-zinc-700 dark:text-zinc-300">{start}–{end}</span> of{" "}
        <span className="text-zinc-700 dark:text-zinc-300">{totalItems}</span> {itemLabel}
      </div>
      {totalPages > 1 && (
        <nav
          aria-label="Pagination"
          className="flex items-center gap-1 text-sm"
        >
          <PageLink
            href={buildHref(safePage - 1)}
            disabled={safePage === 1}
            aria-label="Previous page"
          >
            ‹ Prev
          </PageLink>
          {pages.map((p, i) =>
            p === "ellipsis" ? (
              <span
                key={`e-${i}`}
                className="px-2 text-zinc-400 select-none"
                aria-hidden="true"
              >
                …
              </span>
            ) : (
              <PageLink
                key={p}
                href={buildHref(p)}
                active={p === safePage}
                aria-label={`Page ${p}`}
                aria-current={p === safePage ? "page" : undefined}
              >
                {p}
              </PageLink>
            ),
          )}
          <PageLink
            href={buildHref(safePage + 1)}
            disabled={safePage === totalPages}
            aria-label="Next page"
          >
            Next ›
          </PageLink>
        </nav>
      )}
    </div>
  );
}

function PageLink({
  href,
  children,
  active,
  disabled,
  ...rest
}: {
  href: string;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-current"?: "page";
}) {
  const base =
    "min-w-[2rem] px-2 py-1 rounded-md text-center tabular-nums border";
  if (disabled) {
    return (
      <span
        className={`${base} border-transparent text-zinc-300 dark:text-zinc-700 cursor-not-allowed`}
        aria-disabled="true"
        {...rest}
      >
        {children}
      </span>
    );
  }
  if (active) {
    return (
      <span
        className={`${base} border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 font-medium`}
        {...rest}
      >
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className={`${base} border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300`}
      {...rest}
    >
      {children}
    </Link>
  );
}

// Build [1, 2, 3, ..., N-1, N] style page list. Always includes the
// first and last page; ellipses replace runs > 1 page on either side
// of the current page.
function pageList(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const out: Array<number | "ellipsis"> = [1];
  if (current > 3) out.push("ellipsis");
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  for (let i = start; i <= end; i++) out.push(i);
  if (current < total - 2) out.push("ellipsis");
  out.push(total);
  return out;
}
