import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { runAllowedCommand } from "./command-runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_URL = process.env.MINI_COMPUTER_CLOUD_AGENT_URL;
const AGENT_TOKEN = process.env.MINI_COMPUTER_AGENT_TOKEN;
const DEFAULT_ROOT = path.resolve(process.env.MINI_COMPUTER_WORKSPACE || path.join(__dirname, "..", "workspace"));
const ALLOWED_ROOTS = (process.env.MINI_COMPUTER_ALLOWED_ROOTS || DEFAULT_ROOT)
  .split(";").map((p) => path.resolve(p.trim())).filter(Boolean);
const MAX_FILE_BYTES = 512 * 1024;
let stopping = false;
let reconnectTimer;

if (!CLOUD_URL || !AGENT_TOKEN) {
  console.error("Set MINI_COMPUTER_CLOUD_AGENT_URL and MINI_COMPUTER_AGENT_TOKEN before starting the agent.");
  process.exit(1);
}
if (!CLOUD_URL.startsWith("wss://") && !/^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/agent$/.test(CLOUD_URL)) {
  console.error("Use wss:// for cloud connections; ws:// is allowed only for localhost testing.");
  process.exit(1);
}

async function safePath(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("A path is required.");
  const full = path.resolve(input);
  const root = ALLOWED_ROOTS.find((candidate) => full === candidate || full.startsWith(candidate + path.sep));
  if (!root) throw new Error("Path is outside the configured allowed roots.");
  let existing = full;
  while (true) {
    try { await fs.lstat(existing); break; }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; const parent = path.dirname(existing); if (parent === existing) throw error; existing = parent; }
  }
  const realRoot = await fs.realpath(root);
  const realExisting = await fs.realpath(existing);
  if (realExisting !== realRoot && !realExisting.startsWith(realRoot + path.sep)) throw new Error("Path resolves outside the configured allowed root.");
  return full;
}

async function handle(message) {
  const { id, operation, args = {} } = message;
  try {
    let result;
    if (operation === "health") {
      result = { ok: true, roots: ALLOWED_ROOTS.length };
    } else if (operation === "list_files") {
      const root = await safePath(args.path || DEFAULT_ROOT);
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) throw new Error("Path is not a directory.");
      const entries = await fs.readdir(root, { withFileTypes: true });
      result = await Promise.all(entries.filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== ".git")
        .map(async (entry) => {
          const full = path.join(root, entry.name);
          if (entry.isSymbolicLink()) return null;
          if (entry.isDirectory()) return { name: entry.name, path: full, type: "directory" };
          if (entry.isFile()) return { name: entry.name, path: full, type: "file", size: (await fs.stat(full)).size };
          return null;
        }));
      result = result.filter(Boolean);
    } else if (operation === "read_file") {
      const full = await safePath(args.path);
      const stat = await fs.lstat(full);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Only regular files can be read.");
      if (stat.size > MAX_FILE_BYTES) throw new Error("File exceeds 512 KB limit.");
      result = { path: full, content: await fs.readFile(full, "utf8") };
    } else if (operation === "write_file") {
      const full = await safePath(args.path);
      if (typeof args.content !== "string" || Buffer.byteLength(args.content, "utf8") > MAX_FILE_BYTES) throw new Error("Content must be text no larger than 512 KB.");
      await fs.mkdir(path.dirname(full), { recursive: true });
      const existing = await fs.lstat(full).catch(() => null);
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Only regular files can be replaced.");
      await fs.writeFile(full, args.content, { encoding: "utf8", flag: "w" });
      result = { path: full, bytes: Buffer.byteLength(args.content, "utf8") };
    } else if (operation === "run_command") {
      result = await runAllowedCommand(args, safePath, DEFAULT_ROOT);
    } else {
      throw new Error("Unsupported agent operation.");
    }
    return { id, ok: true, result };
  } catch (error) {
    return { id, ok: false, error: error instanceof Error ? error.message : "Agent operation failed." };
  }
}

function connect() {
  if (stopping) return;
  const ws = new WebSocket(CLOUD_URL, { headers: { Authorization: `Bearer ${AGENT_TOKEN}` }, handshakeTimeout: 15000, maxPayload: 1024 * 1024 });
  let heartbeat;
  ws.on("open", () => {
    console.log("Connected to Mini Computer cloud relay.");
    ws.send(JSON.stringify({ type: "agent_hello", protocol: 1 }));
    heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "heartbeat", at: Date.now() }));
    }, 4 * 60 * 1000);
  });
  ws.on("message", async (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.type !== "request" || typeof message.id !== "string") return;
    const response = await handle(message);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "response", ...response }));
  });
  ws.on("close", () => {
    clearInterval(heartbeat);
    if (!stopping) {
      console.log("Cloud connection closed; reconnecting in 5 seconds.");
      reconnectTimer = setTimeout(connect, 5000);
    }
  });
  ws.on("error", (error) => console.error("Cloud connection error:", error.message));
}

process.on("SIGINT", () => { stopping = true; clearTimeout(reconnectTimer); process.exit(0); });
process.on("SIGTERM", () => { stopping = true; clearTimeout(reconnectTimer); process.exit(0); });
console.log("Mini Computer Windows agent starting.");
console.log("Allowed roots:", ALLOWED_ROOTS.join("; "));
connect();
