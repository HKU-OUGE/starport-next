import path from 'node:path';

export class ConfigError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const fail = code => { throw new ConfigError(code); };
export const clone = value => structuredClone(value);
export function object(value, keys, code = 'invalid_configuration') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) fail(code);
}
export const id = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
export const reference = value => typeof value === 'string' && /^secret:\/\/[a-z][a-z0-9-]{0,95}$/.test(value);
export function relative(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 &&
    !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) &&
    !/[\\:\x00-\x1f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}
const integer = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const array = (v, max) => Array.isArray(v) && v.length <= max;
function unique(rows, key) {
  if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) fail('invalid_configuration');
  if (new Set(rows.map(row => row[key])).size !== rows.length) fail('duplicate_identifier');
}

export function defaultConfig(topology = 'desktop-dsw') {
  return {
    format: 'starport-config', version: 1, topology,
    ui: { language: 'zh-CN', advancedCollapsed: true },
    paths: { state: 'state', cache: 'cache', exports: 'exports' },
    engine: { kind: 'claude-agent-sdk', providerRef: 'secret://model-provider', model: 'select-at-setup', effort: 'high' },
    network: {
      mode: 'required', failClosed: true, directFallback: false,
      policyOwner: 'control', subscriptionRefs: [], selectionRef: null,
      denyHostNetwork: true, dns: 'via-egress', ipv6: 'blocked', udp: 'blocked'
    },
    nodes: [], dependencies: [],
    access: { kind: 'local', policyRef: null, credentialRef: null },
    execution: { scope: 'whole-agent', hostShell: false, hostMounts: false, importHostEnv: false },
    lifecycle: { resumeIdleStopped: 'ask', autoStart: 'ask' },
    extensions: { stagedRef: null, enableAfterReview: false }
  };
}

export function validateConfig(input) {
  object(input, ['format','version','topology','ui','paths','engine','network','nodes','dependencies','access','execution','lifecycle','extensions','workspace','computePolicy','computePolicies','defaultComputeNode']);
  if (input.format !== 'starport-config' || input.version !== 1) fail('unsupported_configuration');
  if (!['desktop-dsw','single-machine','server-hosted'].includes(input.topology)) fail('invalid_topology');
  object(input.ui, ['language','advancedCollapsed']);
  if (input.ui.language !== 'zh-CN' || typeof input.ui.advancedCollapsed !== 'boolean') fail('invalid_ui');
  object(input.paths, ['state','cache','exports']);
  if (!['state','cache','exports'].every(key => relative(input.paths[key]))) fail('relative_paths_required');
  const paths = Object.values(input.paths);
  if (paths.some((a, i) => paths.some((b, j) => i !== j && (a === b || a.startsWith(b + '/'))))) fail('overlapping_profile_paths');
  object(input.engine, ['kind','providerRef','model','effort']);
  if (!['claude-agent-sdk','claude-code'].includes(input.engine.kind) || !reference(input.engine.providerRef) ||
      typeof input.engine.model !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(input.engine.model) ||
      !['off','minimal','low','medium','high','xhigh','max'].includes(input.engine.effort)) fail('invalid_engine');
  const n = input.network;
  object(n, ['mode','failClosed','directFallback','policyOwner','subscriptionRefs','selectionRef','denyHostNetwork','dns','ipv6','udp']);
  if (n.mode !== 'required' || n.failClosed !== true || n.directFallback !== false || n.policyOwner !== 'control' ||
      n.denyHostNetwork !== true || n.dns !== 'via-egress' || n.ipv6 !== 'blocked' || n.udp !== 'blocked') fail('network_boundary_weakened');
  if (!array(n.subscriptionRefs, 32) || !n.subscriptionRefs.every(reference) ||
      new Set(n.subscriptionRefs).size !== n.subscriptionRefs.length ||
      !(n.selectionRef === null || reference(n.selectionRef))) fail('invalid_subscription_references');
  const e = input.execution;
  object(e, ['scope','hostShell','hostMounts','importHostEnv']);
  if (e.scope !== 'whole-agent' || e.hostShell !== false || e.hostMounts !== false || e.importHostEnv !== false) fail('execution_boundary_weakened');
  if (!array(input.nodes, 32)) fail('invalid_nodes');
  unique(input.nodes, 'id');
  for (const node of input.nodes) {
    object(node, ['id','name','transport','connectionRef','runtime','budget']);
    if(node.name!==undefined&&(typeof node.name!=='string'||!node.name.trim()||node.name.length>64||/[\x00-\x1f]/.test(node.name)))fail('invalid_node');
    if (!id(node.id) || !['dsw','ssh','local'].includes(node.transport) ||
        !(node.transport === 'local' ? node.connectionRef === null : reference(node.connectionRef)) ||
        !['linux-gvisor','local-microvm'].includes(node.runtime) ||
        (node.transport === 'local') !== (node.runtime === 'local-microvm')) fail('invalid_node');
    object(node.budget, ['cpus','memoryGiB','gpus']);
    if (!integer(node.budget.cpus, 1, 512) || !integer(node.budget.memoryGiB, 2, 4096) ||
        !array(node.budget.gpus, 64) || !node.budget.gpus.every(x => integer(x, 0, 63)) ||
        new Set(node.budget.gpus).size !== node.budget.gpus.length) fail('invalid_resource_budget');
  }
  if (!array(input.dependencies, 128)) fail('invalid_dependencies');
  unique(input.dependencies, 'id');
  for (const dep of input.dependencies) {
    object(dep, ['id','release','mount','readonly']);
    if (!id(dep.id) || !/^[a-zA-Z0-9._-]{1,80}$/.test(dep.release) ||
        !['dependencies','datasets','assets'].includes(dep.mount) || dep.readonly !== true) fail('invalid_dependency_release');
  }
  object(input.access, ['kind','policyRef','credentialRef']);
  if (!['local','cloudflare'].includes(input.access.kind) ||
      (input.access.kind === 'local' ? input.access.policyRef !== null || input.access.credentialRef !== null :
        !reference(input.access.policyRef) || !reference(input.access.credentialRef))) fail('invalid_access');
  object(input.lifecycle, ['resumeIdleStopped','autoStart']);
  if (!['ask','never'].includes(input.lifecycle.resumeIdleStopped) || !['ask','disabled'].includes(input.lifecycle.autoStart)) fail('invalid_lifecycle');
  object(input.extensions, ['stagedRef','enableAfterReview']);
  if (!(input.extensions.stagedRef === null || reference(input.extensions.stagedRef)) || input.extensions.enableAfterReview !== false) fail('invalid_extensions');
  if(input.workspace!==undefined){
    object(input.workspace,['kind','wslg']);
    if(input.workspace.kind!=='wsl2'||typeof input.workspace.wslg!=='boolean')fail('invalid_workspace_preferences');
  }
  function computePolicy(p){
    object(p,['cpus','memoryGiB','gpus','timeout','parallel']);
    if(!integer(p.cpus,1,512)||!integer(p.memoryGiB,2,4096)||!integer(p.gpus,0,64)||!integer(p.timeout,1,86400)||!(p.parallel===null||integer(p.parallel,1,1024)))fail('invalid_compute_policy');
  }
  if(input.computePolicy!==undefined)computePolicy(input.computePolicy);
  if(input.computePolicies!==undefined){
    object(input.computePolicies,input.nodes.map(n=>n.id));
    for(const p of Object.values(input.computePolicies))computePolicy(p);
  }
  if(input.defaultComputeNode!==undefined&&input.defaultComputeNode!==null&&!input.nodes.some(n=>n.id===input.defaultComputeNode))fail('invalid_default_compute_node');
  return clone(input);
}

export function secretRefs(config) {
  validateConfig(config);
  return [...new Set([
    config.engine.providerRef, ...config.network.subscriptionRefs, config.network.selectionRef,
    ...config.nodes.map(n => n.connectionRef), config.access.policyRef,
    config.access.credentialRef, config.extensions.stagedRef
  ].filter(Boolean))];
}

export function summary(config, privateValues = {}, source = 'starport') {
  validateConfig(config);
  const refs = secretRefs(config);
  return {
    source, topology: config.topology, engine: config.engine.kind,
    nodes: config.nodes.map(n => ({ id: n.id, transport: n.transport, runtime: n.runtime, budget: n.budget })),
    subscriptionCount: config.network.subscriptionRefs.length,
    dependencyCount: config.dependencies.length, access: config.access.kind,
    includedSecretCount: refs.filter(r => Object.hasOwn(privateValues, r)).length,
    missingSecretRefs: refs.filter(r => !Object.hasOwn(privateValues, r)),
    requiresVerification: true, willStartServices: false, willContactServers: false
  };
}
