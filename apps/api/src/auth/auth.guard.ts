import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_CONFIG, AppConfig } from '../config';
import { hashKey } from './api-keys';
import { DEFAULT_OWNER, IS_PUBLIC } from './public.decorator';

/** `Authorization: Bearer <key>` or `X-API-Key: <key>`. */
function presentedKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(String(headers.authorization ?? ''));
  const key = bearer?.[1] ?? headers['x-api-key'];
  return typeof key === 'string' && key ? key : undefined;
}

/**
 * Global guard. With no API_KEYS configured everyone is the default user (the quickstart works
 * as before); with keys, every route except those marked @Public() needs a valid one.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;

    const request = context.switchToHttp().getRequest();
    if (this.cfg.auth.keys.size === 0) {
      request.user = { id: DEFAULT_OWNER };
      return true;
    }
    const key = presentedKey(request.headers);
    const user = key ? this.cfg.auth.keys.get(hashKey(key)) : undefined;
    if (!user) {
      throw new UnauthorizedException("Missing or invalid API key. Send it as 'Authorization: Bearer <key>' or 'X-API-Key'.");
    }
    request.user = { id: user };
    return true;
  }
}
