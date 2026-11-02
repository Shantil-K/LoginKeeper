# Login Keeper

A webOS app for rooted LG TVs. It backs up the sign-ins of apps that run on the TV's web engine (YouTube, JioHotstar, ZEE5, SonyLIV…) and puts them back when the TV forgets them.

## Why logins get lost

Web apps keep their sign-ins in one shared Chromium profile at `/var/lib/wam/Default` (Local Storage, IndexedDB, Cookies). When the TV runs short of memory, for example after a heavy app, the web engine can be killed in the middle of a write. On the next start Chromium finds the database damaged and deletes it, which signs you out of every web app at once.

## What it does

- **Backups:** a full copy of the login storage (about 14 MB), saved to `/media/developer/loginkeeper/backups`. The web engine is paused for the fraction of a second the copy takes, so the copy is consistent.
- **Automatic protection:** a boot hook in Homebrew Channel's `init.d` starts a background job. It makes a backup every 6 hours, keeps the newest 13 (78 hours of history), and checks every 5 minutes for a wipe.
- **Wipe detection:** a marker file inside `Local Storage` goes missing, or the database folder is recreated.
- **Auto restore:** after a wipe it restores the newest backup, but only while you're on the home screen, because a restore restarts the web engine. It restores at most once every 30 minutes.
- **Apps to restore:** you choose which apps a restore puts back.
  - With "All apps", the whole saved storage is copied back.
  - With chosen apps, `lsdb.js` swaps only those apps' entries in the shared Local Storage database. Their IndexedDB folders and cookies (matched by site) are swapped too. Every other app is left alone.
- **Undo:** every restore first saves what was there before, as a "Before a restore" backup.

Not covered: native apps like Netflix and Prime Video. They keep their logins elsewhere.

## Files

- `src/loginkeeper.sh` does all the root work: `status`, `list`, `backup`, `restore`, `apps`, `autostart`, `daemon`. It runs through `org.webosbrew.hbchannel.service/exec`.
- `src/lsdb.js` reads and writes Chromium's leveldb (MANIFEST, logs, snappy tables) using the TV's Node 16. Its reader matches `leveldbutil`, and it checks every database it writes by reading it back.
- `src/js/app.js` is the UI, navigable with the remote's arrow keys.

## Build and install

```
ares-package src -o .
ares-install -d webosroot com.homebrew.loginkeeper_1.0.1_all.ipk
```

Releases are built by GitHub Actions: bump `version` in `src/appinfo.json`, add notes in `.github/release-notes/vX.Y.Z.md`, then push a `vX.Y.Z` tag.
