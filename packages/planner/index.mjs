import { validateConfig, summary } from '../config/model.mjs';

export function plan(config, privateValues = {}) {
  validateConfig(config);
  return {
    ...summary(config, privateValues), implementation: 'offline-planner', deploymentReady: false,
    steps: [
      { id: 'egress', title: '验证订阅和受控出口', requires: [], checks: ['endpoint-validation','guard-before-route','https-through-egress','direct-connect-denied','proxy-loss-denied'] },
      { id: 'nodes', title: '核对真实实例和 SSH 指纹', requires: ['egress'], checks: ['instance-identity','host-key','resource-budget','runtime-capabilities'] },
      { id: 'workspace', title: '建立持久项目环境', requires: ['nodes'], checks: ['whole-agent-contained','scoped-ssh-sftp','host-files-denied','host-environment-denied','metadata-denied'] },
      { id: 'dependencies', title: '挂载指定依赖版本', requires: ['workspace'], checks: ['manifest-hash','abi-compatibility','readonly','no-secret-content','addon-layer'] },
      { id: 'session', title: '连接唯一的会话执行者', requires: ['dependencies'], checks: ['single-owner','incremental-events','attachment-roundtrip','browser-disconnect-preserves-job'] },
      ...(config.access.kind === 'cloudflare' ? [{ id: 'access', title: '发布 Access 与 Tunnel 入口', requires: ['session'], checks: ['jwt-signature-audience','allowed-identity','denied-identity','origin-csrf','stream-reconnect'] }] : [])
    ],
    blockers: [config.topology === 'single-machine' ? 'local_prepare_start_and_verify_required' : 'remote_adapters_not_implemented', 'live_acceptance_required'],
    startupRegistration: 'not-requested', cloudMutations: []
  };
}
