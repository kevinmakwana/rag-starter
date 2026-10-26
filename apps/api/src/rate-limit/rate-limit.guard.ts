import { isIP } from 'net';
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../auth/public.decorator';
import { APP_CONFIG, AppConfig } from '../config';
import { IS_COSTLY } from './costly.decorator';
import { clientBucket, RateLimiter, stripPort } from './rate-limiter';

/**
 * Global guard, registered after AuthGuard: with API keys the caller is the user it identified. Without
 * keys everyone is the same default user, so the client address is the caller instead.
 *
 * Every route except @Public() ones counts against the general limit; @Costly() routes also count
 * against the costly one. Each limit is one budget per caller, shared by all the routes it covers.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limiter = new RateLimiter();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const http = context.switchToHttp();
    const caller = this.callerOf(http.getRequest());
    const { perMinute, costlyPerMinute } = this.cfg.rateLimit;
    const tiers: [string, number][] = [['general', perMinute]];
    if (this.reflector.getAllAndOverride<boolean>(IS_COSTLY, targets)) tiers.push(['costly', costlyPerMinute]);

    for (const [tier, limit] of tiers) {
      if (limit <= 0) continue;
      const result = this.limiter.hit(`${tier}:${caller}`, limit);
      if (!result.allowed) {
        http.getResponse().setHeader('Retry-After', String(result.retryAfterSeconds));
        throw new HttpException('Too many requests. Slow down and try again shortly.', HttpStatus.TOO_MANY_REQUESTS);
      }
    }
    return true;
  }

  protected callerOf(req: { user?: { id?: string }; ip?: string; socket?: { remoteAddress?: string } }): string {
    if (this.cfg.auth.keys.size > 0 && req.user?.id) return `user:${req.user.id}`;
    // With `trust proxy` on, Express takes req.ip from X-Forwarded-For without checking that it is an address,
    // so a client could invent a new bucket per request. Anything that is not an IP falls back to the socket.
    const claimed = stripPort(req.ip);
    const address = isIP(claimed ?? '') ? claimed : req.socket?.remoteAddress;
    return `ip:${clientBucket(address)}`;
  }
}
