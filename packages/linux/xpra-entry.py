"""Xpra 3.1 adapter: fixed display metadata and explicit ready acknowledgement."""
import sys
import xpra
from PIL import Image
if not hasattr(Image, 'ANTIALIAS'):
    Image.ANTIALIAS = Image.Resampling.LANCZOS
if not xpra.__version__.startswith('3.1.'):
    raise SystemExit('xpra_version_not_validated')
from xpra.platform import init, set_default_name
set_default_name('Starport')
init()
if '--clipboard=yes' in sys.argv:
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location('starport_clipboard', Path(__file__).with_name('xpra-clipboard.py'))
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    import os
    policy.configure(os.environ.get("STARPORT_CLIPBOARD", "text"))
import xpra.scripts.main as entry
original_factory = entry.make_client


def create_client(error_cb, options):
    # Let Xpra apply disabled-feature options BEFORE importing its GUI classes.
    # Patch metadata before init_ui/setup_connection can send any hello packet.
    client = original_factory(error_cb, options)
    import xpra.client.mixins.display as display
    neutral = [('display', 1920, 1080, 508, 286,
                [('monitor', 0, 0, 1920, 1080, 508, 286)], 0, 0, 1920, 1080)]
    client.get_screen_sizes = lambda xscale=1, yscale=1: neutral
    client.get_root_size = lambda: (1920, 1080)
    display.get_number_of_desktops = lambda: 1
    display.get_desktop_names = lambda: ('workspace',)
    display.get_wm_name = lambda: 'Starport'
    display.get_xdpi = display.get_ydpi = lambda: 96
    original_ready = client._process_startup_complete

    def ready(packet):
        original_ready(packet)
        print('STARPORT_VIEWER_READY', flush=True)

    client._process_startup_complete = ready
    handlers = getattr(client, '_ui_packet_handlers', {})
    if 'startup-complete' in handlers:
        handlers['startup-complete'] = ready
    return client


entry.make_client = create_client
raise SystemExit(entry.main(sys.argv[0], sys.argv))
