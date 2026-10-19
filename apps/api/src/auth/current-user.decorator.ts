import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { DEFAULT_OWNER } from './public.decorator';

/** The id of the authenticated user (set by AuthGuard); the default user when authentication is off. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest().user?.id ?? DEFAULT_OWNER,
);
