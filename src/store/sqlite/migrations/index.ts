/**
 * Schema migrations for the SQLite people store.
 *
 * Forward-only and additive, for the same reason the store interface has no
 * delete: the tombstone rows in this table are the only thing preventing a
 * historic leaver being offboarded a second time, and the incident behind that
 * rule was a data migration that removed them. A migration here may add a
 * table, add a column or add an index. It may not drop or rewrite one. When a
 * column stops being used it is left in place and ignored.
 *
 * Ordering is the array below, not the filename, so a reader can see the whole
 * history in one place.
 */

import type { DatabaseSync } from 'node:sqlite'
import { migration001 } from './001-people.ts'

export interface Migration {
  /** Stable and never reused. Recorded in `schema_migrations`. */
  id: string
  description: string
  up(db: DatabaseSync): void
}

export const MIGRATIONS: readonly Migration[] = [migration001]
