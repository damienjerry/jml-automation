Activation refused: ${personName} (${workEmail}, HR id ${hrisId})

The identity account is already in use: somebody has set its password or
enrolled MFA on it. The toolkit never resets a working account, so nothing was
touched and no email was sent.

Either this person was activated by hand, or the HR record has been matched to
the wrong account. Check which before doing anything. To clear the refusal once
you are sure: jml joiner approve --hris-id ${hrisId} --reset-refusal
