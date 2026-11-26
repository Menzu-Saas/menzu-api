import { createClient } from "@supabase/supabase-js";
import { isUuid } from "@/lib/uuid";
import { isQueueWorker } from "@/server/orders/queue-client";
import { placeOrder, toOrderApiError } from "@/server/orders/place-order";
import { openCpfForOrder } from "@/server/payments/cpf-vault";
import { ORDER_BODY_MAX_BYTES, readJsonBody } from "@/server/rate-limit";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!isQueueWorker(request)) return new Response(null, { status: 404, headers });
  const serverKey = process.env.MENZU_ORDER_API_KEY?.trim();
  let ready = false;
  if (serverKey) {
    try {
      const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { data, error } = await client.rpc("menzu_guest_order_ready", { p_server_key: serverKey })
        .abortSignal(AbortSignal.timeout(2_000));
      ready = !error && data === true;
    } catch {
      ready = false;
    }
  }
  return Response.json({ ready }, { status: ready ? 200 : 503, headers });
}

export async function POST(request: Request) {
  if (!isQueueWorker(request)) return new Response(null, { status: 404 });
  const job = await readJsonBody(request, ORDER_BODY_MAX_BYTES + 2048) as { payload?: unknown; ip?: unknown; key?: unknown; cpfSealed?: unknown } | undefined;
  if (!isUuid(job?.key) || typeof job?.ip !== "string") return Response.json({ error: { code: "INVALID_PAYLOAD", message: "Dados do pedido inválidos." } }, { status: 400 });
  // O CPF só existe aqui, em memória, para emitir a cobrança. Se não abrir, a cobrança falha com CPF_REQUIRED.
  let cpfCnpj: string | undefined;
  if (typeof job.cpfSealed === "string") {
    try { cpfCnpj = openCpfForOrder(job.cpfSealed, job.key); } catch { cpfCnpj = undefined; }
  }
  try {
    const { orderId, number, totalCents, publicToken } = await placeOrder(job.payload, { clientIp: job.ip, idempotencyKey: job.key, cpfCnpj });
    return Response.json({ orderId, number, totalCents, publicToken }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const failure = toOrderApiError(error);
    return Response.json(failure.toJSON(), { status: failure.status, headers: { "Cache-Control": "no-store" } });
  }
}
