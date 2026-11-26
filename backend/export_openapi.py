import json
from pathlib import Path

from .main import app


if __name__ == "__main__":
    Path(__file__).with_name("openapi.json").write_text(
        json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n", encoding="utf-8",
    )
