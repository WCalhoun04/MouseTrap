"use client";

import { BlinkBlur } from "react-loading-indicators";

// Shades of the site's brass (--color-brass, #e4b15c), light to deep. BlinkBlur fades every
// bar through these in turn, each bar a little behind the last, so they read as a gradient.
const BRASS_GRADIENT = ["#f6dfae", "#ecc47a", "#e4b15c", "#c99236"];

/** Full-page loading state, shared by every page. Screen readers hear "Loading". */
export function PageLoader() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <BlinkBlur color={BRASS_GRADIENT} size="small" />
    </div>
  );
}
