import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST as enqueue } from "@/app/api/orders/route";
import { GET as status } from "@/app/api/orders/status/route";
import { GET as workerReadiness, POST as processOrder } from "@/app/api/internal/orders/process/route";
import { queueReady as guestOrderingAvailable } from "@/server/orders/queue-client";

vi.mock("server-only", () => ({}));
const createClient = vi.hoisted(() => vi.fn());
vi.mock("@supabase/supabase-js", () => ({ createClient }));

const broker = "http://127.0.0.1:3103";
const secret = "test-queue-credential-0123456789abcdef";
const key = "10000000-0000-4000-8000-000000000001";
const orderId = "10000000-0000-4000-8000-000000000002";
const payload = {
  restaurant_slug: "loja-teste", type: "PICKUP", customer: { name: "Maria Silva", phone: "11987654321" },
  payment_method: "CASH", items: [{ product_id: "10000000-0000-4000-8000-000000000003", quantity: 1 }],
};
const transport = vi.fn();
function orderRequest() {
  return new Request("https://app.test/api/orders", {
    method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ ...payload, server_key: "forged" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MENZU_QUEUE_URL", broker);
  vi.stubEnv("MENZU_QUEUE_SECRET", secret);
  vi.stubEnv("MENZU_ORDER_API_KEY", "test-order-key");
  vi.stubGlobal("fetch", transport);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("aceita 202 sem consultar o banco e encaminha só o corpo validado", async () => {
  transport.mockResolvedValueOnce(Response.json({ state: "pending" }, { status: 202, headers: { "Retry-After": "2" } }));
  const response = await enqueue(orderRequest());
  expect(response.status).toBe(202);
  expect(response.headers.get("location")).toBe("/api/orders/status");
  expect(response.headers.get("retry-after")).toBe("2");
  expect(transport.mock.calls[0][0].href).toBe(`${broker}/jobs/${key}`);
  expect(JSON.parse(transport.mock.calls[0][1].body).payload).not.toHaveProperty("server_key");
  expect(createClient).not.toHaveBeenCalled();
});

it("propaga lotação e falha da fila sem gravar diretamente", async () => {
  transport.mockResolvedValueOnce(Response.json({ error: { code: "QUEUE_FULL" } }, { status: 503, headers: { "Retry-After": "3" } }));
  const response = await enqueue(orderRequest());
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("3");
  expect(await response.json()).toMatchObject({ error: { code: "QUEUE_FULL" } });
  transport.mockRejectedValueOnce(new Error("connection refused"));
  expect((await enqueue(orderRequest())).status).toBe(503);
  expect(createClient).not.toHaveBeenCalled();
});

it("consulta o resultado com a chave e entrega o token apenas no cookie HttpOnly", async () => {
  expect((await status(new Request("https://app.test/api/orders/status"))).status).toBe(404);
  expect(transport).not.toHaveBeenCalled();
  transport.mockResolvedValueOnce(Response.json({ orderId, number: 42, totalCents: 1500, publicToken: "receipt-token" }));
  const response = await status(new Request("https://app.test/api/orders/status", { headers: { "Idempotency-Key": key } }));
  expect(await response.json()).toEqual({ orderId, number: 42, totalCents: 1500 });
  expect(response.headers.get("set-cookie")).toMatch(/menzu_receipt_.*=receipt-token.*HttpOnly/);
  expect(createClient).not.toHaveBeenCalled();
});

it("permite gravação somente pela rota interna autenticada", async () => {
  const rpc = vi.fn().mockResolvedValue({
    data: { order_id: orderId, number: 42, total_cents: 1500, public_token: "receipt-token", payment_method: "CASH" },
    error: null,
  });
  createClient.mockReturnValue({ rpc });
  const workerRequest = (authorization: string) => new Request("https://app.test/api/internal/orders/process", {
    method: "POST", headers: { authorization }, body: JSON.stringify({ key, ip: "127.0.0.1", payload }),
  });
  expect((await processOrder(workerRequest("Bearer invalid"))).status).toBe(404);
  expect(rpc).not.toHaveBeenCalled();
  expect((await processOrder(workerRequest(`Bearer ${secret}`))).status).toBe(201);
  expect(rpc).toHaveBeenCalledWith("create_guest_order", expect.objectContaining({
    p_payload: expect.objectContaining({ idempotency_key: key }),
  }));
});

it("consulta somente a fila para habilitar a compra", async () => {
  transport.mockResolvedValueOnce(Response.json({ ready: true }));
  expect(await guestOrderingAvailable()).toBe(true);
  expect(transport).toHaveBeenCalledWith(new URL("/health", broker), expect.objectContaining({
    headers: { authorization: `Bearer ${secret}` },
  }));
  transport.mockResolvedValueOnce(Response.json({ ready: false }, { status: 503 }));
  expect(await guestOrderingAvailable()).toBe(false);
  transport.mockRejectedValueOnce(new Error("connection refused"));
  expect(await guestOrderingAvailable()).toBe(false);
  expect(createClient).not.toHaveBeenCalled();
});

it("só sinaliza prontidão autenticada com a chave real de pedidos validada pelo banco", async () => {
  const abortSignal = vi.fn()
    .mockResolvedValueOnce({ data: true, error: null })
    .mockResolvedValueOnce({ data: false, error: null })
    .mockResolvedValueOnce({ data: null, error: { code: "PGRST202" } });
  const rpc = vi.fn().mockReturnValue({ abortSignal });
  createClient.mockReturnValue({ rpc });
  const request = (authorization: string) => new Request("https://app.test/api/internal/orders/process", { headers: { authorization } });
  expect((await workerReadiness(request("Bearer invalid"))).status).toBe(404);
  expect(rpc).not.toHaveBeenCalled();
  const authorized = request(`Bearer ${secret}`);
  const ready = await workerReadiness(authorized);
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({ ready: true });
  expect(rpc).toHaveBeenCalledWith("menzu_guest_order_ready", { p_server_key: "test-order-key" });
  expect((await workerReadiness(authorized)).status).toBe(503);
  expect((await workerReadiness(authorized)).status).toBe(503);
  vi.stubEnv("MENZU_ORDER_API_KEY", "");
  expect((await workerReadiness(authorized)).status).toBe(503);
  expect(rpc).toHaveBeenCalledTimes(3);
});
