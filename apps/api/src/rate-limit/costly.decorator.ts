import { SetMetadata } from '@nestjs/common';

export const IS_COSTLY = 'isCostly';

/** Mark a route that calls a model (chat or embeddings): it also counts against the lower "costly" limit. */
export const Costly = () => SetMetadata(IS_COSTLY, true);
