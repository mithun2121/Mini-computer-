import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const ALLOWED = new Set(["git", "node", "npm", "pnpm", "python", "py", "docker", "where.exe", "whoami.exe", "ipconfig.exe", "ping.exe", "tracert.exe"]);

export async function runAllowedCommand(args, safePath, defaultRoot) {
  const program = String(args?.program || "");
  const argv = args?.args;
  if (!ALLOWED.has(program)) throw new Error("Program is not in the approved command allowlist.");
  if (!Array.isArray(argv) || argv.length > 24 || argv.some((a) => typeof a !== "string" || a.length > 2048)) throw new Error("Arguments must be at most 24 strings, each no longer than 2048 characters.");
  const cwd = await safePath(args.cwd || defaultRoot);
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error("Working directory must be an allowed directory.");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/i.test(key)));
  return await new Promise((resolve, reject) => {
    const child = spawn(program, argv, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", done = false;
    const cap = (old, chunk) => (old + chunk.toString("utf8")).slice(-32768);
    const timer = setTimeout(() => { if (!done) { done = true; child.kill(); reject(new Error("Command timed out after 30 seconds.")); } }, 30000);
    child.stdout.on("data", (chunk) => { stdout = cap(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = cap(stderr, chunk); });
    child.on("error", (error) => { if (done) return; done = true; clearTimeout(timer); reject(new Error(`Could not start command: ${error.message}`)); });
    child.on("close", (exitCode, signal) => { if (done) return; done = true; clearTimeout(timer); resolve({ program, args: argv, cwd, exitCode, signal, stdout, stderr }); });
  });
}
