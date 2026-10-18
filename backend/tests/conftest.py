# conftest.py – Drishti AI backend test configuration
#
# Ensures init_db() is called before any test touches the database by
# entering the TestClient lifespan context.  Also redirects the database
# to an isolated temp file so tests never write to the production DB.
#
# All test classes in test_api.py reference a module-level `client` variable;
# this fixture patches that variable so they transparently use the started
# client without any changes to the test methods.

from __future__ import annotations
import os
import pytest
import app.db.database as _db_module
from fastapi.testclient import TestClient


def pytest_configure(config):
    """
    Called very early — before any module is collected.
    Set a predictable env var so database.py can pick it up if it hasn't
    been imported yet.  The real override (patching DB_PATH) happens in the
    session fixture below, which handles the case where database.py was
    already imported during collection.
    """
    os.environ.setdefault("DRISHTI_DB_PATH", ":memory:")


@pytest.fixture(scope="session", autouse=True)
def started_client(tmp_path_factory):
    """
    Session-scoped fixture that:
    1. Redirects all database operations to an isolated temp file.
    2. Enters the TestClient context manager, which fires the FastAPI
       lifespan → init_db() → all SQLite tables are created.
    3. Patches the module-level `client` in test_api so every test method
       uses the running, fully-initialised client.
    4. Tears down after the entire session completes.
    """
    # Use a temp file (not :memory:) so aiosqlite works correctly in threads.
    db_file = str(tmp_path_factory.mktemp("testdb") / "test_drishti.db")

    # Patch the already-imported DB_PATH constant directly.
    original_db_path = _db_module.DB_PATH
    _db_module.DB_PATH = db_file

    # Import app and the test module (may already be imported — that's fine).
    from app.main import app
    import tests.test_api as test_module

    with TestClient(app, raise_server_exceptions=True) as live_client:
        # Patch the module-level `client` reference used by all test classes.
        test_module.client = live_client
        yield live_client

    # Restore original DB_PATH after the session.
    _db_module.DB_PATH = original_db_path
