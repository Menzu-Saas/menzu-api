/**
 * Página de status da API (deploy "só API"): HTML único, sem dependências. Mostra apenas o que
 * /api/health já expõe; nada de ambiente, versão ou segredos.
 */
export const API_STATUS_PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Menzu API · Status</title>
<style>
  :root { color-scheme: light dark; --bg:#f1ece6; --card:#fff; --ink:#17140f; --muted:#6f6860; --line:#e7e0d8; --brand:#ff6b1a; --ok:#15803d; --warn:#b45309; --bad:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14120f; --card:#1e1b17; --ink:#f5f1ec; --muted:#aaa197; --line:#332e28; --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; } }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 24px; padding: 28px; }
  .brand { color: var(--brand); font-weight: 800; font-size: 14px; letter-spacing: .08em; text-transform: uppercase; }
  h1 { display: flex; align-items: center; gap: 12px; margin: 10px 0 4px; font-size: 26px; line-height: 1.2; }
  .dot { flex: none; width: 14px; height: 14px; border-radius: 50%; background: var(--muted); }
  [data-state="ok"] .dot { background: var(--ok); animation: pulse 2s infinite; }
  [data-state="warn"] .dot { background: var(--warn); }
  [data-state="bad"] .dot { background: var(--bad); }
  @keyframes pulse { 50% { opacity: .4; } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none !important; } }
  p { color: var(--muted); }
  dl { margin: 22px 0; border-top: 1px solid var(--line); }
  dl div { display: flex; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); }
  dt { color: var(--muted); } dd { font-weight: 700; text-align: right; }
  button { width: 100%; min-height: 48px; border: 0; border-radius: 16px; background: var(--brand); color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: .6; cursor: wait; }
  button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
</style>
</head>
<body>
<main id="card" data-state="loading">
  <span class="brand">Menzu API</span>
  <h1 aria-live="polite"><span class="dot" aria-hidden="true"></span><span id="title">Verificando…</span></h1>
  <p id="detail">Consultando o servidor.</p>
  <dl>
    <div><dt>API</dt><dd id="api">—</dd></div>
    <div><dt>Novos pedidos</dt><dd id="orders">—</dd></div>
    <div><dt>Tempo de resposta</dt><dd id="latency">—</dd></div>
    <div><dt>Última verificação</dt><dd id="checked">—</dd></div>
  </dl>
  <button id="again" type="button">Verificar agora</button>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var busy = false;
  function show(state, title, detail, api, orders, latency) {
    $("card").dataset.state = state;
    $("title").textContent = title;
    $("detail").textContent = detail;
    $("api").textContent = api;
    $("orders").textContent = orders;
    $("latency").textContent = latency;
    $("checked").textContent = new Date().toLocaleTimeString("pt-BR");
  }
  function check() {
    if (busy) return;
    busy = true;
    $("again").disabled = true;
    var start = Date.now();
    var abort = new AbortController();
    var timer = setTimeout(function () { abort.abort(); }, 10000);
    fetch("/api/health", { cache: "no-store", signal: abort.signal })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (body) {
        if (body.ok !== true) throw new Error();
        var ms = (Date.now() - start) + " ms";
        if (body.ordering === true) show("ok", "API ligada", "Tudo funcionando.", "No ar", "Aceitando", ms);
        else show("warn", "API ligada", "A API responde, mas não está aceitando novos pedidos.", "No ar", "Indisponíveis", ms);
      })
      .catch(function () { show("bad", "Sem resposta", "Não foi possível consultar a API.", "Sem resposta", "—", "—"); })
      .finally(function () { clearTimeout(timer); busy = false; $("again").disabled = false; });
  }
  $("again").addEventListener("click", check);
  check();
  setInterval(function () { if (!document.hidden) check(); }, 30000);
})();
</script>
</body>
</html>`;
