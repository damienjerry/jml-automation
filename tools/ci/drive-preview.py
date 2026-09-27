#!/usr/bin/env python3
"""Run a command in a pseudo-terminal and answer the setup wizard's prompts.

Used by CI to walk `./install.sh --preview` on Linux from a fresh clone to the
wizard's last line, the way a person would at a terminal. The wizard reads a
real terminal (readline, muted secret prompts), so piping answers into stdin is
not the same thing and fails at end of input.

Answers are given only once the preview has started, one per prompt, and a
prompt is recognised as output that has gone quiet ending in ": ". The run
passes when the preview says it finished, and fails otherwise, printing
everything it saw.
"""

import os
import pty
import re
import select
import sys
import time

ANSWERS = [
    'Example Organisation', 'example.com', '', 'Europe/London', '', 'admin@example.com', '',
    '2',                 # identity provider: none (1.0b)
    '3',                 # HR: a CSV file
    './people.csv', '',  # path, date format default
    '5', '',             # headcount floor, SQLite
    'n',                 # no Slack
    '1', 'op://Vault/item/field',  # the Google key from 1Password: not read in a preview
]
TIMEOUT_S = int(os.environ.get("DRIVE_TIMEOUT", "900"))
QUIET_S = 0.6
ANSI = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]')


def main() -> int:
    cmd = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)
    out = b''
    answers = list(ANSWERS)
    started = time.time()
    last = time.time()
    while time.time() - started < TIMEOUT_S:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
            last = time.time()
            continue
        text = ANSI.sub('', out.decode(errors='replace'))
        if 'PREVIEW' in text and answers and time.time() - last > QUIET_S and text.rstrip(' ').endswith(':'):
            os.write(fd, (answers.pop(0) + '\r').encode())
            last = time.time()
    else:
        # Timed out: the child is most likely waiting for an answer.
        os.kill(pid, 15)
    try:
        _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        status = 0
    text = ANSI.sub('', out.decode(errors='replace').replace('\r', ''))
    print(text)
    if 'Preview finished' not in text:
        print('FAIL: the preview did not reach its last line', file=sys.stderr)
        return 1
    if answers:
        print(f'FAIL: {len(answers)} answer(s) were never asked for', file=sys.stderr)
        return 1
    print('OK: the setup preview ran to its last line')
    return 0 if os.WEXITSTATUS(status) == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
