# Shared interpreter resolution for fractal-* launchers.
# Packaged TinyWhale sets FRACTAL_PYTHON (or TINYWHALE_PYTHON) to the bundled
# CPython. A set-but-unusable value fails loud so a broken install cannot
# silently fall through to the macOS Xcode CLT stub at /usr/bin/python3.
# Unset means a source checkout: use whatever python3 is on PATH.

if [ -n "${FRACTAL_PYTHON:-}" ]; then
  if [ ! -x "$FRACTAL_PYTHON" ]; then
    echo "fractal: FRACTAL_PYTHON is set but not executable: $FRACTAL_PYTHON" >&2
    exit 127
  fi
  FRACTAL_PYTHON_BIN=$FRACTAL_PYTHON
elif [ -n "${TINYWHALE_PYTHON:-}" ]; then
  if [ ! -x "$TINYWHALE_PYTHON" ]; then
    echo "fractal: TINYWHALE_PYTHON is set but not executable: $TINYWHALE_PYTHON" >&2
    exit 127
  fi
  FRACTAL_PYTHON_BIN=$TINYWHALE_PYTHON
elif [ "${TINYWHALE_PACKAGED:-}" = '1' ]; then
  echo "fractal: packaged TinyWhale is missing FRACTAL_PYTHON; reinstall the app" >&2
  exit 127
else
  FRACTAL_PYTHON_BIN=python3
fi
