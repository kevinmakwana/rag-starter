export interface RateLimitResult {
  allowed: boolean;
  /** Whole seconds until the caller's window ends (at least 1); 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * Fixed-window counters in memory: per API process, gone on restart. A caller can burst up to twice
 * the limit across a window boundary, which is fine for protecting a bill rather than metering usage.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private sweptAt = 0;

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
    /** Upper bound on tracked callers, so a flood of made-up addresses cannot grow the map without limit. */
    private readonly maxKeys = 100_000,
  ) {}

  /** Records one request for `key` and says whether it is within `limit` for the current window. */
  hit(key: string, limit: number): RateLimitResult {
    const now = this.now();
    this.sweep(now);
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.delete(key);
      this.makeRoom();
      this.windows.set(key, window);
    }
    window.count++;
    if (window.count <= limit) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) };
  }

  /** Number of callers currently tracked. */
  get size(): number {
    return this.windows.size;
  }

  /** Still full after the sweep: drop the caller tracked longest (a Map iterates in insertion order). */
  private makeRoom(): void {
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) return;
      this.windows.delete(oldest.value);
    }
  }

  /** At most once a window, drop callers whose window has ended so the map does not grow forever. */
  private sweep(now: number): void {
    if (now - this.sweptAt < this.windowMs) return;
    this.sweptAt = now;
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}

/** `1.2.3.4:5678` and `[2001:db8::1]:443` (as some proxies write X-Forwarded-For) to the bare address. */
export function stripPort(address: string | undefined): string | undefined {
  if (!address) return address;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) return bracketed[1];
  const ipv4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(address);
  return ipv4 ? ipv4[1] : address;
}

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * The part of a client address that identifies one client. IPv4 as is; an IPv4 client on a dual-stack
 * socket arrives as `::ffff:a.b.c.d` and is the same IPv4 client (grouping those by prefix would put
 * every IPv4 client in one bucket); other IPv6 addresses by their /64, since one client can rotate the
 * rest freely.
 */
export function clientBucket(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const address = ip.split('%')[0];
  const mapped = IPV4_MAPPED.exec(address);
  if (mapped) return mapped[1];
  if (!address.includes(':')) return address;

  const [head, tail] = address.split('::');
  const before = head ? head.split(':') : [];
  const after = tail ? tail.split(':') : [];
  const fill = address.includes('::') ? Array<string>(Math.max(0, 8 - before.length - after.length)).fill('0') : [];
  const groups = [...before, ...fill, ...after].map((group) => group.toLowerCase().padStart(4, '0'));
  return `${groups.slice(0, 4).join(':')}::/64`;
}
