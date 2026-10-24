import { clientBucket, RateLimiter } from '../src/rate-limit/rate-limiter';

describe('RateLimiter', () => {
  const clock = (start = 1_000_000) => {
    let now = start;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  };

  it('allows up to the limit within a window, then refuses', () => {
    const limiter = new RateLimiter(60_000, clock().now);

    expect(limiter.hit('k', 2).allowed).toBe(true);
    expect(limiter.hit('k', 2).allowed).toBe(true);
    expect(limiter.hit('k', 2).allowed).toBe(false);
  });

  it('tells a refused caller how many whole seconds remain in the window, at least 1', () => {
    const time = clock();
    const limiter = new RateLimiter(60_000, time.now);
    limiter.hit('k', 1);

    time.advance(20_500);
    expect(limiter.hit('k', 1)).toEqual({ allowed: false, retryAfterSeconds: 40 });

    time.advance(39_400); // 100 ms left
    expect(limiter.hit('k', 1)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('starts a fresh window once the old one has run out', () => {
    const time = clock();
    const limiter = new RateLimiter(60_000, time.now);
    limiter.hit('k', 1);
    expect(limiter.hit('k', 1).allowed).toBe(false);

    time.advance(60_000);

    expect(limiter.hit('k', 1).allowed).toBe(true);
  });

  it('counts each key separately', () => {
    const limiter = new RateLimiter(60_000, clock().now);
    limiter.hit('a', 1);

    expect(limiter.hit('a', 1).allowed).toBe(false);
    expect(limiter.hit('b', 1).allowed).toBe(true);
  });

  it('keeps refusing for the rest of the window however many more requests arrive', () => {
    const limiter = new RateLimiter(60_000, clock().now);
    limiter.hit('k', 1);

    for (let i = 0; i < 1000; i++) expect(limiter.hit('k', 1).allowed).toBe(false);
  });

  it('forgets expired callers so memory does not grow with every address ever seen', () => {
    const time = clock();
    const limiter = new RateLimiter(60_000, time.now);
    for (let i = 0; i < 100; i++) limiter.hit(`ip:${i}`, 5);
    expect(limiter.size).toBe(100);

    time.advance(120_000);
    limiter.hit('fresh', 5);

    expect(limiter.size).toBe(1);
  });
});

describe('clientBucket', () => {
  it('uses an IPv4 address as it is', () => {
    expect(clientBucket('203.0.113.7')).toBe('203.0.113.7');
  });

  it('treats an IPv4-mapped IPv6 address (how Express reports IPv4 clients on a dual-stack socket) as the IPv4 address', () => {
    expect(clientBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientBucket('::FFFF:203.0.113.8')).toBe('203.0.113.8');
  });

  it('groups IPv6 addresses by their /64, so rotating the lower 64 bits does not dodge the limit', () => {
    expect(clientBucket('2001:db8:1:2::1')).toBe(clientBucket('2001:db8:1:2:ffff:0:0:9'));
    expect(clientBucket('2001:db8:1:2::1')).not.toBe(clientBucket('2001:db8:1:3::1'));
    expect(clientBucket('2001:DB8:1:2::1')).toBe(clientBucket('2001:db8:1:2::1'));
  });

  it('expands :: correctly wherever it appears', () => {
    expect(clientBucket('::1')).toBe('0000:0000:0000:0000::/64');
    expect(clientBucket('2001:db8::1')).toBe('2001:0db8:0000:0000::/64');
    expect(clientBucket('fe80::1%eth0')).toBe('fe80:0000:0000:0000::/64');
  });

  it('falls back to a fixed bucket when there is no address', () => {
    expect(clientBucket(undefined)).toBe('unknown');
    expect(clientBucket('')).toBe('unknown');
  });
});
