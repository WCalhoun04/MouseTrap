"use client";

import { Providers } from "@/components/providers";
import { Shell } from "@/components/shell";
import type { ReactNode } from "react";

export function ClientRoot({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <Shell>{children}</Shell>
    </Providers>
  );
}
