import type { Migration } from './index.ts'

/** Adds the non-work address the temporary password is sent to. Nullable, additive. */
export const migration004: Migration = {
  id: '004-personal-email',
  description: 'people.personal_email, the non-work address from the HR system',
  up(db) {
    db.exec(`ALTER TABLE people ADD COLUMN personal_email TEXT`)
  },
}
