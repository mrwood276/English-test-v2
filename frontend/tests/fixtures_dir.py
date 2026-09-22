"""Where the media sample files live (shared by make_fixtures.py and media_e2e.py).

Defaults to <system temp dir>/media_fixtures (/tmp on Linux and macOS, the %TEMP% folder on
Windows), so the tests no longer depend on how a shell resolves a literal "/tmp" path.
Set MEDIA_FIXTURES_DIR to use a different folder.
"""
import os
import tempfile


def fixtures_dir():
    override = os.environ.get("MEDIA_FIXTURES_DIR")
    if override:
        return override
    return os.path.join(tempfile.gettempdir(), "media_fixtures")
