import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

test("renders development preview metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  assert.match(await response.text(), developmentPreviewMeta);
});

test("keeps the requested management controls in the authenticated application", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  for (const label of [
    "Buscar loja por nome, cidade ou estado",
    "Editar todas as informações",
    "Confirmar migração de loja?",
    "Gerenciar e editar tipos",
    "Código compartilhado da nota (#)",
    "Pré-visualizar",
    "Log de auditoria",
    "Exportar CSV",
  ]) {
    assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("database migration defines an append-only audited history", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20261013113000_add_audit_and_shared_invoices.sql", import.meta.url), "utf8");

  assert.match(migration, /create table public\.audit_logs/i);
  assert.match(migration, /revoke all on table public\.audit_logs from anon, authenticated/i);
  assert.match(migration, /grant select on table public\.audit_logs to authenticated/i);
  assert.match(migration, /create trigger equipments_capture_audit/i);
  assert.match(migration, /add column reference_code text/i);
});
