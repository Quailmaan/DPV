// Pylon brand assets. The brand is wordmark-only — no separate glyph or
// pictographic image. The Y in PYLON is rendered in brand orange and that
// single accent letter carries the visual identity. The Y also doubles as
// a goalpost-shaped mark, so it works as a standalone monogram (favicon,
// app icon, social avatar) without needing a separate image asset.

type Size = "sm" | "md" | "lg" | "xl";

const SIZE_PX: Record<Size, number> = {
  sm: 14,
  md: 22,
  lg: 36,
  xl: 56,
};

// Wordmark — P + (orange Y) + LON. Single source of truth for how the
// name renders across the site.
export function PylonWordmark({
  size = "md",
  className = "",
}: {
  size?: Size;
  className?: string;
}) {
  const px = SIZE_PX[size];
  return (
    <span
      className={`font-bold tracking-tight leading-none ${className}`}
      style={{ fontSize: px }}
    >
      P
      <span className="text-orange-600 dark:text-orange-500">Y</span>
      LON
    </span>
  );
}

// PylonMark — the standalone Y monogram. Used wherever the wordmark won't
// fit (favicon, app icon, social avatar). Two modes:
//   filled=false : bold orange Y on transparent background
//   filled=true  : white Y on orange-filled rounded square (app-icon style)
export function PylonMark({
  size = 32,
  filled = false,
  dark = false,
  className = "",
}: {
  size?: number;
  filled?: boolean;
  dark?: boolean;
  className?: string;
}) {
  if (filled) {
    return (
      <span
        className={`inline-flex items-center justify-center rounded-md bg-orange-600 ${className}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <span
          className="font-black tracking-tight leading-none text-white"
          style={{ fontSize: size * 0.68 }}
        >
          Y
        </span>
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md ${
        dark ? "bg-zinc-900" : ""
      } ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span
        className="font-black tracking-tight leading-none text-orange-600 dark:text-orange-500"
        style={{ fontSize: size * 0.78 }}
      >
        Y
      </span>
    </span>
  );
}
