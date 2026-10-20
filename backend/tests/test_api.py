import os
from unittest.mock import Mock

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_is_public():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_run_disabled_without_api_key(monkeypatch):
    monkeypatch.delenv("EXECUTION_API_KEY", raising=False)
    response = client.post("/api/run", json={"language": "python", "code": "print(1)"})
    assert response.status_code == 503


def test_run_rejects_wrong_key(monkeypatch):
    monkeypatch.setenv("EXECUTION_API_KEY", "correct-test-secret")
    response = client.post(
        "/api/run",
        headers={"X-API-Key": "wrong"},
        json={"language": "python", "code": "print(1)"},
    )
    assert response.status_code == 401


def test_run_invokes_docker_without_shell(monkeypatch):
    monkeypatch.setenv("EXECUTION_API_KEY", "correct-test-secret")
    fake = Mock(returncode=0, stdout="5\n", stderr="")
    monkeypatch.setattr("app.main.subprocess.run", lambda *args, **kwargs: (fake if kwargs.get("shell") is False else None))
    response = client.post(
        "/api/run",
        headers={"X-API-Key": "correct-test-secret"},
        json={"language": "python", "code": "print(2 + 3)"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert "5" in response.json()["output"]


def test_code_size_limit(monkeypatch):
    monkeypatch.setenv("EXECUTION_API_KEY", "correct-test-secret")
    monkeypatch.setenv("MAX_CODE_CHARS", "4")
    response = client.post(
        "/api/run",
        headers={"X-API-Key": "correct-test-secret"},
        json={"language": "python", "code": "print(123)"},
    )
    assert response.status_code == 413
