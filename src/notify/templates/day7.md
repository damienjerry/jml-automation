Day 7 offboarding complete: ${personName} (${personEmail})

- Identity provider account: ${idpStatus}
- Google account: ${googleStatus}
- Devices bound at the moment of deletion: none
- Files were handed to: ${transferRecipient}

This person is now recorded as departed. That row is a tombstone and is never
removed: it is what stops a later HR sync seeing an old leaver as a new one and
starting the whole sequence again.
