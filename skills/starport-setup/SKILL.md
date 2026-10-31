---
name: starport-setup
description: Set up or import a Starport Next profile and plan its controlled workspace deployment. Use inside this repository; do not apply these steps to an existing Mac tool installation.
---

# Starport Next setup

Read [the current delivery status](../../docs/ROADMAP.md) first. Local workspaces use
[the QEMU runtime guide](../../docs/LOCAL-RUNTIME.md). Do not claim to have published
an ingress or verified isolation when only a profile was imported.

For the Windows-hosted control-plane route, use [WINDOWS-HOST.md](../../docs/WINDOWS-HOST.md):
`setup-control.ps1`, `setup-wsl.ps1`, then `start-control.ps1`. Preserve existing
WSL distributions and global settings. Model processes must use the inner project
boundary, never the distribution's administrative shell. Keep Windows credentials
out of WSL and set zh_TW.UTF-8 / Asia/Taipei inside the workspace. Do not present
Linux pipe tests as Windows boot, WSLg, or official-account acceptance.

1. Determine whether the user wants one computer, a computer plus an existing
   server, or a server-hosted control plane. Preserve existing deployments.
2. Check Node.js 22+. Use `scripts/setup.ps1` on Windows or `scripts/setup.sh` on
   Linux/macOS to create the default profile, or choose a fresh destination with
   `node bin/starport.mjs init`. Do not replace the process PATH or overwrite a
   profile to work around installation errors.
3. For an existing Pi export, run `config preview`, then `config import`; the
   password goes through the hidden prompt or a private password file, never the
   chat. Use [CONFIGURATION.md](../../docs/CONFIGURATION.md) for the exact commands.
4. Run `validate` and `plan`. Report missing references, unimplemented adapters,
   and target-machine checks separately. Do not contact servers simply to preview.
5. For a local test, run `local doctor`, prepare a dedicated state directory with
   adequate disk and memory, configure an owned egress, then start and verify the
   workspace before `local bootstrap` and a small SDK task. Use a synthetic project;
   do not mount the operator HOME. A temporary acceptance directory is not a
   persistent daily workspace. Windows/macOS need their own actual boot acceptance.
   For other runtime adapters, follow the four
   stages in [DESIGN.md](../../docs/DESIGN.md), using the exact checks from
   [ACCEPTANCE.md](../../docs/ACCEPTANCE.md). Reconcile unknown cloud results before
   retrying. Never bypass host-key checking, isolation, or a closed egress.
6. For subscription-account clients, follow [NATIVE-CLIENTS.md](../../docs/NATIVE-CLIENTS.md).
   Install the official CLI, Desktop, and login browser inside the verified guest.
   Use native mode without an API Key gateway. Never open the operator browser for
   authentication or copy an existing client token into the Agent SDK. Keep account
   authorization pending until the user completes the official login; installation
   alone does not validate an account session.
7. Before registering a usable deployment, ask whether it should start after the
   current user logs in, unless the current session already contains that choice.
   The current local adapter cannot register login startup; do not ask for a startup preference
   as though registration had been implemented. Login startup and boot-before-login
   are different capabilities.

Keep configuration secrets on the control side. Do not copy deployment credentials
or actual host identities into this repository or the agent workspace. Normal
messages need no extra semantic filter or send preview.
