import type { ReactNode } from "react";

const HEIGHTS = {
  sm: "h-48",
  md: "h-80",
  lg: "h-96",
  // Fixed on narrow screens; on wide ones it takes whatever height its flex-column parent
  // has left, so a card that shares a row with a taller one has no empty space at the bottom.
  fill: "h-48 lg:h-auto lg:min-h-32 lg:flex-1",
} as const;

/**
 * Fixed-height frame for a table or list. It keeps the same height whether it holds
 * no rows or hundreds, and scrolls to show the overflow.
 */
export function ScrollBox({
  size = "md",
  className = "",
  children,
}: {
  size?: keyof typeof HEIGHTS;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`scroll-themed ${HEIGHTS[size]} overflow-auto overscroll-contain ${className}`}>
      {children}
    </div>
  );
}

/** Classes for a table header that stays visible while its ScrollBox scrolls. */
export const STICKY_HEAD =
  "sticky top-0 z-10 bg-sheet shadow-[inset_0_-1px_0_var(--color-line)]";
