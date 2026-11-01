// Adapted from Starport Pi's bounded stdio bridge. MIT, Starport contributors.
import net from 'node:net';
import { error } from '../runtime/common.mjs';

// Only the trusted child can choose one of these channel names, never a host or port.
export function pipeBridge(child, destinations, { onEvent = () => {}, onChannel = () => undefined } = {}) {
  const peers = new Map(); let pending = '', closed = false;
  const send = frame => {
    if (closed) return;
    if (child.stdin.writableLength > 4 * 1024 * 1024) return close();
    if (!child.stdin.write(JSON.stringify(frame) + '\n')) for (const p of peers.values()) p.pause();
  };
  const close = () => {
    if (closed) return; closed = true;
    for (const p of peers.values()) p.destroy(); peers.clear();
    child.stdin.end(); onEvent({ type: 'disconnected' });
  };
  child.stdin.on('error', close);
  child.stdin.on('drain', () => { for (const p of peers.values()) p.resume(); });
  child.on('error', close); child.on('close', close); child.stderr.resume();
  child.stdout.on('data', block => {
    pending += block.toString('utf8');
    if (pending.length > 1024 * 1024) return close();
    let at;
    while ((at = pending.indexOf('\n')) >= 0 && !closed) {
      const line = pending.slice(0, at); pending = pending.slice(at + 1);
      try {
        if (line.length > 32768) throw error('frame_limit');
        const f = JSON.parse(line);
        if (['ready','exit','output','failure'].includes(f.type)) { onEvent(f); continue; }
        if (!Number.isSafeInteger(f.id) || f.id < 1) throw error('invalid_channel');
        if (f.type === 'open') {
          const port = destinations[f.channel];
          if (peers.has(f.id) || peers.size >= 48) throw error('channel_not_allowed');
          const p = Number.isInteger(port) ? net.connect({ host: '127.0.0.1', port }) : onChannel(f.channel);
          if (!p) throw error('channel_not_allowed');
          peers.set(f.id, p);
          p.setTimeout?.(120000, () => p.destroy());
          p.on('error', () => p.destroy());
          p.on('data', data => { for (let i = 0; i < data.length; i += 16384) send({ type: 'data', id: f.id, data: data.subarray(i, i + 16384).toString('base64') }); });
          p.on('close', () => { peers.delete(f.id); send({ type: 'close', id: f.id }); });
        } else if (f.type === 'close') peers.get(f.id)?.destroy();
        else if (f.type === 'data') {
          if (typeof f.data !== 'string' || f.data.length > 21848 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.data)) throw error('invalid_data');
          const p = peers.get(f.id); if (p) { if (p.writableLength > 1024 * 1024) p.destroy(); else p.write(Buffer.from(f.data, 'base64')); }
        } else throw error('unknown_frame');
      } catch { close(); }
    }
  });
  return { send, close };
}
