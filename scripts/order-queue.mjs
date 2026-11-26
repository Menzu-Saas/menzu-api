import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Configuração inválida: ${name}`);
  return value;
}

const secret = process.env.MENZU_QUEUE_SECRET;
if (!secret || secret.length < 32) throw new Error("Configure MENZU_QUEUE_SECRET com pelo menos 32 caracteres.");
const auth = Buffer.from(`Bearer ${secret}`);
const workerUrl = new URL("/api/internal/orders/process", process.env.MENZU_QUEUE_WORKER_URL);
const port = integer("MENZU_QUEUE_PORT", 3103, 0, 65_535);
const capacity = integer("MENZU_QUEUE_CAPACITY", 250, 1, 100_000);
const rate = integer("MENZU_QUEUE_RATE", 5, 1, 1_000);
const concurrency = integer("MENZU_QUEUE_CONCURRENCY", 4, 1, 128);
const waitMs = integer("MENZU_QUEUE_WAIT_MS", 180_000, 1_000, 900_000);
const dbPath = process.env.MENZU_QUEUE_DB;
if (!dbPath || dbPath === ":memory:") throw new Error("Configure MENZU_QUEUE_DB em disco persistente.");
process.umask(0o077);
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA secure_delete = ON;
  CREATE TABLE IF NOT EXISTS jobs (
    key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, job TEXT,
    enqueued_at INTEGER NOT NULL, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    status INTEGER, result TEXT, expires_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(due_at, enqueued_at) WHERE status IS NULL;
  CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs(expires_at) WHERE status IS NOT NULL;
`);

const find = db.prepare("SELECT fingerprint, status, result FROM jobs WHERE key = ?");
const count = db.prepare("SELECT count(*) AS total FROM jobs WHERE status IS NULL");
const metrics = db.prepare(`
  SELECT count(*) AS backlog, min(enqueued_at) AS oldest,
    (SELECT count(*) FROM jobs WHERE status != 201 AND expires_at > ?) AS failed
  FROM jobs WHERE status IS NULL
`);
const insert = db.prepare("INSERT INTO jobs (key,fingerprint,job,enqueued_at,due_at) VALUES (?,?,?,?,?)");
const purge = db.prepare("DELETE FROM jobs WHERE expires_at <= ?");
const claim = db.prepare(`
  UPDATE jobs SET due_at = ?, attempts = attempts + 1
  WHERE key = (SELECT key FROM jobs WHERE status IS NULL AND due_at <= ? ORDER BY due_at, enqueued_at LIMIT 1)
  RETURNING key, job, attempts, enqueued_at
`);
const finish = db.prepare("UPDATE jobs SET status = ?, result = ?, job = NULL, expires_at = ? WHERE key = ?");
const retry = db.prepare("UPDATE jobs SET due_at = ? WHERE key = ?");
const expire = db.prepare(`
  UPDATE jobs SET status = CASE WHEN attempts = 0 THEN 408 ELSE 503 END,
    result = CASE WHEN attempts = 0 THEN ? ELSE ? END, job = NULL, expires_at = ?
  WHERE status IS NULL AND enqueued_at <= ? AND (attempts = 0 OR due_at <= ?)
`);
const retention = 24 * 60 * 60 * 1000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const error = (code, message) => ({ error: { code, message } });
const pending = { state: "pending" };
const expired = error("QUEUE_EXPIRED", "O pedido expirou na fila sem ser enviado. Tente novamente.");
const unavailable = error("QUEUE_UNAVAILABLE", "Envio temporariamente indisponível.");
const unconfirmed = error("ORDER_UNCONFIRMED", "Não foi possível confirmar o pedido. Consulte o restaurante antes de fazer outro.");
let ready = false;
let probeExpiresAt = 0;
let probe;
let active = 0;
let stopping = false;

async function workerAvailable() {
  if (Date.now() < probeExpiresAt) return ready;
  probe ??= (async () => {
    try {
      const response = await fetch(workerUrl, {
        headers: { authorization: auth.toString() },
        redirect: "error", signal: AbortSignal.timeout(3_000),
      });
      ready = response.status === 200 && (await response.json())?.ready === true;
    } catch {
      ready = false;
    } finally {
      probeExpiresAt = Date.now() + (ready ? 5_000 : 1_000);
      probe = undefined;
    }
    return ready;
  })();
  return probe;
}

function reply(res, status, body, retryAfter) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...(retryAfter && { "Retry-After": String(retryAfter) }),
  });
  res.end(JSON.stringify(body));
}

async function readJob(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 34 * 1024) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  try {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== auth.length || !timingSafeEqual(supplied, auth)) {
      return reply(res, 404, error("ATTEMPT_NOT_FOUND", "Tentativa não encontrada."));
    }
    if (req.url === "/health" && req.method === "GET") {
      const available = await workerAvailable() && !stopping;
      const now = Date.now();
      const { backlog, oldest, failed } = metrics.get(now);
      return reply(res, available ? 200 : 503, {
        ready: available, backlog, oldestPendingAgeMs: oldest === null ? null : Math.max(0, now - oldest),
        failed, capacity,
      }, available ? undefined : 3);
    }
    const key = req.url?.slice(6) ?? "";
    if (!req.url?.startsWith("/jobs/") || !uuid.test(key)) {
      return reply(res, 404, error("ATTEMPT_NOT_FOUND", "Tentativa não encontrada."));
    }
    if (req.method === "GET") {
      const row = find.get(key);
      if (!row) return reply(res, 404, error("ATTEMPT_NOT_FOUND", "Tentativa não encontrada."));
      return row.status ? reply(res, row.status === 201 ? 200 : row.status, JSON.parse(row.result)) : reply(res, 202, pending, 2);
    }
    if (req.method !== "PUT") return reply(res, 405, error("METHOD_NOT_ALLOWED", "Método indisponível."));
    const job = await readJob(req);
    if (!job?.payload || typeof job.ip !== "string" || job.ip.length > 128) {
      return reply(res, 400, error("INVALID_PAYLOAD", "Dados do pedido inválidos."));
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(job.payload)).digest("hex");
    let row = find.get(key);
    if (!row) {
      const available = await workerAvailable();
      // Recheck after the shared probe so concurrent submissions still admit each key once.
      row = find.get(key);
      if (!row && (!available || stopping)) return reply(res, 503, unavailable, 3);
    }
    if (row) {
      if (row.fingerprint !== fingerprint) return reply(res, 409, error("IDEMPOTENCY_CONFLICT", "Esta tentativa já foi usada com outros dados."));
      return row.status ? reply(res, row.status, JSON.parse(row.result)) : reply(res, 202, pending, 2);
    }
    if (count.get().total >= capacity) return reply(res, 503, error("QUEUE_FULL", "Muitos pedidos aguardando. Tente novamente em instantes."), 3);
    const now = Date.now();
    insert.run(key, fingerprint, JSON.stringify({ ...job, key }), now, now);
    reply(res, 202, pending, 2);
  } catch {
    if (!res.headersSent) reply(res, 503, unavailable, 3);
  }
});

async function processJob() {
  if (stopping || active >= concurrency) return;
  const now = Date.now();
  if (!ready || now >= probeExpiresAt) {
    if (count.get().total) await workerAvailable();
    return;
  }
  const row = claim.get(now + 45_000, now);
  if (!row) return;
  active++;
  try {
    let status = 503;
    let result = unconfirmed;
    if (row.attempts === 1 && now - row.enqueued_at >= waitMs) {
      status = 408;
      result = expired;
    } else {
      try {
        const response = await fetch(workerUrl, {
          method: "POST", headers: { authorization: auth.toString(), "Content-Type": "application/json" },
          body: row.job, redirect: "error", signal: AbortSignal.timeout(20_000),
        });
        if (response.status === 404) probeExpiresAt = 0;
        const body = await response.json();
        if (response.status === 503 && body?.error?.code === "ORDERS_UNAVAILABLE") probeExpiresAt = 0;
        if (response.status === 201 && uuid.test(body?.orderId) && typeof body?.publicToken === "string" && body.publicToken) {
          status = 201;
          result = body;
        } else if (response.status >= 400 && response.status < 500 && body?.error?.code) {
          status = response.status;
          result = body;
        }
      } catch {
        // A lost response may have committed. Retry only with the original idempotency key.
      }
    }
    if (status === 503 && row.attempts < 4 && Date.now() - row.enqueued_at < waitMs) {
      retry.run(Date.now() + 1_000 * 2 ** row.attempts, row.key);
    } else {
      finish.run(status, JSON.stringify(result), Date.now() + retention, row.key);
    }
  } finally {
    active--;
  }
}

const timer = setInterval(() => {
  void processJob().catch(() => console.error("[order-queue] falha ao processar a fila"));
}, Math.ceil(1000 / rate));
const cleanup = setInterval(() => purge.run(Date.now()), 60_000);
const expiry = setInterval(() => {
  const now = Date.now();
  expire.run(JSON.stringify(expired), JSON.stringify(unconfirmed), now + retention, now - waitMs, now);
}, 1_000);
server.requestTimeout = 10_000;
server.listen(port, process.env.MENZU_QUEUE_HOST ?? "127.0.0.1", () => console.log(`Fila de pedidos na porta ${server.address().port}`));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    clearInterval(timer);
    clearInterval(cleanup);
    clearInterval(expiry);
    server.close(() => {
      const drain = setInterval(() => {
        if (active) return;
        clearInterval(drain);
        db.close();
      }, 100);
    });
  });
}
