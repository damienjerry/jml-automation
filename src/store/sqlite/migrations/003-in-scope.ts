import type { Migration } from './index.ts'

/**
 * Adds whether IT provisions for the person. Nullable and additive: existing
 * rows read as "not known", which the toolkit treats as in scope.
 */
export const migration003: Migration = {
  id: '003-in-scope',
  description: 'people.in_scope, whether IT provisions accounts for this person',
  up(db) {
    db.exec(`ALTER TABLE people ADD COLUMN in_scope INTEGER`)
  },
}
