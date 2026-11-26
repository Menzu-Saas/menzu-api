import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";

export function queueConfigured() {
  return Boolean(process.env.MENZU_QUEUE_URL && (process.env.MENZU_QUEUE_SECRET?.length ?? 0) >= 32);
}

export async function queueReady(): Promise<boolean> {
  if (!queueConfigured()) return false;
  try {
    const response = await fetch(new URL("/health", process.env.MENZU_QUEUE_URL), {
      headers: { authorization: `Bearer ${process.env.MENZU_QUEUE_SECRET}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(4_000),
    });
    return response.status === 200 && (await response.json())?.ready === true;
  } catch {
    return false;
  }
}

export function isQueueWorker(request: Request) {
  const secret = process.env.MENZU_QUEUE_SECRET;
  if (!secret || secret.length < 32) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function queueUnavailable() {
  return Response.json({ error: { code: "QUEUE_UNAVAILABLE", message: "Não foi possível consultar o envio. Tente novamente com o mesmo pedido." } }, {
    status: 503,
    headers: { "Cache-Control": "no-store", "Retry-After": "3" },
  });
}

/** `cpfSealed` é o CPF cifrado (cpf-vault); a fila em disco nunca vê o número. */
export async function queueRequest(request: Request, key: string, job?: { payload: unknown; ip: string; cpfSealed?: string }) {
  if (!queueConfigured()) return queueUnavailable();
  try {
    const response = await fetch(new URL(`/jobs/${key}`, process.env.MENZU_QUEUE_URL), {
      method: job ? "PUT" : "GET",
      headers: { authorization: `Bearer ${process.env.MENZU_QUEUE_SECRET}`, "Content-Type": "application/json" },
      body: job && JSON.stringify(job),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(4_000),
    });
    const body = await response.json();
    const headers = new Headers({ "Cache-Control": "no-store" });
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) headers.set("Retry-After", retryAfter);
    if (response.status === 202) headers.set("Location", "/api/orders/status");
    if (response.status === 200 || response.status === 201) {
      const { orderId, number, totalCents, publicToken } = body;
      if (!isUuid(orderId) || typeof publicToken !== "string" || !publicToken) return queueUnavailable();
      const receipt = NextResponse.json({ orderId, number, totalCents }, { status: response.status, headers });
      receipt.cookies.set(`menzu_receipt_${orderId}`, publicToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production" || new URL(request.url).protocol === "https:",
        sameSite: "lax",
        path: "/cardapio",
        maxAge: 24 * 60 * 60,
      });
      return receipt;
    }
    return Response.json(body, { status: response.status, headers });
  } catch {
    return queueUnavailable();
  }
}
