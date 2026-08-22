"""Normalizacion de errores para que nunca lleguen vacios al operador.

Un ``assert`` sin texto (lo que lanza insightface cuando no encuentra los
modelos) da ``str(error) == ""``. Ese string vacio es falsy tanto en el puente
de Electron como en la UI, asi que el fallo se mostraba como exito o como un
badge "Error" sin ninguna pista de la causa.
"""

import os
import traceback


def describe_error(error):
    """``"<Tipo>: <mensaje>"``, con fallback explicito cuando no hay mensaje."""
    message = str(error).strip()
    if message:
        return "{name}: {message}".format(name=type(error).__name__, message=message)
    return "{name} (sin mensaje)".format(name=type(error).__name__)


def describe_error_origin(error):
    """``"archivo.py:123 en funcion"`` de la ultima frame del traceback, o None.

    Es la pista que hace diagnosticable un fallo repetido en cada foto: dice si
    revienta la deteccion, el embedding o el indice, sin necesidad de reproducir
    el problema en una consola que en un ``.app`` empaquetado no existe.
    """
    frames = traceback.extract_tb(error.__traceback__)
    if not frames:
        return None
    last = frames[-1]
    return "{file}:{line} en {name}".format(
        file=os.path.basename(last.filename), line=last.lineno, name=last.name
    )


def describe_error_with_origin(error):
    """``describe_error`` + la ultima frame en una segunda linea."""
    described = describe_error(error)
    origin = describe_error_origin(error)
    if not origin:
        return described
    return "{described}\n{origin}".format(described=described, origin=origin)
