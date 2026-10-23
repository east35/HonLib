# XTEINK library transfer

Razerblade runs `scripts/xteink_library_sync.py` once a minute. When the
XTEINK is in **File Transfer → Join Network**, it copies missing EPUBs from
Jim's library directly into `/HonLib` on the SD card. Existing identical EPUBs
elsewhere on the device are recognized and left in place. The script does not
delete device files. It uses CrossPoint's HTTP file transfer API; HonLib and
Morgan's library are not involved.

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
check that `crosspoint.local` resolves correctly on razerblade. The service
does not sync deletions; removing a book from the server does not remove it
from the device.
