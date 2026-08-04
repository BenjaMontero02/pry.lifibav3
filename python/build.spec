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

# Bundle the face models so a packaged (offline) kiosk never needs to
# download them. At runtime, face_index_service._resolve_insightface_root()
# points FaceAnalysis(root=...) to <sys._MEIPASS>/insightface_models, which
# expects the models under <root>/models/<FACE_MODEL_NAME>.
# Keep in sync with FACE_MODEL_NAME in app/services/face_index_service.py.
FACE_MODEL_NAME = "antelopev2"
face_models_dir = os.path.expanduser(
    os.path.join("~", ".insightface", "models", FACE_MODEL_NAME)
)
if os.path.isdir(face_models_dir):
    datas.append(
        (face_models_dir, os.path.join("insightface_models", "models", FACE_MODEL_NAME))
    )
else:
    sys.stderr.write(
        "WARNING: {model} models not found at {path}. They will NOT be bundled, "
        "and the packaged app will try to download them on first use (this fails "
        "offline). Run the app once in development so InsightFace downloads the "
        "models, then rebuild.\n".format(model=FACE_MODEL_NAME, path=face_models_dir)
    )

# AdaFace ONNX (backend de embeddings). Ruta frozen esperada por
# app/services/adaface_service.py: <MEIPASS>/adaface_models/.
adaface_model_path = os.path.join("python", "models", "adaface_ir101_webface12m.onnx")
if os.path.isfile(adaface_model_path):
    datas.append((adaface_model_path, "adaface_models"))
else:
    sys.stderr.write(
        "WARNING: AdaFace ONNX not found at {path}. The packaged app will fall "
        "back to insightface embeddings. Run scripts/convert_adaface_to_onnx.py "
        "first if AdaFace is the intended backend.\n".format(path=adaface_model_path)
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
    excludes=["torch", "torchvision"],
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
