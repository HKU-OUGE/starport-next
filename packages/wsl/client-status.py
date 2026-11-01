import json
import os
import pathlib
import shutil
import subprocess

def version(command):
    if not shutil.which(command):
        return None
    try:
        p = subprocess.run([command, '--version'], capture_output=True, text=True, timeout=10)
        return p.stdout.strip().splitlines()[0][:120] if p.returncode == 0 and p.stdout.strip() else None
    except (OSError, subprocess.TimeoutExpired):
        return None

sdk = pathlib.Path('/usr/local/lib/starport/agent/node_modules/@anthropic-ai/claude-agent-sdk/package.json')
def compute_configured(file):
    try:
        value = json.loads(pathlib.Path(file).read_text()).get('mcpServers', {}).get('starport-compute', {})
        return value.get('command') == '/usr/bin/python3' and value.get('args') == ['-I', '/opt/starport/compute-mcp.py']
    except (OSError, ValueError, AttributeError):
        return False

compute = {'claudeCodeConfigured': compute_configured('/workspace/.mcp.json'),
           'desktopConfigured': compute_configured('/home/agent/.config/Claude/claude_desktop_config.json'),
           'guidancePresent': all(pathlib.Path('/workspace', name).is_file() for name in ['AGENTS.md', 'CLAUDE.md', 'STARPORT_COMPUTE.md'])}
auth = {'loggedIn': False, 'authMethod': None}
if shutil.which('claude'):
    env = {k:v for k,v in os.environ.items() if k not in ['ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN']}
    env['CLAUDE_CONFIG_DIR'] = '/home/agent/.claude-account'
    try:
        p = subprocess.run(['claude','auth','status','--json'], capture_output=True, text=True, env=env, timeout=15)
        value = json.loads(p.stdout)
        auth = {'loggedIn':value.get('loggedIn') is True, 'authMethod':value.get('authMethod') if value.get('authMethod') in ['claude.ai','api_key','oauth','claudeai'] else None}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
print(json.dumps({'node':version('node'),'claudeCode':version('claude'),
                  'agentSdk':json.loads(sdk.read_text())['version'] if sdk.is_file() else None,
                  'desktopInstalled':bool(shutil.which('claude-desktop')),
                  'browser':version('google-chrome-stable') or version('firefox'),
                  'account':auth, 'desktopLogin':'requires-user-verification', 'computeMcp':compute}))
