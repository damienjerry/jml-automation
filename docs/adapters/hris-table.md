# People from a CSV file or a Google Sheet

For a team with no HR API, or an HR system without an adapter here. Most HR
systems can export people to a CSV file on a schedule, or send a scheduled
report to a Google Sheet. The toolkit reads that table every run.

The table is **only ever read**. The toolkit's own record of what it has done
to each person stays in its people store (SQLite by default), so an edit to the
sheet can change who is employed but can never rewrite the history of an
offboarding.

## Pick one

| | `hris.adapter: csv` | `hris.adapter: sheet` |
| --- | --- | --- |
| Where the people are | a file on the machine that runs the toolkit | a Google Sheet |
| Kept up to date by | an export on a schedule, or by hand | a person editing the sheet, or an HR report written to it |
| Credential | none | the Google service account, reading as itself |
| Automation | only as good as the export schedule | automatic: nothing to export |

A sheet is the simpler choice for a small team: somebody adds a row for a
starter and fills in a last working day for a leaver, and the next run acts on
it. A CSV suits an HR system that can only export files.

## The columns

The first row is the headings. Map your headings in `hris.table.columns`; the
defaults match the shipped example, [examples/people.csv](../../examples/people.csv).

| Field | Default heading | Needed |
| --- | --- | --- |
| `hrisId` | Employee ID | **yes.** A stable id that never changes, even when a name or address does |
| `primaryEmail` | Work email | **yes.** The address the account was created with |
| `firstName`, `lastName` | First name, Last name | a name: these two, or `displayName` |
| `displayName` | (none) | if the table has one column for the full name |
| `department`, `jobTitle` | Department, Job title | no |
| `managerEmail` | Manager email | recommended: files go to the manager on day 6 |
| `personalEmail` | Personal email | recommended: where a starter's temporary password goes |
| `startDate` | Start date | recommended: a future start date makes the person a starter |
| `lastWorkingDay` | Last working day | **how somebody leaves.** Access stops the day after |
| `terminationDate` | (none) | if the contract ends later than the last day in |
| `inScope` | (none) | whether IT provisions accounts for this person; blank means yes |

Set any heading to `null` if your table does not have that column.

## Leavers keep their row

**Do not delete a leaver's row.** Fill in their last working day. The person
becomes a leaver the day after it.

Status comes from the dates, by the same rule as every other HR source here:

- a start date in the future: hired, a starter;
- started and no last working day, or one not yet passed: active;
- past the last working day: left.

A row deleted from the table simply stops being read. The toolkit does not
treat a missing row as a leaver, so a deleted row for somebody it knows about
is left alone, and every run names it in the report as a warning.

## Dates

Every date in the table is in the one format named by `hris.table.dateFormat`:
`YYYY-MM-DD` (the default), `DD/MM/YYYY` or `MM/DD/YYYY`. A date in any other
shape refuses the whole read. Mixed formats are how `03/04` moves a leaving date
by a month. In a Google Sheet, the formatted value a person sees is what is
read, so format the date columns to match.

## What refuses a read

One bad row stops the whole read, and nothing is taken from the table, because
a skipped row is indistinguishable from a leaver. The error names every
problem by row number, so one attempt shows everything to fix:

- a mapped heading missing from the first row;
- a row with no id, or an id or work email on two rows;
- a date not in the stated format, or a date that does not exist;
- a last working day before a start date;
- fewer people than `hris.minPlausibleHeadcount`;
- a table last changed longer ago than `hris.table.maxAgeHours`, when set.

Blank rows are skipped. Headings match without regard to case.

## A Google Sheet

1. Make the sheet, with the headings in the first row. A tab called `People`
   is read by default; set `hris.table.range` for another tab or an A1 range.
2. Share it with the service account's own address (the `client_email` in the
   key file) as a **viewer**.
3. Set `hris.adapter: sheet` and `hris.table.spreadsheetId` to the id in the
   sheet's URL.

It is read with `https://www.googleapis.com/auth/spreadsheets.readonly`, as the
service account itself: no domain-wide delegation and no administrator is
impersonated for this. With `hris.table.maxAgeHours` set, the sheet's last edit
time is read from Drive with `https://www.googleapis.com/auth/drive.readonly`,
also as the service account itself.

## A CSV file

Set `hris.adapter: csv` and `hris.table.path`. **With Docker**, the scheduled
runs happen inside a container that sees only the install's `data/` folder, so
the file has to live there, as `./data/people.csv` or similar; `jml setup`
offers to copy it there and says to point your export at it. Without Docker any
path works. Standard CSV: quoted fields,
commas and line breaks inside quotes, and a leading byte order mark are all
fine. `hris.table.maxAgeHours` checks the file's modified time, so an export
that stopped running is refused rather than read as if nothing had changed.

## Try it with no credentials at all

```
jml store bootstrap --armed
jml sync --armed
jml detect
jml store verify
```

With `hris.adapter: csv`, none of these reads any credential. You see who the
toolkit thinks has started and left before you grant it access to anything.
