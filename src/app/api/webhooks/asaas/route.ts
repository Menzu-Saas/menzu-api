import { z } from "zod";
import { asaasEnvironment, validAsaasWebhookToken } from "@/server/payments/asaas-security";
import { asaasStore } from "@/server/payments/asaas-store";
import { defaultReconcileDeps, reconcileAsaasInbox } from "@/server/payments/asaas-reconciler";

export const runtime = "nodejs";
const eventSchema = z.object({
  id: z.string().min(1).max(200), event: z.string().min(1).max(100),
  account: z.object({ id: z.string().max(100) }).optional(),
  payment: z.object({ id: z.string().max(100) }).optional(),
  transfer: z.object({ id: z.string().max(100) }).optional(),
});

export async function POST(request: Request) {
  if (!validAsaasWebhookToken(request.headers.get("asaas-access-token"))) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  // Bound the stream itself: Content-Length is optional and not trusted.
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "INVALID_EVENT" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65_536) { await reader.cancel(); return Response.json({ error: "EVENT_TOO_LARGE" }, { status: 413 }); }
    chunks.push(value);
  }
  let parsed: ReturnType<typeof eventSchema.safeParse>;
  try { parsed = eventSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch { return Response.json({ error: "INVALID_EVENT" }, { status: 400 }); }
  if (!parsed.success) return Response.json({ error: "INVALID_EVENT" }, { status: 400 });
  try {
    const event = parsed.data;
    const { error } = await asaasStore().from("asaas_webhook_inbox").upsert({
      environment: asaasEnvironment(), event_id: event.id, event_type: event.event,
      account_id: event.account?.id ?? null, resource_id: event.payment?.id ?? event.transfer?.id ?? null,
    }, { onConflict: "environment,event_id", ignoreDuplicates: true });
    if (error) throw new Error("INBOX_UNAVAILABLE");
    // The event is stored first. Confirmation is best effort here; /api/internal/asaas/reconcile retries.
    // The reconciler fetches the charge from Asaas and never trusts this payload.
    if (event.event.startsWith("PAYMENT_")) {
      try { await reconcileAsaasInbox(defaultReconcileDeps(), 5); } catch { /* stays in the inbox */ }
    }
    return Response.json({ received: true });
  } catch { return Response.json({ error: "WEBHOOK_STORAGE_UNAVAILABLE" }, { status: 503 }); }
}
