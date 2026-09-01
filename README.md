# Trash Drop Bridge

Trash Drop Bridge is a GNOME Shell extension that lets you drag files and
folders from Nautilus to the Trash icon in Ubuntu Dock on Wayland.

GNOME Shell does not currently expose an API that lets an extension accept and
finish an external Wayland drag. Trash Drop Bridge reads the drag selection,
detects a release over Ubuntu Dock's Trash icon, and moves the selected local
items to Trash with GIO.

## Features

- Works with the auto-hidden Ubuntu Dock.
- Highlights the Trash drop target.
- Suppresses the misleading rejected-drop snap-back animation.
- Optionally shows a notification after a successful drop.

## Requirements

- GNOME Shell 50
- Ubuntu Dock with its Trash icon enabled
- Nautilus on a Wayland session

## Build and install

```sh
make
make install
```

Log out and back in after installing an extension for the first time, then
enable it:

```sh
gnome-extensions enable trash-drop-bridge@oki
```

The bundle is written to `dist/trash-drop-bridge@oki.shell-extension.zip`.

## Debugging

Follow the extension's messages while testing a drag:

```sh
journalctl --user -f -o cat | grep TrashDropBridge
```

## License

Copyright © 2026 okixk

This project is licensed under the GNU Affero General Public License, version 3.
See [LICENSE](LICENSE).
