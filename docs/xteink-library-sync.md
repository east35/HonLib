# XTEINK library transfer

Razerblade runs `scripts/xteink_library_sync.py` once a minute. When the
XTEINK is in **File Transfer → Join Network**, it mirrors Jim's EPUB library
into `/HonLib` on the SD card. It copies new and changed books and removes
tracked books that have been removed from the source library. It never deletes
books outside `/HonLib`. The previously adopted copy of `D Heavy Water` is
moved into `/HonLib` so it participates in the mirror. It uses CrossPoint's
HTTP file transfer API; HonLib's web app and Morgan's library are not involved.

The user service and timer in `deploy/` are installed under
`~/.config/systemd/user/` on razerblade. `crosspoint.local` resolves to the
reader's current LAN address, and the script checks the device serial before
writing. Its state file is at
`/home/Admin/srv/apps/Lib/xteink-library-sync/state.json`.

Check progress with:

```sh
ssh razerblade 'systemctl --user status xteink-library-sync.timer'
ssh razerblade 'journalctl --user -u xteink-library-sync.service -n 50 --no-pager'
```

Run a check manually with:

```sh
ssh razerblade 'systemctl --user start xteink-library-sync.service'
```

The service quietly exits when the XTEINK is not in File Transfer mode. It
will retry on the next timer run. A failed transfer also retries later, and
the state file records each completed book. If the device address changes,
check that `crosspoint.local` resolves correctly on razerblade.

Cleanup applies only to files the service recorded inside `/HonLib`, and only
if the device copy still matches the recorded hash. An empty source library or
more than 25 missing books stops cleanup for review; `--allow-large-delete`
overrides the count guard for an intentional bulk removal. Deleting books from
HonLib's library folder removes them from the device on the next sync.
