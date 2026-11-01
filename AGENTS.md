# Starport Next — Agent entrypoint

Read [README.md](README.md), [CONTEXT.md](CONTEXT.md), and [SECURITY.md](SECURITY.md).
The current release includes portable configuration, local QEMU workspaces, and a
Windows/WSL2 control plane with optional WSLg clients. Consult
[ROADMAP.md](docs/ROADMAP.md) before claiming that an adapter is implemented.

- Configuration setup/import: read [the setup skill](skills/starport-setup/SKILL.md).
- Explicit removal: read [the uninstall skill](skills/starport-uninstall/SKILL.md).
- Architecture and user flow: [DESIGN.md](docs/DESIGN.md).
- Official account clients: [NATIVE-CLIENTS.md](docs/NATIVE-CLIENTS.md).
- Runtime acceptance: [ACCEPTANCE.md](docs/ACCEPTANCE.md).
- Local runtime setup and testing: [LOCAL-RUNTIME.md](docs/LOCAL-RUNTIME.md).
- Windows control plane and WSL2 projects: [WINDOWS-HOST.md](docs/WINDOWS-HOST.md).

Keep the operator control plane outside the whole-agent workspace. A native
Desktop adapter must connect to a scoped SSH/SFTP endpoint inside that boundary.
The WSLg adapter runs Linux clients inside the project boundary instead; shared
Windows display/clipboard requires an explicit choice. Keep Chromium's sandbox,
and report account authorization separately from package or SDK verification.
Never fall back to an administrative DSW shell, host tools, host environment,
direct egress, or an unverified runtime to make a compatibility check pass.

Preserve active jobs and existing installations. Network changes require an
owned-resource transaction and a current configuration digest. Lost acknowledgements
require reconciliation, not repeating a mutating cloud operation. A transport
404 is not evidence that an instance was deleted.

Use relative operator paths and secret references in tracked configuration.
Credentials, actual instance identifiers, private addresses and runtime receipts
belong in private profiles. Do not copy a live tools directory into this repository.
Imported trust is always unverified; extensions remain staged and disabled.

The interface and repository documentation default to Simplified Chinese.
Chat input conversion to Traditional Chinese and display conversion to Simplified
Chinese must preserve code, paths, attachments and original transcript bytes.
Do not add semantic message filtering or an extra send-preview workflow.

For changes, run the relevant tests plus `npm run check`. Distinguish offline
tests, actual runtime acceptance, and cold-boot acceptance. Do not publish, migrate
active services, or create paid resources merely because an example says how.
