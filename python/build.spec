# -*- mode: python ; coding: utf-8 -*-

import json
import os

import insightface
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

# ``insightface.data.get_object()`` (lo usa landmark_3d_68 para leer
# meanshape_68.pkl) resuelve su directorio como ``sys._MEIPASS/objects`` cuando
# corre congelado, no como ``insightface/data/objects``, que es donde lo deja
# collect_all. Sin esta copia devuelve None SIN excepcion y el fallo aparece
# recien al procesar caras (AttributeError sobre mean_lmk=None en cada foto).
INSIGHTFACE_OBJECTS_DIR = os.path.join(
    os.path.dirname(insightface.__file__), "data", "objects"
)
insightface_objects = (
    sorted(os.listdir(INSIGHTFACE_OBJECTS_DIR))
    if os.path.isdir(INSIGHTFACE_OBJECTS_DIR)
    else []
)
if not insightface_objects:
    raise SystemExit(
        "build.spec: no hay data objects de insightface en {path}. El bundle "
        "quedaria sin meanshape_68.pkl y cualquier modulo que lo use fallaria "
        "en runtime.".format(path=INSIGHTFACE_OBJECTS_DIR)
    )
for object_name in insightface_objects:
    datas.append((os.path.join(INSIGHTFACE_OBJECTS_DIR, object_name), "objects"))
print(
    "build.spec: data objects de insightface OK -> objects ({names})".format(
        names=", ".join(insightface_objects)
    )
)

# Los modelos faciales se empaquetan SIEMPRE dentro del ejecutable: en runtime
# viven bajo sys._MEIPASS, que es de solo lectura, asi que no hay descarga
# posible ahi. La lista de modelos, sus rutas de origen y sus archivos
# esperados salen de scripts/models.json, el mismo manifiesto que consume
# scripts/prepare-models.cjs.
#
# Un modelo faltante o mal estructurado ABORTA el build. Antes era un WARNING,
# y eso fue exactamente lo que permitio publicar instaladores sin modelos con
# el CI en verde: se validaba os.path.isdir(), que da True aunque el directorio
# este vacio o tenga los .onnx un nivel mas abajo.
MANIFEST_PATH = os.path.join(SPECPATH, os.pardir, "scripts", "models.json")

with open(MANIFEST_PATH, encoding="utf-8") as manifest_handle:
    MODELS = json.load(manifest_handle)["models"]


def _resolve_dest(dest):
    if dest.startswith("~/") or dest.startswith("~\\"):
        return os.path.expanduser(dest)
    return os.path.abspath(os.path.join(SPECPATH, os.pardir, dest))


for model in MODELS:
    dest_dir = _resolve_dest(model["dest"])
    missing = [
        name
        for name in model["expectedFiles"]
        if not os.path.isfile(os.path.join(dest_dir, name))
    ]
    if missing:
        raise SystemExit(
            "build.spec: faltan archivos del modelo '{model_id}' en {dest}: {missing}. "
            "El instalador NO puede empaquetarse sin ellos. Corre "
            "`node scripts/prepare-models.cjs` (o `pnpm run prepare:models`) y "
            "volve a intentar.".format(
                model_id=model["id"], dest=dest_dir, missing=", ".join(missing)
            )
        )

    for name in model["expectedFiles"]:
        datas.append((os.path.join(dest_dir, name), model["bundleDir"]))

    print(
        "build.spec: modelo '{model_id}' OK -> {bundle} ({count} archivo(s))".format(
            model_id=model["id"],
            bundle=model["bundleDir"],
            count=len(model["expectedFiles"]),
        )
    )

a = Analysis(
    [os.path.join(SPECPATH, "main.py")],
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
