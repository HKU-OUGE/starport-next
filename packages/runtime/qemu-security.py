"""Allow the owned VM's namespace launcher under Ubuntu's userns mediation.

No global sysctl, host policy or browser sandbox is disabled. The bwrap child
still gets private namespaces, a minimal root and the project's seccomp filter.
"""
from pathlib import Path
import subprocess

restrict = Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
if restrict.exists() and restrict.read_text().strip() == '1':
    profile = Path('/etc/apparmor.d/starport-project-bwrap')
    text = 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile starport-project-bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n'
    if profile.is_symlink() or profile.exists() and profile.read_text() != text:
        raise RuntimeError('project_namespace_policy_changed')
    profile.write_text(text)
    profile.chmod(0o644)
    subprocess.run(['/sbin/apparmor_parser', '-r', str(profile)], check=True)
