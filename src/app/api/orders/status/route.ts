import { isUuid } from "@/lib/uuid";
import { queueRequest } from "@/server/orders/queue-client";
import { clientIp, createRateLimiter } from "@/server/rate-limit";

const limiter = createRateLimiter({ limit: 90, windowMs: 60_000 });

export async function GET(request: Request) {
  const key = request.headers.get("Idempotency-Key");
  if (!isUuid(key)) return Response.json({ error: { code: "ATTEMPT_NOT_FOUND", message: "Tentativa não encontrada." } }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const rate = limiter(`order-status:${clientIp(request.headers)}`);
  if (!rate.ok) return Response.json({ error: { code: "RATE_LIMITED", message: "Aguarde antes de consultar novamente." } }, {
    status: 429,
    headers: { "Cache-Control": "no-store", "Retry-After": String(rate.retryAfterSeconds) },
  });
  return queueRequest(request, key.toLowerCase());
}
