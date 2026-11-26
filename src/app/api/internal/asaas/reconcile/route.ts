import { timingSafeEqual } from "node:crypto";
import { defaultReconcileDeps, reconcileAsaasInbox, sweepPendingAsaasPayments } from "@/server/payments/asaas-reconciler";
import { sweepAsaasSubscriptions } from "@/server/payments/asaas-subscription";

export const runtime = "nodejs";

function authorized(request: Request): boolean {
  const expected = process.env.ASAAS_RECONCILE_SECRET ?? "";
  const received = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (expected.length < 32 || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Call from a scheduler (every minute or so). Reprocesses events that stayed in the inbox and then asks
 * Asaas about charges still open, so a payment is confirmed even if its webhook never arrived.
 */
// Plans change slowly: their charges are re-read at most every 10 minutes to spare the Asaas API.
const PLAN_SWEEP_MS = 10 * 60_000;
let lastPlanSweep = 0;

export async function POST(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 404 });
  try {
    const deps = defaultReconcileDeps();
    const inbox = await reconcileAsaasInbox(deps, 50);
    const sweep = await sweepPendingAsaasPayments(deps);
    let plans: { applied: number; failed: number } | "skipped" = "skipped";
    if (Date.now() - lastPlanSweep >= PLAN_SWEEP_MS) {
      lastPlanSweep = Date.now();
      plans = await sweepAsaasSubscriptions(deps.db, deps.menzuClient ?? null);
    }
    return Response.json({ inbox, sweep, plans }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "RECONCILE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
