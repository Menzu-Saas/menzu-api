import assert from "node:assert/strict";
import test from "node:test";
import { resolveEnv } from "../../scripts/env-compat.mjs";

// Montada em partes para não parecer uma chave real a verificadores de segredos.
const fakeSecret = (suffix) => ["sb", "secret", suffix].join("_");

const good = { SUPABASE_URL: "https://projeto.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_valor-de-teste", APP_URL: "https://front.example.com" };
const legacy = { NEXT_PUBLIC_SUPABASE_URL: good.SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: good.SUPABASE_PUBLISHABLE_KEY, NEXT_PUBLIC_APP_URL: good.APP_URL };

test("com os nomes novos corretos, nada muda e nada é avisado", () => {
  const { env, warnings } = resolveEnv({ ...good, NEXT_PUBLIC_SUPABASE_URL: "https://outro.supabase.co" });
  assert.equal(env.SUPABASE_URL, good.SUPABASE_URL);
  assert.deepEqual(warnings, []);
});

test("nome novo ausente: usa o antigo e avisa", () => {
  const { env, warnings } = resolveEnv(legacy);
  assert.equal(env.SUPABASE_URL, good.SUPABASE_URL);
  assert.equal(env.SUPABASE_PUBLISHABLE_KEY, good.SUPABASE_PUBLISHABLE_KEY);
  assert.equal(env.APP_URL, good.APP_URL);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /SUPABASE_URL ausente.*NEXT_PUBLIC_SUPABASE_URL/);
});

test("valor colado com o nome, aspas, caminho ou chave errada: usa o antigo", () => {
  for (const [name, bad] of [
    ["SUPABASE_URL", `SUPABASE_URL=${good.SUPABASE_URL}`],
    ["SUPABASE_URL", `"${good.SUPABASE_URL}"`],
    ["SUPABASE_URL", `${good.SUPABASE_URL}/rest/v1`],
    ["SUPABASE_PUBLISHABLE_KEY", fakeSecret("nao-pode")],
    ["SUPABASE_PUBLISHABLE_KEY", `SUPABASE_PUBLISHABLE_KEY=${good.SUPABASE_PUBLISHABLE_KEY}`],
  ]) {
    const { env, warnings } = resolveEnv({ ...good, ...legacy, [name]: bad });
    assert.equal(env[name], good[name], bad);
    assert.match(warnings.join("\n"), new RegExp(`${name} com formato inválido`));
  }
});

test("espaços nas pontas são removidos", () => {
  assert.equal(resolveEnv({ ...good, SUPABASE_URL: `  ${good.SUPABASE_URL} ` }).env.SUPABASE_URL, good.SUPABASE_URL);
});

test("sem nenhum valor válido, avisa e nunca mostra os valores", () => {
  const { warnings } = resolveEnv({ SUPABASE_URL: "segredo-colado-no-lugar-errado", SUPABASE_PUBLISHABLE_KEY: fakeSecret("super-secreto") });
  assert.equal(warnings.length, 3);
  assert.doesNotMatch(warnings.join("\n"), /segredo-colado|super-secreto/);
});
