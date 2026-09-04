${runKind} run ${runId} ABORTED, and nothing was changed: ${abortReason}

${abortDetail}

No account was touched and no status was written. This is the designed
behaviour rather than a crash: the run refuses to act on a picture it cannot
trust, because the alternative is acting on the wrong people at scale.

Nothing will happen until the cause is cleared. Rerun with a dry run first, and
compare the selection against what you expect before arming anything.
