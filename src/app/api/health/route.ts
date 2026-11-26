import { queueReady } from "@/server/orders/queue-client";

export const dynamic = "force-dynamic";

/**
 * Health check of the API deployment. Always 200 while the app answers (so the host does not restart it
 * over a queue hiccup); `ordering` says whether new orders are being accepted.
 */
export async function GET() {
  return Response.json({ ok: true, ordering: await queueReady() }, { headers: { "Cache-Control": "no-store" } });
}
