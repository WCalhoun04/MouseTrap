"use client";

import { useId } from "react";
import { formatClock, formatDate, formatUsd } from "@/lib/format";

export function ShareChart({
  points,
  livePrice,
  span = "over 90 days",
  clock = false,
}: {
  points: { t: number; price: number }[];
  livePrice: number;
  /** How the period reads in the chart's accessible label. */
  span?: string;
  /** Label the ends with times of day, for a series that covers minutes, not months. */
  clock?: boolean;
}) {
  const gradientId = useId().replace(/:/g, "");
  const data = points.map((point, index) =>
    index === points.length - 1 ? { ...point, price: livePrice } : point,
  );
  const prices = data.map((point) => point.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const pad = (max - min) * 0.25 || 0.01;
  const lo = min - pad;
  const hi = max + pad;
  const width = 640;
  const height = 200;
  const left = 4;
  const right = 4;
  const top = 16;
  const bottom = 8;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const xAt = (index: number) => left + (index / Math.max(1, data.length - 1)) * innerWidth;
  const yAt = (price: number) => top + (1 - (price - lo) / (hi - lo)) * innerHeight;
  const line = data
    .map((point, index) => `${index === 0 ? "M" : "L"} ${xAt(index)} ${yAt(point.price)}`)
    .join(" ");
  const area = `${line} L ${xAt(data.length - 1)} ${top + innerHeight} L ${xAt(0)} ${top + innerHeight} Z`;
  const first = data[0];
  const last = data[data.length - 1];

  return (
    <figure>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Share price ${span}, from ${formatUsd(first.price, 4)} to ${formatUsd(last.price, 4)}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#e4b15c" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#e4b15c" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke="#e4b15c" strokeWidth="2" />
      </svg>
      <figcaption className="mt-2 flex justify-between font-mono text-[11px] text-faint">
        <span>{clock ? formatClock(first.t) : formatDate(first.t)}</span>
        <span>{clock ? formatClock(last.t) : formatDate(last.t)}</span>
      </figcaption>
    </figure>
  );
}
