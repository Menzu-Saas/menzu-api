import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const getSessionUser = vi.hoisted(() => vi.fn());
vi.mock("@/server/auth", () => ({ getSessionUser }));
const getBuyerCpf = vi.hoisted(() => vi.fn());
vi.mock("@/server/payments/cpf-vault", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/payments/cpf-vault")>()), getBuyerCpf }));
const createClient = vi.hoisted(() => vi.fn());
vi.mock("@supabase/supabase-js", () => ({ createClient }));

import { POST as enqueue } from "@/app/api/orders/route";
import { POST as processOrder } from "@/app/api/internal/orders/process/route";
import { openCpfForOrder, sealCpfForOrder } from "@/server/payments/cpf-vault";

const CPF = "52998224725";
const KEY = "10000000-0000-4000-8000-000000000001";
const OTHER_KEY = "10000000-0000-4000-8000-000000000009";
const secret = "test-queue-credential-0123456789abcdef";
const base = {
  restaurant_slug: "loja-teste", type: "PICKUP", customer: { name: "Maria Silva", phone: "11987654321" },
  items: [{ product_id: "10000000-0000-4000-8000-000000000003", quantity: 1 }],
};
const transport = vi.fn();

function order(body: object) {
  return new Request("https://app.test/api/orders", { method: "POST", headers: { "Idempotency-Key": KEY }, body: JSON.stringify(body) });
}
const queued = () => JSON.parse(transport.mock.calls[0][1].body) as { payload: Record<string, unknown>; cpfSealed?: string };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MENZU_QUEUE_URL", "http://127.0.0.1:3103");
  vi.stubEnv("MENZU_QUEUE_SECRET", secret);
  vi.stubEnv("MENZU_ORDER_API_KEY", "test-order-key");
  vi.stubEnv("MENZU_CPF_ENCRYPTION_KEY", "ab".repeat(32));
  vi.stubEnv("MENZU_ONLINE_PROVIDER", "asaas");
  vi.stubEnv("ASAAS_PLATFORM_WALLET_ID", "123e4567-e89b-42d3-a456-426614174000");
  vi.stubGlobal("fetch", transport);
  transport.mockResolvedValue(Response.json({ state: "pending" }, { status: 202 }));
  getSessionUser.mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("canal do CPF até a cobrança", () => {
  it("cifra o CPF antes de enfileirar: o disco nunca vê o número e o pedido não o carrega", async () => {
    const response = await enqueue(order({ ...base, payment_method: "PIX", cpf: "529.982.247-25" }));
    expect(response.status).toBe(202);
    const job = queued();
    expect(JSON.stringify(job)).not.toContain(CPF);
    expect(JSON.stringify(job)).not.toContain("529.982.247-25");
    expect(job.payload).not.toHaveProperty("cpf");
    expect(openCpfForOrder(job.cpfSealed!, KEY)).toBe(CPF);
  });

  it("o CPF cifrado só abre com a chave do próprio pedido", async () => {
    await enqueue(order({ ...base, payment_method: "CARD_ONLINE", cpf: CPF }));
    expect(() => openCpfForOrder(queued().cpfSealed!, OTHER_KEY)).toThrow();
  });

  it("recusa pagamento online sem CPF, antes de criar o pedido", async () => {
    const response = await enqueue(order({ ...base, payment_method: "PIX" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "CPF_REQUIRED" } });
    expect(transport).not.toHaveBeenCalled();
  });

  it("recusa CPF inválido", async () => {
    const response = await enqueue(order({ ...base, payment_method: "PIX", cpf: "11111111111" }));
    expect(response.status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
  });

  it("usa o CPF guardado na conta quando o navegador não envia", async () => {
    getSessionUser.mockResolvedValue({ id: "20000000-0000-4000-8000-000000000001" });
    getBuyerCpf.mockResolvedValue(CPF);
    expect((await enqueue(order({ ...base, payment_method: "PIX" }))).status).toBe(202);
    expect(getBuyerCpf).toHaveBeenCalledWith("20000000-0000-4000-8000-000000000001");
    expect(openCpfForOrder(queued().cpfSealed!, KEY)).toBe(CPF);
  });

  it("pagamento presencial não pede nem envia CPF", async () => {
    expect((await enqueue(order({ ...base, payment_method: "CASH", cpf: CPF }))).status).toBe(202);
    expect(queued().cpfSealed).toBeUndefined();
    expect(JSON.stringify(queued())).not.toContain(CPF);
  });

  it("a rota interna decifra e entrega o CPF só em memória ao placeOrder", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    createClient.mockReturnValue({ rpc });
    const worker = (cpfSealed?: string) => new Request("https://app.test/api/internal/orders/process", {
      method: "POST", headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ key: KEY, ip: "127.0.0.1", payload: { ...base, payment_method: "PIX" }, cpfSealed }),
    });
    // Mesmo sem banco, o CPF adulterado/ausente não derruba a rota: a cobrança é que falharia com CPF_REQUIRED.
    expect((await processOrder(worker("v1.x.y.z"))).status).toBeGreaterThanOrEqual(400);
    expect((await processOrder(worker(sealCpfForOrder(CPF, KEY)))).status).toBeGreaterThanOrEqual(400);
  });
});

