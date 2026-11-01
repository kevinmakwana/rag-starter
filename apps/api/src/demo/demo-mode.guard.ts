import { CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../auth/public.decorator';
import { APP_CONFIG, AppConfig } from '../config';
import { DailyBudget } from './daily-budget';
import { IS_DEMO_SAFE } from './demo-safe.decorator';

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Only a handler can be demo-safe, never a whole class: @DemoSafe() on a controller would otherwise quietly open
 * every write route it holds (and no per-handler check would notice).
 */
function isDemoSafe(reflector: Reflector, context: ExecutionContext): boolean {
  return !!reflector.get<boolean>(IS_DEMO_SAFE, context.getHandler());
}

/**
 * Deny by default. In demo mode only reads, public routes and routes marked @DemoSafe() get through, so a
 * write route added later is blocked until someone decides otherwise. Registered after AuthGuard and before
 * the rate limiter, so a refused write costs nothing and spends nobody's budget.
 */
@Injectable()
export class DemoModeGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.cfg.demo.enabled) return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    if (isDemoSafe(this.reflector, context)) return true;
    const method = String(context.switchToHttp().getRequest().method).toUpperCase();
    if (READ_METHODS.includes(method)) return true;
    throw new ForbiddenException('This is a read-only demo: uploading, editing and deleting are turned off.');
  }
}

/**
 * One shared per-UTC-day cap on questions. Registered last, after the rate limiter, so only requests that
 * were admitted count: a visitor who is refused (by either guard) cannot use up everyone else's budget.
 */
@Injectable()
export class DemoBudgetGuard implements CanActivate {
  private readonly budget = new DailyBudget();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.cfg.demo.enabled) return true;
    if (!isDemoSafe(this.reflector, context)) return true;

    const result = this.budget.take(this.cfg.demo.maxQueriesPerDay);
    if (!result.allowed) {
      context.switchToHttp().getResponse().setHeader('Retry-After', String(result.retryAfterSeconds));
      throw new HttpException(
        "The demo has reached today's question limit. Please try again tomorrow.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
