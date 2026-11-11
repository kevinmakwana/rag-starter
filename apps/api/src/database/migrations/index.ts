import { Migration } from '../migrator';
import { baseline } from './0001-baseline';
import { documentLanguage } from './0002-document-language';
import { documentTags } from './0003-document-tags';

/** Every schema change, in order. Add a new file and append it here; never edit or reorder applied ones. */
export const migrations: readonly Migration[] = [baseline, documentLanguage, documentTags];
