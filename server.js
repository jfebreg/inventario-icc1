import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import QRCode from "qrcode";
import PDFDocument from "pdfkit";
import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import {
  backfillLegacyState,
  createInspectionRun,
  createCustodyAssignment,
  createTransfer,
  dispatchTransfer,
  ensureDefaultOrganization,
  listCanonicalItems,
  listCustodyAssignments,
  listTransfers,
  listWarehouses,
  logisticsHealth,
  postStockMovement,
  registerCanonicalItem,
  reconcileLegacyState,
  receiveTransfer,
  registerItemFamily,
  registerWarehouse,
  returnCustodyAssignment,
  runLogisticsMigrations,
  stockSnapshot,
  updateInspectionRun
} from "./lib/logistics.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 3000);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png", ".md": "text/markdown; charset=utf-8" };
const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined }) : null;
const maxFileBytes = Number(process.env.MAX_FILE_BYTES || 8_000_000);
let logisticsReady = false;
let logisticsOrganizationId = "";
let logisticsStartup = null;
const initialAdmin = {
  legacyUserId: "julio-febre",
  name: "Julio Febre",
  email: "jfebreg@msn.com",
  role: "Administrador central",
  costCenter: "Bodega Central",
  initials: "JF"
};

function supabaseBaseUrl() {
  return String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
}

function storageConfigured() {
  return Boolean(supabaseBaseUrl() && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_BUCKET);
}

function authConfigured() {
  return Boolean(supabaseBaseUrl() && process.env.SUPABASE_SERVICE_ROLE_KEY && (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY));
}

const supabaseAdmin = supabaseBaseUrl() && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(supabaseBaseUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    })
  : null;

function safeTokenEqual(actual, expected) {
  const a = Buffer.from(String(actual || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

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

function safeName(value) {
  return String(value || "archivo").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w.-]+/g, "_").slice(0, 120);
}

function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) throw new Error("Archivo inválido");
  const mimeType = match[1] || "application/octet-stream";
  const data = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3] || ""), "utf8");
  if (data.length > maxFileBytes) throw new Error(`Archivo demasiado grande. Máximo permitido: ${Math.round(maxFileBytes / 1_000_000)} MB`);
  return { mimeType, data, base64: data.toString("base64") };
}

function dataUrlBuffer(value) {
  if (!value) return null;
  try { return decodeDataUrl(value).data; } catch { return null; }
}

function pdfText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim() || "—";
}

const defaultInspectionItems = [
  "Etiqueta o marcaje legible (WLL)",
  "Sin cortes, desgaste o deformaciones",
  "Sin corrosión excesiva",
  "Uso acorde al ángulo de izaje",
  "Ganchos con seguro operativo",
  "Sin fisuras, deformaciones o desgaste",
  "Capacidad compatible con la carga"
];

function inspectionItemLabel(item) {
  const raw = String(item?.item || item?.label || item?.[2] || String(item?.[0] || "")).trim();
  const direct = raw.match(/^Punto\s+(\d+)$/i);
  const resultKey = raw.match(/^result-(\d+)$/i);
  const idx = direct ? Number(direct[1]) : resultKey ? Number(resultKey[1]) : -1;
  return defaultInspectionItems[idx] || raw.replace(/^result-/, "Punto ") || "Punto revisado";
}

function drawSignature(doc, x, y, title, name, dataUrl) {
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#10251c").text(title, x, y, { width: 210 });
  const img = dataUrlBuffer(dataUrl);
  if (img) {
    try { doc.image(img, x, y + 18, { fit: [180, 55] }); } catch {}
  } else {
    doc.moveTo(x, y + 72).lineTo(x + 200, y + 72).strokeColor("#10251c").stroke();
  }
  doc.font("Helvetica").fontSize(9).fillColor("#10251c").text(pdfText(name), x, y + 80, { width: 210 });
}

async function createInspectionPdf(body) {
  const chunks = [];
  const organization = body?.organization || { name: "Ingeniería y Construcción Chile", rut: "76.267.071-2", address: "Panamá 8854, La Florida, Santiago", label: "Control de Activos" };
  const doc = new PDFDocument({ size: "A4", margin: 42, info: { Title: `Inspección ${body?.asset?.code || ""}` } });
  doc.on("data", c => chunks.push(c));
  const done = new Promise(resolve => doc.on("end", () => resolve(Buffer.concat(chunks))));
  const logoPath = join(root, "logo-icc.jpg");
  try { doc.image(logoPath, 42, 36, { fit: [62, 62] }); } catch {}
  doc.font("Helvetica-Bold").fontSize(17).text("Registro de inspección", 118, 42);
  doc.font("Helvetica").fontSize(9).text(`${pdfText(organization.name)} · ${pdfText(organization.label || "Control de Activos")}`, 118, 64);
  doc.font("Helvetica").fontSize(8).fillColor("#50635a").text(`RUT ${pdfText(organization.rut)} · ${pdfText(organization.address)}`, 118, 76, { width: 390 });
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#006b3a").text(pdfText(body?.asset?.code), 118, 92);
  doc.fillColor("#10251c").moveDown(2);
  const left = 42, right = 306, w = 235;
  const row = (label, value, x, y) => {
    doc.roundedRect(x, y, w, 42, 6).strokeColor("#d7e2dc").stroke();
    doc.fillColor("#50635a").font("Helvetica").fontSize(8).text(label, x + 9, y + 8, { width: w - 18 });
    doc.fillColor("#10251c").font("Helvetica-Bold").fontSize(10).text(pdfText(value), x + 9, y + 22, { width: w - 18 });
  };
  let y = 122;
  row("Activo", body?.asset?.name, left, y); row("Familia", body?.familyName, right, y); y += 52;
  row("Fecha", body?.inspection?.date, left, y); row("Resultado", body?.inspection?.result, right, y); y += 52;
  row("Inspector", body?.inspection?.inspector, left, y); row("Aprobador / revisor", body?.inspection?.approver || body?.inspection?.reviewer, right, y); y += 52;
  row("Proyecto / obra", body?.inspection?.project || body?.asset?.location, left, y); row("Registro adjunto", body?.inspection?.documentName, right, y); y += 62;
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#10251c").text("Checklist de inspección", left, y); y += 22;
  const answers = body?.inspection?.answers || [];
  if (!answers.length) doc.text("Sin respuestas registradas.", left, y);
  else {
    const tableX = left, colItem = 300, colResult = 88, colNote = 112, rowH = 28;
    const drawHeader = () => {
      if (doc.y > 720) doc.addPage();
      const hy = doc.y;
      doc.roundedRect(tableX, hy, 500, rowH, 6).fillAndStroke("#eef7f1", "#d7e2dc");
      doc.fillColor("#10251c").font("Helvetica-Bold").fontSize(8.5);
      doc.text("Punto revisado", tableX + 10, hy + 9, { width: colItem - 16 });
      doc.text("Resultado", tableX + colItem + 8, hy + 9, { width: colResult - 12, align: "center" });
      doc.text("Observación", tableX + colItem + colResult + 8, hy + 9, { width: colNote - 12 });
      doc.y = hy + rowH;
    };
    drawHeader();
    answers.forEach((item, idx) => {
    const label = pdfText(inspectionItemLabel(item));
    const value = pdfText(item?.result || item?.value || item?.[1]);
    const note = pdfText(item?.note || item?.[3] || "");
      if (doc.y > 720) drawHeader();
      const y0 = doc.y, fill = idx % 2 === 0 ? "#ffffff" : "#f8fbf9";
      const labelH = doc.heightOfString(label, { width: colItem - 18 });
      const noteText = note === "—" ? "" : note;
      const noteH = doc.heightOfString(noteText || "—", { width: colNote - 18 });
      const h = Math.max(30, labelH + 16, noteH + 16);
      doc.rect(tableX, y0, 500, h).fillAndStroke(fill, "#d7e2dc");
      doc.fillColor("#10251c").font("Helvetica").fontSize(9).text(label, tableX + 10, y0 + 8, { width: colItem - 18 });
      const badgeColor = value === "Cumple" ? "#d8f7df" : value === "No cumple" ? "#ffe0e0" : "#eef1f0";
      const badgeText = value === "Cumple" ? "#006b3a" : value === "No cumple" ? "#b42318" : "#50635a";
      doc.roundedRect(tableX + colItem + 15, y0 + 7, colResult - 30, 17, 8).fill(badgeColor);
      doc.fillColor(badgeText).font("Helvetica-Bold").fontSize(8).text(value, tableX + colItem + 15, y0 + 11, { width: colResult - 30, align: "center" });
      doc.fillColor("#50635a").font("Helvetica").fontSize(8).text(noteText || "—", tableX + colItem + colResult + 10, y0 + 8, { width: colNote - 18 });
      doc.y = y0 + h;
    });
  }
  doc.moveDown();
  doc.font("Helvetica-Bold").fontSize(13).text("Observaciones");
  doc.font("Helvetica").fontSize(10).text(pdfText(body?.inspection?.notes || "Sin observaciones."), { width: 500 });
  const evidence = dataUrlBuffer(body?.evidenceImage);
  if (evidence) {
    doc.moveDown();
    if (doc.y > 430) doc.addPage();
    doc.font("Helvetica-Bold").fontSize(13).text("Imagen adjunta de respaldo");
    const imageY = doc.y + 8;
    try { doc.image(evidence, left, imageY, { fit: [500, 260], align: "center" }); doc.y = imageY + 275; } catch { doc.font("Helvetica").text("No se pudo insertar la imagen adjunta."); }
  }
  if (doc.y > 620) doc.addPage();
  doc.moveDown();
  doc.font("Helvetica-Bold").fontSize(13).text("Firmas");
  const sigY = doc.y + 16;
  drawSignature(doc, left, sigY, "Firma inspector", body?.inspection?.inspector, body?.inspectorSignature);
  drawSignature(doc, right, sigY, "Firma aprobador / revisor", body?.inspection?.approver || body?.inspection?.reviewer, body?.approverSignature);
  doc.y = sigY + 112;
  doc.font("Helvetica").fontSize(8).fillColor("#50635a").text(`Documento generado automáticamente por la aplicación el ${new Date().toLocaleString("es-CL")}.`, left, doc.y, { width: 500 });
  doc.end();
  return done;
}

async function uploadFileObject(body) {
  if (!pool) throw new Error("DATABASE_URL no configurada");
  const id = body.id || `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filename = safeName(body.filename);
  const category = safeName(body.category || "documentos");
  const ref = String(body.ref || "");
  const { mimeType, data, base64 } = decodeDataUrl(body.dataUrl);
  let provider = "postgres";
  let storagePath = "";
  let publicUrl = "";

  if (storageConfigured()) {
    provider = "supabase";
    storagePath = `${category}/${new Date().toISOString().slice(0, 10)}/${id}-${filename}`;
    const endpoint = `${supabaseBaseUrl()}/storage/v1/object/${encodeURIComponent(process.env.SUPABASE_BUCKET)}/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": mimeType,
        "x-upsert": "true"
      },
      body: data
    });
    if (!response.ok) throw new Error(`No se pudo subir a Supabase Storage: ${await response.text()}`);
    publicUrl = `${supabaseBaseUrl()}/storage/v1/object/${process.env.SUPABASE_BUCKET}/${storagePath}`;
  }

  await pool.query(`INSERT INTO inventory_file_objects (id, filename, mime_type, category, ref, size_bytes, provider, storage_path, public_url, data_base64, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    ON CONFLICT (id) DO UPDATE SET filename=EXCLUDED.filename, mime_type=EXCLUDED.mime_type, category=EXCLUDED.category, ref=EXCLUDED.ref, size_bytes=EXCLUDED.size_bytes, provider=EXCLUDED.provider, storage_path=EXCLUDED.storage_path, public_url=EXCLUDED.public_url, data_base64=EXCLUDED.data_base64, payload=EXCLUDED.payload`,
    [id, filename, mimeType, category, ref, data.length, provider, storagePath, publicUrl, provider === "postgres" ? base64 : "", asJson({ originalName: body.filename, uploadedBy: body.uploadedBy || "", code: body.code || "", center: body.center || "" })]);

  return { id, filename, mimeType, size: data.length, provider, path: storagePath, publicUrl, downloadUrl: `/api/files/${encodeURIComponent(id)}` };
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
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_file_objects (id TEXT PRIMARY KEY, filename TEXT, mime_type TEXT, category TEXT, ref TEXT, size_bytes NUMERIC, provider TEXT, storage_path TEXT, public_url TEXT, data_base64 TEXT, payload JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

async function createAuthAndRealtimeTables(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_auth_settings (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    migration_complete BOOLEAN NOT NULL DEFAULT FALSE,
    bootstrap_used BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query(`INSERT INTO inventory_auth_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_user_profiles (
    id TEXT PRIMARY KEY,
    auth_user_id UUID UNIQUE,
    legacy_user_id TEXT UNIQUE,
    name TEXT NOT NULL,
    email TEXT,
    initials TEXT,
    role TEXT NOT NULL DEFAULT 'Usuario',
    cost_center TEXT NOT NULL DEFAULT 'Bodega Central',
    admin BOOLEAN NOT NULL DEFAULT FALSE,
    permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    invitation_status TEXT NOT NULL DEFAULT 'Pendiente correo',
    invited_at TIMESTAMPTZ,
    activated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS inventory_user_profiles_center_idx ON inventory_user_profiles(cost_center)`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_worker_enrollments (
    id TEXT PRIMARY KEY,
    rut TEXT,
    name TEXT NOT NULL,
    company TEXT,
    job_title TEXT,
    cost_center TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    signature_file_id TEXT,
    signature_data TEXT,
    status TEXT NOT NULL DEFAULT 'Firma pendiente',
    access_profile_id TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS inventory_worker_enrollments_rut_idx ON inventory_worker_enrollments ((UPPER(REPLACE(REPLACE(rut,'.',''),'-','')))) WHERE rut IS NOT NULL AND BTRIM(rut) <> ''`);
  await client.query(`CREATE INDEX IF NOT EXISTS inventory_worker_enrollments_center_idx ON inventory_worker_enrollments(cost_center)`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_tasks (
    id TEXT PRIMARY KEY,
    task_type TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    priority TEXT NOT NULL DEFAULT 'Media',
    status TEXT NOT NULL DEFAULT 'Pendiente',
    center_name TEXT,
    assignee_auth_user_id UUID,
    entity_type TEXT,
    entity_id TEXT,
    due_at TIMESTAMPTZ,
    created_by UUID,
    resolved_at TIMESTAMPTZ,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS inventory_tasks_center_status_idx ON inventory_tasks(center_name, status)`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_notifications (
    id TEXT PRIMARY KEY,
    recipient_auth_user_id UUID,
    center_name TEXT,
    notification_type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    severity TEXT NOT NULL DEFAULT 'info',
    entity_type TEXT,
    entity_id TEXT,
    read_at TIMESTAMPTZ,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS inventory_notifications_recipient_idx ON inventory_notifications(recipient_auth_user_id, read_at)`);

  await client.query(`CREATE OR REPLACE FUNCTION public.inventory_is_admin()
    RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT COALESCE((SELECT admin AND active FROM public.inventory_user_profiles WHERE auth_user_id = auth.uid()), FALSE) $$`);
  await client.query(`CREATE OR REPLACE FUNCTION public.inventory_user_center()
    RETURNS TEXT LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT cost_center FROM public.inventory_user_profiles WHERE auth_user_id = auth.uid() AND active LIMIT 1 $$`);

  const serverOnlyTables = [
    "inventory_app_state", "inventory_families", "inventory_cost_centers", "inventory_users",
    "inventory_assets", "inventory_asset_stock", "inventory_movements", "inventory_workers",
    "inventory_worker_signatures", "inventory_inspections", "inventory_documents", "inventory_ai_results",
    "inventory_inspection_templates", "inventory_audit_log", "inventory_state_versions", "inventory_file_objects"
  ];
  for (const table of serverOnlyTables) {
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await client.query(`REVOKE ALL ON ${table} FROM anon, authenticated`);
  }
  for (const table of ["inventory_user_profiles", "inventory_worker_enrollments", "inventory_tasks", "inventory_notifications"]) {
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await client.query(`REVOKE ALL ON ${table} FROM anon, authenticated`);
    await client.query(`GRANT SELECT ON ${table} TO authenticated`);
  }
  await client.query(`DROP POLICY IF EXISTS inventory_profiles_read ON inventory_user_profiles`);
  await client.query(`CREATE POLICY inventory_profiles_read ON inventory_user_profiles FOR SELECT TO authenticated
    USING (auth_user_id = auth.uid() OR public.inventory_is_admin())`);
  await client.query(`DROP POLICY IF EXISTS inventory_workers_read ON inventory_worker_enrollments`);
  await client.query(`CREATE POLICY inventory_workers_read ON inventory_worker_enrollments FOR SELECT TO authenticated
    USING (public.inventory_is_admin() OR cost_center = public.inventory_user_center())`);
  await client.query(`DROP POLICY IF EXISTS inventory_tasks_read ON inventory_tasks`);
  await client.query(`CREATE POLICY inventory_tasks_read ON inventory_tasks FOR SELECT TO authenticated
    USING (public.inventory_is_admin() OR assignee_auth_user_id = auth.uid() OR center_name = public.inventory_user_center())`);
  await client.query(`DROP POLICY IF EXISTS inventory_notifications_read ON inventory_notifications`);
  await client.query(`CREATE POLICY inventory_notifications_read ON inventory_notifications FOR SELECT TO authenticated
    USING (public.inventory_is_admin() OR recipient_auth_user_id = auth.uid() OR (recipient_auth_user_id IS NULL AND center_name = public.inventory_user_center()))`);

  for (const table of ["inventory_tasks", "inventory_notifications"]) {
    try {
      await client.query(`ALTER PUBLICATION supabase_realtime ADD TABLE ${table}`);
    } catch (error) {
      if (!/already|publication.*does not exist/i.test(error.message)) throw error;
    }
  }
}

function defaultPermissions(role, admin = false) {
  if (admin || role === "Administrador central") return ["view", "inspect", "approve", "move", "receive", "terrain", "print", "workers", "admin", "ai", "audit"];
  if (role === "Responsable centro de costo") return ["view", "inspect", "approve", "move", "receive", "terrain", "print", "workers"];
  return ["view", "inspect"];
}

async function migrateLegacyIdentityData(client) {
  const stateResult = await client.query("SELECT payload FROM inventory_app_state WHERE id = 1");
  const state = stateResult.rows[0]?.payload || {};
  const legacyUsers = Array.isArray(state.users) ? state.users : [];
  for (const user of legacyUsers) {
    const role = user.role || (user.admin ? "Administrador central" : "Usuario");
    await client.query(`INSERT INTO inventory_user_profiles
      (id, legacy_user_id, name, email, initials, role, cost_center, admin, permissions, active, invitation_status, updated_at)
      VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8::jsonb,TRUE,$9,NOW())
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, initials=EXCLUDED.initials, role=EXCLUDED.role,
      cost_center=EXCLUDED.cost_center, admin=EXCLUDED.admin, permissions=EXCLUDED.permissions, updated_at=NOW()`,
      [String(user.id), user.name || "Usuario", user.email || "", user.initials || "", role, user.costCenter || "Bodega Central", Boolean(user.admin), asJson(defaultPermissions(role, user.admin)), user.email ? "Pendiente invitación" : "Pendiente correo"]);
  }
  await client.query(`INSERT INTO inventory_user_profiles
    (id, legacy_user_id, name, email, initials, role, cost_center, admin, permissions, active, invitation_status, updated_at)
    VALUES ($1,$1,$2,$3,$4,$5,$6,TRUE,$7::jsonb,TRUE,'Administrador inicial',NOW())
    ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email, role=EXCLUDED.role,
    cost_center=EXCLUDED.cost_center, admin=TRUE, permissions=EXCLUDED.permissions, active=TRUE, updated_at=NOW()`,
    [initialAdmin.legacyUserId, initialAdmin.name, initialAdmin.email, initialAdmin.initials, initialAdmin.role, initialAdmin.costCenter, asJson(defaultPermissions(initialAdmin.role, true))]);

  for (const center of state.costCenters || []) {
    for (const raw of center.workers || []) {
      const worker = parseWorkerLine(raw, center);
      const signature = state.workerSignatures?.[worker.name] || "";
      await client.query(`INSERT INTO inventory_worker_enrollments
        (id, name, cost_center, email, phone, signature_data, status, payload, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NOW())
        ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, phone=EXCLUDED.phone,
        signature_data=CASE WHEN inventory_worker_enrollments.signature_data='' THEN EXCLUDED.signature_data ELSE inventory_worker_enrollments.signature_data END,
        status=CASE WHEN inventory_worker_enrollments.signature_data<>'' OR EXCLUDED.signature_data<>'' THEN 'Activo' ELSE inventory_worker_enrollments.status END,
        updated_at=NOW()`,
        [worker.id, worker.name, center.name, worker.email, worker.phone, signature, signature ? "Activo" : "Firma pendiente", asJson({ legacy: true, raw })]);
    }
  }
}

async function authSettings() {
  if (!pool) return { migration_complete: false, bootstrap_used: false };
  const result = await pool.query("SELECT * FROM inventory_auth_settings WHERE id = 1");
  return result.rows[0] || { migration_complete: false, bootstrap_used: false };
}

async function requestProfile(req) {
  if (!authConfigured() || !supabaseAdmin) return null;
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return null;
  const result = await pool.query("SELECT * FROM inventory_user_profiles WHERE auth_user_id=$1 AND active=TRUE", [data.user.id]);
  const profile = result.rows[0];
  return profile ? { ...profile, authUser: data.user } : null;
}

async function requestLegacyProfile(req) {
  if (!pool) return null;
  const legacyUserId = String(req.headers["x-legacy-user-id"] || "").trim();
  if (!legacyUserId) return null;
  const result = await pool.query(`SELECT * FROM inventory_user_profiles
    WHERE active=TRUE AND (id=$1 OR legacy_user_id=$1) LIMIT 1`, [legacyUserId]);
  return result.rows[0] || null;
}

async function findAuthUserByEmail(email) {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  return data.users.find(user => String(user.email || "").toLowerCase() === String(email || "").toLowerCase()) || null;
}

async function inviteProfile(profile, email) {
  const redirectTo = `${String(process.env.APP_BASE_URL || "").replace(/\/+$/, "") || "https://inventario-icc1.onrender.com"}/?auth=invite`;
  let authUser = await findAuthUserByEmail(email);
  if (!authUser) {
    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { name: profile.name, legacy_user_id: profile.legacy_user_id }
    });
    if (error) throw error;
    authUser = data.user;
  } else {
    const { error } = await supabaseAdmin.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
  }
  await pool.query(`UPDATE inventory_user_profiles SET auth_user_id=$1, email=$2, invitation_status=$3,
    invited_at=COALESCE(invited_at,NOW()), updated_at=NOW() WHERE id=$4`,
    [authUser.id, email, authUser.email_confirmed_at ? "Activo" : "Invitación enviada", profile.id]);
  return authUser;
}

function profileCan(profile, permission) {
  if (!profile) return false;
  if (profile.admin) return true;
  const permissions = Array.isArray(profile.permissions) ? profile.permissions : [];
  return permissions.includes(permission);
}

async function profileMayAccessWarehouse(profile, warehouseId) {
  if (!profile || !warehouseId) return false;
  if (profile.admin) return true;
  const result = await pool.query(`SELECT 1 FROM logistics_warehouses w
    JOIN logistics_cost_centers cc ON cc.id=w.cost_center_id
    WHERE w.id=$1 AND cc.name=$2 AND w.active=TRUE`, [warehouseId, profile.cost_center]);
  return Boolean(result.rowCount);
}

async function profileMayAccessLocation(profile, locationId) {
  if (!profile || !locationId) return false;
  if (profile.admin) return true;
  const result = await pool.query(`SELECT 1 FROM logistics_locations loc
    JOIN logistics_warehouses w ON w.id=loc.warehouse_id
    JOIN logistics_cost_centers cc ON cc.id=w.cost_center_id
    WHERE loc.id=$1 AND cc.name=$2 AND loc.active=TRUE`, [locationId, profile.cost_center]);
  return Boolean(result.rowCount);
}

function assetBelongsToCenter(asset, center) {
  if (!asset || !center) return false;
  return asset.location === center || Number(asset.stocks?.[center] || 0) > 0;
}

function stateForProfile(state, profile) {
  if (!profile || profile.admin) return state;
  const center = profile.cost_center;
  const visibleAssets = (state.assets || []).filter(asset => assetBelongsToCenter(asset, center));
  const ids = new Set(visibleAssets.map(asset => asset.id));
  const codes = new Set(visibleAssets.map(asset => asset.code));
  const costCenter = (state.costCenters || []).find(item => item.name === center);
  const workerNames = new Set((costCenter?.workers || []).map(raw => parseWorkerLine(raw, costCenter).name));
  return {
    ...state,
    users: (state.users || []).filter(user => user.id === profile.legacy_user_id || user.name === profile.name),
    costCenters: [costCenter, (state.costCenters || []).find(item => item.name === "En tránsito")].filter(Boolean),
    assets: visibleAssets,
    movements: (state.movements || []).filter(item => item.from === center || item.to === center || codes.has(item.code)),
    inspections: (state.inspections || []).filter(item => ids.has(item.assetId)),
    documents: (state.documents || []).filter(item => item.center === center || codes.has(item.code)),
    assignments: (state.assignments || []).filter(item => item.from === center || item.center === center || codes.has(item.code)),
    workerSignatures: Object.fromEntries(Object.entries(state.workerSignatures || {}).filter(([name]) => workerNames.has(name))),
    auditLog: (state.auditLog || []).filter(item => item.user === profile.name).slice(0, 200)
  };
}

function mergeCollectionById(target, incoming, canUse, fallbackPrefix) {
  const result = [...(target || [])];
  const index = new Map(result.map((item, idx) => [String(item.id || `${fallbackPrefix}-${idx}-${item.code || ""}-${item.date || ""}`), idx]));
  for (const [idx, item] of (incoming || []).entries()) {
    if (!canUse(item)) continue;
    const id = String(item.id || `${fallbackPrefix}-${idx}-${item.code || ""}-${item.date || ""}`);
    if (index.has(id)) result[index.get(id)] = item;
    else {
      index.set(id, result.length);
      result.push(item);
    }
  }
  return result;
}

function mergeStateForProfile(current, incoming, profile) {
  if (!profile || profile.admin) return incoming;
  const center = profile.cost_center;
  const merged = structuredClone(current);
  const permittedIds = new Set((current.assets || []).filter(asset => assetBelongsToCenter(asset, center)).map(asset => asset.id));
  const permittedCodes = new Set((current.assets || []).filter(asset => permittedIds.has(asset.id)).map(asset => asset.code));
  const canOperate = profileCan(profile, "move") || profileCan(profile, "inspect");
  if (canOperate) {
    merged.assets = mergeCollectionById(current.assets, incoming.assets, asset => permittedIds.has(asset.id) || (profileCan(profile, "move") && asset.location === center), "asset");
    merged.movements = mergeCollectionById(current.movements, incoming.movements, item => item.from === center || item.to === center || permittedCodes.has(item.code), "movement");
    merged.inspections = mergeCollectionById(current.inspections, incoming.inspections, item => permittedIds.has(item.assetId), "inspection");
    merged.documents = mergeCollectionById(current.documents, incoming.documents, item => item.center === center || permittedCodes.has(item.code), "document");
    merged.assignments = mergeCollectionById(current.assignments, incoming.assignments, item => item.from === center || item.center === center || permittedCodes.has(item.code), "assignment");
  }
  if (profileCan(profile, "inspect") || profileCan(profile, "workers")) {
    const incomingCenter = (incoming.costCenters || []).find(item => item.name === center);
    const currentIndex = (merged.costCenters || []).findIndex(item => item.name === center);
    if (incomingCenter && currentIndex >= 0) {
      merged.costCenters[currentIndex] = {
        ...merged.costCenters[currentIndex],
        inspectors: incomingCenter.inspectors || merged.costCenters[currentIndex].inspectors,
        approvers: incomingCenter.approvers || merged.costCenters[currentIndex].approvers,
        workers: incomingCenter.workers || merged.costCenters[currentIndex].workers,
        safetyAdvisorName: incomingCenter.safetyAdvisorName ?? merged.costCenters[currentIndex].safetyAdvisorName,
        safetyAdvisorSignature: incomingCenter.safetyAdvisorSignature ?? merged.costCenters[currentIndex].safetyAdvisorSignature
      };
    }
    const allowedNames = new Set((incomingCenter?.workers || []).map(raw => parseWorkerLine(raw, incomingCenter).name));
    merged.workerSignatures = { ...(current.workerSignatures || {}) };
    for (const [name, signature] of Object.entries(incoming.workerSignatures || {})) {
      if (allowedNames.has(name)) merged.workerSignatures[name] = signature;
    }
  }
  merged.auditLog = mergeCollectionById(current.auditLog, incoming.auditLog, item => item.user === profile.name, "audit");
  return merged;
}

async function syncNormalizedTables(client, state, savedBy = "Sistema") {
  for (const f of state.families || []) {
    await client.query(`INSERT INTO inventory_families (id, name, prefix, serial, inspection, payload, updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW())
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, prefix=EXCLUDED.prefix, serial=EXCLUDED.serial, inspection=EXCLUDED.inspection, payload=EXCLUDED.payload, updated_at=NOW()`, [f.id, f.name, f.prefix, Boolean(f.serial), f.inspection || "", asJson(f)]);
  }
  for (const c of state.costCenters || []) {
    await client.query(`INSERT INTO inventory_cost_centers (id, name, safety_advisor_name, payload, updated_at) VALUES ($1,$2,$3,$4::jsonb,NOW())
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, safety_advisor_name=EXCLUDED.safety_advisor_name, payload=EXCLUDED.payload, updated_at=NOW()`, [c.id || c.name, c.name, c.safetyAdvisorName || "", asJson(c)]);
    for (const raw of c.workers || []) {
      const w = parseWorkerLine(raw, c);
      await client.query(`INSERT INTO inventory_workers (id, cost_center_id, cost_center_name, name, email, phone, payload, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW())
        ON CONFLICT (id) DO UPDATE SET cost_center_id=EXCLUDED.cost_center_id, cost_center_name=EXCLUDED.cost_center_name, name=EXCLUDED.name, email=EXCLUDED.email, phone=EXCLUDED.phone, payload=EXCLUDED.payload, updated_at=NOW()`, [w.id, c.id || c.name, c.name, w.name, w.email, w.phone, asJson({ raw, ...w })]);
    }
  }
  for (const u of state.users || []) {
    await client.query(`INSERT INTO inventory_users (id, name, initials, role, cost_center, admin, payload, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW())
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, initials=EXCLUDED.initials, role=EXCLUDED.role, cost_center=EXCLUDED.cost_center, admin=EXCLUDED.admin, payload=EXCLUDED.payload, updated_at=NOW()`, [u.id, u.name, u.initials || "", u.role || "", u.costCenter || "", Boolean(u.admin), asJson(u)]);
  }
  for (const [name, signature] of Object.entries(state.workerSignatures || {})) {
    await client.query(`INSERT INTO inventory_worker_signatures (worker_name, signature_data, has_signature, updated_at) VALUES ($1,$2,$3,NOW())
      ON CONFLICT (worker_name) DO UPDATE SET signature_data=EXCLUDED.signature_data, has_signature=EXCLUDED.has_signature, updated_at=NOW()`, [name, signature || "", Boolean(signature)]);
  }
  for (const a of state.assets || []) {
    await client.query(`INSERT INTO inventory_assets (id, code, base_code, unit_no, unit_count, name, family_id, type, serial, brand, status, location, responsible, stock, minimum, payload, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,NOW())
      ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code, base_code=EXCLUDED.base_code, unit_no=EXCLUDED.unit_no, unit_count=EXCLUDED.unit_count, name=EXCLUDED.name, family_id=EXCLUDED.family_id, type=EXCLUDED.type, serial=EXCLUDED.serial, brand=EXCLUDED.brand, status=EXCLUDED.status, location=EXCLUDED.location, responsible=EXCLUDED.responsible, stock=EXCLUDED.stock, minimum=EXCLUDED.minimum, payload=EXCLUDED.payload, updated_at=NOW()`, [a.id, a.code, a.baseCode || a.code, Number(a.unitNo || 1), Number(a.unitCount || 1), a.name, a.family, a.type, a.serial || "", a.brand || "", a.status || "", a.location || "", a.responsible || "", Number(a.stock || 0), Number(a.minimum || 0), asJson(a)]);
    for (const [center, qty] of Object.entries(a.stocks || {})) {
      await client.query(`INSERT INTO inventory_asset_stock (asset_id, center_name, quantity, updated_at) VALUES ($1,$2,$3,NOW())
        ON CONFLICT (asset_id, center_name) DO UPDATE SET quantity=EXCLUDED.quantity, updated_at=NOW()`, [a.id, center, Number(qty || 0)]);
    }
  }
  for (const [idx, m] of (state.movements || []).entries()) {
    const id = m.id || `legacy-${idx}-${m.code || "sin-codigo"}-${m.date || ""}`;
    await client.query(`INSERT INTO inventory_movements (id, movement_date, code, action, user_name, from_location, to_location, quantity, status, detail, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT (id) DO NOTHING`, [id, m.date || "", m.code || "", m.action || "", m.user || "", m.from || "", m.to || "", Number(m.qty || 1), m.status || "", m.detail || "", asJson(m)]);
  }
  for (const i of state.inspections || []) {
    await client.query(`INSERT INTO inventory_inspections (id, asset_id, inspection_date, inspector, approver, result, notes, payload, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NOW())
      ON CONFLICT (id) DO UPDATE SET asset_id=EXCLUDED.asset_id, inspection_date=EXCLUDED.inspection_date, inspector=EXCLUDED.inspector, approver=EXCLUDED.approver, result=EXCLUDED.result, notes=EXCLUDED.notes, payload=EXCLUDED.payload, updated_at=NOW()`, [i.id, i.assetId || "", i.date || "", i.inspector || "", i.approver || "", i.result || "", i.notes || "", asJson(i)]);
  }
  for (const d of state.documents || []) {
    await client.query(`INSERT INTO inventory_documents (id, name, type, kind, source, draft_id, size_bytes, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, type=EXCLUDED.type, kind=EXCLUDED.kind, source=EXCLUDED.source, draft_id=EXCLUDED.draft_id, size_bytes=EXCLUDED.size_bytes, payload=EXCLUDED.payload`, [d.id, d.name || "", d.type || "", d.kind || "", d.source || "", d.draftId || "", Number(d.size || d.size_bytes || 0), asJson(d)]);
  }
  for (const r of state.aiDrafts || []) {
    await client.query(`INSERT INTO inventory_ai_results (id, kind, center_name, filename, status, model, result, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
      ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind, center_name=EXCLUDED.center_name, filename=EXCLUDED.filename, status=EXCLUDED.status, model=EXCLUDED.model, result=EXCLUDED.result, payload=EXCLUDED.payload`, [r.id, r.kind || "", r.center || "", r.filename || "", r.status || "", r.model || "", asJson(r.result || {}), asJson(r)]);
  }
  for (const t of state.inspectionTemplates || []) {
    await client.query(`INSERT INTO inventory_inspection_templates (id, name, family, source_draft, payload) VALUES ($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, family=EXCLUDED.family, source_draft=EXCLUDED.source_draft, payload=EXCLUDED.payload`, [t.id, t.name || "", t.family || "", t.sourceDraft || "", asJson(t)]);
  }
  for (const a of state.auditLog || []) {
    await client.query(`INSERT INTO inventory_audit_log (id, event_date, user_name, action, detail, payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (id) DO NOTHING`, [a.id, a.date || new Date().toISOString(), a.user || "", a.action || "", a.detail || "", asJson(a)]);
  }
  await client.query(`INSERT INTO inventory_state_versions (saved_by, asset_count, movement_count, document_count, payload) VALUES ($1,$2,$3,$4,$5::jsonb)`, [savedBy || "Sistema", (state.assets || []).length, (state.movements || []).length, (state.documents || []).length, asJson({ savedAt: new Date().toISOString(), savedBy: savedBy || "Sistema", assetCount: (state.assets || []).length, movementCount: (state.movements || []).length })]);
}

async function syncOperationalTasks(client, state) {
  const tasks = [];
  const assetById = new Map((state.assets || []).map(asset => [asset.id, asset]));
  const add = (task) => tasks.push({
    priority: "Media",
    center: "Bodega Central",
    detail: "",
    entityType: "",
    entityId: "",
    dueAt: null,
    ...task
  });
  for (const inspection of state.inspections || []) {
    const asset = assetById.get(inspection.assetId);
    const center = asset?.location || inspection.project || "Bodega Central";
    if (inspection.result === "No aprobado" && !inspection.correctionDate) {
      add({ id: `inspection-${inspection.id}`, type: "Inspección rechazada", title: `Inspección pendiente: ${asset?.code || inspection.assetId}`, detail: inspection.notes || "Requiere revisión y definición de plazo.", priority: "Alta", center, entityType: "inspection", entityId: inspection.id, dueAt: inspection.correctionDue || null });
    }
    if (inspection.correctionDue && !inspection.correctionDate) {
      const overdue = new Date(`${inspection.correctionDue}T23:59:59`) < new Date();
      add({ id: `correction-${inspection.id}`, type: "Corrección", title: `${overdue ? "Corrección vencida" : "Corrección pendiente"}: ${asset?.code || inspection.assetId}`, detail: inspection.approvalInstruction || inspection.notes || "Levantamiento pendiente.", priority: overdue ? "Crítica" : "Alta", center, entityType: "inspection", entityId: inspection.id, dueAt: inspection.correctionDue });
    }
  }
  for (const asset of state.assets || []) {
    if (String(asset.status || "").toLowerCase() === "bloqueado") {
      add({ id: `blocked-${asset.id}`, type: "Activo bloqueado", title: `Activo bloqueado: ${asset.code}`, detail: asset.name, priority: "Crítica", center: asset.location || "Bodega Central", entityType: "asset", entityId: asset.id });
    }
    if (asset.type === "Consumible" && Number(asset.minimum || 0) > 0 && Number(asset.stock || 0) <= Number(asset.minimum || 0)) {
      add({ id: `stock-${asset.id}`, type: "Stock bajo", title: `Stock bajo: ${asset.code}`, detail: `${asset.name}. Stock ${asset.stock || 0}; mínimo ${asset.minimum}.`, priority: Number(asset.stock || 0) === 0 ? "Crítica" : "Alta", center: asset.location || "Bodega Central", entityType: "asset", entityId: asset.id });
    }
  }
  for (const movement of state.movements || []) {
    if (movement.status === "En tránsito") {
      add({ id: `transfer-${movement.id || movement.code}-${movement.date || ""}`, type: "Recepción pendiente", title: `Traslado pendiente: ${movement.code}`, detail: `${movement.from || "Origen"} → ${movement.to || "Destino"} · ${movement.qty || 1} unidad(es).`, priority: "Alta", center: movement.to || "Bodega Central", entityType: "movement", entityId: movement.id || movement.code });
    }
  }
  for (const assignment of state.assignments || []) {
    if (/Pendiente aceptación/i.test(assignment.status || "")) {
      add({ id: `epp-${assignment.id}`, type: "Aceptación EPP", title: `Aceptación pendiente: ${assignment.code}`, detail: `${assignment.worker} · ${assignment.qty || 1} unidad(es).`, priority: "Alta", center: assignment.from || assignment.center || "Bodega Central", entityType: "assignment", entityId: assignment.id });
    }
  }
  for (const document of state.documents || []) {
    if (/Pendiente archivo|Error/i.test(document.status || "") || document.uploadError) {
      add({ id: `file-${document.id}`, type: "Documento pendiente", title: `Archivo pendiente: ${document.name}`, detail: document.uploadError || "El archivo obligatorio no quedó almacenado.", priority: "Alta", center: document.center || "Bodega Central", entityType: "document", entityId: document.id });
    }
  }

  const openIds = [];
  for (const task of tasks) {
    openIds.push(task.id);
    const responsible = await client.query(`SELECT auth_user_id FROM inventory_user_profiles
      WHERE active=TRUE AND auth_user_id IS NOT NULL AND (cost_center=$1 OR admin=TRUE)
      ORDER BY admin ASC, updated_at DESC LIMIT 1`, [task.center]);
    const assignee = responsible.rows[0]?.auth_user_id || null;
    await client.query(`INSERT INTO inventory_tasks
      (id, task_type, title, detail, priority, status, center_name, assignee_auth_user_id, entity_type, entity_id, due_at, payload, updated_at)
      VALUES ($1,$2,$3,$4,$5,'Pendiente',$6,$7,$8,$9,$10,$11::jsonb,NOW())
      ON CONFLICT (id) DO UPDATE SET task_type=EXCLUDED.task_type, title=EXCLUDED.title, detail=EXCLUDED.detail,
      priority=EXCLUDED.priority, center_name=EXCLUDED.center_name, assignee_auth_user_id=EXCLUDED.assignee_auth_user_id,
      entity_type=EXCLUDED.entity_type, entity_id=EXCLUDED.entity_id, due_at=EXCLUDED.due_at,
      status=CASE WHEN inventory_tasks.status='En proceso' THEN 'En proceso' ELSE 'Pendiente' END, resolved_at=NULL, updated_at=NOW()`,
      [task.id, task.type, task.title, task.detail, task.priority, task.center, assignee, task.entityType, task.entityId, task.dueAt, asJson(task)]);
    await client.query(`INSERT INTO inventory_notifications
      (id, recipient_auth_user_id, center_name, notification_type, title, body, severity, entity_type, entity_id, payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
      ON CONFLICT (id) DO NOTHING`,
      [`notification-${task.id}`, assignee, task.center, task.type, task.title, task.detail, task.priority === "Crítica" ? "critical" : "warning", task.entityType, task.entityId, asJson(task)]);
  }
  if (openIds.length) {
    await client.query(`UPDATE inventory_tasks SET status='Resuelta', resolved_at=COALESCE(resolved_at,NOW()), updated_at=NOW()
      WHERE status <> 'Resuelta' AND NOT (id = ANY($1::text[]))`, [openIds]);
  } else {
    await client.query(`UPDATE inventory_tasks SET status='Resuelta', resolved_at=COALESCE(resolved_at,NOW()), updated_at=NOW() WHERE status <> 'Resuelta'`);
  }
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
    await createAuthAndRealtimeTables(client);
    await migrateLegacyIdentityData(client);
    const stateResult = await client.query("SELECT payload FROM inventory_app_state WHERE id=1");
    if (stateResult.rows[0]?.payload) await syncOperationalTasks(client, stateResult.rows[0].payload);
    await runLogisticsMigrations(pool, join(root, "migrations"));
    const organization = await ensureDefaultOrganization(pool);
    logisticsOrganizationId = organization.id;
    logisticsStartup = await backfillLegacyState(pool);
    logisticsOrganizationId = logisticsStartup.organizationId || logisticsOrganizationId;
    logisticsReady = true;
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
    let logistics = null;
    if (pool && logisticsReady) {
      try { logistics = await logisticsHealth(pool); } catch {}
    }
    return json(res, 200, { ok: true, service: "inventario-icc", databaseConfigured: Boolean(pool), normalizedTables: Boolean(pool), logisticsReady, logistics, logisticsStartup, openaiConfigured: Boolean(process.env.OPENAI_API_KEY), fileStorageConfigured: storageConfigured(), authConfigured: authConfigured() });
  }

  if (url.pathname === "/api/public-config") {
    const settings = await authSettings();
    return json(res, 200, {
      supabaseUrl: supabaseBaseUrl(),
      supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "",
      authConfigured: authConfigured(),
      migrationComplete: Boolean(settings.migration_complete),
      bootstrapUsed: Boolean(settings.bootstrap_used),
      appBaseUrl: process.env.APP_BASE_URL || "https://inventario-icc1.onrender.com",
      initialAdmin
    });
  }

  if (url.pathname === "/api/auth/bootstrap" && req.method === "POST") {
    if (!authConfigured()) return json(res, 503, { error: "Supabase Auth aún no está configurado en Render." });
    if (!process.env.AUTH_BOOTSTRAP_TOKEN) return json(res, 503, { error: "AUTH_BOOTSTRAP_TOKEN no está configurado en Render." });
    try {
      const body = await readJson(req);
      if (!safeTokenEqual(body.token, process.env.AUTH_BOOTSTRAP_TOKEN)) return json(res, 403, { error: "Código de activación incorrecto." });
      const result = await pool.query("SELECT * FROM inventory_user_profiles WHERE id=$1", [initialAdmin.legacyUserId]);
      const profile = result.rows[0];
      if (!profile) return json(res, 500, { error: "No se pudo preparar el perfil de Julio Febre." });
      await inviteProfile(profile, initialAdmin.email);
      await pool.query("UPDATE inventory_auth_settings SET bootstrap_used=TRUE, updated_at=NOW() WHERE id=1");
      return json(res, 200, { ok: true, message: `Invitación enviada a ${initialAdmin.email}.` });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo enviar la invitación inicial." });
    }
  }

  if (url.pathname === "/api/public/acceptance" && req.method === "GET") {
    if (!pool) return json(res, 503, { error: "Base de datos no configurada." });
    const token = url.searchParams.get("token");
    const result = await pool.query("SELECT payload FROM inventory_app_state WHERE id=1");
    const current = result.rows[0]?.payload || {};
    const assignment = (current.assignments || []).find(item => item.token === token);
    const asset = (current.assets || []).find(item => item.id === assignment?.assetId || item.code === assignment?.code);
    if (!assignment || !asset) return json(res, 404, { error: "No encontramos el cargo." });
    return json(res, 200, { assignment, asset: { id: asset.id, code: asset.code, name: asset.name, type: asset.type } });
  }

  if (url.pathname === "/api/public/acceptance" && req.method === "POST") {
    if (!pool) return json(res, 503, { error: "Base de datos no configurada." });
    const client = await pool.connect();
    try {
      const body = await readJson(req);
      await client.query("BEGIN");
      const result = await client.query("SELECT payload FROM inventory_app_state WHERE id=1 FOR UPDATE");
      const current = result.rows[0]?.payload || {};
      const assignment = (current.assignments || []).find(item => item.token === body.token);
      const asset = (current.assets || []).find(item => item.id === assignment?.assetId || item.code === assignment?.code);
      if (!assignment || !asset) throw new Error("No encontramos el cargo.");
      if (assignment.status === "Aceptado") throw new Error("Este cargo ya fue aceptado.");
      const today = new Date().toISOString().slice(0, 10);
      assignment.status = "Aceptado";
      assignment.acceptedDate = today;
      assignment.acceptedBy = String(body.acceptedBy || assignment.worker);
      assignment.confirmationSent = false;
      asset.status = "A cargo de trabajador";
      asset.responsible = assignment.worker;
      current.movements = current.movements || [];
      current.movements.unshift({ id: `m${Date.now()}`, date: today, code: asset.code, action: "Aceptación de cargo EPP", user: assignment.acceptedBy, from: assignment.from, to: assignment.worker, qty: assignment.qty, status: "Aceptado", detail: `Trabajador acepta cargo digitalmente. Producto: ${asset.name}.` });
      await client.query("UPDATE inventory_app_state SET payload=$1::jsonb, updated_at=NOW() WHERE id=1", [asJson(current)]);
      await syncNormalizedTables(client, current, assignment.acceptedBy);
      await syncOperationalTasks(client, current);
      await client.query("COMMIT");
      return json(res, 200, { ok: true, message: "Cargo aceptado correctamente." });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      return json(res, 400, { error: error.message || "No se pudo aceptar el cargo." });
    } finally {
      client.release();
    }
  }

  let apiProfile = null;
  if (url.pathname === "/api/session/profile") {
    apiProfile = await requestProfile(req);
    if (!apiProfile) return json(res, 401, { error: "Sesión inválida o usuario sin perfil activo." });
    if (apiProfile.admin) {
      await pool.query(`UPDATE inventory_user_profiles SET invitation_status='Activo', activated_at=COALESCE(activated_at,NOW()), updated_at=NOW() WHERE id=$1`, [apiProfile.id]);
      await pool.query("UPDATE inventory_auth_settings SET migration_complete=TRUE, bootstrap_used=TRUE, updated_at=NOW() WHERE id=1");
    }
    return json(res, 200, { profile: apiProfile, migrationComplete: apiProfile.admin ? true : Boolean((await authSettings()).migration_complete) });
  }

  const publicApi = new Set(["/api/health", "/api/public-config", "/api/auth/bootstrap", "/api/public/acceptance", "/api/qr"]);
  if (url.pathname.startsWith("/api/") && !publicApi.has(url.pathname)) {
    const settings = await authSettings();
    if (authConfigured() && settings.migration_complete) {
      apiProfile = await requestProfile(req);
      if (!apiProfile) return json(res, 401, { error: "Debes iniciar sesión nuevamente." });
    } else {
      apiProfile = await requestProfile(req);
      if (!apiProfile) apiProfile = await requestLegacyProfile(req);
      if (!apiProfile) return json(res, 401, { error: "Debes identificarte para usar la API durante la migracion." });
    }
  }

  if (url.pathname === "/api/admin/users" && req.method === "GET") {
    if (!apiProfile?.admin) return json(res, 403, { error: "Sólo el administrador puede gestionar usuarios." });
    const result = await pool.query(`SELECT id, legacy_user_id, auth_user_id, name, email, initials, role, cost_center, admin, permissions, active, invitation_status, invited_at, activated_at
      FROM inventory_user_profiles ORDER BY admin DESC, name`);
    return json(res, 200, { users: result.rows });
  }

  if (url.pathname === "/api/admin/users/invite" && req.method === "POST") {
    if (!apiProfile?.admin) return json(res, 403, { error: "Sólo el administrador puede invitar usuarios." });
    try {
      const body = await readJson(req);
      const email = String(body.email || "").trim().toLowerCase();
      if (!email || !email.includes("@")) return json(res, 400, { error: "Ingresa un correo válido." });
      const id = String(body.id || body.legacyUserId || `user-${Date.now()}`);
      const role = body.role || "Usuario";
      const admin = role === "Administrador central";
      await pool.query(`INSERT INTO inventory_user_profiles
        (id, legacy_user_id, name, email, initials, role, cost_center, admin, permissions, active, invitation_status, updated_at)
        VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8::jsonb,TRUE,'Pendiente invitación',NOW())
        ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email, initials=EXCLUDED.initials,
        role=EXCLUDED.role, cost_center=EXCLUDED.cost_center, admin=EXCLUDED.admin, permissions=EXCLUDED.permissions,
        active=TRUE, updated_at=NOW()`,
        [id, body.name || email, email, body.initials || "", role, body.costCenter || "Bodega Central", admin, asJson(body.permissions || defaultPermissions(role, admin))]);
      const profileResult = await pool.query("SELECT * FROM inventory_user_profiles WHERE id=$1", [id]);
      await inviteProfile(profileResult.rows[0], email);
      return json(res, 200, { ok: true, message: `Invitación enviada a ${email}.` });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo invitar al usuario." });
    }
  }

  if (url.pathname.startsWith("/api/admin/users/") && req.method === "PATCH") {
    if (!apiProfile?.admin) return json(res, 403, { error: "Sólo el administrador puede modificar usuarios." });
    try {
      const id = decodeURIComponent(url.pathname.replace("/api/admin/users/", ""));
      const body = await readJson(req);
      const current = await pool.query("SELECT * FROM inventory_user_profiles WHERE id=$1", [id]);
      if (!current.rows[0]) return json(res, 404, { error: "Usuario no encontrado." });
      const role = body.role || current.rows[0].role;
      const admin = role === "Administrador central";
      const active = body.active !== false;
      const email = String(body.email ?? current.rows[0].email ?? "").trim().toLowerCase();
      await pool.query(`UPDATE inventory_user_profiles SET name=$1, email=$2, initials=$3, role=$4, cost_center=$5, admin=$6,
        permissions=$7::jsonb, active=$8, invitation_status=CASE WHEN $8 THEN invitation_status ELSE 'Deshabilitado' END, updated_at=NOW() WHERE id=$9`,
        [body.name || current.rows[0].name, email, body.initials ?? current.rows[0].initials, role, body.costCenter || current.rows[0].cost_center, admin, asJson(body.permissions || defaultPermissions(role, admin)), active, id]);
      if (current.rows[0].auth_user_id && supabaseAdmin) {
        await supabaseAdmin.auth.admin.updateUserById(current.rows[0].auth_user_id, { email: email || undefined, ban_duration: active ? "none" : "876000h" });
      }
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar el usuario." });
    }
  }

  if (url.pathname === "/api/workers" && req.method === "GET") {
    if (!apiProfile) return json(res, 401, { error: "Debes iniciar sesión." });
    const params = apiProfile.admin ? [] : [apiProfile.cost_center];
    const result = await pool.query(`SELECT * FROM inventory_worker_enrollments ${apiProfile.admin ? "" : "WHERE cost_center=$1"} ORDER BY cost_center, name`, params);
    return json(res, 200, { workers: result.rows });
  }

  if (url.pathname === "/api/workers" && req.method === "POST") {
    if (!profileCan(apiProfile, "workers")) return json(res, 403, { error: "Tu perfil no puede enrolar trabajadores." });
    try {
      const body = await readJson(req);
      const center = body.costCenter || apiProfile.cost_center;
      if (!apiProfile.admin && center !== apiProfile.cost_center) return json(res, 403, { error: "Sólo puedes enrolar en tu centro de costo." });
      if (!String(body.name || "").trim()) return json(res, 400, { error: "El nombre es obligatorio." });
      const id = String(body.id || `worker-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
      const status = body.signatureFileId || body.signatureData ? "Activo" : "Firma pendiente";
      await pool.query(`INSERT INTO inventory_worker_enrollments
        (id, rut, name, company, job_title, cost_center, email, phone, signature_file_id, signature_data, status, payload, created_by, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,NOW())
        ON CONFLICT (id) DO UPDATE SET rut=EXCLUDED.rut, name=EXCLUDED.name, company=EXCLUDED.company,
        job_title=EXCLUDED.job_title, cost_center=EXCLUDED.cost_center, email=EXCLUDED.email, phone=EXCLUDED.phone,
        signature_file_id=EXCLUDED.signature_file_id, signature_data=EXCLUDED.signature_data, status=EXCLUDED.status,
        payload=EXCLUDED.payload, updated_at=NOW()`,
        [id, body.rut || "", body.name.trim(), body.company || "", body.jobTitle || "", center, body.email || "", body.phone || "", body.signatureFileId || "", body.signatureData || "", status, asJson(body), apiProfile.auth_user_id]);
      if (body.createAccess && body.email) {
        const accessId = `access-${id}`;
        const role = "Usuario";
        await pool.query(`INSERT INTO inventory_user_profiles
          (id, legacy_user_id, name, email, initials, role, cost_center, admin, permissions, active, invitation_status, updated_at)
          VALUES ($1,$1,$2,$3,$4,$5,$6,FALSE,$7::jsonb,TRUE,'Pendiente invitación',NOW())
          ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email, cost_center=EXCLUDED.cost_center, active=TRUE, updated_at=NOW()`,
          [accessId, body.name.trim(), body.email, body.initials || "", role, center, asJson(defaultPermissions(role, false))]);
        const accessResult = await pool.query("SELECT * FROM inventory_user_profiles WHERE id=$1", [accessId]);
        await inviteProfile(accessResult.rows[0], body.email);
        await pool.query("UPDATE inventory_worker_enrollments SET access_profile_id=$1 WHERE id=$2", [accessId, id]);
      }
      return json(res, 200, { ok: true, id, status });
    } catch (error) {
      const duplicateRut = error.code === "23505";
      return json(res, 400, { error: duplicateRut ? "Ya existe un trabajador con ese RUT." : error.message || "No se pudo enrolar al trabajador." });
    }
  }

  if (url.pathname.startsWith("/api/workers/") && req.method === "PATCH") {
    if (!profileCan(apiProfile, "workers")) return json(res, 403, { error: "Tu perfil no puede modificar trabajadores." });
    const id = decodeURIComponent(url.pathname.replace("/api/workers/", ""));
    const body = await readJson(req);
    const current = await pool.query("SELECT * FROM inventory_worker_enrollments WHERE id=$1", [id]);
    if (!current.rows[0]) return json(res, 404, { error: "Trabajador no encontrado." });
    if (!apiProfile.admin && current.rows[0].cost_center !== apiProfile.cost_center) return json(res, 403, { error: "Trabajador de otro centro de costo." });
    const status = body.active === false ? "Inactivo" : (body.signatureFileId || body.signatureData || current.rows[0].signature_file_id || current.rows[0].signature_data ? "Activo" : "Firma pendiente");
    await pool.query(`UPDATE inventory_worker_enrollments SET rut=$1, name=$2, company=$3, job_title=$4, email=$5, phone=$6,
      signature_file_id=$7, signature_data=$8, status=$9, updated_at=NOW() WHERE id=$10`,
      [body.rut ?? current.rows[0].rut, body.name || current.rows[0].name, body.company ?? current.rows[0].company, body.jobTitle ?? current.rows[0].job_title, body.email ?? current.rows[0].email, body.phone ?? current.rows[0].phone, body.signatureFileId ?? current.rows[0].signature_file_id, body.signatureData ?? current.rows[0].signature_data, status, id]);
    return json(res, 200, { ok: true, status });
  }

  if (url.pathname === "/api/tasks" && req.method === "GET") {
    if (!apiProfile) return json(res, 401, { error: "Debes iniciar sesión." });
    const result = await pool.query(`SELECT * FROM inventory_tasks
      WHERE ($1::boolean OR assignee_auth_user_id=$2 OR center_name=$3)
      ORDER BY CASE priority WHEN 'Crítica' THEN 1 WHEN 'Alta' THEN 2 ELSE 3 END, due_at NULLS LAST, created_at DESC`,
      [Boolean(apiProfile.admin), apiProfile.auth_user_id, apiProfile.cost_center]);
    return json(res, 200, { tasks: result.rows });
  }

  if (url.pathname.startsWith("/api/tasks/") && req.method === "PATCH") {
    if (!apiProfile) return json(res, 401, { error: "Debes iniciar sesión." });
    const id = decodeURIComponent(url.pathname.replace("/api/tasks/", ""));
    const body = await readJson(req);
    const allowed = ["Pendiente", "En proceso", "Resuelta"];
    if (!allowed.includes(body.status)) return json(res, 400, { error: "Estado de tarea inválido." });
    const result = await pool.query(`UPDATE inventory_tasks SET status=$1, resolved_at=CASE WHEN $1='Resuelta' THEN NOW() ELSE NULL END, updated_at=NOW()
      WHERE id=$2 AND ($3::boolean OR assignee_auth_user_id=$4 OR center_name=$5) RETURNING id`,
      [body.status, id, Boolean(apiProfile.admin), apiProfile.auth_user_id, apiProfile.cost_center]);
    if (!result.rowCount) return json(res, 404, { error: "Tarea no encontrada o sin permiso." });
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/notifications" && req.method === "GET") {
    if (!apiProfile) return json(res, 401, { error: "Debes iniciar sesión." });
    const result = await pool.query(`SELECT * FROM inventory_notifications
      WHERE ($1::boolean OR recipient_auth_user_id=$2 OR (recipient_auth_user_id IS NULL AND center_name=$3))
      ORDER BY created_at DESC LIMIT 100`, [Boolean(apiProfile.admin), apiProfile.auth_user_id, apiProfile.cost_center]);
    return json(res, 200, { notifications: result.rows });
  }

  if (url.pathname === "/api/v1/logistics/dashboard" && req.method === "GET") {
    let dashboardProfile = apiProfile;
    if (!dashboardProfile) {
      const settings = await authSettings();
      if (settings.migration_complete) return json(res, 401, { error: "Debes iniciar sesion nuevamente." });
      const legacyUserId = String(req.headers["x-legacy-user-id"] || "");
      if (legacyUserId) {
        const legacyProfile = await pool.query(`SELECT * FROM inventory_user_profiles
          WHERE active=TRUE AND (id=$1 OR legacy_user_id=$1) LIMIT 1`, [legacyUserId]);
        dashboardProfile = legacyProfile.rows[0] || null;
      }
    }
    if (!profileCan(dashboardProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar el modelo logistico." });
    if (!logisticsReady) return json(res, 503, { error: "El modelo logistico todavia no esta disponible." });
    try {
      const [schema, items, warehouses, stock, transfers, custody, workers, reconciliation] = await Promise.all([
        logisticsHealth(pool),
        listCanonicalItems(pool, dashboardProfile, { search: "" }),
        listWarehouses(pool, dashboardProfile),
        stockSnapshot(pool, dashboardProfile, { itemId: "" }),
        listTransfers(pool, dashboardProfile),
        listCustodyAssignments(pool, dashboardProfile, { status: "active" }),
        pool.query(`SELECT id,name,rut,email,phone,cost_center,status FROM inventory_worker_enrollments
          ${dashboardProfile.admin ? "" : "WHERE cost_center=$1"}
          ORDER BY cost_center,name`, dashboardProfile.admin ? [] : [dashboardProfile.cost_center]).then(result => result.rows),
        dashboardProfile.admin ? reconcileLegacyState(pool) : Promise.resolve(null)
      ]);
      return json(res, 200, {
        ok: true,
        status: {
          ok: true,
          organizationId: logisticsOrganizationId,
          schema,
          migration: logisticsStartup
        },
        items,
        warehouses,
        stock,
        transfers,
        custody,
        workers,
        reconciliation
      });
    } catch (error) {
      return json(res, 500, { error: error.message || "No se pudo preparar el panel logistico." });
    }
  }

  if (url.pathname === "/api/v1/logistics/status" && req.method === "GET") {
    if (!apiProfile) return json(res, 401, { error: "Debes iniciar sesión." });
    if (!logisticsReady) return json(res, 503, { error: "El modelo logístico todavía no está disponible." });
    try {
      return json(res, 200, {
        ok: true,
        organizationId: logisticsOrganizationId,
        schema: await logisticsHealth(pool),
        migration: logisticsStartup
      });
    } catch (error) {
      return json(res, 500, { error: error.message || "No se pudo consultar el modelo logístico." });
    }
  }

  if (url.pathname === "/api/v1/reconciliation" && req.method === "GET") {
    if (!apiProfile?.admin) return json(res, 403, { error: "Sólo el administrador puede revisar la conciliación." });
    try {
      return json(res, 200, await reconcileLegacyState(pool));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo conciliar el inventario." });
    }
  }

  if (url.pathname === "/api/v1/items" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar artículos." });
    try {
      const items = await listCanonicalItems(pool, apiProfile, { search: url.searchParams.get("search") || "" });
      return json(res, 200, { items });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudieron consultar los artículos." });
    }
  }

  if (url.pathname === "/api/v1/families" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) return json(res, 403, { error: "Sólo el administrador puede configurar familias." });
    try {
      const body = await readJson(req);
      const result = await registerItemFamily(pool, {
        ...body,
        organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, result.created ? 201 : 200, result);
    } catch (error) {
      const conflict = error.code === "23505";
      return json(res, conflict ? 409 : 400, {
        error: conflict ? "La abreviatura ya está asignada a otra familia." : (error.message || "No se pudo guardar la familia.")
      });
    }
  }

  if (url.pathname === "/api/v1/items" && req.method === "POST") {
    if (!profileCan(apiProfile, "move")) return json(res, 403, { error: "Tu perfil no puede registrar artículos." });
    try {
      const body = await readJson(req);
      if (!body.initialLocationId) return json(res, 400, { error: "Selecciona la ubicación inicial." });
      if (!apiProfile.admin && !(await profileMayAccessLocation(apiProfile, body.initialLocationId))) {
        return json(res, 403, { error: "Sólo puedes registrar artículos en una bodega de tu centro." });
      }
      const result = await registerCanonicalItem(pool, {
        ...body,
        organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 201, result);
    } catch (error) {
      const conflict = error.code === "23505";
      return json(res, conflict ? 409 : 400, { error: conflict ? "El código o número de serie ya existe." : (error.message || "No se pudo registrar el artículo.") });
    }
  }

  if (url.pathname === "/api/v1/inspections" && req.method === "POST") {
    if (!profileCan(apiProfile, "inspect")) return json(res, 403, { error: "Tu perfil no puede registrar inspecciones." });
    try {
      const body = await readJson(req);
      if (!body.assetUnitId || !body.warehouseId) {
        return json(res, 400, { error: "La inspección requiere una unidad y su bodega V2." });
      }
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, body.warehouseId))) {
        return json(res, 403, { error: "Sólo puedes inspeccionar equipos de tu centro de costo." });
      }
      const currentLocation = await pool.query(`SELECT 1 FROM logistics_stock_balances b
        JOIN logistics_locations loc ON loc.id=b.location_id
        WHERE b.organization_id=$1 AND b.asset_unit_id=$2 AND loc.warehouse_id=$3 AND b.quantity>0`,
        [body.organizationId || logisticsOrganizationId, body.assetUnitId, body.warehouseId]);
      if (!currentLocation.rowCount) {
        return json(res, 409, { error: "El equipo no figura disponible en la bodega seleccionada según el libro mayor V2." });
      }
      const result = await createInspectionRun(pool, {
        ...body,
        organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, result.replayed ? 200 : 201, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo registrar la inspección." });
    }
  }

  const inspectionAction = url.pathname.match(/^\/api\/v1\/inspections\/([^/]+)\/(deadline|correction|approve|verify)$/);
  if (inspectionAction && req.method === "POST") {
    const [, inspectionId, operation] = inspectionAction;
    const permission = operation === "correction" ? "inspect" : "approve";
    if (!profileCan(apiProfile, permission)) {
      return json(res, 403, { error: "Tu perfil no puede completar esta etapa de la inspección." });
    }
    try {
      const scope = await pool.query("SELECT warehouse_id FROM logistics_inspection_runs WHERE id=$1", [inspectionId]);
      if (!scope.rows[0]) return json(res, 404, { error: "Inspección V2 no encontrada." });
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scope.rows[0].warehouse_id))) {
        return json(res, 403, { error: "La inspección pertenece a otro centro de costo." });
      }
      const actionByOperation = {
        deadline: "SET_DEADLINE",
        correction: "RECORD_CORRECTION",
        approve: "APPROVE",
        verify: "VERIFY_CORRECTION"
      };
      const body = await readJson(req);
      const result = await updateInspectionRun(pool, inspectionId, {
        ...body,
        action: actionByOperation[operation]
      }, apiProfile.id);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar la inspección." });
    }
  }

  if (url.pathname === "/api/v1/warehouses" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar bodegas." });
    try {
      return json(res, 200, { warehouses: await listWarehouses(pool, apiProfile) });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudieron consultar las bodegas." });
    }
  }

  if (url.pathname === "/api/v1/warehouses" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) return json(res, 403, { error: "Sólo el administrador puede crear bodegas." });
    try {
      const body = await readJson(req);
      const result = await registerWarehouse(pool, {
        ...body,
        organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 201, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo crear la bodega." });
    }
  }

  if (url.pathname === "/api/v1/stock" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar stock." });
    try {
      const stock = await stockSnapshot(pool, apiProfile, { itemId: url.searchParams.get("itemId") || "" });
      return json(res, 200, { stock });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo consultar el stock." });
    }
  }

  if (url.pathname === "/api/v1/stock/movements" && req.method === "POST") {
    if (!profileCan(apiProfile, "move")) return json(res, 403, { error: "Tu perfil no puede mover inventario." });
    try {
      const body = await readJson(req);
      if (!apiProfile.admin && ["ADJUSTMENT", "REVERSAL", "OPENING"].includes(String(body.movementType || "").toUpperCase())) {
        return json(res, 403, { error: "Sólo el administrador puede ajustar, abrir o revertir stock." });
      }
      if (!apiProfile.admin) {
        if (body.fromLocationId && !(await profileMayAccessLocation(apiProfile, body.fromLocationId))) {
          return json(res, 403, { error: "No puedes retirar stock desde otra bodega." });
        }
        if (!body.fromLocationId && body.toLocationId && !(await profileMayAccessLocation(apiProfile, body.toLocationId))) {
          return json(res, 403, { error: "No puedes ingresar stock en otra bodega." });
        }
      }
      const result = await postStockMovement(pool, {
        ...body,
        organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, result.replayed ? 200 : 201, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo registrar el movimiento." });
    }
  }

  if (url.pathname === "/api/v1/custody" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar entregas a terreno." });
    try {
      return json(res, 200, {
        assignments: await listCustodyAssignments(pool, apiProfile, {
          status: url.searchParams.get("status") || ""
        })
      });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudieron consultar las entregas a terreno." });
    }
  }

  if (url.pathname === "/api/v1/custody" && req.method === "POST") {
    if (!profileCan(apiProfile, "terrain")) return json(res, 403, { error: "Tu perfil no puede entregar productos a terreno." });
    try {
      const body = await readJson(req);
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, body.warehouseId))) {
        return json(res, 403, { error: "Sólo puedes entregar desde una bodega de tu centro." });
      }
      const result = await createCustodyAssignment(pool, {
        ...body,
        organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, result.replayed ? 200 : 201, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo registrar la entrega a terreno." });
    }
  }

  const custodyReturn = url.pathname.match(/^\/api\/v1\/custody\/([^/]+)\/return$/);
  if (custodyReturn && req.method === "POST") {
    if (!profileCan(apiProfile, "terrain")) return json(res, 403, { error: "Tu perfil no puede registrar devoluciones desde terreno." });
    try {
      const assignmentId = decodeURIComponent(custodyReturn[1]);
      const current = await pool.query("SELECT warehouse_id FROM logistics_custody_assignments WHERE id=$1", [assignmentId]);
      if (!current.rows[0]) return json(res, 404, { error: "Entrega a terreno no encontrada." });
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, current.rows[0].warehouse_id))) {
        return json(res, 403, { error: "La entrega pertenece a otra bodega." });
      }
      const result = await returnCustodyAssignment(pool, assignmentId, await readJson(req), apiProfile.id);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo registrar la devolución." });
    }
  }

  if (url.pathname === "/api/v1/transfers" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar traslados." });
    try {
      return json(res, 200, { transfers: await listTransfers(pool, apiProfile) });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudieron consultar los traslados." });
    }
  }

  if (url.pathname === "/api/v1/transfers" && req.method === "POST") {
    if (!profileCan(apiProfile, "move")) return json(res, 403, { error: "Tu perfil no puede crear traslados." });
    try {
      const body = await readJson(req);
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, body.sourceWarehouseId))) {
        return json(res, 403, { error: "Sólo puedes despachar desde una bodega de tu centro." });
      }
      const transfer = await createTransfer(pool, {
        ...body,
        organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 201, { transfer });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo crear el traslado." });
    }
  }

  const transferAction = url.pathname.match(/^\/api\/v1\/transfers\/([^/]+)\/(dispatch|receive)$/);
  if (transferAction && req.method === "POST") {
    const [, transferId, action] = transferAction;
    const permission = action === "receive" ? "receive" : "move";
    if (!profileCan(apiProfile, permission)) return json(res, 403, { error: "Tu perfil no puede completar esta operación." });
    try {
      const body = await readJson(req);
      const transferResult = await pool.query("SELECT * FROM logistics_transfer_orders WHERE id=$1", [transferId]);
      const transfer = transferResult.rows[0];
      if (!transfer) return json(res, 404, { error: "Traslado no encontrado." });
      const scopedWarehouse = action === "receive" ? transfer.destination_warehouse_id : transfer.source_warehouse_id;
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scopedWarehouse))) {
        return json(res, 403, { error: `El ${action === "receive" ? "destino" : "origen"} no pertenece a tu centro.` });
      }
      const updated = action === "receive"
        ? await receiveTransfer(pool, transferId, body, apiProfile.id)
        : await dispatchTransfer(pool, transferId, body, apiProfile.id);
      return json(res, 200, { transfer: updated });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar el traslado." });
    }
  }

  if (url.pathname.startsWith("/api/notifications/") && req.method === "PATCH") {
    if (!apiProfile) return json(res, 401, { error: "Debes iniciar sesión." });
    const id = decodeURIComponent(url.pathname.replace("/api/notifications/", ""));
    const result = await pool.query(`UPDATE inventory_notifications SET read_at=NOW() WHERE id=$1 AND
      ($2::boolean OR recipient_auth_user_id=$3 OR (recipient_auth_user_id IS NULL AND center_name=$4)) RETURNING id`,
      [id, Boolean(apiProfile.admin), apiProfile.auth_user_id, apiProfile.cost_center]);
    if (!result.rowCount) return json(res, 404, { error: "Notificación no encontrada." });
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/storage/status") {
    if (!pool) return json(res, 503, { ok: false, database: false, error: "DATABASE_URL no configurada" });
    const status = {
      ok: false,
      database: true,
      supabaseConfigured: storageConfigured(),
      bucket: process.env.SUPABASE_BUCKET || "",
      baseUrl: supabaseBaseUrl(),
      urlWasRestEndpoint: /\/rest\/v1\/?$/i.test(String(process.env.SUPABASE_URL || "")),
      recentFiles: []
    };
    try {
      const recent = await pool.query("SELECT id, filename, provider, storage_path, size_bytes, created_at FROM inventory_file_objects ORDER BY created_at DESC LIMIT 10");
      status.recentFiles = recent.rows;
      if (storageConfigured()) {
        const endpoint = `${supabaseBaseUrl()}/storage/v1/bucket/${encodeURIComponent(process.env.SUPABASE_BUCKET)}`;
        const response = await fetch(endpoint, { headers: { "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY } });
        status.supabaseReachable = response.ok;
        if (!response.ok) status.supabaseError = await response.text();
      }
      status.ok = Boolean(status.database && (!status.supabaseConfigured || status.supabaseReachable));
      return json(res, 200, status);
    } catch (error) {
      status.error = error.message;
      return json(res, 400, status);
    }
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    if (!pool) return json(res, 503, { error: "DATABASE_URL no configurada" });
    try {
      const result = await pool.query("SELECT payload FROM inventory_app_state WHERE id = 1");
      const current = result.rows[0]?.payload || null;
      return json(res, 200, { state: current ? stateForProfile(current, apiProfile) : null });
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
      const currentResult = await client.query("SELECT payload FROM inventory_app_state WHERE id=1 FOR UPDATE");
      const nextState = mergeStateForProfile(currentResult.rows[0]?.payload || {}, body.state, apiProfile);
      await client.query(`INSERT INTO inventory_app_state (id, payload, updated_at) VALUES (1, $1::jsonb, NOW())
        ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`, [JSON.stringify(nextState)]);
      await syncNormalizedTables(client, nextState, apiProfile?.name || body.savedBy || "Sistema");
      await syncOperationalTasks(client, nextState);
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
      const currentResult = await pool.query("SELECT payload FROM inventory_app_state WHERE id=1");
      const nextState = mergeStateForProfile(currentResult.rows[0]?.payload || {}, body.state, apiProfile);
      await pool.query(`INSERT INTO inventory_app_state (id, payload, updated_at) VALUES (1, $1::jsonb, NOW())
        ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`, [JSON.stringify(nextState)]);
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

  if (url.pathname === "/api/files/upload" && req.method === "POST") {
    try {
      const body = await readJson(req);
      if (!body.filename || !body.dataUrl) return json(res, 400, { error: "Falta archivo" });
      const result = await uploadFileObject(body);
      return json(res, 200, result);
    } catch (error) {
      console.error("Error subiendo archivo:", error.message);
      return json(res, 400, { error: error.message || "No se pudo guardar el archivo" });
    }
  }

  if (url.pathname === "/api/inspection/pdf" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const pdf = await createInspectionPdf(body);
      const code = safeName(body?.asset?.code || "inspeccion");
      const date = safeName(body?.inspection?.date || new Date().toISOString().slice(0, 10));
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Inspeccion_${code}_${date}.pdf"`,
        "Cache-Control": "no-store"
      });
      return res.end(pdf);
    } catch (error) {
      console.error("Error generando PDF de inspección:", error.message);
      return json(res, 400, { error: error.message || "No se pudo generar el PDF de inspección" });
    }
  }

  if (url.pathname.startsWith("/api/files/") && req.method === "GET") {
    if (!pool) return json(res, 503, { error: "DATABASE_URL no configurada" });
    try {
      const id = decodeURIComponent(url.pathname.replace("/api/files/", ""));
      const result = await pool.query("SELECT * FROM inventory_file_objects WHERE id = $1", [id]);
      const row = result.rows[0];
      if (!row) return json(res, 404, { error: "Archivo no encontrado" });
      if (row.provider === "supabase" && row.storage_path && storageConfigured()) {
        const endpoint = `${supabaseBaseUrl()}/storage/v1/object/${encodeURIComponent(process.env.SUPABASE_BUCKET)}/${String(row.storage_path).split("/").map(encodeURIComponent).join("/")}`;
        const response = await fetch(endpoint, { headers: { "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY } });
        if (!response.ok) throw new Error("No se pudo leer archivo desde Supabase");
        const body = Buffer.from(await response.arrayBuffer());
        res.writeHead(200, { "Content-Type": row.mime_type || "application/octet-stream", "Content-Disposition": `attachment; filename="${safeName(row.filename)}"` });
        return res.end(body);
      }
      const body = Buffer.from(row.data_base64 || "", "base64");
      res.writeHead(200, { "Content-Type": row.mime_type || "application/octet-stream", "Content-Disposition": `attachment; filename="${safeName(row.filename)}"` });
      return res.end(body);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo descargar el archivo" });
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

  if (url.pathname === "/vendor/supabase.js") {
    try {
      const body = await readFile(join(root, "node_modules", "@supabase", "supabase-js", "dist", "umd", "supabase.js"));
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" });
      return res.end(body);
    } catch {
      return json(res, 500, { error: "No se pudo cargar el cliente Supabase." });
    }
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
