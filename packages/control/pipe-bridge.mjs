// Adapted from Starport Pi's bounded stdio bridge. MIT, Starport contributors.
import net from 'node:net';
import { error } from '../runtime/common.mjs';

// Only the trusted child can choose one of these channel names, never a host or port.
export function pipeBridge(child, destinations, { onEvent = () => {}, onChannel = () => undefined } = {}) {
  const peers = new Map(); let pending = '', closed = false;
  const closePeer = (id, notify = true) => {
    const p = peers.get(id);
    if (!p) return;
    // Free capacity synchronously: socket.close is emitted on a later turn.
    peers.delete(id); p.destroy();
    if (notify) send({ type: 'close', id });
  };
  const send = frame => {
    if (closed) return;
    if (frame.type === 'data' && child.stdin.writableLength > 4 * 1024 * 1024) {
      closePeer(frame.id); return;
    }
    // Reserve bounded space for control/close frames when a data peer is slow.
    if (child.stdin.writableLength > 5 * 1024 * 1024) return close();
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
          if (!['proxy','model','compute','viewer'].includes(f.channel) || peers.has(f.id)) throw error('channel_not_allowed');
          // Capacity and a detached viewer are normal channel failures, not an
          // instruction to end every application in the native namespace.
          if (peers.size >= 48) { send({ type: 'close', id: f.id }); continue; }
          const p = Number.isInteger(port) ? net.connect({ host: '127.0.0.1', port }) : onChannel(f.channel);
          if (!p) { send({ type: 'close', id: f.id }); continue; }
          peers.set(f.id, p);
          p.setTimeout?.(120000, () => p.destroy());
          p.on('error', () => p.destroy());
          p.on('data', data => { for (let i = 0; i < data.length; i += 16384) send({ type: 'data', id: f.id, data: data.subarray(i, i + 16384).toString('base64') }); });
          p.on('close', () => { if (peers.get(f.id) === p) { peers.delete(f.id); send({ type: 'close', id: f.id }); } });
        } else if (f.type === 'close') closePeer(f.id, false);
        else if (f.type === 'data') {
          if (typeof f.data !== 'string' || f.data.length > 21848 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.data)) throw error('invalid_data');
          const p = peers.get(f.id); if (p) { if (p.writableLength > 1024 * 1024) closePeer(f.id); else p.write(Buffer.from(f.data, 'base64')); }
        } else throw error('unknown_frame');
      } catch { close(); }
    }
  });
  return { send, close };
}
