import { requireRole } from "@/lib/auth";
import { tradeGoodsReportsGet } from "@/lib/trade-goods-routes";

const readGuard = () => requireRole("owner", "manager");

export const GET = tradeGoodsReportsGet("wholesale", readGuard);
