const finite = value => typeof value === 'number' && Number.isFinite(value);

// A pure admission decision, not a cloud operation or a background reconciler.
export function readiness(observation, { now, generation, paused = false, ttlSeconds = 120 } = {}) {
  if (!finite(now) || !finite(observation?.checkedAt) || !finite(ttlSeconds) || ttlSeconds <= 0 ||
      now < observation.checkedAt || now - observation.checkedAt > ttlSeconds) return { ready: false, reason: 'stale' };
  if (typeof generation !== 'string' || !generation.trim() || observation.generation !== generation)
    return { ready: false, reason: 'configuration_changed' };
  if (paused) return { ready: false, reason: 'admission_paused' };
  if (observation.cloudState !== 'running') return { ready: false, reason: observation.cloudState === 'stopped' ? 'node_stopped' : 'cloud_not_ready' };
  for (const [key, reason] of [['ssh','ssh_unavailable'],['runtime','runtime_unavailable'],['isolation','isolation_unverified'],['egress','egress_unavailable'],['capacity','capacity_unverified']]) {
    if (observation[key] !== true) return { ready: false, reason };
  }
  return { ready: true, reason: null };
}

export function resumeDecision(observation, { authorized = false, now, ttlSeconds = 120 } = {}) {
  if (!finite(now) || !finite(observation?.checkedAt) || !finite(ttlSeconds) || ttlSeconds <= 0 || now < observation.checkedAt || now - observation.checkedAt > ttlSeconds)
    return { action: 'inspect', reason: 'stale' };
  if (observation.cloudState !== 'stopped') return { action: 'none', reason: 'not_stopped' };
  if (observation.stopReason !== 'inactivity') return { action: 'inspect', reason: 'stop_reason_unconfirmed' };
  if (!authorized) return { action: 'ask', reason: 'start_not_authorized' };
  if (observation.startOperation) return { action: 'reconcile', reason: 'operation_already_recorded' };
  return { action: 'start-once', reason: 'confirmed_idle_stop' };
}
