import type { NextConfig } from "next";

// API do Menzu: só rotas em /api/*. As páginas ficam no repositório menzu-front.
const config: NextConfig = { env: { NEXT_PUBLIC_MENZU_APP: "restaurant" } };
export default config;
