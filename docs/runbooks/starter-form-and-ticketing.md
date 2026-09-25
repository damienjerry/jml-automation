# The starter form and ticketing

Only when `ticketing.adapter` is set. With `joiner.gate: ticket` the starter
form is what opens the activation gate.

## What happens without you

- Joiner detected, gate closed: the manager gets one message asking them to
  raise the form (`ticketing.formInstruction`). If the HR record holds no
  usable manager address, IT gets one message instead.
- The day before the start date, gate still closed: one reminder to the manager.
- The form's ticket lands: `jml-ticket-inbound` relays it to the sidecar, which
  matches it to exactly one waiting person and opens their gate. The next
  pipeline run activates them. The ticket gets a reply saying who it matched.
- A leaver becomes a day-0 candidate: one ticket, due the day after leaving,
  listing the plan and the platforms IT does not administer.

## When the bridge could not match

The ticket carries a reply "could not be matched", and IT gets a note naming
the ticket. Two causes: nobody waiting has that name or address (the HR sync
has not created the row yet, or the name on the form differs from the HR
system), or two people match. Either way, find the person and open the gate by
hand:

```bash
jml joiner show --email jane.doe@example.com
jml joiner approve --email jane.doe@example.com --actor you@example.com --note "ticket #42"
```

## When nobody was nudged

`jml joiner show` prints `nudged` and `reminded`. A row with neither and a
closed gate means the pipeline has not run since the joiner appeared, or the
person is out of scope. A row nudged with no manager address means IT was told
instead; raise the form yourself or open the gate.

## Testing the inbound path without a real ticket

```bash
curl -s -X POST "$JML_API_URL/v1/tickets/inbound" \
  -H "Authorization: Bearer $JML_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"eventType":"created","ticket":{"id":"t-1","ticketNumber":1,"formId":"<your starter form id>","customFields":[{"fieldName":"First Name","value":"Jane"},{"fieldName":"Last Name","value":"Doe"}]}}'
```

The answer names the outcome: `opened`, `unmatched`, `ambiguous` or `ignored`.
