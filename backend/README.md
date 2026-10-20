# Mini Computer Execution API (early scaffold)

This FastAPI service exposes a health endpoint and an authenticated `POST /api/run` endpoint. It runs Python or JavaScript in a disposable Docker container with network access disabled and resource limits applied.

## Prerequisites

- Python 3.11+
- Docker Engine/Desktop running
- Build tools/images permitted by your environment

## Build and start (PowerShell)

From the repository root:

```powershell
docker build -f backend/Dockerfile.runner -t mini-computer-runner:dev backend
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `.env` and set `EXECUTION_API_KEY` to a long random value. Load the variables into the current PowerShell session (the application does not automatically read the .env file):

```powershell
$env:EXECUTION_API_KEY = "replace-with-your-long-random-secret"
$env:CORS_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"
$env:RUN_TIMEOUT_SECONDS = "5"
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Health check: `http://127.0.0.1:8000/health`

Example request:

```powershell
$headers = @{ "X-API-Key" = $env:EXECUTION_API_KEY }
$body = @{ language = "python"; code = "print('Hello from Mini Computer')"; } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8000/api/run" -Headers $headers -ContentType "application/json" -Body $body
```

JavaScript example: set `language = "javascript"` and use code such as `console.log(2 + 3)`.

## Safety limits and remaining work

- The execution endpoint returns 503 until `EXECUTION_API_KEY` is configured.
- The API uses `shell=False`, limits request size and output, applies a wall-clock timeout, and starts disposable runner containers with no network, read-only root filesystem, dropped Linux capabilities, no-new-privileges, and CPU/memory/PID limits.
- **Do not expose this scaffold directly to the public internet yet.** A Docker daemon is a powerful host-level interface. Run the API on a dedicated, disposable host; do not mount the Docker socket into a public-facing general-purpose application. Consider a separate execution broker, per-user authentication, rate limits, request auditing, stronger sandboxing (for example gVisor/Firecracker), and security review before public deployment.
- The simple shared API key is a development gate, not multi-user authentication. Never place it in frontend JavaScript.
- This endpoint is synchronous and intended for the first integration test, not high concurrency. Run the test suite from `backend/` with `pytest -q`.
- The API has not yet been wired into the browser prototype or ChatGPT Apps SDK.
