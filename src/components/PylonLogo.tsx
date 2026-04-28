import type { SVGProps } from "react";

// Pylon glyph — stylized NFL goal-line pylon. Tall narrow trapezoid (slightly
// wider at base) with a single horizontal accent stripe near the top, the
// way real pylons have a reflective band. Uses currentColor so the pylon
// inherits brand color from CSS — easy theming.
//
// Aspect: 12:36 = 1:3. Real pylons are ~4.5:1 (needle-like); 1:3 is the
// right iconic abstraction for a logo at all sizes including 16px favicon.
export function PylonGlyph({
  size = 32,
  stripe = true,
  ...props
}: { size?: number; stripe?: boolean } & SVGProps<SVGSVGElement>) {
  const height = (size * 36) / 12;
  return (
    <svg
      width={size}
      height={height}
      viewBox="0 0 12 36"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    >
      <path d="M 3 2 L 9 2 L 10 34 L 2 34 Z" fill="currentColor" />
      {stripe && (
        <rect
          x="3"
          y="6"
          width="6"
          height="1.5"
          fill="white"
          fillOpacity="0.92"
        />
      )}
    </svg>
  );
}

type Variant = "default" | "accent" | "stacked";
type Size = "sm" | "md" | "lg" | "xl";

const SIZE_PX: Record<Size, { glyph: number; textPx: number; gap: number }> = {
  sm: { glyph: 14, textPx: 14, gap: 6 },
  md: { glyph: 22, textPx: 22, gap: 8 },
  lg: { glyph: 36, textPx: 36, gap: 12 },
  xl: { glyph: 64, textPx: 56, gap: 18 },
};

// PylonWordmark — three variants:
//   default : pylon glyph beside PYLON wordmark (most flexible, most legible)
//   accent  : wordmark only, with the Y rendered in brand orange
//   stacked : glyph above wordmark (square avatar shape)
export function PylonWordmark({
  variant = "default",
  size = "md",
  className = "",
}: {
  variant?: Variant;
  size?: Size;
  className?: string;
}) {
  const s = SIZE_PX[size];
  if (variant === "stacked") {
    return (
      <span
        className={`inline-flex flex-col items-center ${className}`}
        style={{ gap: s.gap }}
      >
        <PylonGlyph
          size={s.glyph * 1.4}
          className="text-orange-600 dark:text-orange-500"
        />
        <span
          className="font-bold tracking-tight leading-none"
          style={{ fontSize: s.textPx * 0.7 }}
        >
          PYLON
        </span>
      </span>
    );
  }
  if (variant === "accent") {
    return (
      <span
        className={`font-bold tracking-tight leading-none ${className}`}
        style={{ fontSize: s.textPx }}
      >
        P
        <span className="text-orange-600 dark:text-orange-500">Y</span>
        LON
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center ${className}`}
      style={{ gap: s.gap }}
    >
      <PylonGlyph
        size={s.glyph}
        className="text-orange-600 dark:text-orange-500"
      />
      <span
        className="font-bold tracking-tight leading-none"
        style={{ fontSize: s.textPx }}
      >
        PYLON
      </span>
    </span>
  );
}
