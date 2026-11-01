---
name: starport-setup
description: Set up or import a Starport Next profile and plan its controlled workspace deployment. Use inside this repository; do not apply these steps to an existing Mac tool installation.
---

# Starport Next setup

Read [the current delivery status](../../docs/ROADMAP.md) first. Local workspaces use
[the QEMU runtime guide](../../docs/LOCAL-RUNTIME.md). Do not claim to have published
an ingress or verified isolation when only a profile was imported.

For the Windows-hosted control-plane route, use [WINDOWS-HOST.md](../../docs/WINDOWS-HOST.md):
`setup-control.ps1`, `setup-wsl.ps1`, `setup-wsl-clients.ps1` when clients are requested,
then `start-control.ps1`. Preserve existing
WSL distributions and global settings. Model processes must use the inner project
boundary, never the distribution's administrative shell. Keep Windows credentials
out of WSL and set zh_TW.UTF-8 / Asia/Taipei inside the workspace. Do not present
Linux pipe tests as Windows boot, WSLg, or official-account acceptance.
Report the installation, login, and runtime verification of Claude Code, Agent SDK,
Claude Desktop, and the browser separately. A working control panel and verified
WSL workspace do not establish that these clients are installed or configured.
When handing off a local Windows workspace, verify the panel's Explorer button
opens that project's WSL folder. Use the owned distribution receipt and fixed
project path; do not accept arbitrary host paths or launch Explorer from Access.
For an existing owned distribution, finish active jobs and GUI sessions before
`wsl update-runtime`; verify the old runtime digest and reconcile an interrupted
migration. Restart the owned control process and rerun boundary checks afterwards.
Never reuse an old runtime's successful report to authorize a new version.

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
   The QEMU native mode has no API Key gateway. WSL2 may enable the SDK gateway
   with `-Client api`, but its native supervisor must strip all model/API/OAuth
   environment credentials and use a separate account config. Never open the operator browser for
   authentication or copy an existing client token into the Agent SDK. Keep account
   authorization pending until the user completes the official login; installation
   alone does not validate an account session.
   WSLg is disabled by default. If independent windows are requested, explain that
   the display and Windows clipboard are shared and may reveal identity, company,
   location or document contents. Record an explicit choice with `-EnableWslg`
   (or `wslg: true`); an existing choice in the conversation is sufficient.
   Do not claim manual clipboard isolation in this mode, disable Chromium's
   sandbox, or weaken network/filesystem isolation to get a window to launch.
   Let the user create/unlock the private Linux keyring in its own window; never
   request its password in chat or bypass it with a plaintext password store.
   When WSLg is chosen, complete Windows desktop and Start-menu shortcuts before
   handoff. `setup-wsl-clients.ps1 -EnableWslg -ControlState <actual-control-state>`
   registers them; for existing installs use `register-client-shortcuts.ps1` with
   the actual State, Config, Workspace and optional Node plus `-RepairWslShortcuts`.
   Preserve automatic-link backups and the private ownership receipt. Do not use
   `wslg.exe -- <application>` as the project launcher: its distribution-level
   user lacks the project HOME and controlled proxy. Do not create a host HOME,
   change the default user, or add `--no-sandbox` to mask this error.
   Existing installs with `ozone-platform=auto` need `wsl clients-configure --state
   <actual-wsl-state>` while idle, then boundary verification; check Wayland for
   WSLg and X11 for web sessions. Do not reinstall all packages just for this fix.
   Verify browser, Desktop and Claude Code from the installed shortcuts as actual
   Windows windows, plus a controlled HTTPS page after user keyring unlock. A
   short-lived process acknowledgement is not a successful launch. Record account
   login separately. If a web GUI session is active, let the user close its apps
   before switching; never silently terminate it or create another project HOME.
   After explicit API authorization, run one small SDK file task through the
   Windows gateway, verify the artifact and report SDK cost separately from
   official-account login. Keep the real key on Windows and transcripts private.
   The WSL SDK does not set a USD budget ceiling. Report actual model cost; do not
   restore an arbitrary monetary cap after the user has removed it. The current
   eight-turn and 300-second limits are separate from billing and remote compute.
7. For a usable Windows deployment, follow [SERVICES.md](../../docs/SERVICES.md).
   Ask whether it should start after the current user logs in, unless this session
   already contains that choice. With authorization, run `register-startup.ps1`
   with `-Action enable`, then `-Action start`, using this installation's actual
   control state, host config and Node paths. Include `workerComputeFile` when an
   independent worker should be supervised. Verify the owned shortcut, fresh
   supervisor receipt, both process identities and local service health. Repeat
   startup must not duplicate processes. An idle control recovery test must retain
   the compute connection and must not resubmit jobs. Do not restart active work
   for this test. This is current-user login startup, not an SCM service before
   login; distinguish registration, manual launch, actual relogin and cold boot.
   Never register a SYSTEM process against another user's WSL distribution.
8. After a Windows installation finishes and the control service is healthy, open
   the local access-code window using [show-access-code.ps1](../../scripts/show-access-code.ps1)
   with `powershell -NoProfile -STA -ExecutionPolicy Bypass -File scripts/show-access-code.ps1
   -State <actual-control-state>`. It must offer a selectable code and a copy button.
   Use this deployment's actual state directory, including custom external paths;
   do not assume an AppData path. Pass only the state path to the helper, never the
   code itself, and do not put the code in chat, logs, command arguments, or URLs.
   Copy only after the user clicks. This is a control-panel handoff, not confirmation
   that model clients are configured. In a headless session, report that no window
   was displayed and provide the local code-file path and retrieval command.

Keep configuration secrets on the control side. Do not copy deployment credentials
or actual host identities into this repository or the agent workspace. Normal
messages need no extra semantic filter or send preview.

For remote computation, follow [COMPUTE.md](../../docs/COMPUTE.md). Reusing an old
credential does not require keeping its application as a runtime dependency.
Deploy the independent Next worker additively; copy and verify runtime dependencies,
keep old jobs intact, and obtain the intended shared/exclusive GPU allocation.
Validate CPU isolation, one authorized GPU task, artifacts, cancellation and resource
release through the actual project API. Place the project compute client and usage
instructions in the workspace, then separately verify a Claude tool call. Never give
the model a management SSH command or cloud credential. Record unresolved submissions
before retrying and report cross-service scheduling and quota limits accurately.
Keep configured ceilings separate from physical node capacity. `parallel: null`
removes the fixed concurrent-job count, but resource admission remains enforced.

For multiple servers, follow [MULTI-SERVER.md](../../docs/MULTI-SERVER.md). Give every
worker its own connection, local port, token and state; preserve legacy `primary`
when migrating old jobs. Reuse authorized Pi credentials as independent copies,
but verify each new host fingerprint before authenticated SSH. For a fresh server,
use the standalone archive installer described in COMPUTE.md; never install Pi as
a prerequisite. Keep node IDs stable, retain the requested default, and verify one
real job per added machine. Never turn an unknown submission into a retry on another
node. Register each workerComputeFile with the login supervisor and verify per-node
health; do not equate synthetic multi-node tests with multiple live servers.
For external dependency reuse, read [DEPENDENCIES.md](../../docs/DEPENDENCIES.md).
Use the local panel's Dependencies and Data page to select a node, name, kind and
specific directory. Review contents first: every project in this installation can
read published releases. Publication snapshots with reflink or a copy fallback,
hashes content and mounts pinned versions read-only; it does not install packages,
follow live mutable sources or certify Python compatibility. Do not choose a real
source without user direction; an owned empty fixture is sufficient when requested.
Verify compute_resources discovery, exact IDs/digests in mounts, denied writes,
absence of host paths in mountinfo, and disable rejecting new selections while
preserving already submitted jobs. Keep fixture receipts and source paths private.
When the user authorizes automatic Conda reuse, use Auto Reuse Conda on the chosen
node. It reads user registration and known prefixes, never searches other users
or shared disks recursively, and reuses existing publishing/ready registrations.
If none are found, ask for the specific personal prefix; do not claim adoption or
install a replacement environment. Base caches/sub-environments are excluded.
Python/Conda requires an isolated interpreter/import test: external symlinks are
rejected and scripts/binaries may retain prefixes. Do not mount the whole host
system or execute model code in management SSH to make it work. No symlink, alias,
or source-prefix byte scan proves content hides identity. Report empty-folder
acceptance separately from actual environment or real dataset acceptance.

For domain/email settings, follow [REMOTE-ACCESS.md](../../docs/REMOTE-ACCESS.md).
Use the local panel's Remote Access page for an existing Cloudflare application.
Keep Tunnel tokens on the host and never echo them. This page does not provision
cloud resources or update the cloud email policy. Verify local unauthenticated
rejection separately from actual allowed/denied email login through the public
domain. Missing domain, Audience or cloud routing leaves public acceptance pending;
do not invent production values to make that check pass.

For a remote URL covering CLI, Desktop and SDK, use the authenticated web project
desktop described in REMOTE-ACCESS.md. A WSLg launch button alone is not remote
interaction. Existing installs can add `wsl remote-display-install`, then update
the idle runtime, restart only the owned control process and reverify. Preserve
active remote compute jobs. Test pixels, keyboard input, reconnect and denied
unauthenticated WebSocket upgrades. Never expose a host desktop or raw VNC port.
Native account login and SDK API validation remain separate; do not claim all
three authenticated just because their packages or launchers work. Keep the
public URL available for the user's email-login test and record any pending result.
Verify the actual public tab, not only a local viewer: the initial page must show
navigation and a connection state, then the project desktop and keyring if needed.
The control server bundles its first response with the pinned esbuild dependency;
retain platform optional packages during npm install and restart control after web
source changes. If the panel is blank or unstyled, inspect resource loading, CSP
and the public connection before attributing it to keyring or account state.
Connect only one viewer per project. Keep the user's public viewer open and point
to the keyring inside its canvas; do not tell them to find a Windows dialog or
reset the keyring because a remote image was not visible.

WSL native startup merges the scoped compute MCP into project and Desktop config,
and imports `AGENTS.md` from `CLAUDE.md`. Validate both inline-script submission
and artifact retrieval, preserving existing instructions and unrelated MCPs.
Distinguish CLI API acceptance from subscription login and Desktop chat acceptance.
If Chrome remains blank while Unlock Keyring is open, have the user unlock it and
recheck a controlled HTTPS page before changing the network or password store.

For panel configuration transfers, use the existing portable bundle format and
preview before importing to a new profile. Include `workerComputeFile` in the host
configuration when its independent worker should be backed up. Never migrate live
trust, account cookies, access codes or verified state; report that import stages
configuration and does not activate it. Verify encrypted round trips with synthetic
fixtures and verify the template workflow in the real panel without displaying secrets.
