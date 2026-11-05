"""Xpra 3.1 plain-text clipboard policy, shared by the guest and Linux viewer.

Only explicit CLIPBOARD copy/paste is forwarded. No PRIMARY selection, files,
images, HTML, clipboard history, or text rewriting. This is a format boundary,
not a filter on the meaning of copied text.
"""
import re


TEXT = frozenset(('UTF8_STRING', 'TEXT', 'STRING', 'text/plain',
                  'text/plain;charset=utf-8', 'text/plain;charset=UTF-8'))


def name(value):
    return value.decode('ascii', errors='replace') if isinstance(value, bytes) else value


def targets(values):
    return [v for v in values if name(v) in TEXT or name(v) == 'TARGETS']


def text_payload(dtype, dformat, encoding):
    return name(dtype) in TEXT and dformat == 8 and name(encoding) == 'bytes'


def incoming(packet):
    """Reject non-text data even when a peer advertises a misleading target."""
    p = list(packet)
    kind = name(p[0])
    if kind == 'clipboard-token':
        if name(p[1]) != 'CLIPBOARD':
            return None
        if len(p) >= 3:
            p[2] = targets(p[2])
        if len(p) >= 8 and (name(p[3]) not in TEXT or not text_payload(*p[4:7])):
            p[3:8] = ['', 'STRING', 8, 'bytes', b'']
    elif kind in ('clipboard-request', 'clipboard-contents', 'clipboard-contents-none'):
        if name(p[2]) != 'CLIPBOARD':
            return None
        if kind == 'clipboard-contents':
            if name(p[3]) == 'ATOM' and p[4] == 32 and name(p[5]) == 'atoms':
                p[6] = targets(p[6])
            elif not text_payload(*p[3:6]):
                return ['clipboard-contents-none', p[1], p[2]]
    elif kind == 'clipboard-enable-selections':
        p[1] = [v for v in p[1] if name(v) == 'CLIPBOARD']
    elif kind == 'clipboard-loop-uuids':
        p[1] = {k: v for k, v in p[1].items() if name(k) == 'CLIPBOARD'}
    return p


def configure():
    import xpra
    if not xpra.__version__.startswith('3.1.'):
        raise SystemExit('xpra_version_not_validated')
    import xpra.platform.features as features
    # Apply before the client/server mixins import these values.
    features.CLIPBOARDS = ['CLIPBOARD']
    features.CLIPBOARD_PREFERRED_TARGETS = ['UTF8_STRING', 'text/plain', 'TEXT', 'STRING']
    from xpra.clipboard import clipboard_core as core
    core.CLIPBOARDS = ['CLIPBOARD']
    core.ALL_CLIPBOARDS = [b'CLIPBOARD']
    allowed = '|'.join(re.escape(v) for v in sorted(TEXT | {'TARGETS'}))
    core.DISCARD_TARGETS = (re.compile('^(?!(?:' + allowed + ')$).*'),)
    core.DISCARD_EXTRA_TARGETS = ()
    base = core.ClipboardProtocolHelperCore
    original_process = base.process_clipboard_packet
    original_wire = base._munge_raw_selection_to_wire
    original_proxies = base.init_proxies

    def process(self, packet):
        value = incoming(packet)
        if value is not None:
            return original_process(self, value)

    def wire(self, target, dtype, dformat, data):
        if name(target) == 'TARGETS' and name(dtype) == 'ATOM' and dformat == 32:
            return original_wire(self, target, dtype, dformat, data)
        if name(target) not in TEXT or name(dtype) not in TEXT or dformat != 8:
            return None, None
        return original_wire(self, target, dtype, dformat, data)

    def proxies(self, selections):
        return original_proxies(self, [v for v in selections if name(v) == 'CLIPBOARD'])

    base.process_clipboard_packet = process
    base._munge_raw_selection_to_wire = wire
    base.init_proxies = proxies


if __name__ == '__main__':
    import runpy
    from PIL import Image
    if not hasattr(Image, 'ANTIALIAS'):
        Image.ANTIALIAS = Image.Resampling.LANCZOS
    configure()
    runpy.run_path('/usr/bin/xpra', run_name='__main__')
