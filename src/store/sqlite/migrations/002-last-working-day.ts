import type { Migration } from './index.ts'

/**
 * Adds the last working day beside the termination date.
 *
 * Additive, like every migration here: the column is nullable and existing
 * rows read as "not held", which makes the termination date decide on its own,
 * exactly as before the column existed.
 */
export const migration002: Migration = {
  id: '002-last-working-day',
  description: 'people.last_working_day, the day access should end when it differs from the contract end',
  up(db) {
    db.exec(`ALTER TABLE people ADD COLUMN last_working_day TEXT`)
  },
}
