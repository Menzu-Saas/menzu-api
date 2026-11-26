// Production start on a single server (Render): the Next.js app (site + API), the order queue and the
// payment sweeper. The queue and the sweeper only talk to the app over the loopback interface.
// If the app or the queue dies, everything stops so the platform restarts the service cleanly.
import { spawn } from "node:child_process";
import { resolveEnv } from "./env-compat.mjs";

const port = String(process.env.PORT || 10000);
const queuePort = String(process.env.MENZU_QUEUE_PORT || 3103);
const app = `http://127.0.0.1:${port}`;

const resolved = resolveEnv(process.env);
for (const warning of resolved.warnings) console.warn(`[start] ${warning}`);

const env = {
  ...resolved.env,
  MENZU_QUEUE_PORT: queuePort,
  MENZU_QUEUE_HOST: "127.0.0.1",
  MENZU_QUEUE_URL: `http://127.0.0.1:${queuePort}`,
  MENZU_QUEUE_WORKER_URL: app,
  ASAAS_SWEEP_URL: app,
};

if (!env.MENZU_QUEUE_DB) throw new Error("Configure MENZU_QUEUE_DB em um disco persistente.");

const children = new Map();
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) child.kill("SIGTERM");
  // The queue finishes writing to disk on SIGTERM; do not wait forever.
  setTimeout(() => process.exit(code), 10_000).unref();
  process.exitCode = code;
}

function start(name, args, { essential = true } = {}) {
  const child = spawn(process.execPath, args, { stdio: "inherit", env });
  children.set(name, child);
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (stopping) return;
    console.error(`[start] ${name} encerrou (${signal ?? code})`);
    if (essential) stop(1);
    else setTimeout(() => !stopping && start(name, args, { essential }), 30_000);
  });
}

start("app", ["node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", port]);
start("fila", ["scripts/order-queue.mjs"]);
// The sweeper needs its secret; without it the site still works and webhooks still confirm payments.
if ((env.ASAAS_RECONCILE_SECRET?.length ?? 0) >= 32) start("varredor", ["scripts/asaas-sweeper.mjs"], { essential: false });
else console.warn("[start] ASAAS_RECONCILE_SECRET ausente: varredor de pagamentos desligado.");

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));
