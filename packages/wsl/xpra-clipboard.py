"""Xpra 3.1 text and opt-in image clipboard policy, shared by the guest and Linux viewer.

Only explicit CLIPBOARD copy/paste is forwarded. Opt-in text-image mode adds
validated PNG/JPEG images. No PRIMARY, file paths, HTML or clipboard history. This is a format boundary,
not a filter on the meaning of copied text.
"""
import re
import io

IMAGES = frozenset(("image/png", "image/jpeg"))
MAX_IMAGE_BYTES = 16 * 1024 * 1024

def formats(mode):
    if mode not in ("text", "text-image"):
        raise ValueError("invalid_clipboard_mode")
    return TEXT | IMAGES if mode == "text-image" else TEXT

def image_payload(dtype, data):
    if not isinstance(data, (bytes, bytearray)) or not 0 < len(data) <= MAX_IMAGE_BYTES:
        return False
    try:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as img:
            if img.format != {"image/png": "PNG", "image/jpeg": "JPEG"}[name(dtype)]:
                return False
            if img.width * img.height > 32000000:
                return False
            img.verify()
        return True
    except Exception:
        return False



TEXT = frozenset(('UTF8_STRING', 'TEXT', 'STRING', 'text/plain',
                  'text/plain;charset=utf-8', 'text/plain;charset=UTF-8'))


def name(value):
    return value.decode('ascii', errors='replace') if isinstance(value, bytes) else value


def targets(values, mode="text"):
    return [v for v in values if name(v) in formats(mode) or name(v) == 'TARGETS']


def text_payload(dtype, dformat, encoding):
    return name(dtype) in TEXT and dformat == 8 and name(encoding) == 'bytes'


def incoming(packet, mode="text"):
    """Reject non-text data even when a peer advertises a misleading target."""
    allowed = formats(mode)
    p = list(packet)
    kind = name(p[0])
    if kind == 'clipboard-token':
        if name(p[1]) != 'CLIPBOARD':
            return None
        if len(p) >= 3:
            p[2] = targets(p[2], mode)
        if len(p) >= 8 and (name(p[3]) not in allowed or ((name(p[3]) in IMAGES or name(p[4]) in IMAGES) and name(p[4]) != name(p[3])) or not ((text_payload(*p[4:7])) or (name(p[4]) in IMAGES and p[5] == 8 and name(p[6]) == 'bytes' and image_payload(p[4], p[7])))):
            p[3:8] = ['', 'STRING', 8, 'bytes', b'']
    elif kind in ('clipboard-request', 'clipboard-contents', 'clipboard-contents-none'):
        if name(p[2]) != 'CLIPBOARD':
            return None
        if kind == 'clipboard-contents':
            if name(p[3]) == 'ATOM' and p[4] == 32 and name(p[5]) == 'atoms':
                p[6] = targets(p[6], mode)
            elif not (text_payload(*p[3:6]) or (name(p[3]) in allowed & IMAGES and p[4] == 8 and name(p[5]) == 'bytes' and image_payload(p[3], p[6]))):
                return ['clipboard-contents-none', p[1], p[2]]
    elif kind == 'clipboard-enable-selections':
        p[1] = [v for v in p[1] if name(v) == 'CLIPBOARD']
    elif kind == 'clipboard-loop-uuids':
        p[1] = {k: v for k, v in p[1].items() if name(k) == 'CLIPBOARD'}
    return p


def configure(mode="text"):
    allowed_formats = formats(mode)
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
    allowed = '|'.join(re.escape(v) for v in sorted(allowed_formats | {'TARGETS'}))
    core.DISCARD_TARGETS = (re.compile('^(?!(?:' + allowed + ')$).*'),)
    core.DISCARD_EXTRA_TARGETS = ()
    base = core.ClipboardProtocolHelperCore
    original_process = base.process_clipboard_packet
    original_wire = base._munge_raw_selection_to_wire
    original_proxies = base.init_proxies

    def process(self, packet):
        value = incoming(packet, mode)
        if value is not None:
            return original_process(self, value)

    def wire(self, target, dtype, dformat, data):
        if name(target) == 'TARGETS' and name(dtype) == 'ATOM' and dformat == 32:
            return original_wire(self, target, dtype, dformat, data)
        if name(target) not in allowed_formats or name(dtype) not in allowed_formats or dformat != 8:
            return None, None
        if (name(target) in IMAGES or name(dtype) in IMAGES) and (name(dtype) != name(target) or not image_payload(dtype, data)):
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
    configure("text-image")
    runpy.run_path('/usr/bin/xpra', run_name='__main__')
