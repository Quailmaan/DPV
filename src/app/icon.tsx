// Dynamic favicon: filled-orange rounded square with a white Y monogram.
// The Y is the brand mark — same letter that's accented orange in the
// PYLON wordmark, doubling here as the standalone app icon.
//
// Next.js 16 picks this up automatically as the favicon (replacing the
// static favicon.ico in this directory) and emits the appropriate <link>
// tags for browsers and PWAs.

import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

// Brand orange — matches text-orange-600 used in the wordmark accent.
const ORANGE = "#ea580c";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: ORANGE,
          borderRadius: 6,
          color: "white",
          fontSize: 24,
          fontWeight: 900,
          letterSpacing: "-0.02em",
          fontFamily:
            "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          lineHeight: 1,
        }}
      >
        Y
      </div>
    ),
    { ...size },
  );
}
