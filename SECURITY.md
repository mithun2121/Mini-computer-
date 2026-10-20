# Security Notes

## Current prototype

- The current runner is a browser-only JavaScript demonstration inside an iframe with the sandbox attribute set to `allow-scripts`.
- It is not a secure multi-tenant cloud execution service and must not be represented as one.
- It does not execute Python, make MCP connections, call an LLM, or persist user projects on a server.
- Do not paste secrets, access tokens, private keys, or production credentials into this demo.

## Before cloud execution

- Run user code in disposable, isolated containers or a dedicated sandbox service. Do not execute user code inside the API process or an ordinary serverless request handler.
- Enforce CPU, memory, wall-clock, process, storage, and network limits.
- Disable outbound network access by default; allow it only through explicit policy.
- Keep each user's files and execution sessions isolated.
- Authenticate every project and execution request. Apply quotas, audit events, and abuse controls.
- Store secrets in server-side secret management. Never expose provider keys in browser code.
- Treat model-generated code as untrusted code. Require explicit approval before it can access files, networks, credentials, or connected tools.
- Validate and authorize MCP tool calls on the server. Do not treat tool descriptions or model output as authorization.
- Add automated tests and a security review before public multi-user deployment.
