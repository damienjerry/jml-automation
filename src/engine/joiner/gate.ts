/**
 * What has to happen before an eligible person is activated.
 *
 * Three settings, one interface:
 *  - none: nothing. The HR record is the authority.
 *  - manual: somebody runs `jml joiner approve`, which stamps the row.
 *  - ticket: a ticketing adapter opens it. Interface only in this phase; it
 *    behaves as manual, so an adopter can wire their own without the engine
 *    changing.
 *
 * The gate exists because in one estate a manager's form was the only thing
 * that said "this person needs a laptop and these apps", and activating
 * without it produced accounts nobody had asked for and no kit for the
 * people who had.
 */

import type { Person } from '../../core/types.ts'

export type GateMode = 'none' | 'manual' | 'ticket'

export interface GateVerdict {
  open: boolean
  reason: string
}

export interface ActivationGate {
  readonly mode: GateMode
  isOpen(person: Person): Promise<GateVerdict>
}

export function createActivationGate(mode: GateMode): ActivationGate {
  if (mode === 'none') {
    return { mode, isOpen: async () => ({ open: true, reason: 'no gate configured' }) }
  }
  return {
    mode,
    isOpen: async (person) => {
      const at = person.activation?.gateOpenedAt
      if (at) return { open: true, reason: `gate opened ${at} by ${person.activation?.gateOpenedBy ?? 'unknown'}` }
      return {
        open: false,
        reason:
          mode === 'manual'
            ? 'waiting for `jml joiner approve`'
            : 'waiting for the ticketing adapter to open the gate (no adapter is wired in this phase, so approve by hand)',
      }
    },
  }
}
