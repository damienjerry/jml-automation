# A brief for an AI assistant adapting this toolkit

Copy everything below the line into Claude, Codex, Gemini or another coding
assistant, after the sentence that describes your platforms. Give it
[AGENTS.md](../AGENTS.md), [adapting.md](adapting.md), [policy.md](policy.md) and
[access-removal.md](access-removal.md) as well.

Two things before you start:

- **You own the result.** An assistant makes the code quicker to write. It does
  not make the lifecycle right for your organisation, and it will not maintain
  the fork. When a provider changes its API, your version is yours to fix.
- **Never paste a credential or a real employee's details into the chat.** Use
  the shipped fixture and made-up people. If the assistant needs the shape of
  your HR data, give it field names and one invented record.

---

We run: [HR system], [identity provider], [email and files platform],
[scheduler, or none], [ticketing, or none]. We want the leaver path first.
Our answers to docs/policy.md are: [paste them].

Adapt this repository to that stack. Work in this order, and stop for my review
at the end of each numbered step. Do not write code until step 3.

1. **Inventory.** For each platform, list what the toolkit needs to read and
   change, and the smallest permission that allows it. Name every action from
   `armedActions` and say whether it maps to our platform, maps partly, or does
   not map at all.
2. **Gaps.** List plainly what our stack cannot do that the reference stack
   does, and what our policy answers need that the toolkit does not do. Say
   whether each change is a setting, a new adapter file, or a change to shared
   code (a fork). Rewrite docs/access-removal.md for our platforms, marking each
   route verified, requested, manual, or not covered.
3. **Build against fakes.** Implement the adapter or connector behind the
   existing interfaces. Add a fake for it in the style of the shipped fakes, and
   run the existing conformance and regression suites against it. Use invented
   people only. Never commit real names, addresses, ids or tokens, including in
   fixtures and test names.
4. **Keep every safety rule.** Do not remove or weaken: dry run as the default;
   the three arming locks (`mode: armed`, `armedActions`, `--armed`); read-back
   verification after every write; the HR plausibility floor; the day-0 circuit
   breaker; the tombstone bootstrap; the device gate failing closed; the audit
   log. **A missing or failed read is never "none found".** If our platform has
   no device inventory, the device gate must block or be explicitly declared
   absent in configuration, never return an empty list.
5. **Hand over.** Give me: the permission list to request; a test plan that
   starts with `jml doctor`, then a dry run against real data, then one armed
   action on one test account I create, with how to undo it; the lines to add to
   docs/operating.md for daily checks on our platforms; and a list of what is
   still unverified after the tests pass, and why.

Do not tell me something works because its tests pass. Tell me which behaviour
was exercised against a real service and which only against a fake.
