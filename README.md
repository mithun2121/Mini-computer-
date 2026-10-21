# Mini Computer

**An interactive computer workspace designed for ChatGPT, AI-assisted development, and MCP integrations.**

Mini Computer aims to let a person and an AI work on the same project: edit files, run code, inspect real output and errors, and use explicitly connected tools. The long-term direction is an embedded ChatGPT app with a hosted backend and optional local-computer connector.

> **Status: early prototype.** The current version is a static browser demo. It includes a file switcher, JavaScript editor, sandboxed iframe runner, and output panel. It can send code to a locally configured execution API. It does not yet connect to an LLM, MCP server, cloud execution service, or persistent storage.

## Run the demo

No build step is required.

1. Download or clone this repository.
2. Open `index.html` in a modern browser.
3. Edit `main.js` and press **Run**.
4. Choose `notes.md` in the left sidebar to view the roadmap notes.
5. Use **Reset demo** to restore the example.

You can also serve the folder with any static HTTP server. This is a browser-only prototype, not a deployed multi-user service.

## Current features

- Responsive dark workspace UI.
- Switch between sample `main.js` and `notes.md` files.
- Edit JavaScript and capture console output in a sandboxed iframe.
- Clear output and reset the demo.
- Product roadmap and security notes.

## Architecture direction

```text
ChatGPT App / Interactive View
              |
         MCP Server
              |
    Authenticated Backend API
       /        |         \
 Projects   AI Provider   Execution API
                           |
                    Isolated Sandbox
```

The planned production architecture separates the interactive view, MCP tool interface, backend authorization, project storage, AI-provider integration, and code execution. Arbitrary user code must run in an isolated execution environment, never inside the API process.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for phases and acceptance targets.

- **Phase 1:** interactive prototype (current)
- **Phase 2:** isolated Python/JavaScript execution and persistent projects
- **Phase 3:** MCP tools and AI-assisted edit/run/debug workflow
- **Phase 4:** ChatGPT app integration and deployment preparation

## Security

Read [SECURITY.md](SECURITY.md) before extending the execution model. Do not place API keys, passwords, or production secrets in browser code. The current demo is not a secure hosted code runner and should not be advertised as one.

## Contributing

Issues and pull requests are welcome. Please describe the intended behavior and include reproduction steps for bugs. Security-sensitive reports should not include live credentials or private user data.

## License

The repository license should be selected and added by the project owner. Until a license file is present, do not assume that the code is licensed for reuse.

## Embedded ChatGPT app / MCP scaffold

The repository now includes an early **MCP Apps UI scaffold** intended to render inside a compatible ChatGPT conversation, rather than only as a standalone dashboard:

- `mcp-server/server.js` registers the embedded UI resource and three workspace tools: open workspace, list files, read file, and write file.
- `mcp-server/ui/workspace.html` is a self-contained responsive workspace UI.
- `package.json` contains the Node.js dependencies.

### Start the MCP server locally

Requires Node.js 20 or newer.

```powershell
npm install
$env:MINI_COMPUTER_WORKSPACE = "$PWD\workspace"
npm start
```

Health check: `http://localhost:8788/health`. The MCP endpoint is `http://localhost:8788/mcp`.

**Important limitations:** this is a development scaffold, not a published or verified ChatGPT app. ChatGPT needs to reach the MCP endpoint over a supported remote connection; a localhost URL alone is not accessible to ChatGPT's hosted service. Use an approved secure tunnel or a properly secured HTTPS deployment for testing. Do not expose the development server publicly without authentication and review.

The workspace tools are restricted to the configured workspace directory and skip hidden folders and symlinks. They do not provide general access to the whole PC. Terminal execution and Python execution are intentionally not enabled in this MCP scaffold; they require a separately isolated runner, explicit permissions, and security tests. The current embedded UI is a UI prototype and is not yet wired to call the file tools directly.

Official references:
- OpenAI Apps SDK: https://developers.openai.com/apps-sdk/
- MCP Apps UI integration: https://developers.openai.com/plugins/build/chatgpt-ui
- MCP server + UI quickstart: https://developers.openai.com/plugins/build/app-quickstart
