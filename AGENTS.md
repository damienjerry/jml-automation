# Notes for an automated reader

This file is a stub. A machine-readable description of the modules, their
credentials and the transition table is a later phase of work. Until then,
what follows is the honest account of which surfaces can be relied on.

## The authoritative machine-readable surfaces

Three, and nothing else:

| Surface | What it describes | How it is produced |
| --- | --- | --- |
| [schema/jml.config.schema.json](schema/jml.config.schema.json) | Every configuration key, its type, default, and whether it holds a secret reference | Generated from [src/config/schema.ts](src/config/schema.ts) by `npm run generate` |
| [docs/](docs/) | Behaviour, credentials, runbooks, and the incident each safeguard exists for | Hand-written, except [docs/config-reference.md](docs/config-reference.md), which is generated from the same schema |
| `jml --help`, and `jml <command> --help` | Command names, the flags each one accepts, and which commands need `--armed` | Generated from the command table in [src/cli/commands/registry.ts](src/cli/commands/registry.ts) |

Anything else is an implementation detail and may change without notice. In
particular: the shape of the run report, the audit row fields, the sidecar's
JSON bodies, the store's table layout, and the internal module boundaries are
not a contract. Read them if you are reviewing the code; do not build against
them.

`npm run check:generated` fails when a generated file has drifted from the
schema it comes from, so the two generated surfaces above cannot go stale
without CI saying so.

## Reviewing this repository for safety

Start in this order. It is the shortest path to knowing whether the code does
what the documentation claims.

1. [SECURITY.md](SECURITY.md). The threat model, the destructive action
   inventory, the refusals, and the list of claims with the command that
   checks each one. It also states plainly what is **not** proven.
2. [src/core/transitions.ts](src/core/transitions.ts). The only place a
   lifecycle status is assigned. Every edge carries the reason it exists, and
   the comments name the failure each rule prevents. `departed` has no
   outgoing edge, deliberately.
3. [test/regression/](test/regression/). Seventy-eight files, each named for the
   failure it prevents, each with a header explaining the incident and why it
   was not noticed at the time. [docs/incidents.md](docs/incidents.md) is the
   same material as prose, grouped, with a link to every one of those files.

Then, for the parts that touch a provider:

- [src/engine/leaver/gate.ts](src/engine/leaver/gate.ts) for the four checks
  standing in front of a deletion, and which of them fails closed.
- [src/engine/device/preflight.ts](src/engine/device/preflight.ts) for the
  eighteen reasons a device action is refused.
- [src/connectors/jumpcloud/scopes.ts](src/connectors/jumpcloud/scopes.ts) and
  [src/connectors/google/scopes.ts](src/connectors/google/scopes.ts) for the
  exact API calls and scopes, split by whether they read or write.
- [src/config/secrets.ts](src/config/secrets.ts) and
  [src/config/redact.ts](src/config/redact.ts) for credential handling.

## Enumerating modules and their credentials

There is no module manifest in this release. Use these instead:

```
# Every configuration key, with type, default and secret-or-not.
cat schema/jml.config.schema.json
cat docs/config-reference.md

# Every environment variable, names only, with the key it maps to.
cat .env.example

# What the identity provider key must be able to do, split read from write,
# with the armed action each write belongs to.
cat src/connectors/jumpcloud/scopes.ts

# Every Google scope, the subject its token is minted for, the connector
# methods that use it, whether it is required, and what breaks without it.
cat src/connectors/google/scopes.ts

# Which actions can be armed at all.
grep -A 10 "ARMED_ACTIONS = \[" src/config/schema.ts

# Which commands exist and which need --armed.
node bin/jml.mjs --help
```

The two scope files are the source for the credential documentation rather
than a copy of it, and a test compares them, so the documented permissions
cannot drift from the calls the code makes.

To see the whole leaver lifecycle decide a suspension and a deletion without
any credential, any network call or any file written:

```
node bin/jml.mjs demo
```

## Two things worth knowing before changing anything

- **Only reads have run against a real tenant** (one shadow run, 2026-09-25:
  doctor, HR read, directory read, Google scope probes, Notion read-only). No
  write has, and neither device uninstall script has run on real hardware. See
  the closing section of [SECURITY.md](SECURITY.md).
- **Several safeguards are literal `true` in the schema and are not meant to
  be configurable**, among them `leaver.deviceGate.failClosed` and
  `devices.forbidGroupBoundCommands`. Each one is a recorded incident.
  [docs/incidents.md](docs/incidents.md) says which.
