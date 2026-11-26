import { API_STATUS_PAGE } from "@/lib/api-status-page";

/** Única página da API: mostra se ela está ligada, consultando /api/health. */
export function GET() {
  return new Response(API_STATUS_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
