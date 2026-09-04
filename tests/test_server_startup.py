from __future__ import annotations

import runpy
import sys
import unittest
from pathlib import Path


SERVER_PATH = Path(__file__).parents[1] / "src-tauri" / "resources" / "server.py"


class ServerStartupTests(unittest.TestCase):
    def test_normal_startup_does_not_import_akshare(self) -> None:
        sys.modules.pop("akshare", None)

        runpy.run_path(str(SERVER_PATH), run_name="startup_probe")

        self.assertNotIn("akshare", sys.modules)


if __name__ == "__main__":
    unittest.main()
