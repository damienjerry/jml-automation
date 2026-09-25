import type { RegisterPlatform, SaasRegisterAdapter } from '../../src/register/types.ts'

export class FakeRegister implements SaasRegisterAdapter {
  readonly name = 'fake-register'
  constructor(private readonly platforms: RegisterPlatform[]) {}
  async listPlatforms(): Promise<RegisterPlatform[]> {
    return this.platforms
  }
}

export const REGISTER = new FakeRegister([
  { name: 'Design tool', owners: ['owner.one@example.com'], handling: 'Team-owned' },
  { name: 'Analytics', owners: ['owner.one@example.com', 'owner.two@example.com'], handling: 'Team-owned' },
  { name: 'Old CRM', owners: ['owner.three@example.com'], handling: 'Retired' },
  { name: 'Identity provider', owners: [], handling: 'Automated' },
])
