/**
 * The register of platforms the organisation uses, and who owns each.
 *
 * IT administers some of them and can close a leaver's access itself. The
 * rest belong to a team, and the only thing IT can do is tell the owner. That
 * is what this register is for: a name, an owner address, and how offboarding
 * is handled.
 *
 * The reference adapter reads a file, because every register product exports
 * one and a file is the only source that needs no credential. A Notion or
 * spreadsheet adapter is a later addition behind the same interface.
 */

export interface RegisterPlatform {
  name: string
  /** Lower-cased addresses. Empty when nobody is listed. */
  owners: string[]
  /**
   * How a leaver's access is handled, as the register spells it. `retired`
   * rows are skipped everywhere; everything else with an owner is notified,
   * because the message says IT will not follow up and that is true of every
   * platform IT does not administer.
   */
  handling: string
}

export interface SaasRegisterAdapter {
  readonly name: string
  listPlatforms(): Promise<RegisterPlatform[]>
}
