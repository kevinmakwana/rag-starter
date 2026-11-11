import { Migration } from '../migrator';
import { baseline } from './0001-baseline';

/** Every schema change, in order. Add a new file and append it here; never edit or reorder applied ones. */
export const migrations: readonly Migration[] = [baseline];
