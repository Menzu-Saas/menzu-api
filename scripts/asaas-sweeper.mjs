// Calls /api/internal/asaas/reconcile on a fixed interval: reprocesses stored webhook events and asks
// Asaas about open charges, so a payment is confirmed even if its webhook never arrives.
//   npm run asaas:sweep            runs until stopped
//   npm run asaas:sweep -- --once  runs one pass and exits (for an external scheduler or a check)
const secret = process.env.ASAAS_RECONCILE_SECRET;
if (!secret || secret.length < 32) throw new Error("Configure ASAAS_RECONCILE_SECRET com pelo menos 32 caracteres.");
const base = process.env.ASAAS_SWEEP_URL || process.env.MENZU_QUEUE_WORKER_URL;
if (!base) throw new Error("Configure ASAAS_SWEEP_URL (ou MENZU_QUEUE_WORKER_URL) com o endereço do aplicativo.");
const url = new URL("/api/internal/asaas/reconcile", base);
const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
if (url.protocol !== "https:" && !local) throw new Error("Fora do computador local o endereço precisa ser https.");

const seconds = Number(process.env.ASAAS_SWEEP_SECONDS || 60);
if (!Number.isInteger(seconds) || seconds < 15 || seconds > 3600) throw new Error("ASAAS_SWEEP_SECONDS deve ficar entre 15 e 3600.");

const log = (message) => console.log(`[asaas-sweeper] ${new Date().toISOString()} ${message}`);

async function pass() {
  try {
    const response = await fetch(url, {
      method: "POST", headers: { authorization: `Bearer ${secret}` }, redirect: "error", signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      log(`falhou: HTTP ${response.status}`);
      return false;
    }
    const result = await response.json();
    log(`ok ${JSON.stringify(result)}`);
    return true;
  } catch (error) {
    log(`falhou: ${error instanceof Error ? error.message : "erro desconhecido"}`);
    return false;
  }
}

if (process.argv.includes("--once")) {
  process.exitCode = (await pass()) ? 0 : 1;
} else {
  log(`a cada ${seconds}s em ${url.origin}`);
  // The next pass is scheduled only after the previous one ends, so passes never overlap.
  const loop = async () => {
    await pass();
    setTimeout(loop, seconds * 1000);
  };
  await loop();
}
