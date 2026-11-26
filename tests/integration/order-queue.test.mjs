import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("fila persistente limita admissão, reexecuta com a mesma chave e guarda o resultado", { timeout: 20_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "menzu-queue-"));
  const secret = randomBytes(32).toString("hex");
  const authorization = `Bearer ${secret}`;
  const orderId = randomUUID();
  const keys = [randomUUID(), randomUUID(), randomUUID()];
  const calls = [];
  let workerReady = true;
  let probes = 0;
  const worker = createServer(async (req, res) => {
    if (req.method === "GET") {
      assert.equal(req.headers.authorization, authorization);
      assert.equal(req.url, "/api/internal/orders/process");
      probes++;
      res.writeHead(workerReady ? 200 : 503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ready: workerReady }));
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const { key, payload } = JSON.parse(raw);
    calls.push({ key, at: Date.now(), authorization: req.headers.authorization, path: req.url });
    const failed = key === keys[0] && calls.filter((call) => call.key === key).length === 1;
    if (payload.restaurant_slug === "closed") {
      res.writeHead(409, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { code: "RESTAURANT_CLOSED" } }));
    }
    res.writeHead(failed ? 503 : 201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(failed ? { error: { code: "UNAVAILABLE" } } : { orderId, number: 1, totalCents: 1000, publicToken: "test-token" }));
  }).listen(0, "127.0.0.1");
  const processes = [];
  async function start(rate) {
    const processHandle = spawn(process.execPath, [fileURLToPath(new URL("../../scripts/order-queue.mjs", import.meta.url))], {
      env: {
        ...process.env,
        MENZU_QUEUE_SECRET: secret, MENZU_QUEUE_WORKER_URL: `http://127.0.0.1:${worker.address().port}`,
        MENZU_QUEUE_DB: join(temp, "queue.sqlite"), MENZU_QUEUE_HOST: "127.0.0.1", MENZU_QUEUE_PORT: "0",
        MENZU_QUEUE_CAPACITY: "2", MENZU_QUEUE_RATE: String(rate), MENZU_QUEUE_CONCURRENCY: "1", MENZU_QUEUE_WAIT_MS: "15000",
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    processes.push(processHandle);
    const lines = createInterface({ input: processHandle.stdout });
    const port = await new Promise((resolve, reject) => {
      lines.once("line", (line) => resolve(Number(line.match(/\d+$/)?.[0])));
      processHandle.once("exit", (code) => reject(new Error(`Fila saiu antes de iniciar (${code}).`)));
      processHandle.once("error", reject);
    });
    assert.ok(port);
    return { processHandle, origin: `http://127.0.0.1:${port}` };
  }
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  function request(origin, key, payload, auth = authorization) {
    return fetch(`${origin}/jobs/${key}`, {
      method: payload ? "PUT" : "GET",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: payload && JSON.stringify({ payload, ip: "test" }),
      signal: AbortSignal.timeout(2_000),
    });
  }
  function health(origin, auth = authorization) {
    return fetch(`${origin}/health`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(4_000) });
  }
  async function result(origin, key) {
    for (let tries = 0; tries < 100; tries++) {
      const response = await request(origin, key);
      if (response.status !== 202) return response;
      await sleep(80);
    }
    assert.fail("O job não terminou.");
  }
  const payload = { restaurant_slug: "loja-a" };
  try {
    await once(worker, "listening");
    const before = await start(1);
    assert.equal((await request(before.origin, keys[0], payload, "invalid")).status, 404);
    assert.equal((await health(before.origin, "invalid")).status, 404);
    const [accepted, duplicate] = await Promise.all([
      request(before.origin, keys[0], payload),
      request(before.origin, keys[0], payload),
    ]);
    assert.equal(accepted.status, 202);
    assert.equal(duplicate.status, 202);
    assert.equal(accepted.headers.get("retry-after"), "2");
    assert.equal((await request(before.origin, keys[1], { restaurant_slug: "loja-b" })).status, 202);
    const ready = await health(before.origin);
    assert.equal(ready.status, 200);
    assert.equal(ready.headers.get("cache-control"), "no-store");
    const metrics = await ready.json();
    assert.deepEqual(metrics, { ready: true, backlog: 2, oldestPendingAgeMs: metrics.oldestPendingAgeMs, failed: 0, capacity: 2 });
    assert.ok(Number.isInteger(metrics.oldestPendingAgeMs) && metrics.oldestPendingAgeMs >= 0);
    assert.equal(probes, 1);
    assert.equal((await request(before.origin, keys[0], payload)).status, 202);
    assert.equal((await request(before.origin, keys[0], { restaurant_slug: "other" })).status, 409);
    const full = await request(before.origin, keys[2], payload);
    assert.equal(full.status, 503);
    assert.equal((await full.json()).error.code, "QUEUE_FULL");
    await stop(before.processHandle);
    assert.equal(calls.length, 0, "Os dois pedidos devem sobreviver ao reinício antes de qualquer processamento");

    const after = await start(5);
    assert.equal((await result(after.origin, keys[1])).status, 200);
    const final = await result(after.origin, keys[0]);
    assert.equal(final.status, 200);
    assert.equal((await final.json()).orderId, orderId);
    assert.equal((await request(after.origin, keys[0], payload)).status, 201);
    assert.equal((await request(after.origin, keys[2], payload)).status, 202);
    assert.equal((await result(after.origin, keys[2])).status, 200);
    assert.equal((await request(after.origin, randomUUID())).status, 404);
    assert.deepEqual(calls.map((call) => call.key), [keys[0], keys[1], keys[0], keys[2]]);
    for (const [index, call] of calls.entries()) {
      assert.equal(call.authorization, authorization);
      assert.equal(call.path, "/api/internal/orders/process");
      if (index > 0) assert.ok(call.at - calls[index - 1].at >= 175);
    }

    const closed = randomUUID();
    assert.equal((await request(after.origin, closed, { restaurant_slug: "closed" })).status, 202);
    assert.equal((await result(after.origin, closed)).status, 409);
    workerReady = false;
    await sleep(5_050);
    const unready = await health(after.origin);
    assert.equal(unready.status, 503);
    assert.deepEqual(await unready.json(), { ready: false, backlog: 0, oldestPendingAgeMs: null, failed: 1, capacity: 2 });
    const refused = randomUUID();
    const unavailable = await request(after.origin, refused, payload);
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error.code, "QUEUE_UNAVAILABLE");
    assert.equal((await request(after.origin, refused)).status, 404);
    assert.equal((await request(after.origin, keys[0])).status, 200);
    assert.equal((await request(after.origin, keys[0], payload)).status, 201);
    workerReady = true;
    await sleep(1_050);
    assert.equal((await health(after.origin)).status, 200);
  } finally {
    await Promise.all(processes.map(stop));
    await new Promise((resolve) => worker.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
