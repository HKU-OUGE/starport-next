---
name: starport-uninstall
description: Inspect and remove a Starport Next profile or a future receipt-owned installation when the user explicitly asks to uninstall. Preserve unrelated services, workspaces, and shared dependencies.
---

# Starport Next uninstall

Read [ROADMAP.md](../../docs/ROADMAP.md) and the installation receipts. The local adapter
runs a workspace supervisor but registers no login startup and creates no cloud resources.
Use `local status` and `local stop` for the exact state directory, export needed project
files, and confirm the supervisor and VM have stopped before removing that directory.
Never delete the base image of a live workspace. Removing its checkout must not be used
as a reason to stop an older Starport, Mac network, DSW instance, or Cloudflare tunnel.

For the Windows control route, close only its owned foreground control process,
export required project data, and inspect `wsl.json`. `wsl --unregister` permanently
deletes an entire distribution: require explicit approval for that exact recorded
distribution and its data. Never use `wsl --shutdown` or infer ownership from a
similar name. Closing the new control process does not cancel remote compute jobs.

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
