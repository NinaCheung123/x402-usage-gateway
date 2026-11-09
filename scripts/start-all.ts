/**
 * Starts the RPC shield, facilitator and gateway together, each once the one
 * before it is ready. Ctrl-C stops all three. If any of them dies, this stops
 * the rest and says so, rather than looking healthy with a piece missing.
 *
 * `npm start` is the normal mode. `npm run start:demo` also turns on the switches
 * the demo uses to cause failures on purpose. Never expose demo mode to others.
 */
import { spawn, type ChildProcess } from "node:child_process";
import "dotenv/config";

const demoMode = process.argv.includes("--demo");
const env: NodeJS.ProcessEnv = {
  ...process.env,
  RPC_SHIELD_URL: process.env.RPC_SHIELD_URL ?? "http://localhost:8899",
  ALLOW_SIMULATED_FAILURES: demoMode ? "true" : "false",
};

const isUp = (check: () => Promise<Response>) => check().then(() => true, () => false);
const services = [
  {
    name: "rpc",
    file: "src/rpc-shield.ts",
    ready: () => fetch("http://localhost:8899", { method: "POST", body: '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' }),
  },
  { name: "facilitator", file: "src/facilitator.ts", ready: () => fetch("http://localhost:4022/supported") },
  { name: "gateway", file: "src/gateway.ts", ready: () => fetch("http://localhost:4021/s/atlas/pricing") },
];

const children = new Map<string, ChildProcess>();
let stopping = false;

async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  // Newest first, so the gateway can still claim what it's owed through the facilitator.
  for (const child of [...children.values()].reverse()) {
    if (child.exitCode !== null) continue;
    child.kill("SIGTERM");
    await new Promise((r) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL"); // Never leave a service behind holding its port.
        r(undefined);
      }, 15_000);
      child.once("exit", () => {
        clearTimeout(timer);
        r(undefined);
      });
    });
  }
  process.exit(code);
}
// Last resort if this process is stopped mid-shutdown.
process.on("exit", () => {
  for (const child of children.values()) if (child.exitCode === null) child.kill("SIGKILL");
});
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

for (const { name, file, ready } of services) {
  if (await isUp(ready)) {
    console.error(`Port for ${name} is already in use. Stop whatever is running there and try again.`);
    await stop(1);
  }
  const child = spawn(process.execPath, ["--import", "tsx", file], { env, stdio: ["ignore", "pipe", "pipe"] });
  const log = (d: Buffer) => process.stdout.write(d.toString().replace(/^(?=.)/gm, `[${name}] `));
  child.stdout!.on("data", log);
  child.stderr!.on("data", log);
  child.once("exit", (code) => {
    if (stopping) return;
    console.error(`\n${name} stopped unexpectedly (exit code ${code}). Stopping everything.`);
    void stop(1);
  });
  children.set(name, child);

  const deadline = Date.now() + 60_000;
  while (!(await isUp(ready))) {
    if (Date.now() > deadline) {
      console.error(`${name} wasn't ready after 60 seconds. Stopping everything.`);
      await stop(1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
console.log(`\nReady${demoMode ? " (demo mode: failure switches on)" : ""}. Dashboard: http://localhost:4021/`);
