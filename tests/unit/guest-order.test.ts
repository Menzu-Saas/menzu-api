import { beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
vi.mock("server-only",()=>({}));
import { placeOrder } from "@/server/orders/place-order";
const rpc=vi.fn();
const payload={restaurant_slug:"burger-house",type:"PICKUP",customer:{name:"Maria Silva",phone:"11987654321"},payment_method:"CASH",items:[{product_id:"10000000-0003-4000-8000-000000000001",quantity:1}]};
const deps={supabase:{rpc} as unknown as SupabaseClient<Database>,env:{MENZU_ORDER_API_KEY:"test-server-order-key-never-public"},idempotencyKey:"10000000-0003-4000-8000-000000000002",clientIp:"127.0.0.1"};
beforeEach(()=>{vi.resetAllMocks();});
it("envia sem conta e mantém o preço calculado no banco",async()=>{
 rpc.mockResolvedValue({data:{order_id:"order",number:10,public_token:"token",total_cents:1500,payment_id:"payment",payment_method:"CASH"},error:null});
 const result=await placeOrder({...payload,total_cents:1,buyer_user_id:"forged"},deps);
 expect(rpc).toHaveBeenCalledWith("create_guest_order",expect.objectContaining({p_payload:expect.objectContaining({idempotency_key:deps.idempotencyKey})}));
 expect(rpc.mock.calls[0][1].p_payload).not.toHaveProperty("total_cents");
 expect(rpc.mock.calls[0][1].p_payload).not.toHaveProperty("buyer_user_id");
 expect(result.totalCents).toBe(1500);
 expect(JSON.stringify(result)).not.toContain(deps.env.MENZU_ORDER_API_KEY);
});
it("recusa pagamento online antes de chamar o banco",async()=>{
 await expect(placeOrder({...payload,payment_method:"PIX"},deps)).rejects.toMatchObject({code:"PAYMENT_METHOD_DISABLED"});
 expect(rpc).not.toHaveBeenCalled();
});
it("informa indisponibilidade enquanto o banco não estiver habilitado",async()=>{
 rpc.mockResolvedValue({data:null,error:{code:"PGRST202"}});
 await expect(placeOrder(payload,deps)).rejects.toMatchObject({status:503,code:"ORDERS_UNAVAILABLE"});
});
