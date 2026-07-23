import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import QRCode from "qrcode";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 3000);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png", ".md": "text/markdown; charset=utf-8" };
const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined }) : null;

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 15_000_000) throw new Error("Solicitud demasiado grande");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function extractJson(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("La IA no devolvió JSON válido");
  return JSON.parse(match[0]);
}

function asJson(value) {
  return JSON.stringify(value ?? null);
}

function parseWorkerLine(raw, center) {
  const [name, email, phone] = String(raw || "").split(/[|;]/).map(x => x.trim());
  return { id: `${center.id || center.name}:${name || raw}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: name || raw || "Sin nombre", email: email || "", phone: phone || "" };
}

async function createNormalizedTables(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_families (id TEXT PRIMARY KEY, name TEXT, prefix TEXT, serial BOOLEAN, inspection TEXT, payload JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_cost_centers (id TEXT PRIMARY KEY, name TEXT UNIQUE, safety_advisor_name TEXT, payload JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_users (id TEXT PRIMARY KEY, name TEXT, initials TEXT, role TEXT, cost_center TEXT, admin BOOLEAN, payload JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_assets (id TEXT PRIMARY KEY, code TEXT UNIQUE, base_code TEXT, unit_no INTEGER, unit_count INTEGER, name TEXT, family_id TEXT, type TEXT, serial TEXT, brand TEXT, status TEXT, location TEXT, responsible TEXT, stock NUMERIC, minimum NUMERIC, payload JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_asset_stock (asset_id TEXT, center_name TEXT, quantity NUMERIC NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(asset_id, center_name))`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_movements (id TEXT PRIMARY KEY, movement_date TEXT, code TEXT, action TEXT, user_name TEXT, from_location TEXT, to_location TEXT, quantity NUMERIC, status TEXT, detail TEXT, payload JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_workers (id TEXT PRIMARY KEY, cost_center_id TEXT, cost_center_name TEXT, name TEXT, email TEXT, phone TEXT, payload JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_worker_signatures (worker_name TEXT PRIMARY KEY, signature_data TEXT, has_signature BOOLEAN, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_inspections (id TEXT PRIMARY KEY, asset_id TEXT, inspection_date TEXT, inspector TEXT, approver TEXT, result TEXT, notes TEXT, payload JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_documents (id TEXT PRIMARY KEY, name TEXT, type TEXT, kind TEXT, source TEXT, draft_id TEXT, size_bytes NUMERIC, payload JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_ai_results (id TEXT PRIMARY KEY, kind TEXT, center_name TEXT, filename TEXT, status TEXT, model TEXT, result JSONB, payload JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_inspection_templates (id TEXT PRIMARY KEY, name TEXT, family TEXT, source_draft TEXT, payload JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_audit_log (id TEXT PRIMARY KEY, event_date TIMESTAMPTZ, user_name TEXT, action TEXT, detail TEXT, payload JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_state_versions (id BIGSERIAL PRIMARY KEY, saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), saved_by TEXT, asset_count INTEGER, movement_count INTEGER, document_count INTEGER, payload JSONB)`);
}

async function syncNormalizedTables(client, state) {
  await client.query(`DELETE FROM inventory_asset_stock`);
  await client.query(`DELETE FROM inventory_workers`);
  await client.query(`DELETE FROM inventory_worker_signatures`);
  await client.query(`DELETE FROM inventory_inspection_templates`);
  await client.query(`DELETE FROM inventory_ai_results`);
  await client.query(`DELETE FROM inventory_documents`);
  await client.query(`DELETE FROM inventory_inspections`);
  await client.query(`DELETE FROM inventory_movements`);
  await client.query(`DELETE FROM inventory_assets`);
  await client.query(`DELETE FROM inventory_users`);
  await client.query(`DELETE FROM inventory_cost_centers`);
  await client.query(`DELETE FROM inventory_families`);

  for (const f of state.families || []) {
    await client.query(`INSERT INTO inventory_families (id, name, prefix, serial, inspection, payload, updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW())`, [f.id, f.name, f.prefix, Boolean(f.serial), f.inspection || "", asJson(f)]);
  }
  for (const c of state.costCenters || []) {
    await client.query(`INSERT INTO inventory_cost_centers (id, name, safety_advisor_name, payload, updated_at) VALUES ($1,$2,$3,$4::jsonb,NOW())`, [c.id || c.name, c.name, c.safetyAdvisorName || "", asJson(c)]);
    for (const raw of c.workers || []) {
      const w = parseWorkerLine(raw, c);
      await client.query(`INSERT INTO inventory_workers (id, cost_center_id, cost_center_name, name, email, phone, payload, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW())`, [w.id, c.id || c.name, c.name, w.name, w.email, w.phone, asJson({ raw, ...w })]);
    }
  }
  for (const u of state.users || []) {
    await client.query(`INSERT INTO inventory_users (id, name, initials, role, cost_center, admin, payload, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW())`, [u.id, u.name, u.initials || "", u.role || "", u.costCenter || "", Boolean(u.admin), asJson(u)]);
  }
  for (const [name, signature] of Object.entries(state.workerSignatures || {})) {
    await client.query(`INSERT INTO inventory_worker_signatures (worker_name, signature_data, has_signature, updated_at) VALUES ($1,$2,$3,NOW())`, [name, signature || "", Boolean(signature)]);
  }
  for (const a of state.assets || []) {
    await client.query(`INSERT INTO inventory_assets (id, code, base_code, unit_no, unit_count, name, family_id, type, serial, brand, status, location, responsible, stock, minimum, payload, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,NOW())`, [a.id, a.code, a.baseCode || a.code, Number(a.unitNo || 1), Number(a.unitCount || 1), a.name, a.family, a.type, a.serial || "", a.brand || "", a.status || "", a.location || "", a.responsible || "", Number(a.stock || 0), Number(a.minimum || 0), asJson(a)]);
    for (const [center, qty] of Object.entries(a.stocks || {})) {
      await client.query(`INSERT INTO inventory_asset_stock (asset_id, center_name, quantity, updated_at) VALUES ($1,$2,$3,NOW())`, [a.id, center, Number(qty || 0)]);
    }
  }
  for (const [idx, m] of (state.movements || []).entries()) {
    const id = m.id || `legacy-${idx}-${m.code || "sin-codigo"}-${m.date || ""}`;
    await client.query(`INSERT INTO inventory_movements (id, movement_date, code, action, user_name, from_location, to_location, quantity, status, detail, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`, [id, m.date || "", m.code || "", m.action || "", m.user || "", m.from || "", m.to || "", Number(m.qty || 1), m.status || "", m.detail || "", asJson(m)]);
  }
  for (const i of state.inspections || []) {
    await client.query(`INSERT INTO inventory_inspections (id, asset_id, inspection_date, inspector, approver, result, notes, payload, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NOW())`, [i.id, i.assetId || "", i.date || "", i.inspector || "", i.approver || "", i.result || "", i.notes || "", asJson(i)]);
  }
  for (const d of state.documents || []) {
    await client.query(`INSERT INTO inventory_documents (id, name, type, kind, source, draft_id, size_bytes, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [d.id, d.name || "", d.type || "", d.kind || "", d.source || "", d.draftId || "", Number(d.size || d.size_bytes || 0), asJson(d)]);
  }
  for (const r of state.aiDrafts || []) {
    await client.query(`INSERT INTO inventory_ai_results (id, kind, center_name, filename, status, model, result, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`, [r.id, r.kind || "", r.center || "", r.filename || "", r.status || "", r.model || "", asJson(r.result || {}), asJson(r)]);
  }
  for (const t of state.inspectionTemplates || []) {
    await client.query(`INSERT INTO inventory_inspection_templates (id, name, family, source_draft, payload) VALUES ($1,$2,$3,$4,$5::jsonb)`, [t.id, t.name || "", t.family || "", t.sourceDraft || "", asJson(t)]);
  }
  for (const a of state.auditLog || []) {
    await client.query(`INSERT INTO inventory_audit_log (id, event_date, user_name, action, detail, payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (id) DO NOTHING`, [a.id, a.date || new Date().toISOString(), a.user || "", a.action || "", a.detail || "", asJson(a)]);
  }
  await client.query(`INSERT INTO inventory_state_versions (saved_by, asset_count, movement_count, document_count, payload) VALUES ($1,$2,$3,$4,$5::jsonb)`, [(state.users || [])[0]?.name || "Sistema", (state.assets || []).length, (state.movements || []).length, (state.documents || []).length, asJson({ savedAt: new Date().toISOString(), assetCount: (state.assets || []).length, movementCount: (state.movements || []).length })]);
}

async function analyzeWithOpenAI(body) {
  if (!process.env.OPENAI_API_KEY) {
    return { configured: false, result: null, message: "OPENAI_API_KEY no configurada en Render" };
  }
  const isInspection = body.kind === "inspection";
  const schemaHint = isInspection
    ? `{"documentType":"inspection","title":"","familySuggestion":"","checklist":[{"item":"","expectedAnswer":"Cumple/No cumple/No aplica","requiresEvidence":false}],"requiredFields":[""],"signatures":[""],"confidence":0}`
    : `{"documentType":"purchase","supplier":"","supplierTaxId":"","folio":"","date":"","items":[{"description":"","quantity":1,"unit":"","brand":"","model":"","suggestedFamily":"","suggestedCode":"","confidence":0,"needsManualRegistration":false}],"confidence":0}`;
  const catalog = (body.catalog || []).slice(0, 250).map(a => `${a.code} | ${a.name} | ${a.family} | ${a.type}`).join("\n");
  const prompt = `Eres asistente de inventario ICC. Extrae datos desde el documento adjunto y responde SOLO JSON válido con esta forma: ${schemaHint}

Reglas:
- Si reconoces un producto del catálogo, usa suggestedCode.
- Si no lo reconoces con seguridad, deja suggestedCode vacío y needsManualRegistration=true.
- No inventes códigos.
- Confianza entre 0 y 1.

Catálogo disponible:
${catalog}`;

  const content = [{ type: "input_text", text: prompt }];
  if (body.mime?.startsWith("image/")) content.push({ type: "input_image", image_url: body.dataUrl });
  else content.push({ type: "input_file", filename: body.filename || "documento.pdf", file_data: body.dataUrl });

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5",
      input: [{ role: "user", content }]
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "No se pudo analizar con OpenAI");
  return { configured: true, result: extractJson(payload.output_text), rawModel: payload.model };
}

async function setupDatabase() {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS inventory_app_state (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await createNormalizedTables(client);
  } catch (error) {
    console.error("Base de datos no disponible al iniciar; la app seguirá funcionando en modo temporal.", error.message);
  }
  finally {
    client.release();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/health") {
    return json(res, 200, { ok: true, service: "inventario-icc", databaseConfigured: Boolean(pool), normalizedTables: Boolean(pool), openaiConfigured: Boolean(process.env.OPENAI_API_KEY) });
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    if (!pool) return json(res, 503, { error: "DATABASE_URL no configurada" });
    try {
      const result = await pool.query("SELECT payload FROM inventory_app_state WHERE id = 1");
      return json(res, 200, { state: result.rows[0]?.payload || null });
    } catch (error) {
      return json(res, 503, { error: "Base de datos no disponible", detail: error.message });
    }
  }

  if (url.pathname === "/api/state" && req.method === "PUT" && url.searchParams.get("legacy") !== "1") {
    if (!pool) return json(res, 503, { error: "DATABASE_URL no configurada" });
    const client = await pool.connect();
    try {
      const body = await readJson(req);
      if (!body.state || typeof body.state !== "object") return json(res, 400, { error: "Estado de inventario inválido" });
      await client.query("BEGIN");
      await client.query(`INSERT INTO inventory_app_state (id, payload, updated_at) VALUES (1, $1::jsonb, NOW())
        ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`, [JSON.stringify(body.state)]);
      await syncNormalizedTables(client, body.state);
      await client.query("COMMIT");
      return json(res, 200, { ok: true, normalized: true });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      return json(res, 400, { error: error.message || "No se pudo guardar" });
    } finally {
      client.release();
    }
  }

  if (url.pathname === "/api/state" && req.method === "PUT") {
    if (!pool) return json(res, 503, { error: "DATABASE_URL no configurada" });
    try {
      const body = await readJson(req);
      if (!body.state || typeof body.state !== "object") return json(res, 400, { error: "Estado de inventario inválido" });
      await pool.query(`INSERT INTO inventory_app_state (id, payload, updated_at) VALUES (1, $1::jsonb, NOW())
        ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`, [JSON.stringify(body.state)]);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo guardar" });
    }
  }

  if (url.pathname === "/api/ai/analyze" && req.method === "POST") {
    try {
      const body = await readJson(req);
      if (!body.kind || !body.filename || !body.dataUrl) return json(res, 400, { error: "Faltan datos del documento" });
      const result = await analyzeWithOpenAI(body);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo analizar el documento" });
    }
  }

  if (url.pathname === "/api/qr" && req.method === "GET") {
    const data = url.searchParams.get("data");
    if (!data) return json(res, 400, { error: "Falta dato para QR" });
    try {
      const svg = await QRCode.toString(data, { type: "svg", errorCorrectionLevel: "L", margin: 2, width: 512 });
      res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=86400" });
      return res.end(svg);
    } catch {
      return json(res, 500, { error: "No se pudo generar QR" });
    }
  }

  if (url.pathname.startsWith("/api/")) {
    return json(res, 404, { error: "API aún no implementada" });
  }

  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^[/\\]+/, "");
  const file = normalize(join(root, relative));
  if (!file.startsWith(root)) return json(res, 403, { error: "Ruta no permitida" });

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("No file");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": mime[extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(body);
  } catch {
    try {
      const body = await readFile(join(root, "index.html"));
      res.writeHead(200, { "Content-Type": mime[".html"] });
      res.end(body);
    } catch {
      json(res, 500, { error: "No se pudo cargar la aplicación" });
    }
  }
});

setupDatabase()
  .then(() => server.listen(port, "0.0.0.0", () => console.log(`Inventario ICC escuchando en puerto ${port}`)))
  .catch((error) => {
    console.error("No se pudo preparar la base de datos; la app seguirá iniciando.", error.message);
    server.listen(port, "0.0.0.0", () => console.log(`Inventario ICC escuchando en puerto ${port}`));
  });
