"""Import stub for `ruckig`, used when running tools/so101_piper_ws_bridge.py.

actuacore's `actuator` package imports ruckig at module load (for the mobile
base, which the bridge never drives), but ruckig 0.17.3's sdist fails to build
against scikit-build-core >= 0.10. Putting this directory FIRST on PYTHONPATH
satisfies the import without the dependency; anything that actually tries to
use ruckig raises immediately.
"""


class _Unavailable:
    def __init__(self, *args, **kwargs):
        raise RuntimeError("ruckig is stubbed out in the so101_piper_ws_bridge environment")


ControlInterface = InputParameter = OutputParameter = Result = Ruckig = _Unavailable
