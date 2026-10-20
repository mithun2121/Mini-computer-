# Mini Computer Roadmap

## Phase 1 — Interactive prototype
- [x] Responsive workspace shell
- [x] Switch between demo files
- [x] Edit JavaScript and capture console output
- [x] Reset and clear-output controls
- [x] Security boundary documentation

## Phase 2 — Real execution backend
- [ ] API service for creating and managing execution sessions
- [ ] Disposable sandbox for Python and JavaScript
- [ ] Runtime limits, output limits, and timeout enforcement
- [ ] Project and file persistence
- [ ] Authentication, quotas, and audit logging

## Phase 3 — AI and MCP
- [ ] MCP server with a small, permissioned tool surface
- [ ] Tool discovery and connection management
- [ ] AI-assisted code changes with diffs and user approval
- [ ] Send execution output and errors back into the AI workflow
- [ ] Explain code and propose fixes

## Phase 4 — ChatGPT app
- [ ] Build the interactive view using the official Apps SDK / MCP Apps approach
- [ ] Connect the hosted MCP server to the app
- [ ] Test supported clients and authentication
- [ ] Prepare documentation, privacy policy, and deployment
- [ ] Review publication requirements before directory submission

## Release principles
Security and reliable execution take priority over autonomous access to a user's machine. Local-computer access, if added, must be an optional connector with explicit permissions.
