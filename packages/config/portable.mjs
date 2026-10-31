import { decrypt, MAX_BYTES } from './crypto.mjs';
import { clone, defaultConfig, fail, id, object, reference, secretRefs, summary, validateConfig } from './model.mjs';

const text = (v, limit = 65536) => typeof v === 'string' && v.length > 0 && v.length <= limit && !v.includes('\0');
const https = v => {
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && v.length <= 8192; }
  catch { return false; }
};
function safeTree(v, depth = 0) {
  if (depth > 16) fail('profile_too_deep');
  if (v && typeof v === 'object') {
    for (const [k, child] of Object.entries(v)) {
      if (['__proto__','prototype','constructor'].includes(k)) fail('unsafe_profile_key');
      safeTree(child, depth + 1);
    }
  }
}
function privateKey(value) {
  if (value !== undefined && (!text(value) || !/^-----BEGIN (?:OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(value.trim()))) fail('invalid_private_key_material');
}
function node(value) {
  object(value, ['name','type','server','port','cipher','password','uuid','alterId','tls','servername','sni','alpn','client-fingerprint','network','flow','reality-opts','ws-opts','grpc-opts','plugin','plugin-opts','udp']);
  if (!['ss','vmess','vless','trojan'].includes(value.type) || !text(value.server, 253) ||
      !/^[-a-zA-Z0-9.:[\]]+$/.test(value.server) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      !['tcp','ws','grpc'].includes(value.network || 'tcp') || value.udp === true) fail('invalid_proxy_node');
  const out = clone(value); out.udp = false; return out;
}

export function validatePrivate(config, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) fail('invalid_private_values');
  safeTree(values);
  const allowed = new Set(secretRefs(config));
  const normalized = {};
  for (const [ref, value] of Object.entries(values)) {
    if (!allowed.has(ref) || !reference(ref)) fail('unreferenced_private_value');
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_private_value');
    const v = clone(value);
    if (ref === config.engine.providerRef) {
      object(v, ['kind','provider','endpoint','token']);
      if (v.kind !== 'model-provider' || !['anthropic-api','compatible-gateway'].includes(v.provider) ||
          !https(v.endpoint) || (v.token !== undefined && !text(v.token, 16384))) fail('invalid_model_provider');
    } else if (config.network.subscriptionRefs.includes(ref)) {
      object(v, ['kind','url','nodes','hosts']);
      if (v.kind !== 'subscription' || (v.url !== undefined && v.url !== null && !https(v.url)) ||
          !Array.isArray(v.nodes) || v.nodes.length > 2000 || (!v.nodes.length && !v.url)) fail('invalid_subscription');
      v.nodes = v.nodes.map(node);
      if (v.hosts !== undefined) {
        if (!v.hosts || typeof v.hosts !== 'object' || Array.isArray(v.hosts) || Object.keys(v.hosts).length > 5000 ||
            Object.entries(v.hosts).some(([a,b]) => !/^[a-zA-Z0-9.-]{1,253}$/.test(a) || typeof b !== 'string' || !/^[-a-zA-Z0-9.:[\]]{1,253}$/.test(b))) fail('invalid_endpoint_aliases');
      }
    } else if (ref === config.network.selectionRef) {
      object(v, ['kind','candidates']);
      if (v.kind !== 'node-selection' || !Array.isArray(v.candidates) || !v.candidates.length || v.candidates.length > 8) fail('invalid_node_selection');
      for (const c of v.candidates) {
        object(c, ['subscriptionRef','nodeIndex']);
        if (!config.network.subscriptionRefs.includes(c.subscriptionRef) || !Number.isInteger(c.nodeIndex) || c.nodeIndex < 0) fail('invalid_node_selection');
        const sub = values[c.subscriptionRef];
        if (!sub || !Array.isArray(sub.nodes) || !sub.nodes[c.nodeIndex]) fail('selected_node_missing');
      }
    } else if (config.nodes.some(n => n.connectionRef === ref)) {
      const n = config.nodes.find(n => n.connectionRef === ref);
      if (n.transport === 'dsw') {
        object(v, ['kind','instanceId','region','user','privateKey','credentials']);
        if (v.kind !== 'dsw-connection' || !/^dsw-[a-z0-9]{12,64}$/.test(v.instanceId || '') ||
            !/^[a-z][a-z0-9-]{1,40}$/.test(v.region || '') || !/^[a-z_][a-z0-9_-]{0,63}$/i.test(v.user || '')) fail('invalid_dsw_identity');
        if (v.credentials !== undefined) {
          object(v.credentials, ['accessKeyId','accessKeySecret','securityToken']);
          if (!text(v.credentials.accessKeyId, 256) || !text(v.credentials.accessKeySecret, 1024) ||
              (v.credentials.securityToken !== undefined && !text(v.credentials.securityToken, 16384))) fail('invalid_cloud_credential');
        }
      } else {
        object(v, ['kind','host','port','privateKey']);
        if (v.kind !== 'ssh-connection' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,252}$/.test(v.host || '') ||
            !Number.isInteger(v.port) || v.port < 1 || v.port > 65535) fail('invalid_ssh_connection');
      }
      privateKey(v.privateKey);
    } else if (ref === config.access.policyRef) {
      object(v, ['kind','zone','prefix','allowedEmails']);
      if (v.kind !== 'access-policy' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(v.zone || '') ||
          !/^[a-z0-9](?:[a-z0-9-]{0,34}[a-z0-9])?$/.test(v.prefix || '') ||
          !Array.isArray(v.allowedEmails) || !v.allowedEmails.length || v.allowedEmails.length > 100 ||
          v.allowedEmails.some(e => !text(e, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) fail('invalid_access_policy');
    } else if (ref === config.access.credentialRef) {
      object(v, ['kind','apiToken']);
      if (v.kind !== 'cloudflare-credential' || !text(v.apiToken, 16384)) fail('invalid_access_credential');
    } else if (ref === config.extensions.stagedRef) {
      object(v, ['kind','skills','mcp','plugins']);
      if (v.kind !== 'staged-addons') fail('invalid_addon_bundle');
      for (const key of ['skills','mcp','plugins']) {
        if (!Array.isArray(v[key]) || v[key].length > 200) fail('invalid_addon_bundle');
        v[key] = v[key].map(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) fail('invalid_addon_bundle');
          return { ...item, enabled: false };
        });
      }
    } else fail('invalid_private_reference');
    normalized[ref] = v;
  }
  return normalized;
}

export function bundle(config, privateValues = {}, { includeSecrets = false } = {}) {
  const clean = validateConfig(config);
  const values = validatePrivate(clean, privateValues);
  return { format: 'starport-profile', version: 1, createdAt: new Date().toISOString(),
    includesSecrets: Boolean(includeSecrets), config: clean, privateValues: includeSecrets ? values : {} };
}

function migratePi(b) {
  if (b.version !== 1 || !Array.isArray(b.servers) || b.servers.length > 32 ||
      !Array.isArray(b.network?.subscriptions) || b.network.subscriptions.length > 32) fail('invalid_pi_profile');
  const config = defaultConfig(); const values = {}; const warnings = ['reverify_all_connections','reenroll_cloudflare','review_addons_before_enable'];
  if (b.preferences?.model) config.engine.model = b.preferences.model;
  if (b.preferences?.effort) config.engine.effort = b.preferences.effort;
  if (b.anthropicApiKey) values[config.engine.providerRef] = {
    kind: 'model-provider', provider: 'anthropic-api', endpoint: 'https://api.anthropic.com', token: b.anthropicApiKey
  };
  for (const s of b.servers) {
    if (!id(s.name) || !['ssh','dsw'].includes(s.mode)) fail('invalid_pi_server');
    const ref = 'secret://connection-' + s.name;
    const budget = s.budget || { cpus: 4, memoryGiB: 8, gpus: [] };
    config.nodes.push({ id: s.name, transport: s.mode, connectionRef: ref, runtime: 'linux-gvisor', budget: {
      cpus: budget.cpus, memoryGiB: budget.memoryGiB, gpus: clone(budget.gpus)
    } });
    const connection = s.mode === 'dsw' ? {
      kind: 'dsw-connection', instanceId: s.instanceId, region: s.region, user: s.user || 'root'
    } : { kind: 'ssh-connection', host: s.host, port: s.port || 22 };
    if (s.privateKey) connection.privateKey = s.privateKey;
    if (s.credentials) {
      connection.credentials = { accessKeyId: s.credentials.accesskeyid, accessKeySecret: s.credentials.accesskeysecret,
        ...(s.credentials.ststoken ? { securityToken: s.credentials.ststoken } : {}) };
    }
    values[ref] = connection;
  }
  for (const s of b.network.subscriptions) {
    if (!id(s.id)) fail('invalid_pi_subscription');
    const ref = 'secret://subscription-' + s.id;
    config.network.subscriptionRefs.push(ref);
    if (s.nodes || s.url) values[ref] = { kind: 'subscription', nodes: clone(s.nodes || []), hosts: clone(s.hosts || {}), url: s.url || null };
  }
  if (b.network.selected) {
    const m = /^([a-z][a-z0-9-]{0,63}):(\d+)$/.exec(b.network.selected);
    if (!m) fail('invalid_pi_selection');
    const ref = 'secret://subscription-' + m[1];
    if (values[ref]?.nodes[Number(m[2])]) {
      config.network.selectionRef = 'secret://node-selection';
      values[config.network.selectionRef] = { kind: 'node-selection', candidates: [{ subscriptionRef: ref, nodeIndex: Number(m[2]) }] };
    } else warnings.push('node_selection_requires_credentials');
  }
  if (b.cloudflare) {
    config.access = { kind: 'cloudflare', policyRef: 'secret://access-policy', credentialRef: 'secret://cloudflare-token' };
    values[config.access.policyRef] = { kind: 'access-policy', zone: b.cloudflare.zone, prefix: b.cloudflare.prefix || 'console', allowedEmails: clone(b.cloudflare.allowedEmails) };
    if (b.cloudflare.apiToken) values[config.access.credentialRef] = { kind: 'cloudflare-credential', apiToken: b.cloudflare.apiToken };
  }
  if (b.addons) {
    config.extensions.stagedRef = 'secret://staged-addons';
    values[config.extensions.stagedRef] = { kind: 'staged-addons', skills: clone(b.addons.skills || []), mcp: clone(b.addons.mcp || []), plugins: clone(b.addons.plugins || []) };
  }
  if (b.localRuntime?.requested) warnings.push('local_runtime_not_imported_requires_new_acceptance');
  warnings.push('host_paths_trust_tokens_processes_not_imported');
  validateConfig(config);
  return { config, privateValues: validatePrivate(config, values), source: 'starport-pi-v1', warnings };
}

export async function decodeBundle(value, password) {
  if (!value || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES * 2) fail('invalid_profile');
  let encrypted = false;
  if (['starport-profile-encrypted','starport-pi-profile-encrypted'].includes(value.format)) {
    value = await decrypt(value, password); encrypted = true;
  }
  safeTree(value);
  let result;
  if (value.format === 'starport-pi-profile') result = migratePi(value);
  else {
    object(value, ['format','version','createdAt','includesSecrets','config','privateValues'], 'invalid_profile');
    if (value.format !== 'starport-profile' || value.version !== 1 || typeof value.includesSecrets !== 'boolean') fail('unsupported_profile');
    const config = validateConfig(value.config);
    result = { config, privateValues: validatePrivate(config, value.privateValues), source: 'starport-v1', warnings: [] };
  }
  // Pi configuration-only exports still contain connection identities, but no tokens.
  const sensitive = value.includesSecrets || value.anthropicApiKey || value.cloudflare?.apiToken ||
    value.servers?.some(s => s.privateKey || s.credentials) || value.network?.subscriptions?.some(s => s.nodes?.length || s.url) ||
    (value.format === 'starport-pi-profile' && ['skills','mcp','plugins'].some(k => value.addons?.[k]?.length)) ||
    (value.format === 'starport-profile' && Object.keys(result.privateValues).length);
  if (sensitive && !encrypted) fail('encrypted_profile_required');
  return result;
}

export function preview(decoded) {
  return { ...summary(decoded.config, decoded.privateValues, decoded.source), warnings: decoded.warnings };
}
