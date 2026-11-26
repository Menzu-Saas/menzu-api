import { quoteOrder, toOrderApiError, OrderApiError } from "@/server/orders/place-order";
import {
  clientIp,
  createRateLimiter,
  exceedsContentLength,
  ORDER_BODY_MAX_BYTES,
  readJsonBody,
} from "@/server/rate-limit";

// Quotes are recalculated while the cart changes, so the brake is looser than for orders.
const limiter = createRateLimiter({ limit: 60, windowMs: 60_000 });

export async function POST(req: Request) {
  const rate = limiter(`quote:${clientIp(req.headers)}`);
  if (!rate.ok) {
    const e = new OrderApiError(429, "RATE_LIMITED", "Muitas tentativas. Aguarde um instante e tente novamente.");
    return Response.json(e.toJSON(), { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } });
  }

  if (exceedsContentLength(req, ORDER_BODY_MAX_BYTES)) {
    const e = new OrderApiError(413, "INVALID_PAYLOAD", "Dados do pedido inválidos.");
    return Response.json(e.toJSON(), { status: 413 });
  }

  const body = await readJsonBody(req, ORDER_BODY_MAX_BYTES);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const e = new OrderApiError(400, "INVALID_PAYLOAD", "Dados do pedido inválidos.");
    return Response.json(e.toJSON(), { status: 400 });
  }

  try {
    const quote = await quoteOrder(body);
    return Response.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const err = toOrderApiError(e);
    if (err.status >= 500) console.error("[api/orders/quote] unexpected error", e);
    return Response.json(err.toJSON(), { status: err.status });
  }
}
