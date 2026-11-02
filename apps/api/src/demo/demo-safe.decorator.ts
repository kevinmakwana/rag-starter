import { SetMetadata } from '@nestjs/common';

export const IS_DEMO_SAFE = 'isDemoSafe';

/** Mark a route a demo visitor may call although it is not a read by HTTP method: it reads, but carries a body. */
export const DemoSafe = () => SetMetadata(IS_DEMO_SAFE, true);
