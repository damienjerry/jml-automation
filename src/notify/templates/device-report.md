Device ${disposition}: ${deviceName}

- Serial: ${deviceSerial}
- Operating system: ${deviceOs}
- Last contact with the provider: ${deviceLastContact}
- Provider holds the disk-encryption recovery key: ${fdeKeyPresent}
- Previously bound to: ${previousOwner}

Steps:

${steps}

Deletion gate after this run: ${gateAfter}

The provider's record is the only way to reach this machine. Deleting the record
before the agents are gone leaves a machine nobody can reach and no way to
remove them later, so the record is only removed once a receipt has been read
back from the device itself.
