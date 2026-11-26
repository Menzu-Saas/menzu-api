import { expect, it, vi } from "vitest";

const orderId = "10000000-0003-4000-8000-000000000001";
const token = "fixture-receipt-token";

vi.mock("server-only", () => ({}));
import { GET } from "@/app/api/orders/status/route";

it("entrega a confirmação por cookie HttpOnly sem serializar o token no JSON", async () => {
  vi.stubEnv("MENZU_QUEUE_URL", "http://127.0.0.1:3103");
  vi.stubEnv("MENZU_QUEUE_SECRET", "fixture-queue-secret-0123456789abcdef");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ orderId, number: 10, totalCents: 1500, publicToken: token })));
  let response: Response;
  try {
    response = await GET(new Request("https://example.test/api/orders/status", {
      headers: { "Idempotency-Key": "10000000-0003-4000-8000-000000000002" },
    }));
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ orderId, number: 10, totalCents: 1500 });
  expect(response.headers.get("cache-control")).toBe("no-store");
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toContain(`menzu_receipt_${orderId}=${token}`);
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/Secure/i);
  expect(cookie).toMatch(/Path=\/cardapio/i);
  expect(cookie).toMatch(/SameSite=lax/i);
});
