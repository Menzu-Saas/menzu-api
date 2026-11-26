import { cpfDigits, isValidCpf } from "@/lib/cpf";
import { isUuid } from "@/lib/uuid";
import { getSessionUser } from "@/server/auth";
import { isOnlineMethod } from "@/server/payments";
import { getBuyerCpf, sealCpfForOrder } from "@/server/payments/cpf-vault";
import { parseOrderPayload, toOrderApiError, OrderApiError } from "@/server/orders/place-order";
import { queueRequest } from "@/server/orders/queue-client";
import {
  clientIp,
  createRateLimiter,
  exceedsContentLength,
  ORDER_BODY_MAX_BYTES,
  readJsonBody,
} from "@/server/rate-limit";

// First-line per-IP brake, per server instance (see rate-limit.ts). The authoritative per-client,
// per-phone and per-restaurant limits run in create_order, keyed by the client fingerprint.
const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

function errorResponse(e: OrderApiError, headers?: HeadersInit) {
  return Response.json(e.toJSON(), { status: e.status, headers });
}

/** CPF enviado pelo comprador; senão, o guardado na conta dele. Sem nenhum, o pedido online é recusado. */
async function sealedCpf(body: object, orderKey: string): Promise<string> {
  const sent = (body as Record<string, unknown>).cpf;
  let cpf = typeof sent === "string" ? cpfDigits(sent) : "";
  if (!isValidCpf(cpf)) {
    cpf = "";
    const user = await getSessionUser();
    if (user) cpf = (await getBuyerCpf(user.id).catch(() => null)) ?? "";
  }
  if (!isValidCpf(cpf)) throw new OrderApiError(400, "CPF_REQUIRED", "Informe seu CPF para pagar online.");
  return sealCpfForOrder(cpf, orderKey);
}

export async function POST(req: Request) {
  const ip = clientIp(req.headers);
  const rate = limiter(`orders:${ip}`);
  if (!rate.ok) {
    return errorResponse(new OrderApiError(429, "RATE_LIMITED", "Muitas tentativas. Aguarde um instante e tente novamente."), {
      "Retry-After": String(rate.retryAfterSeconds),
    });
  }

  if (exceedsContentLength(req, ORDER_BODY_MAX_BYTES)) {
    return errorResponse(new OrderApiError(413, "INVALID_PAYLOAD", "Dados do pedido inválidos."));
  }

  const body = await readJsonBody(req, ORDER_BODY_MAX_BYTES);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse(new OrderApiError(400, "INVALID_PAYLOAD", "Dados do pedido inválidos."));
  }
  // Honeypot: real customers never fill the hidden "website" field.
  const website = (body as Record<string, unknown>).website;
  if (website !== undefined && website !== null && website !== "") {
    return errorResponse(new OrderApiError(400, "INVALID_PAYLOAD", "Dados do pedido inválidos."));
  }

  const idempotencyKey = req.headers.get("Idempotency-Key");
  if (!isUuid(idempotencyKey)) return errorResponse(new OrderApiError(400, "INVALID_PAYLOAD", "Tentativa de pedido inválida. Recarregue a página."));
  try {
    const key = idempotencyKey.toLowerCase();
    const payload = parseOrderPayload(body);
    // O CPF só é exigido no pagamento online e nunca entra no pedido: a fila grava o pedido em disco,
    // então ele segue cifrado, preso à chave deste pedido.
    const cpfSealed = isOnlineMethod(payload.payment_method) ? await sealedCpf(body, key) : undefined;
    return await queueRequest(req, key, { payload, ip, cpfSealed });
  } catch (e) {
    const err = toOrderApiError(e);
    if (err.status >= 500) console.error("[api/orders] pedido indisponível", err.code);
    return errorResponse(err);
  }
}
