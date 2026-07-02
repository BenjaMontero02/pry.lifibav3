# -*- mode: python ; coding: utf-8 -*-

import os
import sys

from PyInstaller.utils.hooks import collect_all

datas = []
binaries = []
hiddenimports = []

# insightface and onnxruntime load native binaries and data files through
# dynamic imports that PyInstaller cannot detect statically.
for package_name in ("insightface", "onnxruntime"):
    package_datas, package_binaries, package_hiddenimports = collect_all(package_name)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hiddenimports

# Bundle the buffalo_l models so a packaged (offline) kiosk never needs to
# download them. At runtime, face_index_service._resolve_insightface_root()
# points FaceAnalysis(root=...) to <sys._MEIPASS>/insightface_models, which
# expects the models under <root>/models/buffalo_l.
buffalo_l_models_dir = os.path.expanduser(
    os.path.join("~", ".insightface", "models", "buffalo_l")
)
if os.path.isdir(buffalo_l_models_dir):
    datas.append(
        (buffalo_l_models_dir, os.path.join("insightface_models", "models", "buffalo_l"))
    )
else:
    sys.stderr.write(
        "WARNING: buffalo_l models not found at {path}. They will NOT be bundled, "
        "and the packaged app will try to download them on first use (this fails "
        "offline). Run the app once in development so InsightFace downloads the "
        "models, then rebuild.\n".format(path=buffalo_l_models_dir)
    )

a = Analysis(
    ["python/main.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="python-child",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
)
