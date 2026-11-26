import ast
import re
from pathlib import Path
import sys

import pytest

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = tuple(sorted((ROOT / "quanttrading").rglob("*.py")))
NETWORK_IMPORTS = {
    "asyncio", "ftplib", "http", "imaplib", "nntplib", "poplib", "smtplib",
    "socket", "socketserver", "ssl", "telnetlib", "urllib", "xmlrpc",
}
FORBIDDEN_NAMES = {
    "__import__", "import_module", "getenv", "getenvb", "environ", "environb",
    "putenv", "unsetenv", "load_dotenv", "dotenv",
}
LIVE_PATH = re.compile(r"broker|exchange|(?:place|send|submit|route|execute)_?orders?|order_?routing", re.I)


def nodes(path):
    return ast.walk(ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))


@pytest.mark.parametrize("path", RUNTIME, ids=lambda path: path.name)
def test_runtime_uses_only_offline_stdlib_imports(path):
    for node in nodes(path):
        if isinstance(node, ast.Import):
            imports = [name.name for name in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            imports = [node.module]
        else:
            continue
        for name in imports:
            top_level = name.split(".")[0]
            assert top_level in sys.stdlib_module_names or top_level == "quanttrading"
            assert top_level not in NETWORK_IMPORTS


@pytest.mark.parametrize("path", RUNTIME, ids=lambda path: path.name)
def test_runtime_has_no_float_or_live_configuration_or_submission_symbols(path):
    for node in nodes(path):
        if isinstance(node, ast.Constant):
            assert not isinstance(node.value, float)
            if isinstance(node.value, str):
                assert ".env" not in node.value
        if isinstance(node, ast.Name):
            name = node.id
        elif isinstance(node, ast.Attribute):
            name = node.attr
        elif isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            name = node.name
        elif isinstance(node, ast.alias):
            name = node.name
        else:
            continue
        assert name != "float"
        assert name not in FORBIDDEN_NAMES
        assert not LIVE_PATH.search(name)


def test_synthetic_provenance_and_no_dotenv():
    for fixture in (ROOT / "fixtures").glob("*.csv"):
        rows = fixture.read_bytes().splitlines()[1:]
        assert rows
        assert all(re.fullmatch(rb"SYNTH(?:_[A-Z0-9._-]+)?", row.split(b",")[1]) for row in rows)
    assert "synthetic `SYNTH` data" in (ROOT / "README.md").read_text(encoding="utf-8")
    for directory in (ROOT, ROOT / "quanttrading", ROOT / "fixtures", ROOT / "tests"):
        assert not list(directory.glob(".env*"))


def test_build_backend_is_pinned_and_runtime_has_no_dependencies():
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert project["build-system"]["build-backend"] == "setuptools.build_meta"
    setuptools, = project["build-system"]["requires"]
    assert re.fullmatch(r"setuptools==[0-9]+\.[0-9]+\.[0-9]+", setuptools)
    assert project["project"]["dependencies"] == []
