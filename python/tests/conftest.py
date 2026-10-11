"""Los tests no cargan modelos faciales: solo ejercitan la logica con datos sinteticos."""

import os
import sys

PYTHON_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PYTHON_ROOT not in sys.path:
    sys.path.insert(0, PYTHON_ROOT)
