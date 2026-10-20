from __future__ import annotations

import hmac
import os
import subprocess
import time
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(
    title="Mini Computer Execution API",
    description="Early-stage API for isolated code execution through disposable Docker containers.",
    version="0.1.0",
)

# Configure explicit frontend origins before deployment. "*" is intentionally not used.
_raw_origins = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
_origins = [origin.strip() for origin in _raw_origins.split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-API-Key"],
)

MAX_CODE_CHARS = int(os.getenv("MAX_CODE_CHARS", "20000"))
MAX_OUTPUT_CHARS = int(os.getenv("MAX_OUTPUT_CHARS", "12000"))
RUN_TIMEOUT_SECONDS = int(os.getenv("RUN_TIMEOUT_SECONDS", "5"))
RUNNER_IMAGE = os.getenv("RUNNER_IMAGE", "mini-computer-runner:dev")


class RunRequest(BaseModel):
    language: Literal["python", "javascript"]
    code: str = Field(min_length=1)


class RunResponse(BaseModel):
    status: Literal["success", "error", "timeout"]
    output: str
    duration_ms: int
    truncated: bool = False


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    expected = os.getenv("EXECUTION_API_KEY")
    # Execution is disabled until an operator configures a non-empty key.
    if not expected:
        raise HTTPException(status_code=503, detail="Execution is disabled. Configure EXECUTION_API_KEY.")
    if not x_api_key or not hmac.compare_digest(x_api_key, expected):
        raise HTTPException(status_code=401, detail="Invalid API key.")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "mini-computer-execution-api"}


@app.post("/api/run", response_model=RunResponse, dependencies=[Depends(require_api_key)])
def run_code(request: RunRequest) -> RunResponse:
    if len(request.code) > MAX_CODE_CHARS:
        raise HTTPException(status_code=413, detail=f"Code exceeds the {MAX_CODE_CHARS}-character limit.")

    # The runner image must be built locally first. No network, no capabilities,
    # read-only root filesystem, memory/CPU/PID limits, and a hard wall-clock timeout.
    if request.language == "python":
        command = ["docker", "run", "--rm", "-i", "--pull=never",
                   "--network=none", "--memory=128m", "--cpus=0.5",
                   "--pids-limit=64", "--read-only",
                   "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
                   "--user=65534:65534", "--security-opt=no-new-privileges",
                   "--cap-drop=ALL", RUNNER_IMAGE, "python", "-I", "-"]
    else:
        command = ["docker", "run", "--rm", "-i", "--pull=never",
                   "--network=none", "--memory=128m", "--cpus=0.5",
                   "--pids-limit=64", "--read-only",
                   "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
                   "--user=65534:65534", "--security-opt=no-new-privileges",
                   "--cap-drop=ALL", RUNNER_IMAGE, "node", "--disable-proto=throw", "-"]

    started = time.monotonic()
    try:
        result = subprocess.run(
            command,
            input=request.code,
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT_SECONDS,
            check=False,
            shell=False,
        )
        duration_ms = int((time.monotonic() - started) * 1000)
        combined = (result.stdout or "") + (result.stderr or "")
        truncated = len(combined) > MAX_OUTPUT_CHARS
        output = combined[:MAX_OUTPUT_CHARS]
        return RunResponse(
            status="success" if result.returncode == 0 else "error",
            output=output or "(No output)",
            duration_ms=duration_ms,
            truncated=truncated,
        )
    except subprocess.TimeoutExpired as exc:
        duration_ms = int((time.monotonic() - started) * 1000)
        partial = exc.stdout or ""
        if isinstance(partial, bytes):
            partial = partial.decode("utf-8", errors="replace")
        output = (partial + "\nExecution timed out.")[:MAX_OUTPUT_CHARS]
        return RunResponse(status="timeout", output=output, duration_ms=duration_ms)
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="Docker is not available on the API host.")
    except Exception as exc:
        # Avoid returning environment variables, stack traces, or internal paths.
        raise HTTPException(status_code=500, detail=f"Execution service error: {type(exc).__name__}.")
