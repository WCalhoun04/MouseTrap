import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BookTop, Fill } from "../exchange/types.ts";

/** Append-only JSONL record of every fill with the book it happened against. */
export class FillLog {
  private ready: Promise<unknown> | null = null;

  constructor(private readonly dir: string | null) {}

  record(fill: Fill, book: BookTop | undefined, mode: string): void {
    if (!this.dir) return;
    const dir = this.dir;
    this.ready ??= mkdir(dir, { recursive: true });
    const day = new Date(fill.at).toISOString().slice(0, 10);
    const line = JSON.stringify({ ...fill, mode, bid: book?.bid ?? null, ask: book?.ask ?? null }) + "\n";
    void this.ready.then(() => appendFile(join(dir, `fills-${day}.jsonl`), line)).catch(() => {});
  }
}
