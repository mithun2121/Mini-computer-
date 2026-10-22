import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { registerOAuthRoutes, verifyAccessToken } from "./oauth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8788);
const UI_PATH = path.join(__dirname, "ui", "workspace.html");
const WORKSPACE_ROOT = path.resolve(process.env.MINI_COMPUTER_WORKSPACE || path.join(process.cwd(), "workspace"));
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 500;
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
registerOAuthRoutes(app);

let agentSocket = null;
const pendingAgentRequests = new Map();
let requestCounter = 0;
function secureEqual(a, b) {
  const x = Buffer.from(String(a || "")); const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
function requestAgent(operation, args = {}) {
  if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) throw new Error("Windows agent is offline.");
  const id = `${Date.now()}-${++requestCounter}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pendingAgentRequests.delete(id); reject(new Error("Windows agent request timed out.")); }, 20000);
    pendingAgentRequests.set(id, { resolve, reject, timeout });
    agentSocket.send(JSON.stringify({ type: "request", id, operation, args }));
  });
}
async function ensureWorkspace() { await fs.mkdir(WORKSPACE_ROOT, { recursive: true }); }
function resolveSafePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) throw new Error("A relative path is required.");
  if (path.isAbsolute(relativePath)) throw new Error("Absolute paths are not allowed.");
  const resolved = path.resolve(WORKSPACE_ROOT, relativePath);
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + path.sep)) throw new Error("Path is outside the configured workspace.");
  return resolved;
}
function toolResult(text, structuredContent) { return { content: [{ type: "text", text }], ...(structuredContent ? { structuredContent } : {}) }; }

function makeServer() {
  const server = new McpServer({ name: "mini-computer", version: "0.3.0" });
  registerAppResource(server, "mini-computer-workspace", "ui://mini-computer/workspace.html", {
    title: "Mini Computer Workspace", description: "Interactive in-chat file explorer, code editor, terminal/output workspace.", mimeType: RESOURCE_MIME_TYPE
  }, async () => ({ contents: [{ uri: "ui://mini-computer/workspace.html", mimeType: RESOURCE_MIME_TYPE,
    text: await fs.readFile(UI_PATH, "utf8"), _meta: { ui: { prefersBorder: true, domain: process.env.MINI_COMPUTER_PUBLIC_ORIGIN || "http://localhost" }, "openai/widgetDescription": "Interactive Mini Computer workspace. File operations are scoped to the configured workspace." } }] }));

  registerAppTool(server, "mini_computer_open", { title: "Open Mini Computer", description: "Open the interactive Mini Computer workspace inside this conversation.",
    inputSchema: { focus: z.enum(["files", "editor", "terminal", "output"]).optional() },
    _meta: { ui: { resourceUri: "ui://mini-computer/workspace.html" }, "openai/outputTemplate": "ui://mini-computer/workspace.html" }
  }, async ({ focus }) => toolResult("Mini Computer workspace opened. Windows agent relay is " + (agentSocket?.readyState === WebSocket.OPEN ? "connected" : "offline") + ". Terminal execution is not enabled yet.",
    { focus: focus || "files", workspace: path.basename(WORKSPACE_ROOT), agentConnected: agentSocket?.readyState === WebSocket.OPEN, terminalEnabled: false }));

  server.registerTool("mini_computer_list_files", { title: "List cloud workspace files", description: "List files in the cloud service workspace. Paths are relative to the cloud workspace root.",
    inputSchema: { path: z.string().optional().default("."), recursive: z.boolean().optional().default(false) }, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ path: relativePath = ".", recursive = false }) => {
    await ensureWorkspace(); const base = relativePath === "." ? WORKSPACE_ROOT : resolveSafePath(relativePath);
    const stat = await fs.stat(base); if (!stat.isDirectory()) throw new Error("Requested path is not a directory.");
    const files = [];
    async function walk(dir, rel, depth) {
      if (depth > 8 || files.length >= MAX_FILES) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || ["node_modules", ".git"].includes(entry.name) || entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name); const childRel = path.posix.join(rel, entry.name);
        if (entry.isDirectory()) { files.push({ path: childRel, type: "directory" }); if (recursive) await walk(full, childRel, depth + 1); }
        else if (entry.isFile()) files.push({ path: childRel, type: "file", size: (await fs.stat(full)).size });
        if (files.length >= MAX_FILES) break;
      }
    }
    await walk(base, relativePath === "." ? "" : relativePath, 0);
    return toolResult(JSON.stringify(files, null, 2), { files, root: WORKSPACE_ROOT });
  });
  server.registerTool("mini_computer_read_file", { title: "Read cloud workspace file", description: "Read a UTF-8 text file in the cloud workspace, up to 512 KB.", inputSchema: { path: z.string().min(1) }, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ path: relativePath }) => {
    await ensureWorkspace(); const full = resolveSafePath(relativePath); const stat = await fs.lstat(full);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Only regular files can be read.");
    if (stat.size > MAX_FILE_BYTES) throw new Error("File exceeds the 512 KB limit.");
    const content = await fs.readFile(full, "utf8"); return toolResult(content, { path: relativePath, content });
  });
  server.registerTool("mini_computer_write_file", { title: "Write cloud workspace file", description: "Create or replace a UTF-8 text file in the cloud workspace. Confirm user intent before calling.", inputSchema: { path: z.string().min(1), content: z.string().max(MAX_FILE_BYTES) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ path: relativePath, content }) => {
    await ensureWorkspace(); const full = resolveSafePath(relativePath); await fs.mkdir(path.dirname(full), { recursive: true });
    const existing = await fs.lstat(full).catch(() => null); if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Only regular files can be replaced.");
    await fs.writeFile(full, content, { encoding: "utf8", flag: "w" }); return toolResult("Saved " + relativePath, { path: relativePath, bytes: Buffer.byteLength(content, "utf8") });
  });
  server.registerTool("mini_computer_windows_list_files", { title: "List Windows PC files", description: "List entries in a directory inside the Windows agent's explicitly allowed roots. Supply an absolute Windows path or omit it for the agent's configured workspace.", inputSchema: { path: z.string().optional() }, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ path: targetPath }) => { const r = await requestAgent("list_files", { path: targetPath }); if (!r.ok) throw new Error(r.error); return toolResult(JSON.stringify(r.result, null, 2), { entries: r.result }); });
  server.registerTool("mini_computer_windows_read_file", { title: "Read Windows PC file", description: "Read a UTF-8 text file up to 512 KB from an explicitly allowed Windows directory. Supply an absolute Windows path.", inputSchema: { path: z.string().min(1) }, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ path: targetPath }) => { const r = await requestAgent("read_file", { path: targetPath }); if (!r.ok) throw new Error(r.error); return toolResult(r.result.content, { path: r.result.path, content: r.result.content }); });
  server.registerTool("mini_computer_windows_write_file", { title: "Write Windows PC file", description: "Create or replace a UTF-8 text file up to 512 KB inside an explicitly allowed Windows directory. This modifies the user's PC; confirm intent before calling.", inputSchema: { path: z.string().min(1), content: z.string().max(MAX_FILE_BYTES) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ path: targetPath, content }) => { const r = await requestAgent("write_file", { path: targetPath, content }); if (!r.ok) throw new Error(r.error); return toolResult(`Saved ${r.result.path} (${r.result.bytes} bytes).`, r.result); });
  server.registerTool("mini_computer_windows_run_command", { title: "Run an approved Windows command", description: "Run one allowlisted executable directly (no shell) inside an explicitly allowed Windows directory. Supported programs: git, node, npm, pnpm, python, py, docker, where.exe, whoami.exe, ipconfig.exe, ping.exe, tracert.exe. Maximum 30 seconds and capped output. This executes code or changes system state; only run commands the user explicitly requested.", inputSchema: { program: z.enum(["git", "node", "npm", "pnpm", "python", "py", "docker", "where.exe", "whoami.exe", "ipconfig.exe", "ping.exe", "tracert.exe"]), args: z.array(z.string().max(2048)).max(24), cwd: z.string().optional() }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ program, args, cwd }) => { const r = await requestAgent("run_command", { program, args, cwd }); if (!r.ok) throw new Error(r.error); return toolResult(JSON.stringify(r.result, null, 2), r.result); });
  return server;
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "mini-computer-mcp", agentConnected: agentSocket?.readyState === WebSocket.OPEN, ui: "ui://mini-computer/workspace.html" }));
app.get("/", (_req, res) => res.status(200).send("Mini Computer MCP cloud relay is running. Connect ChatGPT to /mcp."));
app.post("/mcp", async (req, res) => {
  const method = req.body?.method;
  if (method === "tools/call") {
    const authHeader = req.headers.authorization || "";
    const suppliedToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const claims = verifyAccessToken(suppliedToken);
    const toolName = String(req.body?.params?.name || "");
    const requiredScope = /run_command/.test(toolName) ? "terminal:execute" : (/write_file/.test(toolName) ? "files:write" : "files:read");
    const origin = process.env.MINI_COMPUTER_PUBLIC_ORIGIN || "https://configure-mini-computer-origin.example";
    if (!claims) return res.status(401).set("WWW-Authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="files:read files:write terminal:execute"`).json({ error: "unauthorized", error_description: "Sign in through the MCP OAuth authorization flow." });
    const granted = new Set(String(claims.scope || "").split(/\s+/));
    if (!granted.has(requiredScope)) return res.status(403).json({ error: "insufficient_scope", scope: requiredScope });
  }
  const server = makeServer(); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
  catch (error) { console.error("MCP request failed:", error); if (!res.headersSent) res.status(500).json({ error: "MCP request failed" }); }
});

const httpServer = createServer(app);
const agentWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
httpServer.on("upgrade", (req, socket, head) => {
  if (req.url !== "/agent") { socket.destroy(); return; }
  const expected = process.env.MINI_COMPUTER_AGENT_TOKEN;
  const auth = req.headers.authorization || "";
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!expected || !secureEqual(supplied, expected)) { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
  agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit("connection", ws, req));
});
agentWss.on("connection", (ws) => {
  if (agentSocket && agentSocket.readyState === WebSocket.OPEN) agentSocket.close(4001, "Agent replaced by new connection");
  agentSocket = ws;
  console.log("Windows agent connected.");
  ws.on("message", (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === "response" && typeof msg.id === "string") {
      const p = pendingAgentRequests.get(msg.id); if (!p) return;
      clearTimeout(p.timeout); pendingAgentRequests.delete(msg.id); p.resolve(msg);
    }
  });
  ws.on("close", () => {
    if (agentSocket === ws) agentSocket = null;
    for (const [id, p] of pendingAgentRequests) { clearTimeout(p.timeout); p.reject(new Error("Windows agent disconnected.")); pendingAgentRequests.delete(id); }
    console.log("Windows agent disconnected.");
  });
  ws.on("error", (e) => console.error("Windows agent websocket error:", e.message));
});
httpServer.listen(PORT, "0.0.0.0", async () => {
  await ensureWorkspace();
  console.log(`Mini Computer MCP server listening on port ${PORT}`);
  console.log(`Cloud workspace root: ${WORKSPACE_ROOT}`);
  console.log("Windows agent relay is enabled; terminal execution remains disabled.");
});
