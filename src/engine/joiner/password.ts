/**
 * A temporary password.
 *
 * Generated from the system's random source, never logged, never written to
 * the store or the audit. It exists in memory for the length of one
 * activation and is sent to people, not recorded. The alphabet leaves out
 * characters that are misread when typed from an email (0/O, 1/l/I).
 */

import { randomInt } from 'node:crypto'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'

export function temporaryPassword(length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}
