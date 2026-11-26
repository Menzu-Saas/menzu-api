// Compatibilidade da troca de nomes: se a variável nova faltar ou estiver malformada, usa a antiga
// (NEXT_PUBLIC_*) quando ela for válida. Os avisos citam só NOMES, nunca valores.
// Pode ser removido quando o serviço publicado tiver os nomes novos corretos.
const isOrigin = (value) => {
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return (url.protocol === "https:" || (url.protocol === "http:" && local)) && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
};

const RULES = {
  SUPABASE_URL: isOrigin,
  // Chave publicável (nova) ou "anon" (JWT, antiga). Uma chave secreta aqui é recusada.
  SUPABASE_PUBLISHABLE_KEY: (value) => /^(sb_publishable_|eyJ)[A-Za-z0-9._-]+$/.test(value),
  APP_URL: isOrigin,
};

export function resolveEnv(source) {
  const env = { ...source };
  const warnings = [];
  for (const [name, valid] of Object.entries(RULES)) {
    const legacy = `NEXT_PUBLIC_${name}`;
    const current = source[name]?.trim() ?? "";
    const fallback = source[legacy]?.trim() ?? "";
    if (current && valid(current)) {
      env[name] = current;
      continue;
    }
    const problem = current ? `${name} com formato inválido` : `${name} ausente`;
    if (fallback && valid(fallback)) {
      env[name] = fallback;
      warnings.push(`${problem}; usando ${legacy}. Corrija ${name} no painel.`);
    } else {
      warnings.push(`${problem} e ${legacy} não tem um valor válido. Corrija ${name} no painel.`);
    }
  }
  return { env, warnings };
}
