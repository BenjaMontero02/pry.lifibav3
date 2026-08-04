"""Convierte el checkpoint PyTorch de AdaFace a ONNX (solo desarrollo).

Uso:
  python scripts/convert_adaface_to_onnx.py --adaface-repo <ruta clone AdaFace> \
      --checkpoint <ruta .ckpt> --output python/models/adaface_ir101_webface12m.onnx

Requiere torch instalado (no es dependencia del runtime).
"""

import argparse
import os
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--adaface-repo", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument(
        "--output",
        default=os.path.join("python", "models", "adaface_ir101_webface12m.onnx"),
    )
    args = parser.parse_args()

    import torch

    sys.path.insert(0, args.adaface_repo)
    import net  # definicion del modelo, vive en el repo AdaFace

    model = net.build_model("ir_101")
    # weights_only=True: el .ckpt viene de una descarga externa; sin esto,
    # torch.load despickla objetos arbitrarios (ejecucion de codigo).
    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    state_dict = {
        key[len("model."):]: value
        for key, value in checkpoint["state_dict"].items()
        if key.startswith("model.")
    }
    model.load_state_dict(state_dict)
    model.eval()

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    dummy = torch.randn(1, 3, 112, 112)
    torch.onnx.export(
        model,
        dummy,
        args.output,
        input_names=["input"],
        output_names=["embedding", "norm"],
        dynamic_axes={"input": {0: "batch"}, "embedding": {0: "batch"}, "norm": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )
    print(f"OK: {args.output}")


if __name__ == "__main__":
    main()
