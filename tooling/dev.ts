// `bun run dev`: runs the hub and web portal concurrently with prefixed logs and
// tears both down on SIGINT/SIGTERM. Env is passed through untouched.
import { resolve } from "node:path";

type Proc = {
  name: string;
  cmd: string[];
  cwd: string;
  child: ReturnType<typeof Bun.spawn>;
};

const ROOT = resolve(import.meta.dir, "..");

// The Vite dev portal (:5173) proxies /api to the hub, which must trust its origin; a developer's own env wins.
const SERVICES: Array<{ name: string; cmd: string[]; cwd: string; env: Record<string, string> }> = [
  { name: "hub", cmd: ["bun", "--conditions=intx-src", "src/server.ts"], cwd: `${ROOT}/apps/hub`, env: { PORTAL_ORIGIN: "http://localhost:5173" } },
  { name: "web", cmd: ["bun", "run", "dev"], cwd: `${ROOT}/apps/web`, env: {} },
];

let shuttingDown = false;
let failed = false;
const procs: Proc[] = [];

const decoder = new TextDecoder();

async function pump(
  stream: ReadableStream<Uint8Array>,
  prefix: string,
  out: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) out(`${prefix} ${line}`);
    }
    if (buf.length > 0) out(`${prefix} ${buf}`);
  } catch {
    // The stream closes underneath us during shutdown.
  } finally {
    reader.releaseLock();
  }
}

function logLine(line: string) {
  console.log(line);
}

function logErrorLine(line: string) {
  console.error(line);
}

async function superviseExit(proc: Proc): Promise<void> {
  const code = await proc.child.exited;
  if (shuttingDown) return;
  if (code !== 0) failed = true;
  console.error(`[dev] ${proc.name} exited with code ${code} — stopping the rest.`);
  await shutdown(code === 0 ? 0 : 1);
}

function spawnAll(): void {
  for (const svc of SERVICES) {
    const child = Bun.spawn(svc.cmd, {
      cwd: svc.cwd,
      env: { ...svc.env, ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const proc: Proc = { ...svc, child };
    procs.push(proc);
    console.log(`[dev] ${svc.name} started (pid ${child.pid}): ${svc.cmd.join(" ")}`);
    void pump(child.stdout, `[${svc.name}]`, logLine);
    void pump(child.stderr, `[${svc.name}:err]`, logErrorLine);
    void superviseExit(proc);
  }
}

function killTree(proc: Proc, signal: "SIGTERM" | "SIGKILL"): void {
  if (proc.child.exitCode !== null) return;
  try {
    process.kill(-proc.child.pid, signal);
    return;
  } catch {
    // Not a process-group leader; fall back to killing the child directly.
  }
  try {
    proc.child.kill(signal);
  } catch {
    // Already exited.
  }
}

async function exitedOrNull(proc: Proc): Promise<number | null> {
  try {
    return await proc.child.exited;
  } catch {
    return null;
  }
}

async function killAfterGrace(): Promise<void> {
  await Bun.sleep(5000);
  for (const proc of procs) killTree(proc, "SIGKILL");
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[dev] shutting down…");
  for (const proc of procs) killTree(proc, "SIGTERM");
  const exits = Promise.all(procs.map(exitedOrNull));
  await Promise.race([exits, killAfterGrace()]);
  await Promise.race([exits, Bun.sleep(1000)]);
  console.log("[dev] all stopped.");
  process.exit(exitCode !== 0 || failed ? 1 : 0);
}

function onSignal() {
  void shutdown(0);
}

process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

spawnAll();
