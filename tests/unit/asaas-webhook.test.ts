import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "@/app/api/webhooks/asaas/route";
const { upsert } = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/payments/asaas-store", () => ({ asaasStore: () => ({ from: () => ({ upsert }) }) }));
beforeEach(() => {
  vi.stubEnv("ASAAS_WEBHOOK_TOKEN", "test-token-123456789012345678901234567890");
  vi.stubEnv("ASAAS_ENVIRONMENT", "sandbox");
  upsert.mockReset().mockResolvedValue({ error: null });
});
const event = { id: "evt-1", event: "PAYMENT_RECEIVED", payment: { id: "pay-1", creditCard: { secret: "not-persisted" } } };
function request(body: unknown, token = process.env.ASAAS_WEBHOOK_TOKEN!) {
  return new Request("https://menzu.test/api/webhooks/asaas", { method: "POST", headers: { "asaas-access-token": token }, body: JSON.stringify(body) });
}

it("rejects unauthenticated notifications without touching storage", async () => {
  expect((await POST(request(event, "wrong"))).status).toBe(401);
  expect(upsert).not.toHaveBeenCalled();
});
it("persists only resource references and deduplicates by environment and event id", async () => {
  expect((await POST(request(event))).status).toBe(200);
  expect(upsert).toHaveBeenCalledWith({ environment: "sandbox", event_id: "evt-1", event_type: "PAYMENT_RECEIVED", account_id: null, resource_id: "pay-1" }, { onConflict: "environment,event_id", ignoreDuplicates: true });
});
it("returns retryable failure rather than acknowledging an event lost in storage", async () => {
  upsert.mockResolvedValue({ error: { message: "database unavailable" } });
  expect((await POST(request(event))).status).toBe(503);
});
it("rejects malformed and oversized input", async () => {
  expect((await POST(request({}))).status).toBe(400);
  expect((await POST(request({ ...event, large: "x".repeat(70_000) }))).status).toBe(413);
  expect(upsert).not.toHaveBeenCalled();
});
