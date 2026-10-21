import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_PATH = path.join(__dirname, "ui", "workspace.html");
const PORT = Number(process.env.PORT || 8788);
const WORKSPACE_ROOT = path.resolve(process.env.MINI_COMPUTER_WORKSPACE || path.join(process.cwd(), "workspace"));
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 500;
const app = express();
app.use(express.json({ limit: "1mb" }));

async function ensureWorkspace() { await fs.mkdir(WORKSPACE_ROOT, { recursive: true }); }
function resolveSafePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) throw new Error("A relative path is required.");
  if (path.isAbsolute(relativePath)) throw new Error("Absolute paths are not allowed.");
  const resolved = path.resolve(WORKSPACE_ROOT, relativePath);
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + path.sep)) throw new Error("Path is outside the configured workspace.");
  return resolved;
}
function toolResult(text, structuredContent) {
  return { content: [{ type: "text", text }], ...(structuredContent ? { structuredContent } : {}) };
}

function makeServer() {
  const server = new McpServer({ name: "mini-computer", version: "0.2.0" });
  registerAppResource(server, "mini-computer-workspace", "ui://mini-computer/workspace.html", {
    title: "Mini Computer Workspace",
    description: "Interactive in-chat file explorer, code editor, terminal/output workspace.",
    mimeType: RESOURCE_MIME_TYPE
  }, async () => ({
    contents: [{
      uri: "ui://mini-computer/workspace.html",
      mimeType: RESOURCE_MIME_TYPE,
      text: await fs.readFile(UI_PATH, "utf8"),
      _meta: {
        ui: { prefersBorder: true, domain: process.env.MINI_COMPUTER_PUBLIC_ORIGIN || "http://localhost" },
        "openai/widgetDescription": "Interactive Mini Computer workspace. File operations are scoped to the configured workspace."
      }
    }]
  }));

  registerAppTool(server, "mini_computer_open", {
    title: "Open Mini Computer",
    description: "Open the interactive Mini Computer workspace inside this conversation.",
    inputSchema: { focus: z.enum(["files", "editor", "terminal", "output"]).optional() },
    _meta: { ui: { resourceUri: "ui://mini-computer/workspace.html" }, "openai/outputTemplate": "ui://mini-computer/workspace.html" }
  }, async ({ focus }) => toolResult(
    "Mini Computer workspace opened. The current scaffold provides workspace file tools; terminal execution is not enabled yet.",
    { focus: focus || "files", workspace: path.basename(WORKSPACE_ROOT), terminalEnabled: false }
  ));

  server.registerTool("mini_computer_list_files", {
    title: "List workspace files",
    description: "List files under the configured workspace. Paths are relative to the workspace root.",
    inputSchema: { path: z.string().optional().default("."), recursive: z.boolean().optional().default(false) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ path: relativePath = ".", recursive = false }) => {
    await ensureWorkspace();
    const base = relativePath === "." ? WORKSPACE_ROOT : resolveSafePath(relativePath);
    const stat = await fs.stat(base);
    if (!stat.isDirectory()) throw new Error("Requested path is not a directory.");
    const files = [];
    async function walk(dir, rel, depth) {
      if (depth > 8 || files.length >= MAX_FILES) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || ["node_modules", ".git"].includes(entry.name) || entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        const childRel = path.posix.join(rel, entry.name);
        if (entry.isDirectory()) { files.push({ path: childRel, type: "directory" }); if (recursive) await walk(full, childRel, depth + 1); }
        else if (entry.isFile()) files.push({ path: childRel, type: "file", size: (await fs.stat(full)).size });
        if (files.length >= MAX_FILES) break;
      }
    }
    await walk(base, relativePath === "." ? "" : relativePath, 0);
    return toolResult(JSON.stringify(files, null, 2), { files, root: WORKSPACE_ROOT });
  });

  server.registerTool("mini_computer_read_file", {
    title: "Read workspace file",
    description: "Read a UTF-8 text file inside the configured workspace, up to 512 KB.",
    inputSchema: { path: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ path: relativePath }) => {
    await ensureWorkspace();
    const full = resolveSafePath(relativePath);
    const stat = await fs.lstat(full);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Only regular files can be read.");
    if (stat.size > MAX_FILE_BYTES) throw new Error("File exceeds the 512 KB limit.");
    const content = await fs.readFile(full, "utf8");
    return toolResult(content, { path: relativePath, content });
  });

  server.registerTool("mini_computer_write_file", {
    title: "Write workspace file",
    description: "Create or replace a UTF-8 text file in the configured workspace. This modifies files; confirm user intent before calling.",
    inputSchema: { path: z.string().min(1), content: z.string().max(MAX_FILE_BYTES) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ path: relativePath, content }) => {
    await ensureWorkspace();
    const full = resolveSafePath(relativePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    const existing = await fs.lstat(full).catch(() => null);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Only regular files can be replaced.");
    await fs.writeFile(full, content, { encoding: "utf8", flag: "w" });
    return toolResult("Saved " + relativePath, { path: relativePath, bytes: Buffer.byteLength(content, "utf8") });
  });
  return server;
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "mini-computer-mcp", ui: "ui://mini-computer/workspace.html" }));
app.post("/mcp", async (req, res) => {
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
  catch (error) { console.error("MCP request failed:", error); if (!res.headersSent) res.status(500).json({ error: "MCP request failed" }); }
});
app.get("/", (_req, res) => res.status(200).send("Mini Computer MCP server is running. Connect ChatGPT to /mcp."));
app.listen(PORT, "0.0.0.0", async () => {
  await ensureWorkspace();
  console.log(`Mini Computer MCP server listening on port ${PORT}`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
  console.log("Safe file tools are enabled; code execution is not enabled in this scaffold.");
});
