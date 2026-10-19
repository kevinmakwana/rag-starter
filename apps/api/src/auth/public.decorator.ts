import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';
/** Everything is owned by this user when authentication is off, and by existing documents from before accounts. */
export const DEFAULT_OWNER = 'default';

/** Mark a route as open to everyone, e.g. health checks. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
