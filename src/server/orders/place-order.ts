import "server-only";
import { isUuid } from "@/lib/uuid";
import { createHmac, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ZodError } from "zod";
import { MENZU_ERROR_MESSAGES, parseMenzuError } from "@/lib/order-errors";
import { orderPayloadSchema, quotePayloadSchema, type OrderQuote, type QuoteItem } from "@/lib/schemas/order";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { PaymentMethod, PaymentStatus } from "@/lib/types";
import {
  getPaymentProvider,
  isAsaasSelected,
  isDevelopmentPaymentsEnabled,
  isOnlineMethod,
  OFFLINE_PROVIDER,
  type PaymentProvider,
} from "@/server/payments";
import { PLATFORM_ONLINE_FEE_BPS } from "@/server/payments/asaas-config";
import { createServiceRoleClient } from "@/server/payments/service-client";

type Db = SupabaseClient<Database>;

export type PlaceOrderResult = {
  orderId: string;
  number: number;
  publicToken: string;
  totalCents: number;
  payment: {
    id: string;
    method: PaymentMethod;
    provider: string;
    status: PaymentStatus;
    pixQrCode?: string;
    pixQrBase64?: string;
    checkoutUrl?: string;
    /** Set when the order was created but the online charge could not be generated. */
    error?: { code: string; message: string };
  };
};

/** Error carrying an HTTP status and the stable `{ code, message }` body for API routes. */
export class OrderApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Structured details sent next to code/message (e.g. BELOW_MINIMUM numbers). */
    readonly details?: Record<string, number>,
  ) {
    super(message);
    this.name = "OrderApiError";
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...this.details } };
  }
}

// Business-state conflicts (retrying the same payload later may succeed or the cart must change).
const CONFLICT_CODES = new Set([
  "IDEMPOTENCY_CONFLICT",
  "RESTAURANT_CLOSED",
  "RESTAURANT_PAUSED",
  "OUTSIDE_HOURS",
  "PRODUCT_UNAVAILABLE",
  "OUT_OF_STOCK",
  "COUPON_LIMIT_REACHED",
  "COUPON_CUSTOMER_LIMIT",
  "COUPON_EXPIRED",
]);

/** BELOW_MINIMUM carries `{"minimum_cents", "subtotal_cents"}` (server numbers) in the error hint. */
function belowMinimumDetails(e: unknown): Record<string, number> | undefined {
  const hint = e && typeof e === "object" && "hint" in e ? (e as { hint: unknown }).hint : undefined;
  if (typeof hint !== "string") return undefined;
  try {
    const h = JSON.parse(hint) as Record<string, unknown>;
    const min = h.minimum_cents;
    const sub = h.subtotal_cents;
    if (Number.isSafeInteger(min) && Number.isSafeInteger(sub)) {
      return { minimum_cents: min as number, subtotal_cents: sub as number };
    }
  } catch {
    // Not our hint: the message alone is still meaningful.
  }
  return undefined;
}

export function toOrderApiError(e: unknown): OrderApiError {
  if (e instanceof OrderApiError) return e;
  const { code, message } = parseMenzuError(e);
  if (code === "UNKNOWN") return new OrderApiError(500, code, message);
  if (code === "RATE_LIMITED") return new OrderApiError(429, code, message);
  const details = code === "BELOW_MINIMUM" ? belowMinimumDetails(e) : undefined;
  return new OrderApiError(CONFLICT_CODES.has(code) ? 409 : 400, code, message, details);
}

const ORDERS_UNAVAILABLE_MESSAGE = "Pedidos indisponíveis no momento. Tente novamente mais tarde.";

/**
 * Per-client key for the database rate limits: hex HMAC-SHA256 of the client IP keyed with the
 * server order key, so the database can count orders per client without ever seeing an IP.
 */
export function clientFingerprint(ip: string, serverKey: string): string {
  return createHmac("sha256", serverKey).update(`menzu:client:${ip}`).digest("hex");
}

function fromZod(error: ZodError): OrderApiError {
  const customerIssue = error.issues.some((i) => i.path[0] === "customer");
  const code = customerIssue ? "INVALID_CUSTOMER" : "INVALID_PAYLOAD";
  return new OrderApiError(400, code, MENZU_ERROR_MESSAGES[code]);
}

export function parseOrderPayload(payload: unknown) {
  const parsed = orderPayloadSchema.safeParse(payload);
  if (!parsed.success) throw fromZod(parsed.error);
  // BETA: online payment (PIX and card) stays closed unless Asaas is explicitly selected.
  if (isOnlineMethod(parsed.data.payment_method) && !isAsaasSelected()) {
    throw new OrderApiError(400, "PAYMENT_METHOD_DISABLED", "Pagamento online indisponível nesta BETA. Escolha pagamento presencial.");
  }
  return parsed.data;
}

export type OrderDeps = {
  supabase?: Db;
  provider?: PaymentProvider;
  env?: Record<string, string | undefined>;
  /** Service-role client for set_payment_provider_data; null = not configured (default: from env). */
  serviceClient?: Db | null;
  /** Client IP from the platform header (see clientIp in rate-limit.ts); default "unknown". */
  clientIp?: string;
  idempotencyKey?: string | null;
  /**
   * Buyer CPF/CNPJ (digits) for the payment provider. Resolved on the server at charge time; it must
   * never travel in the order payload, because the queue stores the payload on disk.
   */
  cpfCnpj?: string | null;
};

async function client(deps?: OrderDeps): Promise<Db> {
  return deps?.supabase ?? createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
}

function serviceClientFor(deps?: OrderDeps): Db | null {
  return deps?.serviceClient === undefined ? createServiceRoleClient() : deps.serviceClient;
}

/** Server-only order key (MENZU_ORDER_API_KEY); create_order refuses payloads without it. */
function orderKey(env: Record<string, string | undefined>): string {
  const key = env.MENZU_ORDER_API_KEY?.trim();
  if (!key) {
    console.error("[orders] MENZU_ORDER_API_KEY is not configured; refusing order");
    throw new OrderApiError(503, "ORDERS_UNAVAILABLE", ORDERS_UNAVAILABLE_MESSAGE);
  }
  return key;
}

type CreateOrderRpc = {
  replayed?: boolean;
  order_id: string;
  number: number;
  public_token: string;
  total_cents: number;
  payment_id: string;
  payment_method: PaymentMethod;
};

/**
 * zod parse (unknown keys, including any client-sent `server_key`, are stripped) → rpc create_order
 * with the server-only order key and the client fingerprint (database rate limits) (authenticated SSR client; prices computed in SQL) → for PIX/CARD_ONLINE:
 * provider.createPayment → service-role rpc set_payment_provider_data. Without a service-role key
 * (local dev), only the development provider can be registered, via set_development_payment_data
 * (which also requires the order key and the allow_development_payments flag).
 */
export async function placeOrder(payload: unknown, deps?: OrderDeps): Promise<PlaceOrderResult> {
  if (deps?.idempotencyKey !== undefined && !isUuid(deps.idempotencyKey)) throw new OrderApiError(400, "INVALID_PAYLOAD", "Tentativa de pedido inválida. Recarregue a página.");
  const order = parseOrderPayload(payload);
  const supabase = await client(deps);
  const env = deps?.env ?? process.env;
  const serverKey = orderKey(env);

  let provider: PaymentProvider | null = null;
  if (isOnlineMethod(order.payment_method)) {
    provider = deps?.provider ?? getPaymentProvider(env);
    // Without a real provider, online methods exist only in local development (never in production).
    if (provider.id === "development" && !isDevelopmentPaymentsEnabled(env)) {
      throw new OrderApiError(400, "PAYMENT_METHOD_DISABLED", MENZU_ERROR_MESSAGES.PAYMENT_METHOD_DISABLED);
    }
    // Mercado Pago rejects PIX without a payer e-mail: refuse up front instead of creating an
    // order whose charge is bound to fail.
    if (
      provider.id === "mercadopago" &&
      order.payment_method === "PIX" &&
      !order.customer.email &&
      !env.MERCADOPAGO_DEFAULT_PAYER_EMAIL?.trim()
    ) {
      throw new OrderApiError(400, "PAYER_EMAIL_REQUIRED", MENZU_ERROR_MESSAGES.PAYER_EMAIL_REQUIRED);
    }
  }
  // Real provider data can only be written by the service role: never create a real charge we
  // could not register.
  const service = provider ? serviceClientFor(deps) : null;
  if (provider && provider.id !== "development" && !service) {
    console.error("[orders] SUPABASE_SERVICE_ROLE_KEY is not configured; online payments are unavailable");
    throw new OrderApiError(400, "PAYMENT_METHOD_DISABLED", MENZU_ERROR_MESSAGES.PAYMENT_METHOD_DISABLED);
  }

  const { data, error } = await (supabase as SupabaseClient).rpc("create_guest_order", {
    p_payload: {
      ...order,
      idempotency_key: deps?.idempotencyKey ?? randomUUID(),
      server_key: serverKey,
      client_fingerprint: clientFingerprint(deps?.clientIp ?? "unknown", serverKey),
    } as unknown as Json,
  });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") throw new OrderApiError(503, "ORDERS_UNAVAILABLE", "Pedidos sem cadastro aguardam habilitação no servidor. Tente novamente mais tarde.");
    const err = toOrderApiError(error);
    // Only this server calls create_order and it always sends the key: FORBIDDEN here means the
    // database hash is missing or out of sync with MENZU_ORDER_API_KEY (run `npm run db:order-key`).
    if (err.code === "FORBIDDEN") {
      console.error("[orders] create_order refused the server order key: order_api_key_sha256 is missing or does not match MENZU_ORDER_API_KEY");
      throw new OrderApiError(503, "ORDERS_UNAVAILABLE", ORDERS_UNAVAILABLE_MESSAGE);
    }
    throw err;
  }
  const created = data as unknown as CreateOrderRpc;

  const result: PlaceOrderResult = {
    orderId: created.order_id,
    number: created.number,
    publicToken: created.public_token,
    totalCents: created.total_cents,
    payment: {
      id: created.payment_id,
      method: created.payment_method,
      provider: provider ? "pending" : OFFLINE_PROVIDER,
      status: "PENDING",
    },
  };
  if (created.replayed) {
    const snapshot = await supabase.rpc("get_public_order", { p_order_id: created.order_id, p_token: created.public_token });
    const current = snapshot.data as unknown as { status?: string; payment?: { provider: string; status: PaymentStatus; pix_qr_code?: string; pix_qr_base64?: string; checkout_url?: string } } | null;
    if (snapshot.error || !current?.payment) throw new OrderApiError(503, "ORDERS_UNAVAILABLE", ORDERS_UNAVAILABLE_MESSAGE);
    if (current.status === "CANCELLED") throw new OrderApiError(409, "ORDER_CANCELLED", "Este pedido foi cancelado. Revise o carrinho para fazer uma nova compra.");
    if (current.payment.provider !== "pending") {
      result.payment = { ...result.payment, provider: current.payment.provider, status: current.payment.status,
        pixQrCode: current.payment.pix_qr_code || undefined, pixQrBase64: current.payment.pix_qr_base64 || undefined,
        checkoutUrl: current.payment.checkout_url || undefined };
      return result;
    }
  }
  if (!provider || !isOnlineMethod(created.payment_method)) return result;
  // Card with Asaas: a charge with a link to Asaas' own payment page; the card is typed there.

  try {
    const charge = await provider.createPayment({
      paymentId: created.payment_id,
      orderId: created.order_id,
      orderNumber: created.number,
      publicToken: created.public_token,
      method: created.payment_method,
      cardType: order.card_type,
      amountCents: created.total_cents,
      description: `Pedido #${created.number}`,
      customer: { name: order.customer.name, phone: order.customer.phone, email: order.customer.email ?? null, cpfCnpj: deps?.cpfCnpj ?? null },
    });
    if (charge.status !== "PENDING" && charge.status !== "PROCESSING") {
      throw new Error(`Provider returned ${charge.status} at creation.`);
    }
    const { error: setError } = service && charge.provider === "asaas"
      ? await (service as SupabaseClient).rpc("set_asaas_payment_data", {
          p_payment_id: created.payment_id,
          p_token: created.public_token,
          p_provider_payment_id: charge.providerPaymentId,
          p_status: charge.status,
          p_pix_qr_code: charge.pixQrCode ?? null,
          p_pix_qr_base64: charge.pixQrBase64 ?? null,
          p_checkout_url: charge.checkoutUrl ?? null,
          p_raw: charge.raw as Json,
          p_fee_bps: PLATFORM_ONLINE_FEE_BPS,
        })
      : service
      ? await service.rpc("set_payment_provider_data", {
          p_payment_id: created.payment_id,
          p_token: created.public_token,
          p_provider: charge.provider,
          p_provider_payment_id: charge.providerPaymentId as string,
          p_status: charge.status,
          p_pix_qr_code: (charge.pixQrCode ?? null) as string,
          p_pix_qr_base64: (charge.pixQrBase64 ?? null) as string,
          p_checkout_url: (charge.checkoutUrl ?? null) as string,
          p_raw: charge.raw as Json,
        })
      : await supabase.rpc("set_development_payment_data", {
          p_payment_id: created.payment_id,
          p_token: created.public_token,
          p_server_key: serverKey,
          p_provider_payment_id: charge.providerPaymentId as string,
          p_status: charge.status,
          p_pix_qr_code: (charge.pixQrCode ?? null) as string,
          p_raw: charge.raw as Json,
        });
    if (setError) throw setError;
    result.payment = {
      ...result.payment,
      provider: charge.provider,
      status: charge.status,
      pixQrCode: charge.pixQrCode,
      pixQrBase64: charge.pixQrBase64,
      checkoutUrl: charge.checkoutUrl,
    };
  } catch (e) {
    // The order exists (PENDING, payment provider 'pending'); report honestly that no charge exists.
    console.error("[orders] online payment setup failed", {
      orderId: created.order_id,
      paymentId: created.payment_id,
      error: e instanceof Error ? e.message : parseMenzuError(e).code,
    });
    result.payment.error = {
      code: "PAYMENT_PROVIDER_ERROR",
      message: "Não foi possível gerar o pagamento online. Fale com o restaurante.",
    };
  }
  return result;
}

type QuoteRpc = OrderQuote & { coupon_error: { code: string; message: string } | null };

export async function quoteOrder(payload: unknown, deps?: OrderDeps): Promise<OrderQuote> {
  const parsed = quotePayloadSchema.safeParse(payload);
  if (!parsed.success) throw fromZod(parsed.error);
  const supabase = await client(deps);
  const { data, error } = await supabase.rpc("quote_order", { p_payload: parsed.data as unknown as Json });
  if (error) throw toOrderApiError(error);
  const q = data as unknown as QuoteRpc;
  const quote: OrderQuote = {
    items: (q.items ?? []) as QuoteItem[],
    subtotal_cents: q.subtotal_cents,
    discount_cents: q.discount_cents,
    delivery_fee_cents: q.delivery_fee_cents,
    total_cents: q.total_cents,
    coupon: q.coupon ?? null,
    delivery_zone: q.delivery_zone ?? null,
    estimated_minutes: q.estimated_minutes,
  };
  if (q.coupon_error) quote.coupon_error = q.coupon_error;
  return quote;
}



