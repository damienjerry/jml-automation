Day 0 offboarding: ${personName} (${personEmail})

- HR id: ${hrisId}
- Leaving date held by the HR system: ${terminationDate}
- Suspended at: ${suspendedAt}
- Line manager: ${managerStatus}

Steps:

${actionsTaken}

Drive transfer is due ${transferOn}. Deletion is due ${deleteOn}, and is refused
until the transfer has completed and no device is still bound to this person.

A step that failed is retried on later runs. A step that keeps failing parks the
row for review rather than being carried as done, so the summary count is the
number to watch, not this note.
