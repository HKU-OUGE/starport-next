"""Bounded PNG-only clipboard receiver inside an explicitly shared WSLg project."""
import base64
import hashlib
import struct
import time

MAX_BYTES = 16 * 1024 * 1024
MAX_PIXELS = 32000000


def validate_png(data):
    if len(data) < 33 or len(data) > MAX_BYTES or data[:16] != b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR':
        raise ValueError('invalid_clipboard_image')
    width, height = struct.unpack('>II', data[16:24])
    if not width or not height or width * height > MAX_PIXELS:
        raise ValueError('clipboard_image_limit')
    return width, height


class ImageTransfer:
    def __init__(self):
        self.reset()

    def reset(self):
        self.id = None
        self.data = bytearray()
        self.bytes = 0
        self.sha = None
        self.deadline = 0

    def accept(self, message):
        import re
        try:
            if message.get('stage') == 'begin':
                self.reset()
                if not isinstance(message.get('id'), str) or not re.fullmatch('[a-f0-9]{24}', message['id']):
                    raise ValueError('invalid_clipboard_transfer')
                if type(message.get('bytes')) is not int or not 33 <= message['bytes'] <= MAX_BYTES or not re.fullmatch('[a-f0-9]{64}', message.get('sha256', '')):
                    raise ValueError('clipboard_image_limit')
                self.id, self.bytes, self.sha = message['id'], message['bytes'], message['sha256']
                self.deadline = time.monotonic() + 30
            else:
                if self.id is None or message.get('id') != self.id or time.monotonic() > self.deadline:
                    raise ValueError('clipboard_transfer_expired')
                if message.get('stage') == 'chunk':
                    value = message.get('data')
                    if not isinstance(value, str) or len(value) > 21848 or message.get('offset') != len(self.data):
                        raise ValueError('invalid_clipboard_chunk')
                    decoded = base64.b64decode(value, validate=True)
                    if len(self.data) + len(decoded) > self.bytes:
                        raise ValueError('clipboard_image_limit')
                    self.data.extend(decoded)
                elif message.get('stage') == 'end':
                    data = bytes(self.data)
                    if len(data) != self.bytes or hashlib.sha256(data).hexdigest() != self.sha:
                        raise ValueError('clipboard_image_integrity')
                    validate_png(data)
                    self.reset()
                    return data
                else:
                    raise ValueError('invalid_clipboard_transfer')
        except Exception:
            self.reset()
            raise
        return None


def own_clipboard():
    import os
    import sys
    import threading
    if os.environ.get('STARPORT_WSLG_SHARED') != '1' or os.environ.get('STARPORT_REMOTE_DISPLAY') == '1':
        raise ValueError('wslg_authorization_required')
    os.environ['GDK_BACKEND'] = 'x11'
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import Gtk, Gdk, GdkPixbuf, GLib
    initialized, _ = Gtk.init_check([])
    if not initialized:
        raise ValueError('clipboard_display_unavailable')
    clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    def apply(data):
        try:
            validate_png(data)
            loader = GdkPixbuf.PixbufLoader.new_with_type('png')
            loader.write(data)
            loader.close()
            pixbuf = loader.get_pixbuf()
            if pixbuf.get_width() * pixbuf.get_height() > MAX_PIXELS:
                raise ValueError('clipboard_image_limit')
            clipboard.set_image(pixbuf)
            print('applied', flush=True)
        except Exception:
            print('rejected', flush=True)
        return False
    def read_exact(size):
        data = bytearray()
        while len(data) < size:
            part = sys.stdin.buffer.read(size-len(data))
            if not part:
                raise EOFError()
            data.extend(part)
        return bytes(data)
    def reader():
        try:
            while True:
                size = struct.unpack('>I', read_exact(4))[0]
                if not 33 <= size <= MAX_BYTES:
                    break
                data = read_exact(size)
                validate_png(data)
                GLib.idle_add(apply, data)
        except (EOFError, ValueError):
            pass
        finally:
            GLib.idle_add(Gtk.main_quit)
    print('ready', flush=True)
    threading.Thread(target=reader, daemon=True).start()
    Gtk.main()


if __name__ == '__main__':
    own_clipboard()
