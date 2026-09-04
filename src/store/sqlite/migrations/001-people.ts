/**
 * The people table.
 *
 * Two shapes are worth explaining.
 *
 * `email_index` holds every address this person has ever used, each wrapped in
 * a separator, so a lookup by address is an exact containment test rather than
 * a pattern match. A `LIKE '%addr%'` search matches a longer address that
 * merely contains the one asked for, which is how a lookup returns the wrong
 * person; the wrapping makes that impossible.
 *
 * `suspended_at` duplicates the value inside the offboarding JSON so that the
 * Day-0 selection can be a plain indexed query. It is written in one place in
 * the store, never by a caller.
 */

import type { Migration } from './index.ts'

export const migration001: Migration = {
  id: '001-people',
  description: 'people table, email lookup index, lifecycle indexes and the migration ledger',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS people (
        hris_id                TEXT PRIMARY KEY,
        status                 TEXT NOT NULL,
        primary_email          TEXT NOT NULL,
        alias_emails           TEXT NOT NULL DEFAULT '[]',
        email_index            TEXT NOT NULL DEFAULT '',
        display_name           TEXT NOT NULL,
        first_name             TEXT,
        last_name              TEXT,
        department             TEXT,
        job_title              TEXT,
        site                   TEXT,
        manager_email          TEXT,
        start_date             TEXT,
        termination_date       TEXT,
        hold                   INTEGER NOT NULL DEFAULT 0,
        hold_reason            TEXT,
        review_reason          TEXT,
        external_ids           TEXT NOT NULL DEFAULT '{}',
        google_account_present INTEGER,
        offboarding            TEXT,
        activation             TEXT,
        note                   TEXT,
        source                 TEXT,
        updated_at             TEXT,
        suspended_at           TEXT
      ) STRICT
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS people_status ON people (status)`)
    db.exec(`CREATE INDEX IF NOT EXISTS people_suspended_at ON people (suspended_at)`)
    db.exec(`CREATE INDEX IF NOT EXISTS people_termination_date ON people (termination_date)`)
    db.exec(`CREATE INDEX IF NOT EXISTS people_primary_email ON people (primary_email)`)
  },
}
