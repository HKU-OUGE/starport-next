---
name: starport-uninstall
description: Inspect and remove a Starport Next profile or a future receipt-owned installation when the user explicitly asks to uninstall. Preserve unrelated services, workspaces, and shared dependencies.
---

# Starport Next uninstall

Read [ROADMAP.md](../../docs/ROADMAP.md) and the installation receipts. The local adapter
runs a workspace supervisor and creates no cloud resources. Windows may additionally
have a current-user login entry, described in [SERVICES.md](../../docs/SERVICES.md).
Use `local status` and `local stop` for the exact state directory, export needed project
files, and confirm the supervisor and VM have stopped before removing that directory.
Never delete the base image of a live workspace. Removing its checkout must not be used
as a reason to stop an older Starport, Mac network, DSW instance, or Cloudflare tunnel.

For the Windows control route, first disable this deployment's login entry using
`register-startup.ps1 -Action disable` with its actual control state and config.
Verify the shortcut was removed, then stop only the supervisor identified by the
manifest, fresh receipt, command line and process creation time. Otherwise it may
restart services being removed. Close only its owned control and compute processes,
export required project data, and inspect `wsl.json`. `wsl --unregister` permanently
deletes an entire distribution: require explicit approval for that exact recorded
distribution and its data. Never use `wsl --shutdown` or infer ownership from a
similar name. Closing the new control process does not cancel remote compute jobs.

Before removing the checkout, inspect `client-shortcuts-<workspace>.json` in its
control state. Remove only listed desktop/Start-menu links whose target and
arguments still identify this installation's `launch-client.ps1`, state and project.
For repaired WSL automatic links, restore the corresponding private backup only
if the current link is still owned and the distribution is being retained. Do not
restore links for a distribution being removed or overwrite links changed by the
user. Preserve unrelated WSL menu entries and never delete a whole shared menu.
The shortcut receipt may also contain `retired` names and cached `icons` from an
appearance change. Treat archived links as backups, not live startup entries;
remove only owned caches/backups included in the user's removal scope.

Inventory exact paths and ownership first. Distinguish repository source, private
profiles/vaults, projects, task artifacts, dependency releases, and temporary files.
Explain the scope and estimated storage recovery; use the user's explicit deletion
allowlist when provided, otherwise obtain the missing scope before deletion.

For later deployed versions, drain new admissions and preserve active work. Use
receipt-owned service identifiers and verified process identities; never kill a
reused PID. Remove only resources created by the selected installation. Shared
dependencies and data require a zero-active-lease check. Access/Tunnel removal is
separate from local removal and requires authorization for those exact resources.

Default to preserving project files and encrypted backups. Offer a separate
explicit choice for permanent data removal. Report verified removal and any
remaining objects without claiming success from a missing local directory alone.

## Linux panel removal

Read [LINUX-HOST.md](../../docs/LINUX-HOST.md) and inspect `linux-services.json`.
Disable this deployment's login startup, stop its recorded units only after
local work is idle, and run `linux services unregister`. Remove unchanged
receipt-owned menu entries with `linux shortcuts remove`. Unmount each recorded
project SSHFS directory with `fusermount3 -u` before deleting anything below it;
never recursively delete a mounted project directory. Stop the exact owned QEMU
VM and preserve its disk/project data unless explicitly included in the user's
deletion scope. A shared Xpra, SSHFS or QEMU package is not owned by one deployment.
