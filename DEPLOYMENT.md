# Mini Computer MCP — cloud deployment

## What runs where

- **Render:** public HTTPS MCP endpoint, OAuth authorization/token endpoints, and a WebSocket relay.
- **Windows agent:** connects outbound to Render over `wss://`, reconnects after drops, and can access only configured roots.
- **ChatGPT:** connects to the public `/mcp` URL and authorizes through OAuth 2.1 with PKCE.

The Render Free service can sleep/restart. The Windows agent reconnects automatically, but local PC tools require the PC to be on and online. Free services have ephemeral disks, so do not store important user data in the cloud workspace.

## Deploy to Render

1. Push this repository to your GitHub account.
2. In Render, choose **New → Blueprint** and select this repository; Render reads `render.yaml`.
3. Create the service on the Free plan.
4. After Render assigns the service URL, set these environment variables in the service dashboard:
   - `MINI_COMPUTER_PUBLIC_ORIGIN`: exact origin, e.g. `https://your-service.onrender.com` (no trailing slash or `/mcp`).
   - `MINI_COMPUTER_OAUTH_SECRET`: a random secret of at least 32 characters.
   - `MINI_COMPUTER_OAUTH_USERNAME`: your private sign-in username.
   - `MINI_COMPUTER_OAUTH_PASSWORD`: a unique, long password used only for Mini Computer.
   - `MINI_COMPUTER_AGENT_TOKEN`: a different random secret used only by the Windows agent.
5. Save changes and redeploy. Check `https://your-service.onrender.com/health` and both OAuth metadata URLs:
   - `/.well-known/oauth-protected-resource`
   - `/.well-known/oauth-authorization-server`

Generate secrets locally in PowerShell without printing them into chat:

```powershell
$bytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[BitConverter]::ToString($bytes).Replace('-', '') | Set-Clipboard
```

Run separately for the OAuth secret and agent token. Paste each directly into its Render environment variable field. Do not reuse your Windows password.

## Configure the Windows agent

Create `.env.local` in the repository root (it is git-ignored) with these values:

```dotenv
MINI_COMPUTER_CLOUD_AGENT_URL=wss://your-service.onrender.com/agent
MINI_COMPUTER_AGENT_TOKEN=the-same-agent-token-configured-in-Render
MINI_COMPUTER_ALLOWED_ROOTS=C:\Users\YOUR_WINDOWS_USER\Mini-computer-\workspace
```

Only add directories you actually want ChatGPT to access. Multiple roots are separated with semicolons. Do not add the whole `C:\` drive unless you have a specific need and understand the risk.

Start the agent from PowerShell:

```powershell
cd C:\Users\YOUR_WINDOWS_USER\Mini-computer-
$envFile = Join-Path (Get-Location) '.env.local'
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
  }
}
npm run agent
```

Leave that terminal running while you need Windows PC tools. The agent reconnects after cloud restarts or network interruptions.

## Connect ChatGPT

1. Open ChatGPT on the web → **Settings → Apps** (or Plugins/custom MCP servers, depending on the interface).
2. Choose **Add custom MCP server** and select the public server URL connection, not Tunnel.
3. Server URL: `https://your-service.onrender.com/mcp`.
4. Select **OAuth** authentication. Use the server's dynamic client registration flow if prompted; do not enter a static API key.
5. Sign in using the Mini Computer OAuth username and password you configured in Render.
6. Install/enable the app and check the available tools.

## Security notes

- The Windows agent token and OAuth secret must never be committed to GitHub.
- Local file operations are restricted to `MINI_COMPUTER_ALLOWED_ROOTS`; symbolic-link escapes are checked.
- Terminal execution is limited to an executable allowlist, uses no shell, has a 30-second timeout, and caps output. Approved executables can still run code, so invoke them only when explicitly intended.
- OAuth access tokens expire after one hour and can be refreshed for up to 30 days; the authorization server uses authorization code + PKCE (S256).
- This is a self-hosted personal tool, not a hardened multi-tenant production service. Review tool calls carefully and do not expose it to untrusted users.
