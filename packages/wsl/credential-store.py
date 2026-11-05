"""A first-launch choice for this project, never the host keyring."""
import json
import os
from pathlib import Path


def select_store(home, requested='keyring'):
    if requested not in ('keyring', 'basic'):
        raise ValueError('invalid_credential_storage')
    home = Path(home)
    directory = home / '.local/state/starport'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    file = directory / 'credential-storage.json'
    if file.is_symlink():
        raise ValueError('credential_storage_symlink')
    if file.exists():
        value = json.loads(file.read_text())
        if value.get('mode') not in ('keyring', 'basic'):
            raise ValueError('invalid_credential_storage')
        return value['mode']
    # Existing login profiles are never silently migrated or downgraded.
    existing = any((home / name).exists() for name in
                   ('.config/starport-browser', '.config/Claude', '.local/share/keyrings'))
    mode = 'keyring' if existing else requested
    with file.open('x', encoding='utf8') as out:
        os.chmod(file, 0o600)
        json.dump({'mode': mode, 'version': 1}, out)
    return mode
