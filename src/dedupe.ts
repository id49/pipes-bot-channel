export type DedupeOptions = { ttlMs?: number; max?: number; now?: () => number };

// Bounded, TTL-limited set of keys. Map insertion order doubles as age order, so the oldest entry is the first key.
// Expired entries are not swept on a timer; they are replaced when seen again or evicted once the set is full.
export class Dedupe {
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly recordedAt = new Map<string, number>();

  constructor(opts: DedupeOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 600_000;
    this.max = opts.max ?? 5_000;
    this.now = opts.now ?? Date.now;
  }

  // Returns true for a live duplicate. Otherwise records the key (refreshing an expired one) and returns false.
  seen(key: string): boolean {
    const now = this.now();
    const at = this.recordedAt.get(key);
    if (at !== undefined && now - at < this.ttlMs) return true;

    this.recordedAt.delete(key);
    if (this.recordedAt.size >= this.max) {
      const oldest = this.recordedAt.keys().next().value;
      if (oldest !== undefined) this.recordedAt.delete(oldest);
    }
    this.recordedAt.set(key, now);
    return false;
  }
}
