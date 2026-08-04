import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import QRCode from "qrcode";
import PDFDocument from "pdfkit";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  backfillLegacyState,
  calculateInventoryClassifications,
  createCycleCount,
  createAssetCompliance,
  createAssetDisposal,
  createInspectionRun,
  createCustodyAssignment,
  createInboundReceipt,
  createInventoryAdjustment,
  createInventoryPeriod,
  createPurchaseOrder,
  createSupplierInvoice,
  createMaterialRequest,
  createMaintenancePlan,
  createPurchaseRequisition,
  createWorkOrder,
  createTransfer,
  dispatchTransfer,
  ensureDefaultOrganization,
  getCutoverStatus,
  listCanonicalItems,
  listAssetCompliance,
  listAssetDisposals,
  listAssetFinancials,
  listCycleCounts,
  listCustodyAssignments,
  listInboundReceipts,
  listInventoryAnalytics,
  listInventoryAccuracy,
  listCatalogDataQuality,
  listInventoryClassifications,
  listInventoryControls,
  listLogisticsKpis,
  listKpiTargets,
  listScheduledLogisticsJobs,
  listOutboxHealth,
  listMaterialRequests,
  listMaintenance,
  listPurchaseRequisitions,
  listProcurement,
  listReplenishmentSuggestions,
  listSuppliers,
  listSupplierItemCatalog,
  listTransfers,
  listWarehouses,
  logisticsHealth,
  postStockMovement,
  registerCanonicalDocument,
  registerCanonicalItem,
  reconcileLegacyState,
  assessCutoverReadiness,
  receiveTransfer,
  receiveLot,
  registerStorageLocation,
  registerSupplier,
  registerItemFamily,
  registerWarehouse,
  reviewReplenishmentTasks,
  reviewCycleCountTasks,
  reviewCatalogDataQuality,
  reviewCatalogDuplicateDecision,
  remediateCatalogDataIssue,
  resolveItemIdentifier,
  returnCustodyAssignment,
  runLogisticsMigrations,
  runDueLogisticsJobs,
  processOutboxEvents,
  snapshotLogisticsKpis,
  stockSnapshot,
  suggestPutawayLocations,
  updateCycleCount,
  updateAssetCompliance,
  updateAssetDisposal,
  upsertAssetFinancial,
  updateItemCost,
  updateInboundReceipt,
  updateInventoryAdjustment,
  updateClassificationPolicy,
  updateMaterialRequest,
  updatePickTask,
  updateWorkOrder,
  updatePurchaseOrder,
  updatePurchaseRequisition,
  updateProcurementSettings,
  updateSupplierInvoice,
  updateSupplierReturn,
  updateStorageLocation,
  updateInspectionRun,
  closeInventoryPeriod,
  runAssetDepreciation,
  upsertReplenishmentPolicy,
  upsertItemPresentation,
  upsertSupplierItem,
  upsertKpiTarget,
  updateScheduledLogisticsJob,
  updateCutoverMode,
  retryOutboxEvent
} from "./lib/logistics.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 3000);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png", ".md": "text/markdown; charset=utf-8" };
function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback));
}
const databasePoolMax = boundedNumber(process.env.DB_POOL_MAX, 10, 2, 30);
const databaseStatementTimeoutMs = boundedNumber(process.env.DB_STATEMENT_TIMEOUT_MS, 15_000, 3_000, 120_000);
const databaseConnectionTimeoutMs = boundedNumber(process.env.DB_CONNECTION_TIMEOUT_MS, 5_000, 1_000, 30_000);
const pool = process.env.DATABASE_URL ? new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  max: databasePoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: databaseConnectionTimeoutMs,
  statement_timeout: databaseStatementTimeoutMs,
  query_timeout: databaseStatementTimeoutMs + 2_000,
  keepAlive: true,
  application_name: "inventario-icc1",
  maxUses: 7_500
}) : null;
if (pool) {
  pool.on("error", error => {
    console.error(JSON.stringify({
      type: "database_pool_error",
      error: error?.message || "Conexión PostgreSQL interrumpida"
    }));
  });
}
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
const ROLE_PERMISSIONS = Object.freeze({
  "Usuario": ["view"],
  "Inspector": ["view", "inspect"],
  "Operador de bodega": ["view", "move", "receive", "terrain", "print"],
  "Responsable centro de costo": ["view", "inspect", "move", "receive", "terrain", "print", "workers"],
  "Aprobador centro de costo": ["view", "approve", "audit"],
  "Administrador central": ["view", "inspect", "approve", "move", "receive", "terrain",
    "print", "workers", "admin", "ai", "audit"]
});
const KNOWN_PERMISSIONS = new Set(Object.values(ROLE_PERMISSIONS).flat());
const bootstrapAttemptWindows = new Map();
const requestRateWindows = new Map();

function supabaseBaseUrl() {
  return String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
}

function storageConfigured() {
  return Boolean(supabaseBaseUrl() && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_BUCKET);
}

function authConfigured() {
  return Boolean(supabaseBaseUrl() && process.env.SUPABASE_SERVICE_ROLE_KEY && (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY));
}

function criticalReauthMinutes() {
  const configured = Number(process.env.AUTH_CRITICAL_REAUTH_MINUTES || 60);
  return Math.min(480, Math.max(10, Number.isFinite(configured) ? configured : 60));
}

function requiresRecentAuthentication(pathname, method) {
  if (String(method || "GET").toUpperCase() === "GET") return false;
  return pathname.startsWith("/api/admin/")
    || (pathname.startsWith("/api/v1/releases/") && method === "PATCH")
    || (pathname === "/api/v1/cutover" && method === "PATCH");
}

function hasRecentAuthentication(profile) {
  const signedInAt = new Date(profile?.authUser?.last_sign_in_at || 0).getTime();
  if (!Number.isFinite(signedInAt) || signedInAt <= 0) return false;
  return Date.now() - signedInAt <= criticalReauthMinutes() * 60 * 1000;
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

function requestFingerprint(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const address = forwarded || req.socket?.remoteAddress || "unknown";
  return createHash("sha256").update(address).digest("hex").slice(0, 20);
}

function consumeRequestRate(req, bucket, limit, windowMs) {
  const now = Date.now();
  const key = `${bucket}:${requestFingerprint(req)}`;
  let entry = requestRateWindows.get(key);
  if (!entry || now - entry.startedAt >= windowMs) entry = { startedAt: now, count: 0 };
  const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - entry.startedAt)) / 1000));
  if (entry.count >= limit) return { allowed: false, limit, remaining: 0, retryAfterSeconds };
  entry.count += 1;
  requestRateWindows.set(key, entry);
  if (requestRateWindows.size > 5000) {
    for (const [candidate, value] of requestRateWindows) {
      if (now - value.startedAt >= windowMs) requestRateWindows.delete(candidate);
    }
  }
  return { allowed: true, limit, remaining: Math.max(0, limit - entry.count), retryAfterSeconds };
}

function setRateLimitHeaders(res, result) {
  res.setHeader("RateLimit-Limit", String(result.limit));
  res.setHeader("RateLimit-Remaining", String(result.remaining));
  res.setHeader("RateLimit-Reset", String(result.retryAfterSeconds));
  if (!result.allowed) res.setHeader("Retry-After", String(result.retryAfterSeconds));
}

function isMutationMethod(method) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(String(method || "GET").toUpperCase());
}

function requestOriginAllowed(req) {
  if (!isMutationMethod(req.method)) return true;
  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite === "cross-site") return false;
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true; // lectores, integraciones y pruebas sin contexto de navegador
  try {
    const supplied = new URL(origin).origin;
    const configured = process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).origin : "";
    const forwardedProto = String(req.headers["x-forwarded-proto"] || (req.socket?.encrypted ? "https" : "http")).split(",")[0].trim();
    const requestHost = String(req.headers.host || "").trim();
    const current = requestHost ? `${forwardedProto}://${requestHost}` : "";
    return supplied === configured || supplied === current;
  } catch {
    return false;
  }
}

function consumeBootstrapAttempt(req) {
  const key = requestFingerprint(req);
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  let entry = bootstrapAttemptWindows.get(key);
  if (!entry || now - entry.startedAt >= windowMs) entry = { startedAt: now, count: 0 };
  if (entry.count >= 5) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - entry.startedAt)) / 1000)) };
  }
  entry.count += 1;
  bootstrapAttemptWindows.set(key, entry);
  if (bootstrapAttemptWindows.size > 1000) {
    for (const [candidate, value] of bootstrapAttemptWindows) {
      if (now - value.startedAt >= windowMs) bootstrapAttemptWindows.delete(candidate);
    }
  }
  return { allowed: true, fingerprint: key };
}

async function recordBootstrapSecurityEvent(eventType, req, metadata = {}) {
  if (!pool) return;
  try {
    await pool.query(`INSERT INTO inventory_security_events
      (event_type,target_profile_id,metadata)
      VALUES ($1,$2,$3::jsonb)`,
    [eventType, initialAdmin.legacyUserId, asJson({
      ...metadata,
      requestFingerprint: requestFingerprint(req)
    })]);
  } catch (error) {
    console.warn("No se pudo registrar el evento de activación:", error.message);
  }
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function applyBrowserSecurityHeaders(res) {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join("; "));
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader("Origin-Agent-Cluster", "?1");
}

class HttpRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpRequestError";
    this.status = status;
    this.code = code;
  }
}

async function fetchWithTimeout(url, options = {}, settings = {}) {
  const service = settings.service || "El servicio externo";
  const timeoutMs = boundedNumber(settings.timeoutMs, 30_000, 1_000, 180_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new HttpRequestError(504, "UPSTREAM_TIMEOUT", `${service} no respondió dentro del plazo permitido.`);
    }
    throw new HttpRequestError(502, "UPSTREAM_UNAVAILABLE", `${service} no está disponible temporalmente.`);
  } finally {
    clearTimeout(timer);
  }
}

function validateJsonComplexity(value) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > 20_000) throw new HttpRequestError(422, "JSON_TOO_COMPLEX", "La solicitud contiene demasiados campos.");
    if (current.depth > 50) throw new HttpRequestError(422, "JSON_TOO_DEEP", "La solicitud contiene demasiados niveles anidados.");
    if (!current.value || typeof current.value !== "object") continue;
    for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 });
  }
}

function requireStableOperationKey(value, field = "idempotencyKey") {
  const key = String(value || "").trim();
  if (!key) throw new HttpRequestError(422, "IDEMPOTENCY_KEY_REQUIRED", `Falta ${field} para proteger la operación contra duplicados.`);
  if (key.length < 6 || key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new HttpRequestError(422, "INVALID_IDEMPOTENCY_KEY", `${field} no tiene un formato válido.`);
  }
  return key;
}

async function readJson(req) {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > 15_000_000) {
    throw new HttpRequestError(413, "PAYLOAD_TOO_LARGE", "Solicitud demasiado grande. Máximo permitido: 15 MB.");
  }
  const hasBody = declaredLength > 0 || Boolean(req.headers["transfer-encoding"]);
  const contentType = String(req.headers["content-type"] || "").trim();
  if (hasBody && !/^application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw new HttpRequestError(415, "JSON_CONTENT_TYPE_REQUIRED", "El contenido debe enviarse en formato JSON.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 15_000_000) throw new HttpRequestError(413, "PAYLOAD_TOO_LARGE", "Solicitud demasiado grande. Máximo permitido: 15 MB.");
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpRequestError(400, "INVALID_JSON", "El contenido JSON no es válido.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new HttpRequestError(400, "JSON_OBJECT_REQUIRED", "La solicitud debe contener un objeto o una lista JSON.");
  }
  validateJsonComplexity(parsed);
  return parsed;
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
  const sha256 = createHash("sha256").update(data).digest("hex");
  let provider = "postgres";
  let storagePath = "";
  let publicUrl = "";

  if (storageConfigured()) {
    provider = "supabase";
    storagePath = `${category}/${new Date().toISOString().slice(0, 10)}/${id}-${filename}`;
    const endpoint = `${supabaseBaseUrl()}/storage/v1/object/${encodeURIComponent(process.env.SUPABASE_BUCKET)}/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": mimeType,
        "x-upsert": "true"
      },
      body: data
    }, { service: "Supabase Storage", timeoutMs: process.env.STORAGE_TIMEOUT_MS || 30_000 });
    if (!response.ok) throw new Error(`No se pudo subir a Supabase Storage: ${await response.text()}`);
    publicUrl = `${supabaseBaseUrl()}/storage/v1/object/${process.env.SUPABASE_BUCKET}/${storagePath}`;
  }

  await pool.query(`INSERT INTO inventory_file_objects (id, filename, mime_type, category, ref, size_bytes, provider, storage_path, public_url, data_base64, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    ON CONFLICT (id) DO UPDATE SET filename=EXCLUDED.filename, mime_type=EXCLUDED.mime_type, category=EXCLUDED.category, ref=EXCLUDED.ref, size_bytes=EXCLUDED.size_bytes, provider=EXCLUDED.provider, storage_path=EXCLUDED.storage_path, public_url=EXCLUDED.public_url, data_base64=EXCLUDED.data_base64, payload=EXCLUDED.payload`,
    [id, filename, mimeType, category, ref, data.length, provider, storagePath, publicUrl, provider === "postgres" ? base64 : "", asJson({ originalName: body.filename, uploadedBy: body.uploadedBy || "", code: body.code || "", center: body.center || "", sha256 })]);

  return { id, filename, mimeType, size: data.length, provider, path: storagePath, publicUrl, sha256, downloadUrl: `/api/files/${encodeURIComponent(id)}` };
}

async function verifyFileIntegrity(row, body, profile) {
  const actualSha256 = createHash("sha256").update(body).digest("hex");
  const expectedSha256 = String(row?.payload?.sha256 || "").trim().toLowerCase();
  const expectedSize = Number(row?.size_bytes);
  const sizeMismatch = Number.isFinite(expectedSize) && expectedSize >= 0 && expectedSize !== body.length;
  const hashMismatch = /^[0-9a-f]{64}$/.test(expectedSha256) && !safeTokenEqual(actualSha256, expectedSha256);
  if (sizeMismatch || hashMismatch) {
    const reason = sizeMismatch ? "FILE_SIZE_MISMATCH" : "FILE_INTEGRITY_MISMATCH";
    console.error(JSON.stringify({ type: "file_integrity_failure", fileId: row.id, reason }));
    try {
      await pool.query(`INSERT INTO inventory_audit_log
        (id,event_date,user_name,action,detail,payload)
        VALUES ($1,NOW(),$2,'Integridad de archivo fallida',$3,$4::jsonb)`,
      [`file-integrity-${randomUUID()}`, profile?.name || profile?.id || "Sistema",
        `Se bloqueó la descarga de ${row.filename || row.id}.`,
        asJson({ fileId: row.id, provider: row.provider, reason, expectedSha256, actualSha256, expectedSize, actualSize: body.length })]);
    } catch (error) {
      console.error("No se pudo auditar la falla de integridad:", error.message);
    }
    throw new HttpRequestError(409, reason, "El archivo no superó la verificación de integridad y su descarga fue bloqueada.");
  }
  return { sha256: actualSha256, status: expectedSha256 ? "verified" : "unregistered" };
}

function fileIntegrityHeaders(integrity, size) {
  const digestBase64 = Buffer.from(integrity.sha256, "hex").toString("base64");
  return {
    "Content-Length": String(size),
    "X-Content-SHA256": integrity.sha256,
    "X-Integrity-Status": integrity.status,
    "Content-Digest": `sha-256=:${digestBase64}:`
  };
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
  if (admin) return [...ROLE_PERMISSIONS["Administrador central"]];
  return [...(ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.Usuario)];
}

function normalizedRole(value, fallback = "Usuario") {
  const role = String(value || fallback).trim();
  if (!Object.hasOwn(ROLE_PERMISSIONS, role)) throw new Error("Rol de acceso no permitido.");
  return role;
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
  let result = await pool.query(`UPDATE inventory_user_profiles SET last_seen_at=NOW()
    WHERE auth_user_id=$1 AND active=TRUE
      AND (last_seen_at IS NULL OR last_seen_at<NOW()-INTERVAL '15 minutes')
    RETURNING *`, [data.user.id]);
  if (!result.rows[0]) {
    result = await pool.query(`SELECT * FROM inventory_user_profiles
      WHERE auth_user_id=$1 AND active=TRUE`, [data.user.id]);
  }
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

function authEmailCooldownSeconds() {
  const configured = Number(process.env.AUTH_EMAIL_COOLDOWN_SECONDS || 3600);
  return Number.isFinite(configured) ? Math.max(60, Math.floor(configured)) : 3600;
}

function authEmailCooldownRemaining(profile) {
  if (!profile?.invited_at) return 0;
  const elapsed = Math.floor((Date.now() - new Date(profile.invited_at).getTime()) / 1000);
  return Math.max(0, authEmailCooldownSeconds() - elapsed);
}

function friendlyAuthEmailError(error) {
  const message = String(error?.message || "");
  if (error?.status === 429 || /rate.*limit|email.*limit|too many/i.test(message)) {
    const limited = new Error("Supabase alcanzó el límite de correos. Espera una hora antes de solicitar otro enlace.");
    limited.code = "AUTH_EMAIL_RATE_LIMIT";
    limited.status = 429;
    return limited;
  }
  return error;
}

async function inviteProfile(profile, email) {
  const remaining = authEmailCooldownRemaining(profile);
  if (remaining > 0) {
    const minutes = Math.max(1, Math.ceil(remaining / 60));
    const error = new Error(`Ya se envió un enlace recientemente. Espera ${minutes} minuto(s) antes de solicitar otro.`);
    error.code = "AUTH_EMAIL_COOLDOWN";
    error.status = 429;
    throw error;
  }
  const redirectTo = `${String(process.env.APP_BASE_URL || "").replace(/\/+$/, "") || "https://inventario-icc1.onrender.com"}/?auth=invite`;
  let authUser;
  try {
    authUser = await findAuthUserByEmail(email);
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
  } catch (error) {
    throw friendlyAuthEmailError(error);
  }
  await pool.query(`UPDATE inventory_user_profiles SET auth_user_id=$1, email=$2, invitation_status=$3,
    invited_at=NOW(), updated_at=NOW() WHERE id=$4`,
    [authUser.id, email, authUser.email_confirmed_at ? "Activo" : "Invitación enviada", profile.id]);
  return authUser;
}

function profileCan(profile, permission) {
  if (!profile) return false;
  if (!KNOWN_PERMISSIONS.has(permission)) return false;
  if (profile.admin) return true;
  const permissions = Array.isArray(profile.permissions) ? profile.permissions : [];
  return permissions.includes(permission);
}

async function securityGovernanceOverview() {
  const [profilesResult, rolesResult, lastReviewResult] = await Promise.all([
    pool.query(`SELECT id,auth_user_id,name,email,role,cost_center,admin,permissions,
      active,invitation_status,invited_at,activated_at,last_seen_at,
      security_version,last_security_change_at
      FROM inventory_user_profiles ORDER BY admin DESC,name`),
    pool.query(`SELECT role_code,role_name,permissions,privileged,can_initiate,
      can_approve,description FROM inventory_role_templates
      WHERE active=TRUE ORDER BY privileged,role_name`),
    pool.query(`SELECT * FROM inventory_access_reviews ORDER BY reviewed_at DESC LIMIT 1`)
  ]);
  const issues = [];
  for (const profile of profilesResult.rows) {
    const permissions = Array.isArray(profile.permissions) ? profile.permissions : [];
    const unknown = permissions.filter(permission => !KNOWN_PERMISSIONS.has(permission));
    if (unknown.length) {
      issues.push({
        code: "UNKNOWN_PERMISSION",
        severity: "HIGH",
        profileId: profile.id,
        name: profile.name,
        detail: `Permisos no reconocidos: ${unknown.join(", ")}`
      });
    }
    const initiates = ["move", "receive", "terrain"].some(permission =>
      permissions.includes(permission));
    if (!profile.admin && initiates && permissions.includes("approve")) {
      issues.push({
        code: "SOD_CONFLICT",
        severity: "HIGH",
        profileId: profile.id,
        name: profile.name,
        detail: "El perfil puede iniciar y aprobar operaciones."
      });
    }
    const invitationAge = profile.invited_at
      ? (Date.now() - new Date(profile.invited_at).getTime()) / 86_400_000 : 0;
    if (profile.active && profile.invitation_status !== "Activo" && invitationAge > 7) {
      issues.push({
        code: "STALE_INVITATION",
        severity: "MEDIUM",
        profileId: profile.id,
        name: profile.name,
        detail: `Invitación pendiente hace ${Math.floor(invitationAge)} días.`
      });
    }
    const inactivityDays = profile.last_seen_at
      ? (Date.now() - new Date(profile.last_seen_at).getTime()) / 86_400_000 : null;
    if (profile.active && profile.activated_at && inactivityDays !== null && inactivityDays > 90) {
      issues.push({
        code: "INACTIVE_ACCOUNT",
        severity: "MEDIUM",
        profileId: profile.id,
        name: profile.name,
        detail: `Sin uso hace ${Math.floor(inactivityDays)} días.`
      });
    }
  }
  return {
    profiles: profilesResult.rows,
    roleTemplates: rolesResult.rows,
    issues,
    summary: {
      profiles: profilesResult.rowCount,
      active: profilesResult.rows.filter(profile => profile.active).length,
      privileged: profilesResult.rows.filter(profile => profile.admin).length,
      highRisk: issues.filter(issue => issue.severity === "HIGH").length,
      observations: issues.length
    },
    lastReview: lastReviewResult.rows[0] || null
  };
}

async function completeAccessReview(actorProfileId) {
  const overview = await securityGovernanceOverview();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const review = (await client.query(`INSERT INTO inventory_access_reviews
      (reviewed_by,status,profile_count,issue_count,findings)
      VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
    [actorProfileId, overview.issues.length ? "REQUIRES_ACTION" : "COMPLETED",
      overview.summary.profiles, overview.issues.length, asJson(overview.issues)])).rows[0];
    await client.query(`INSERT INTO inventory_security_events
      (event_type,actor_profile_id,metadata)
      VALUES ('ACCESS_REVIEW_COMPLETED',$1,$2::jsonb)`,
    [actorProfileId, asJson({ reviewId: review.id, summary: overview.summary })]);
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,after_data)
      VALUES ($1,'ACCESS_REVIEW_COMPLETED','access_review',$2,$3,'WEB',$4::jsonb)`,
    [logisticsOrganizationId, review.id, actorProfileId, asJson(review)]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload,status,available_at)
      VALUES ($1,'ACCESS_REVIEW_COMPLETED','access_review',$2,$3::jsonb,'PENDING',NOW())`,
    [logisticsOrganizationId, review.id, asJson({ reviewId: review.id,
      issueCount: overview.issues.length })]);
    await client.query("COMMIT");
    return { ...overview, lastReview: review };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function profileMayAccessWarehouse(profile, warehouseId) {
  if (!profile || !warehouseId) return false;
  if (profile.admin) return true;
  const result = await pool.query(`SELECT 1 FROM logistics_warehouses w
    JOIN logistics_cost_centers cc ON cc.id=w.cost_center_id
    WHERE w.id=$1 AND cc.name=$2 AND w.active=TRUE`, [warehouseId, profile.cost_center]);
  return Boolean(result.rowCount);
}

async function deviceReadinessOverview(profile) {
  const params = [logisticsOrganizationId];
  let scope = "";
  if (!profile.admin) {
    params.push(profile.cost_center);
    scope = ` AND (p.warehouse_id IS NULL OR EXISTS (
      SELECT 1 FROM logistics_warehouses w
      JOIN logistics_cost_centers cc ON cc.id=w.cost_center_id
      WHERE w.id=p.warehouse_id AND cc.name=$2
    ))`;
  }
  const profiles = await pool.query(`SELECT p.*,
      w.name AS warehouse_name,
      COALESCE(c.check_count,0)::integer AS check_count,
      c.last_check_type,c.last_check_status,c.last_checked_at
    FROM logistics_device_profiles p
    LEFT JOIN logistics_warehouses w ON w.id=p.warehouse_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS check_count,
        (ARRAY_AGG(check_type ORDER BY performed_at DESC))[1] AS last_check_type,
        (ARRAY_AGG(status ORDER BY performed_at DESC))[1] AS last_check_status,
        MAX(performed_at) AS last_checked_at
      FROM logistics_device_checks WHERE device_profile_id=p.id
    ) c ON TRUE
    WHERE p.organization_id=$1 AND p.active=TRUE ${scope}
    ORDER BY p.profile_type,p.device_name`, params);
  const checks = await pool.query(`SELECT c.*,p.device_name,p.profile_type
    FROM logistics_device_checks c
    JOIN logistics_device_profiles p ON p.id=c.device_profile_id
    WHERE c.organization_id=$1 ${scope.replaceAll("p.", "p.")}
    ORDER BY c.performed_at DESC LIMIT 40`, params);
  const required = ["CAMERA_QR", "KEYBOARD_SCANNER", "PRINT_LABEL"];
  const recent = new Map();
  for (const check of checks.rows) {
    if (!recent.has(check.check_type)) recent.set(check.check_type, check);
  }
  return {
    profiles: profiles.rows,
    recentChecks: checks.rows,
    summary: required.map(type => {
      const check = recent.get(type);
      return {
        type,
        status: check?.status || "WARN",
        checkedAt: check?.performed_at || null,
        detail: check ? `${check.device_name}: ${check.status}` : "Sin prueba registrada"
      };
    })
  };
}

async function upsertDeviceProfile(profile, body) {
  const type = String(body.profileType || "").toUpperCase();
  if (!["MOBILE", "USB_SCANNER", "LABEL_PRINTER", "WORKSTATION"].includes(type)) {
    throw new Error("Tipo de dispositivo inválido.");
  }
  const deviceKey = String(body.deviceKey || "").trim();
  const deviceName = String(body.deviceName || "").trim();
  if (!deviceKey || !deviceName) throw new Error("Nombre e identificador del dispositivo son obligatorios.");
  if (body.warehouseId && !profile.admin &&
      !(await profileMayAccessWarehouse(profile, body.warehouseId))) {
    throw new Error("El dispositivo pertenece a otro centro.");
  }
  const result = await pool.query(`INSERT INTO logistics_device_profiles
    (organization_id,profile_type,device_name,device_key,warehouse_id,manufacturer,
      model,connection_type,label_width_mm,label_height_mm,dpi,metadata,created_by,updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$13)
    ON CONFLICT (organization_id,device_key) DO UPDATE SET
      profile_type=EXCLUDED.profile_type,device_name=EXCLUDED.device_name,
      warehouse_id=EXCLUDED.warehouse_id,manufacturer=EXCLUDED.manufacturer,
      model=EXCLUDED.model,connection_type=EXCLUDED.connection_type,
      label_width_mm=EXCLUDED.label_width_mm,label_height_mm=EXCLUDED.label_height_mm,
      dpi=EXCLUDED.dpi,metadata=EXCLUDED.metadata,updated_by=EXCLUDED.updated_by,
      updated_at=NOW(),active=TRUE RETURNING *`,
  [logisticsOrganizationId, type, deviceName, deviceKey, body.warehouseId || null,
    body.manufacturer || "", body.model || "", body.connectionType || "",
    body.labelWidthMm || null, body.labelHeightMm || null, body.dpi || null,
    asJson(body.metadata || {}), profile.id]);
  return result.rows[0];
}

async function recordDeviceCheck(profile, body) {
  const type = String(body.checkType || "").toUpperCase();
  const status = String(body.status || "").toUpperCase();
  if (!["CAMERA_QR", "KEYBOARD_SCANNER", "PRINT_LABEL", "NETWORK",
    "SECURE_CONTEXT", "LOCAL_STORAGE"].includes(type)) throw new Error("Prueba inválida.");
  if (!["PASS", "WARN", "FAIL"].includes(status)) throw new Error("Resultado inválido.");
  if (!body.deviceProfileId || !body.idempotencyKey) {
    throw new Error("Falta identificar el dispositivo o la prueba.");
  }
  const scope = await pool.query(`SELECT warehouse_id FROM logistics_device_profiles
    WHERE id=$1 AND organization_id=$2 AND active=TRUE`,
  [body.deviceProfileId, logisticsOrganizationId]);
  if (!scope.rows[0]) throw new Error("Dispositivo inexistente.");
  if (!profile.admin && scope.rows[0].warehouse_id &&
      !(await profileMayAccessWarehouse(profile, scope.rows[0].warehouse_id))) {
    throw new Error("El dispositivo pertenece a otro centro.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const check = (await client.query(`INSERT INTO logistics_device_checks
      (organization_id,device_profile_id,check_type,status,idempotency_key,
        measurements,notes,performed_by)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
      ON CONFLICT (organization_id,idempotency_key) DO UPDATE SET
        idempotency_key=EXCLUDED.idempotency_key
      RETURNING *`,
    [logisticsOrganizationId, body.deviceProfileId, type, status,
      String(body.idempotencyKey), asJson(body.measurements || {}),
      String(body.notes || ""), profile.id])).rows[0];
    await client.query(`UPDATE logistics_device_profiles SET last_status=$1,
      last_verified_at=NOW(),updated_by=$2,updated_at=NOW() WHERE id=$3`,
    [status, profile.id, body.deviceProfileId]);
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,after_data)
      VALUES ($1,'DEVICE_CHECK_RECORDED','device_profile',$2,$3,'WEB',$4::jsonb)`,
    [logisticsOrganizationId, body.deviceProfileId, profile.id, asJson(check)]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload,status,available_at)
      VALUES ($1,'DEVICE_CHECK_RECORDED','device_profile',$2,$3::jsonb,'PENDING',NOW())`,
    [logisticsOrganizationId, body.deviceProfileId,
      asJson({ deviceProfileId: body.deviceProfileId, checkType: type, status })]);
    await client.query("COMMIT");
    return check;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

let operationalHealthRunning = false;
async function captureOperationalHealth(source = "SCHEDULER", actorProfileId = null) {
  if (!pool || !logisticsReady || operationalHealthRunning) return { skipped: true };
  operationalHealthRunning = true;
  const started = Date.now();
  try {
    const checks = [];
    const add = (component, status, detail) => checks.push({ component, status, detail });
    const dbStarted = Date.now();
    await pool.query("SELECT 1");
    add("DATABASE", "PASS", `PostgreSQL respondió en ${Date.now() - dbStarted} ms.`);
    const jobs = await pool.query(`SELECT COUNT(*)::int AS failed FROM logistics_scheduled_jobs
      WHERE organization_id=$1 AND enabled=TRUE AND last_status='FAILED'`,
    [logisticsOrganizationId]);
    add("SCHEDULER", Number(jobs.rows[0]?.failed || 0) ? "FAIL" : "PASS",
      `${Number(jobs.rows[0]?.failed || 0)} automatización(es) fallida(s).`);
    const outbox = await pool.query(`SELECT
      COUNT(*) FILTER (WHERE status='DEAD_LETTER')::int AS dead,
      COUNT(*) FILTER (WHERE status IN ('PENDING','RETRY')
        AND created_at<NOW()-INTERVAL '15 minutes')::int AS delayed
      FROM logistics_outbox_events WHERE organization_id=$1`, [logisticsOrganizationId]);
    add("OUTBOX", Number(outbox.rows[0]?.dead || 0) ? "FAIL"
      : Number(outbox.rows[0]?.delayed || 0) ? "WARN" : "PASS",
    `${Number(outbox.rows[0]?.dead || 0)} descartado(s), ${Number(outbox.rows[0]?.delayed || 0)} atrasado(s).`);
    add("AUTH", authConfigured() ? "PASS" : "FAIL",
      authConfigured() ? "Supabase Auth configurado." : "Configuración de acceso incompleta.");
    add("STORAGE", storageConfigured() ? "PASS" : "WARN",
      storageConfigured() ? "Supabase Storage configurado." : "Almacenamiento documental incompleto.");
    const overall = checks.some(check => check.status === "FAIL") ? "DOWN"
      : checks.some(check => check.status === "WARN") ? "DEGRADED" : "HEALTHY";
    const run = (await pool.query(`INSERT INTO logistics_health_runs
      (organization_id,overall_status,source,checks,duration_ms,checked_by)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING *`,
    [logisticsOrganizationId, overall, source, asJson(checks),
      Date.now() - started, actorProfileId])).rows[0];
    await pool.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,after_data)
      VALUES ($1,'HEALTH_CHECK_COMPLETED','health_run',$2,$3,$4,$5::jsonb)`,
    [logisticsOrganizationId, run.id, actorProfileId,
      source === "SCHEDULER" ? "SYSTEM" : "WEB", asJson(run)]);
    return run;
  } finally {
    operationalHealthRunning = false;
  }
}

function startOperationalHealthScheduler() {
  const run = () => captureOperationalHealth("SCHEDULER")
    .catch(error => console.error("No se pudo registrar la salud operacional:", error.message));
  setTimeout(() => captureOperationalHealth("STARTUP")
    .catch(error => console.error("No se pudo registrar la salud inicial:", error.message)), 15_000).unref?.();
  setInterval(run, 5 * 60 * 1000).unref?.();
}

async function operationalContinuityOverview(profile) {
  const params = [logisticsOrganizationId];
  let scope = "";
  if (!profile.admin) {
    params.push(profile.cost_center);
    scope = ` AND (incident.warehouse_id IS NULL OR EXISTS (
      SELECT 1 FROM logistics_warehouses warehouse
      JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
      WHERE warehouse.id=incident.warehouse_id AND center.name=$2
    ))`;
  }
  const health = await pool.query(`SELECT * FROM logistics_health_runs
    WHERE organization_id=$1 ORDER BY checked_at DESC LIMIT 30`, [logisticsOrganizationId]);
  const incidents = await pool.query(`SELECT incident.*,warehouse.name AS warehouse_name,
      owner.name AS owner_name,opener.name AS opened_by_name
    FROM logistics_operational_incidents incident
    LEFT JOIN logistics_warehouses warehouse ON warehouse.id=incident.warehouse_id
    LEFT JOIN inventory_user_profiles owner ON owner.id::text=incident.owner_profile_id::text
    LEFT JOIN inventory_user_profiles opener ON opener.id::text=incident.opened_by::text
    WHERE incident.organization_id=$1 ${scope}
    ORDER BY CASE incident.status WHEN 'OPEN' THEN 1 WHEN 'INVESTIGATING' THEN 2
      WHEN 'MITIGATED' THEN 3 ELSE 4 END,
      CASE incident.severity WHEN 'SEV1' THEN 1 WHEN 'SEV2' THEN 2
        WHEN 'SEV3' THEN 3 ELSE 4 END,incident.opened_at DESC`, params);
  return {
    healthRuns: health.rows,
    incidents: incidents.rows,
    summary: {
      status: health.rows[0]?.overall_status || "UNKNOWN",
      lastCheckedAt: health.rows[0]?.checked_at || null,
      open: incidents.rows.filter(row => row.status !== "RESOLVED").length,
      critical: incidents.rows.filter(row => row.status !== "RESOLVED" &&
        ["SEV1", "SEV2"].includes(row.severity)).length
    }
  };
}

async function openOperationalIncident(profile, body) {
  if (body.warehouseId && !profile.admin &&
      !(await profileMayAccessWarehouse(profile, body.warehouseId))) {
    throw new Error("El incidente pertenece a otro centro.");
  }
  const severity = String(body.severity || "").toUpperCase();
  const category = String(body.category || "").toUpperCase();
  if (!["SEV1", "SEV2", "SEV3", "SEV4"].includes(severity)) throw new Error("Severidad inválida.");
  if (!["APPLICATION", "DATABASE", "AUTH", "STORAGE", "INTEGRATION",
    "DEVICE", "PROCESS", "SECURITY"].includes(category)) throw new Error("Categoría inválida.");
  if (!String(body.title || "").trim() || !String(body.description || "").trim()) {
    throw new Error("Título y descripción son obligatorios.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",
      [`incident:${logisticsOrganizationId}`]);
    const year = new Date().getFullYear();
    const count = await client.query(`SELECT COUNT(*)::int AS total
      FROM logistics_operational_incidents WHERE organization_id=$1
        AND incident_number LIKE $2`, [logisticsOrganizationId, `INC-${year}-%`]);
    const number = `INC-${year}-${String(Number(count.rows[0]?.total || 0) + 1).padStart(5, "0")}`;
    const incident = (await client.query(`INSERT INTO logistics_operational_incidents
      (organization_id,incident_number,warehouse_id,category,severity,title,
       description,impact,owner_profile_id,opened_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [logisticsOrganizationId, number, body.warehouseId || null, category, severity,
      String(body.title).trim(), String(body.description).trim(),
      String(body.impact || ""), body.ownerProfileId || profile.id, profile.id])).rows[0];
    await client.query(`INSERT INTO logistics_incident_events
      (organization_id,incident_id,event_type,actor_profile_id,notes,after_data)
      VALUES ($1,$2,'OPERATIONAL_INCIDENT_OPENED',$3,$4,$5::jsonb)`,
    [logisticsOrganizationId, incident.id, profile.id, incident.description, asJson(incident)]);
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,after_data)
      VALUES ($1,'OPERATIONAL_INCIDENT_OPENED','operational_incident',$2,$3,'WEB',$4::jsonb)`,
    [logisticsOrganizationId, incident.id, profile.id, asJson(incident)]);
    if (["SEV1", "SEV2"].includes(severity)) {
      await client.query(`INSERT INTO inventory_tasks
        (id,task_type,title,detail,priority,status,center_name,entity_type,entity_id,payload,updated_at)
        VALUES ($1,'Incidente operacional',$2,$3,'Crítica','Pendiente',$4,
          'operational_incident',$5,$6::jsonb,NOW())
        ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,detail=EXCLUDED.detail,
          status='Pendiente',resolved_at=NULL,payload=EXCLUDED.payload,updated_at=NOW()`,
      [`incident-${incident.id}`, `${number}: ${incident.title}`, incident.impact || incident.description,
        activeUserCenterFallback(body.centerName), incident.id, asJson(incident)]);
    }
    await client.query("COMMIT");
    return incident;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function activeUserCenterFallback(value) {
  return String(value || "Bodega Central").trim() || "Bodega Central";
}

async function updateOperationalIncident(profile, incidentId, body) {
  const current = (await pool.query(`SELECT * FROM logistics_operational_incidents
    WHERE id=$1 AND organization_id=$2`, [incidentId, logisticsOrganizationId])).rows[0];
  if (!current) throw new Error("Incidente inexistente.");
  if (!profile.admin && current.warehouse_id &&
      !(await profileMayAccessWarehouse(profile, current.warehouse_id))) {
    throw new Error("El incidente pertenece a otro centro.");
  }
  const action = String(body.action || "").toUpperCase();
  const statusMap = { ACKNOWLEDGE: "INVESTIGATING", MITIGATE: "MITIGATED", RESOLVE: "RESOLVED" };
  const nextStatus = statusMap[action];
  if (!nextStatus) throw new Error("Acción de incidente inválida.");
  if (action === "RESOLVE" && (!String(body.resolution || "").trim() ||
      !String(body.rootCause || "").trim() || !String(body.correctiveAction || "").trim())) {
    throw new Error("Para cerrar debes registrar resolución, causa raíz y acción correctiva.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = (await client.query(`UPDATE logistics_operational_incidents SET
      status=$1,owner_profile_id=COALESCE($2,owner_profile_id),
      acknowledged_at=CASE WHEN $1='INVESTIGATING' THEN COALESCE(acknowledged_at,NOW()) ELSE acknowledged_at END,
      mitigated_at=CASE WHEN $1='MITIGATED' THEN COALESCE(mitigated_at,NOW()) ELSE mitigated_at END,
      resolved_at=CASE WHEN $1='RESOLVED' THEN NOW() ELSE resolved_at END,
      resolution=COALESCE(NULLIF($3,''),resolution),
      root_cause=COALESCE(NULLIF($4,''),root_cause),
      corrective_action=COALESCE(NULLIF($5,''),corrective_action),updated_at=NOW()
      WHERE id=$6 RETURNING *`,
    [nextStatus, body.ownerProfileId || null, String(body.resolution || ""),
      String(body.rootCause || ""), String(body.correctiveAction || ""), incidentId])).rows[0];
    const eventType = action === "RESOLVE" ? "OPERATIONAL_INCIDENT_RESOLVED"
      : `OPERATIONAL_INCIDENT_${action}`;
    await client.query(`INSERT INTO logistics_incident_events
      (organization_id,incident_id,event_type,actor_profile_id,notes,before_data,after_data)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [logisticsOrganizationId, incidentId, eventType, profile.id,
      String(body.notes || body.resolution || ""), asJson(current), asJson(updated)]);
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,before_data,after_data)
      VALUES ($1,$2,'operational_incident',$3,$4,'WEB',$5::jsonb,$6::jsonb)`,
    [logisticsOrganizationId, eventType, incidentId, profile.id, asJson(current), asJson(updated)]);
    if (nextStatus === "RESOLVED") {
      await client.query(`UPDATE inventory_tasks SET status='Resuelta',
        resolved_at=COALESCE(resolved_at,NOW()),updated_at=NOW()
        WHERE id=$1`, [`incident-${incidentId}`]);
    }
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function runtimeReleaseMetadata(latestMigration = "") {
  const commit = String(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "local").trim();
  return {
    releaseKey: `${commit}:${latestMigration || "no-migration"}`,
    versionLabel: process.env.APP_VERSION || "1.1.0",
    commitSha: commit,
    serviceId: process.env.RENDER_SERVICE_ID || "",
    environment: process.env.RENDER ? "production" : (process.env.NODE_ENV || "development"),
    latestMigration,
    metadata: {
      instanceId: process.env.RENDER_INSTANCE_ID || "",
      serviceName: process.env.RENDER_SERVICE_NAME || "inventario-icc1"
    }
  };
}

async function registerCurrentRelease() {
  const latestMigration = (await pool.query(`SELECT version FROM logistics_schema_migrations
    ORDER BY version DESC LIMIT 1`)).rows[0]?.version || "";
  const meta = runtimeReleaseMetadata(latestMigration);
  const result = await pool.query(`INSERT INTO logistics_release_records
    (organization_id,release_key,version_label,commit_sha,service_id,environment,
     latest_migration,metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    ON CONFLICT (organization_id,release_key) DO UPDATE SET
      service_id=EXCLUDED.service_id,environment=EXCLUDED.environment,
      metadata=EXCLUDED.metadata,updated_at=NOW()
    RETURNING *,(xmax=0) AS created`,
  [logisticsOrganizationId, meta.releaseKey, meta.versionLabel, meta.commitSha,
    meta.serviceId, meta.environment, meta.latestMigration, asJson(meta.metadata)]);
  const release = result.rows[0];
  if (release.created) {
    await pool.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,source,after_data)
      VALUES ($1,'RELEASE_DEPLOYED','release',$2,'SYSTEM',$3::jsonb)`,
    [logisticsOrganizationId, release.id, asJson(release)]);
  }
  return release;
}

async function releasesOverview() {
  const current = await registerCurrentRelease();
  const releases = await pool.query(`SELECT release.*,
      approver.name AS approved_by_name,
      COALESCE(checks.total,0)::int AS check_count,
      COALESCE(checks.failures,0)::int AS failed_checks
    FROM logistics_release_records release
    LEFT JOIN inventory_user_profiles approver ON approver.id::text=release.approved_by::text
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE mandatory=TRUE AND status<>'PASS') AS failures
      FROM logistics_release_checks WHERE release_id=release.id
    ) checks ON TRUE
    WHERE release.organization_id=$1 ORDER BY release.deployed_at DESC LIMIT 20`,
  [logisticsOrganizationId]);
  const checks = await pool.query(`SELECT DISTINCT ON (check_code) *
    FROM logistics_release_checks WHERE release_id=$1
    ORDER BY check_code,measured_at DESC`, [current.id]);
  return { current, releases: releases.rows, checks: checks.rows };
}

async function validateRelease(releaseId, actorProfileId) {
  const release = (await pool.query(`SELECT * FROM logistics_release_records
    WHERE id=$1 AND organization_id=$2`, [releaseId, logisticsOrganizationId])).rows[0];
  if (!release) throw new Error("Versión inexistente.");
  const checks = [];
  const add = (checkCode, status, detail, mandatory = true) =>
    checks.push({ checkCode, status, detail, mandatory });
  const dbStarted = Date.now();
  await pool.query("SELECT 1");
  add("DATABASE", "PASS", `PostgreSQL respondió en ${Date.now() - dbStarted} ms.`);
  const latestMigration = (await pool.query(`SELECT version FROM logistics_schema_migrations
    ORDER BY version DESC LIMIT 1`)).rows[0]?.version || "";
  add("MIGRATIONS", latestMigration.startsWith("047_") ? "PASS" : "FAIL",
    `Última migración: ${latestMigration || "ninguna"}.`);
  const audit = await pool.query(`SELECT COUNT(*)::int AS errors
    FROM logistics_audit_chain_verification WHERE NOT content_valid OR NOT link_valid`);
  add("AUDIT_CHAIN", Number(audit.rows[0]?.errors || 0) ? "FAIL" : "PASS",
    Number(audit.rows[0]?.errors || 0) ? `${audit.rows[0].errors} diferencia(s).` : "Cadena íntegra.");
  add("AUTH", authConfigured() ? "PASS" : "FAIL",
    authConfigured() ? "Supabase Auth configurado." : "Variables de acceso incompletas.");
  add("STORAGE", storageConfigured() ? "PASS" : "FAIL",
    storageConfigured() ? "Supabase Storage configurado." : "Variables de archivos incompletas.");
  const health = (await pool.query(`SELECT overall_status,checked_at FROM logistics_health_runs
    WHERE organization_id=$1 ORDER BY checked_at DESC LIMIT 1`, [logisticsOrganizationId])).rows[0];
  const healthCurrent = health && Date.now() - new Date(health.checked_at).getTime() < 15 * 60_000;
  add("CONTINUITY", healthCurrent && health.overall_status !== "DOWN" ? "PASS" : "FAIL",
    !health ? "Sin diagnóstico operacional." : `${health.overall_status} · ${health.checked_at}.`);
  const outbox = await pool.query(`SELECT COUNT(*)::int AS dead FROM logistics_outbox_events
    WHERE organization_id=$1 AND status='DEAD_LETTER'`, [logisticsOrganizationId]);
  add("OUTBOX", Number(outbox.rows[0]?.dead || 0) ? "FAIL" : "PASS",
    `${Number(outbox.rows[0]?.dead || 0)} evento(s) descartado(s).`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const check of checks) {
      await client.query(`INSERT INTO logistics_release_checks
        (organization_id,release_id,check_code,mandatory,status,detail,measured_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [logisticsOrganizationId, releaseId, check.checkCode, check.mandatory,
        check.status, check.detail, actorProfileId]);
    }
    const mandatoryFailures = checks.filter(check => check.mandatory && check.status !== "PASS");
    await client.query(`UPDATE logistics_release_records SET status=$1,
      validated_at=NOW(),latest_migration=$2,updated_at=NOW() WHERE id=$3`,
    [mandatoryFailures.length ? "FAILED" : "VALIDATING", latestMigration, releaseId]);
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,after_data)
      VALUES ($1,'RELEASE_VALIDATED','release',$2,$3,'WEB',$4::jsonb)`,
    [logisticsOrganizationId, releaseId, actorProfileId,
      asJson({ checks, mandatoryFailures: mandatoryFailures.length })]);
    await client.query("COMMIT");
    return { checks, mandatoryFailures: mandatoryFailures.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function changeReleaseStatus(releaseId, action, actorProfileId, reason = "") {
  const normalized = String(action || "").toUpperCase();
  const release = (await pool.query(`SELECT * FROM logistics_release_records
    WHERE id=$1 AND organization_id=$2`, [releaseId, logisticsOrganizationId])).rows[0];
  if (!release) throw new Error("Versión inexistente.");
  if (normalized === "APPROVE") {
    const latest = await pool.query(`SELECT DISTINCT ON (check_code)
      check_code,mandatory,status FROM logistics_release_checks
      WHERE release_id=$1 ORDER BY check_code,measured_at DESC`, [releaseId]);
    const required = ["DATABASE", "MIGRATIONS", "AUDIT_CHAIN", "AUTH", "STORAGE", "CONTINUITY", "OUTBOX"];
    const byCode = new Map(latest.rows.map(row => [row.check_code, row]));
    const mandatoryFailures = required.filter(code => !byCode.has(code) ||
      byCode.get(code).status !== "PASS");
    if (mandatoryFailures.length) {
      throw new Error("No puedes aprobar una versión con controles obligatorios pendientes.");
    }
  } else if (normalized === "ROLLBACK") {
    if (String(reason || "").trim().length < 10) {
      throw new Error("La reversa requiere un fundamento de al menos 10 caracteres.");
    }
  } else {
    throw new Error("Acción de versión inválida.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (normalized === "APPROVE") {
      await client.query(`UPDATE logistics_release_records SET status='DEPLOYED',
        updated_at=NOW() WHERE organization_id=$1 AND status='APPROVED' AND id<>$2`,
      [logisticsOrganizationId, releaseId]);
    }
    const nextStatus = normalized === "APPROVE" ? "APPROVED" : "ROLLED_BACK";
    const updated = (await client.query(`UPDATE logistics_release_records SET status=$1,
      approved_at=CASE WHEN $1='APPROVED' THEN NOW() ELSE approved_at END,
      approved_by=CASE WHEN $1='APPROVED' THEN $2 ELSE approved_by END,
      rollback_reason=CASE WHEN $1='ROLLED_BACK' THEN $3 ELSE rollback_reason END,
      updated_at=NOW() WHERE id=$4 RETURNING *`,
    [nextStatus, actorProfileId, String(reason || "").trim(), releaseId])).rows[0];
    const eventType = normalized === "APPROVE" ? "RELEASE_APPROVED" : "RELEASE_ROLLED_BACK";
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,before_data,after_data)
      VALUES ($1,$2,'release',$3,$4,'WEB',$5::jsonb,$6::jsonb)`,
    [logisticsOrganizationId, eventType, releaseId, actorProfileId, asJson(release), asJson(updated)]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload,status,available_at)
      VALUES ($1,$2,'release',$3,$4::jsonb,'PENDING',NOW())`,
    [logisticsOrganizationId, eventType, releaseId,
      asJson({ releaseId, commitSha: release.commit_sha, reason })]);
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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

async function syncInventoryAdjustmentTask(adjustmentId) {
  const result = await pool.query(`SELECT adjustment.*,item.sku,item.name AS item_name,
      warehouse.name AS warehouse_name,center.name AS cost_center
    FROM logistics_inventory_adjustments adjustment
    JOIN logistics_items item ON item.id=adjustment.item_id
    JOIN logistics_warehouses warehouse ON warehouse.id=adjustment.warehouse_id
    LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
    WHERE adjustment.id=$1`, [adjustmentId]);
  const adjustment = result.rows[0];
  if (!adjustment) return;
  const taskId = `inventory-adjustment-${adjustment.id}`;
  if (!["SUBMITTED", "APPROVED"].includes(adjustment.status)) {
    await pool.query(`UPDATE inventory_tasks SET status='Resuelta',resolved_at=COALESCE(resolved_at,NOW()),
      updated_at=NOW() WHERE id=$1`, [taskId]);
    return;
  }
  const responsible = await pool.query(`SELECT auth_user_id FROM inventory_user_profiles
    WHERE active=TRUE AND auth_user_id IS NOT NULL AND id<>$1
      AND (admin=TRUE OR permissions ? 'approve')
      AND (admin=TRUE OR cost_center=$2)
    ORDER BY admin DESC,updated_at DESC LIMIT 1`,
  [adjustment.requested_by, adjustment.cost_center || "Bodega Central"]);
  const assignee = responsible.rows[0]?.auth_user_id || null;
  const title = adjustment.status === "SUBMITTED"
    ? `Ajuste pendiente de aprobación: ${adjustment.adjustment_number}`
    : `Ajuste pendiente de contabilización: ${adjustment.adjustment_number}`;
  const detail = `${adjustment.sku} · ${adjustment.item_name} · ${Number(adjustment.quantity_delta) > 0 ? "+" : ""}${adjustment.quantity_delta} · ${adjustment.warehouse_name}`;
  await pool.query(`INSERT INTO inventory_tasks
    (id,task_type,title,detail,priority,status,center_name,assignee_auth_user_id,entity_type,entity_id,payload,updated_at)
    VALUES ($1,'Ajuste de inventario',$2,$3,'Alta','Pendiente',$4,$5,'inventory_adjustment',$6,$7::jsonb,NOW())
    ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,detail=EXCLUDED.detail,status='Pendiente',
      center_name=EXCLUDED.center_name,assignee_auth_user_id=EXCLUDED.assignee_auth_user_id,
      resolved_at=NULL,payload=EXCLUDED.payload,updated_at=NOW()`,
  [taskId, title, detail, adjustment.cost_center || "Bodega Central", assignee,
    adjustment.id, JSON.stringify(adjustment)]);
  await pool.query(`INSERT INTO inventory_notifications
    (id,recipient_auth_user_id,center_name,notification_type,title,body,severity,entity_type,entity_id,payload)
    VALUES ($1,$2,$3,'Ajuste de inventario',$4,$5,'warning','inventory_adjustment',$6,$7::jsonb)
    ON CONFLICT (id) DO NOTHING`,
  [`notification-${taskId}-${adjustment.status}`, assignee, adjustment.cost_center || "Bodega Central",
    title, detail, adjustment.id, JSON.stringify(adjustment)]);
}

async function syncSupplierInvoiceTask(invoiceId) {
  const result = await pool.query(`SELECT invoice.*,purchase_order.purchase_order_number,
      warehouse.name AS warehouse_name,center.name AS cost_center,supplier.name AS supplier_name
    FROM logistics_supplier_invoices invoice
    JOIN logistics_purchase_orders purchase_order ON purchase_order.id=invoice.purchase_order_id
    JOIN logistics_warehouses warehouse ON warehouse.id=purchase_order.warehouse_id
    LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
    JOIN logistics_suppliers supplier ON supplier.id=invoice.supplier_id
    WHERE invoice.id=$1`, [invoiceId]);
  const invoice = result.rows[0];
  if (!invoice) return;
  const taskId = `supplier-invoice-${invoice.id}`;
  if (!["MATCHED", "EXCEPTION"].includes(invoice.status)) {
    await pool.query(`UPDATE inventory_tasks SET status='Resuelta',resolved_at=COALESCE(resolved_at,NOW()),
      updated_at=NOW() WHERE id=$1`, [taskId]);
    return;
  }
  const responsible = await pool.query(`SELECT auth_user_id FROM inventory_user_profiles
    WHERE active=TRUE AND auth_user_id IS NOT NULL AND id<>$1
      AND (admin=TRUE OR permissions ? 'approve') AND (admin=TRUE OR cost_center=$2)
    ORDER BY admin DESC,updated_at DESC LIMIT 1`,
  [invoice.registered_by, invoice.cost_center || "Bodega Central"]);
  const assignee = responsible.rows[0]?.auth_user_id || null;
  const exception = invoice.status === "EXCEPTION";
  const title = exception
    ? `Factura bloqueada por diferencias: ${invoice.invoice_number}`
    : `Factura conciliada pendiente de aprobación: ${invoice.invoice_number}`;
  const detail = `${invoice.supplier_name} · ${invoice.purchase_order_number} · ${invoice.currency} ${invoice.total_amount}`;
  await pool.query(`INSERT INTO inventory_tasks
    (id,task_type,title,detail,priority,status,center_name,assignee_auth_user_id,entity_type,entity_id,payload,updated_at)
    VALUES ($1,'Conciliación de factura',$2,$3,$4,'Pendiente',$5,$6,'supplier_invoice',$7,$8::jsonb,NOW())
    ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,detail=EXCLUDED.detail,priority=EXCLUDED.priority,
      status='Pendiente',center_name=EXCLUDED.center_name,assignee_auth_user_id=EXCLUDED.assignee_auth_user_id,
      resolved_at=NULL,payload=EXCLUDED.payload,updated_at=NOW()`,
  [taskId, title, detail, exception ? "Crítica" : "Alta", invoice.cost_center || "Bodega Central",
    assignee, invoice.id, JSON.stringify(invoice)]);
  await pool.query(`INSERT INTO inventory_notifications
    (id,recipient_auth_user_id,center_name,notification_type,title,body,severity,entity_type,entity_id,payload)
    VALUES ($1,$2,$3,'Conciliación de factura',$4,$5,$6,'supplier_invoice',$7,$8::jsonb)
    ON CONFLICT (id) DO NOTHING`,
  [`notification-${taskId}-${invoice.status}`, assignee, invoice.cost_center || "Bodega Central",
    title, detail, exception ? "critical" : "warning", invoice.id, JSON.stringify(invoice)]);
}

async function syncSupplierReturnTask(returnId) {
  const result = await pool.query(`SELECT supplier_return.*,supplier.name AS supplier_name,
      warehouse.name AS warehouse_name,center.name AS cost_center,receipt.receipt_number
    FROM logistics_supplier_returns supplier_return
    JOIN logistics_suppliers supplier ON supplier.id=supplier_return.supplier_id
    JOIN logistics_warehouses warehouse ON warehouse.id=supplier_return.warehouse_id
    LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
    JOIN logistics_inbound_receipts receipt ON receipt.id=supplier_return.receipt_id
    WHERE supplier_return.id=$1`, [returnId]);
  const supplierReturn = result.rows[0];
  if (!supplierReturn) return;
  const taskId = `supplier-return-${supplierReturn.id}`;
  if (["CLOSED", "CANCELLED"].includes(supplierReturn.status)) {
    await pool.query(`UPDATE inventory_tasks SET status='Resuelta',resolved_at=COALESCE(resolved_at,NOW()),
      updated_at=NOW() WHERE id=$1`, [taskId]);
    return;
  }
  const responsible = await pool.query(`SELECT auth_user_id FROM inventory_user_profiles
    WHERE active=TRUE AND auth_user_id IS NOT NULL
      AND (admin=TRUE OR permissions ? 'approve') AND (admin=TRUE OR cost_center=$1)
    ORDER BY admin DESC,updated_at DESC LIMIT 1`, [supplierReturn.cost_center || "Bodega Central"]);
  const assignee = responsible.rows[0]?.auth_user_id || null;
  const waitingCredit = supplierReturn.status === "CREDIT_PENDING";
  const title = waitingCredit
    ? `Nota de crédito pendiente: ${supplierReturn.return_number}`
    : `Devolución a proveedor abierta: ${supplierReturn.return_number}`;
  const detail = `${supplierReturn.supplier_name} · ${supplierReturn.receipt_number} · ${supplierReturn.reason_code}`;
  await pool.query(`INSERT INTO inventory_tasks
    (id,task_type,title,detail,priority,status,center_name,assignee_auth_user_id,entity_type,entity_id,payload,updated_at)
    VALUES ($1,'Devolución a proveedor',$2,$3,$4,'Pendiente',$5,$6,'supplier_return',$7,$8::jsonb,NOW())
    ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,detail=EXCLUDED.detail,priority=EXCLUDED.priority,
      status='Pendiente',center_name=EXCLUDED.center_name,assignee_auth_user_id=EXCLUDED.assignee_auth_user_id,
      resolved_at=NULL,payload=EXCLUDED.payload,updated_at=NOW()`,
  [taskId, title, detail, waitingCredit ? "Alta" : "Media", supplierReturn.cost_center || "Bodega Central",
    assignee, supplierReturn.id, JSON.stringify(supplierReturn)]);
  await pool.query(`INSERT INTO inventory_notifications
    (id,recipient_auth_user_id,center_name,notification_type,title,body,severity,entity_type,entity_id,payload)
    VALUES ($1,$2,$3,'Devolución a proveedor',$4,$5,$6,'supplier_return',$7,$8::jsonb)
    ON CONFLICT (id) DO NOTHING`,
  [`notification-${taskId}-${supplierReturn.status}`, assignee,
    supplierReturn.cost_center || "Bodega Central", title, detail,
    waitingCredit ? "warning" : "info", supplierReturn.id, JSON.stringify(supplierReturn)]);
}

async function syncAssetDisposalTask(disposalId) {
  const result = await pool.query(`SELECT disposal.*,unit.unit_code,item.name AS item_name,
      warehouse.name AS warehouse_name,center.name AS cost_center
    FROM logistics_asset_disposals disposal
    JOIN logistics_asset_units unit ON unit.id=disposal.asset_unit_id
    JOIN logistics_items item ON item.id=disposal.item_id
    JOIN logistics_warehouses warehouse ON warehouse.id=disposal.warehouse_id
    LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
    WHERE disposal.id=$1`, [disposalId]);
  const disposal = result.rows[0];
  if (!disposal) return;
  const taskId = `asset-disposal-${disposal.id}`;
  if (!["SUBMITTED", "APPROVED"].includes(disposal.status)) {
    await pool.query(`UPDATE inventory_tasks SET status='Resuelta',resolved_at=COALESCE(resolved_at,NOW()),
      updated_at=NOW() WHERE id=$1`, [taskId]);
    return;
  }
  const responsible = await pool.query(`SELECT auth_user_id FROM inventory_user_profiles
    WHERE active=TRUE AND auth_user_id IS NOT NULL AND id<>$1
      AND (admin=TRUE OR permissions ? 'approve') AND (admin=TRUE OR cost_center=$2)
    ORDER BY admin DESC,updated_at DESC LIMIT 1`,
  [disposal.requested_by, disposal.cost_center || "Bodega Central"]);
  const assignee = responsible.rows[0]?.auth_user_id || null;
  const title = disposal.status === "SUBMITTED"
    ? `Baja pendiente de aprobación: ${disposal.unit_code}`
    : `Baja aprobada pendiente de contabilizar: ${disposal.unit_code}`;
  const detail = `${disposal.item_name} · ${disposal.reason_code} · ${disposal.disposal_number}`;
  await pool.query(`INSERT INTO inventory_tasks
    (id,task_type,title,detail,priority,status,center_name,assignee_auth_user_id,entity_type,entity_id,payload,updated_at)
    VALUES ($1,'Baja de activo',$2,$3,'Alta','Pendiente',$4,$5,'asset_disposal',$6,$7::jsonb,NOW())
    ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,detail=EXCLUDED.detail,status='Pendiente',
      center_name=EXCLUDED.center_name,assignee_auth_user_id=EXCLUDED.assignee_auth_user_id,
      resolved_at=NULL,payload=EXCLUDED.payload,updated_at=NOW()`,
  [taskId, title, detail, disposal.cost_center || "Bodega Central", assignee, disposal.id,
    JSON.stringify(disposal)]);
  await pool.query(`INSERT INTO inventory_notifications
    (id,recipient_auth_user_id,center_name,notification_type,title,body,severity,entity_type,entity_id,payload)
    VALUES ($1,$2,$3,'Baja de activo',$4,$5,'warning','asset_disposal',$6,$7::jsonb)
    ON CONFLICT (id) DO NOTHING`,
  [`notification-${taskId}-${disposal.status}`, assignee, disposal.cost_center || "Bodega Central",
    title, detail, disposal.id, JSON.stringify(disposal)]);
}

async function syncAssetComplianceTask(complianceId) {
  const result = await pool.query(`SELECT compliance.*,unit.unit_code,item.name AS item_name,
      center.name AS cost_center,
      CASE WHEN compliance.expires_at IS NULL THEN NULL
        ELSE compliance.expires_at-CURRENT_DATE END AS days_remaining,
      CASE WHEN compliance.expires_at<CURRENT_DATE THEN 'EXPIRED'
        WHEN compliance.expires_at<=CURRENT_DATE+compliance.reminder_days THEN 'EXPIRING'
        ELSE compliance.status END AS effective_status
    FROM logistics_asset_compliance_records compliance
    JOIN logistics_asset_units unit ON unit.id=compliance.asset_unit_id
    JOIN logistics_items item ON item.id=unit.item_id
    LEFT JOIN LATERAL (
      SELECT balance.location_id FROM logistics_stock_balances balance
      WHERE balance.asset_unit_id=unit.id AND balance.quantity>0
      ORDER BY balance.updated_at DESC LIMIT 1
    ) stock ON TRUE
    LEFT JOIN logistics_locations location ON location.id=stock.location_id
    LEFT JOIN logistics_warehouses warehouse ON warehouse.id=location.warehouse_id
    LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
    WHERE compliance.id=$1`, [complianceId]);
  const record = result.rows[0];
  if (!record) return;
  const taskId = `asset-compliance-${record.id}`;
  if (record.status !== "ACTIVE" || !record.expires_at || record.effective_status === "ACTIVE") {
    await pool.query(`UPDATE inventory_tasks SET status='Resuelta',
      resolved_at=COALESCE(resolved_at,NOW()),updated_at=NOW() WHERE id=$1`, [taskId]);
    return;
  }
  const responsible = await pool.query(`SELECT auth_user_id FROM inventory_user_profiles
    WHERE active=TRUE AND auth_user_id IS NOT NULL
      AND (admin=TRUE OR permissions ? 'inspect' OR permissions ? 'approve')
      AND (admin=TRUE OR cost_center=$1)
    ORDER BY admin DESC,updated_at DESC LIMIT 1`, [record.cost_center || "Bodega Central"]);
  const assignee = responsible.rows[0]?.auth_user_id || null;
  const expired = record.effective_status === "EXPIRED";
  const title = expired
    ? `Documento vencido: ${record.unit_code}`
    : `Próximo vencimiento: ${record.unit_code}`;
  const detail = `${record.item_name} · ${record.requirement_name} · vence ${record.expires_at}`;
  await pool.query(`INSERT INTO inventory_tasks
    (id,task_type,title,detail,priority,status,center_name,assignee_auth_user_id,
     entity_type,entity_id,due_at,payload,updated_at)
    VALUES ($1,'Cumplimiento de activo',$2,$3,$4,'Pendiente',$5,$6,
      'asset_compliance',$7,$8,$9::jsonb,NOW())
    ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,detail=EXCLUDED.detail,
      priority=EXCLUDED.priority,status='Pendiente',center_name=EXCLUDED.center_name,
      assignee_auth_user_id=EXCLUDED.assignee_auth_user_id,due_at=EXCLUDED.due_at,
      resolved_at=NULL,payload=EXCLUDED.payload,updated_at=NOW()`,
  [taskId, title, detail, expired && record.critical ? "Crítica" : Number(record.days_remaining) <= 7 ? "Alta" : "Media",
    record.cost_center || "Bodega Central", assignee, record.id, record.expires_at,
    JSON.stringify(record)]);
  if (["EXPIRED", "EXPIRING"].includes(record.effective_status)) {
    await pool.query(`INSERT INTO inventory_notifications
      (id,recipient_auth_user_id,center_name,notification_type,title,body,severity,
       entity_type,entity_id,payload)
      VALUES ($1,$2,$3,'Cumplimiento de activo',$4,$5,$6,'asset_compliance',$7,$8::jsonb)
      ON CONFLICT (id) DO NOTHING`,
    [`notification-${taskId}-${record.effective_status}`, assignee,
      record.cost_center || "Bodega Central", title, detail,
      expired && record.critical ? "critical" : "warning", record.id, JSON.stringify(record)]);
  }
}

let complianceSweepRunning = false;
async function sweepAssetComplianceTasks() {
  if (!pool || !logisticsReady || complianceSweepRunning) return { scanned: 0, skipped: true };
  complianceSweepRunning = true;
  try {
    const records = await pool.query(`SELECT id FROM logistics_asset_compliance_records
      WHERE status='ACTIVE' ORDER BY expires_at NULLS LAST`);
    for (const record of records.rows) await syncAssetComplianceTask(record.id);
    const resolved = await pool.query(`UPDATE inventory_tasks task
      SET status='Resuelta',resolved_at=COALESCE(resolved_at,NOW()),updated_at=NOW()
      WHERE task.entity_type='asset_compliance' AND task.status<>'Resuelta'
        AND NOT EXISTS (
          SELECT 1 FROM logistics_asset_compliance_records compliance
          WHERE compliance.id::text=task.entity_id AND compliance.status='ACTIVE'
        ) RETURNING id`);
    return { scanned: records.rowCount, resolved: resolved.rowCount };
  } finally {
    complianceSweepRunning = false;
  }
}

function startComplianceScheduler() {
  const run = () => sweepAssetComplianceTasks()
    .catch(error => console.error("No se pudo revisar vencimientos técnicos:", error.message));
  setTimeout(run, 5_000).unref?.();
  setInterval(run, 15 * 60 * 1000).unref?.();
}

let logisticsJobSweepRunning = false;
async function sweepScheduledLogisticsJobs() {
  if (!pool || !logisticsReady || logisticsJobSweepRunning) {
    return { skipped: true, processed: 0 };
  }
  logisticsJobSweepRunning = true;
  try {
    return await runDueLogisticsJobs(pool);
  } finally {
    logisticsJobSweepRunning = false;
  }
}

function startLogisticsJobScheduler() {
  const run = () => sweepScheduledLogisticsJobs()
    .catch(error => console.error("No se pudieron ejecutar automatizaciones logisticas:", error.message));
  setTimeout(run, 10_000).unref?.();
  setInterval(run, 15 * 60 * 1000).unref?.();
}

let outboxSweepRunning = false;
async function sweepLogisticsOutbox() {
  if (!pool || !logisticsReady || outboxSweepRunning) {
    return { skipped: true, processed: 0, published: 0, failed: 0 };
  }
  outboxSweepRunning = true;
  try {
    return await processOutboxEvents(pool, { limit: 100, maxAttempts: 5 });
  } finally {
    outboxSweepRunning = false;
  }
}

function startLogisticsOutboxScheduler() {
  const run = () => sweepLogisticsOutbox()
    .catch(error => console.error("No se pudo procesar la cola logistica:", error.message));
  setTimeout(run, 12_000).unref?.();
  setInterval(run, 60_000).unref?.();
}

async function createCanonicalBackup(actorProfile) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const organizationId = logisticsOrganizationId;
    const datasets = {};
    const directTables = {
      organizations: "logistics_organizations",
      costCenters: "logistics_cost_centers",
      sites: "logistics_sites",
      warehouses: "logistics_warehouses",
      locations: "logistics_locations",
      itemFamilies: "logistics_item_families",
      items: "logistics_items",
      unitsOfMeasure: "logistics_units_of_measure",
      itemPresentations: "logistics_item_uoms",
      supplierItems: "logistics_supplier_items",
      classificationPolicies: "logistics_classification_policies",
      inventoryClassifications: "logistics_inventory_classifications",
      assetUnits: "logistics_asset_units",
      lots: "logistics_lots",
      stockMovements: "logistics_stock_movements",
      stockLedger: "logistics_stock_ledger",
      stockBalances: "logistics_stock_balances",
      transferOrders: "logistics_transfer_orders",
      custodyAssignments: "logistics_custody_assignments",
      documents: "logistics_documents",
      auditEvents: "logistics_audit_events",
      inspectionTemplates: "logistics_inspection_template_versions",
      inspectionRuns: "logistics_inspection_runs",
      maintenancePlans: "logistics_maintenance_plans",
      workOrders: "logistics_work_orders",
      assetDisposals: "logistics_asset_disposals",
      assetFinancials: "logistics_asset_financials",
      assetCompliance: "logistics_asset_compliance_records",
      materialRequests: "logistics_material_requests",
      stockReservations: "logistics_stock_reservations",
      pickTasks: "logistics_pick_tasks",
      kpiSnapshots: "logistics_kpi_snapshots",
      kpiTargets: "logistics_kpi_targets",
      scheduledJobs: "logistics_scheduled_jobs",
      outboxEvents: "logistics_outbox_events"
    };
    for (const [name, table] of Object.entries(directTables)) {
      const result = await client.query(`SELECT * FROM ${table}
        WHERE organization_id=$1 ORDER BY 1`, [organizationId]);
      datasets[name] = result.rows;
    }
    const childQueries = {
      transferLines: `SELECT line.* FROM logistics_transfer_lines line
        JOIN logistics_transfer_orders parent ON parent.id=line.transfer_id
        WHERE parent.organization_id=$1 ORDER BY line.id`,
      materialRequestLines: `SELECT line.* FROM logistics_material_request_lines line
        JOIN logistics_material_requests parent ON parent.id=line.request_id
        WHERE parent.organization_id=$1 ORDER BY line.id`,
      documentLinks: `SELECT link.* FROM logistics_document_links link
        JOIN logistics_documents parent ON parent.id=link.document_id
        WHERE parent.organization_id=$1 ORDER BY link.document_id,link.entity_type,link.entity_id`,
      inspectionTemplateItems: `SELECT child.* FROM logistics_inspection_template_items child
        JOIN logistics_inspection_template_versions parent ON parent.id=child.template_version_id
        WHERE parent.organization_id=$1 ORDER BY child.template_version_id,child.item_order`,
      inspectionAnswers: `SELECT child.* FROM logistics_inspection_answers child
        JOIN logistics_inspection_runs parent ON parent.id=child.inspection_id
        WHERE parent.organization_id=$1 ORDER BY child.inspection_id,child.id`,
      inspectionFindings: `SELECT child.* FROM logistics_inspection_findings child
        JOIN logistics_inspection_runs parent ON parent.id=child.inspection_id
        WHERE parent.organization_id=$1 ORDER BY child.inspection_id,child.id`,
      inspectionApprovals: `SELECT child.* FROM logistics_inspection_approvals child
        JOIN logistics_inspection_runs parent ON parent.id=child.inspection_id
        WHERE parent.organization_id=$1 ORDER BY child.inspection_id,child.id`,
      workOrderParts: `SELECT child.* FROM logistics_work_order_parts child
        JOIN logistics_work_orders parent ON parent.id=child.work_order_id
        WHERE parent.organization_id=$1 ORDER BY child.work_order_id,child.id`,
      fileObjects: `SELECT file.id,file.filename,file.mime_type,file.category,file.reference,
          file.size_bytes,file.provider,file.storage_path,file.public_url,file.payload,file.created_at
        FROM inventory_file_objects file
        JOIN logistics_documents document ON document.file_object_id=file.id
        WHERE document.organization_id=$1 ORDER BY file.id`
    };
    for (const [name, sql] of Object.entries(childQueries)) {
      datasets[name] = (await client.query(sql, [organizationId])).rows;
    }
    datasets.workers = (await client.query(`SELECT id,rut,name,company,job_title,cost_center,
      email,phone,signature_file_id,status,created_at,updated_at
      FROM inventory_worker_enrollments ORDER BY id`)).rows;
    const chain = await client.query(`SELECT COUNT(*)::int AS errors
      FROM logistics_audit_chain_verification
      WHERE organization_id=$1 AND (NOT content_valid OR NOT link_valid)`, [organizationId]);
    const auditHead = await client.query(`SELECT event_hash FROM logistics_audit_events
      WHERE organization_id=$1 ORDER BY id DESC LIMIT 1`, [organizationId]);
    const recordCounts = Object.fromEntries(Object.entries(datasets)
      .map(([name, rows]) => [name, rows.length]));
    const payload = {
      format: "ICC-LOGISTICS-BACKUP-1",
      generatedAt: new Date().toISOString(),
      organizationId,
      audit: {
        chainValid: Number(chain.rows[0]?.errors || 0) === 0,
        headHash: auditHead.rows[0]?.event_hash || null
      },
      recordCounts,
      datasets
    };
    const body = JSON.stringify(payload);
    const payloadSha256 = createHash("sha256").update(body).digest("hex");
    const manifest = (await client.query(`INSERT INTO logistics_backup_manifests
      (organization_id,generated_by,payload_sha256,audit_head_hash,audit_chain_valid,
       record_counts,metadata)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING *`,
    [organizationId, actorProfile.id, payloadSha256, payload.audit.headHash,
      payload.audit.chainValid, JSON.stringify(recordCounts),
      JSON.stringify({ filePayloadsExcluded: true, storage: "Supabase Storage", bytes: Buffer.byteLength(body) })])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,
       source,after_data,metadata)
      VALUES ($1,'CANONICAL_BACKUP_EXPORTED','backup_manifest',$2,$3,$4,'SYSTEM',$5::jsonb,$6::jsonb)`,
    [organizationId, manifest.id, actorProfile.id, `backup:${manifest.id}`,
      JSON.stringify({ payloadSha256, recordCounts }),
      JSON.stringify({ auditHeadHash: payload.audit.headHash, auditChainValid: payload.audit.chainValid })]);
    await client.query("COMMIT");
    return { body, manifest };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function productionReadiness() {
  const checks = [];
  const add = (code, label, status, detail, action = "") =>
    checks.push({ code, label, status, detail, action });
  const started = Date.now();
  await pool.query("SELECT 1");
  add("database", "Base de datos PostgreSQL", "PASS", `Respuesta en ${Date.now() - started} ms.`);

  const migrations = await pool.query(`SELECT version,applied_at FROM logistics_schema_migrations
    ORDER BY version DESC`);
  const latestMigration = migrations.rows[0]?.version || "";
  add("migrations", "Migraciones del modelo", latestMigration.startsWith("047_") ? "PASS" : "FAIL",
    `${migrations.rowCount} aplicadas · última: ${latestMigration || "ninguna"}.`,
    latestMigration.startsWith("047_") ? "" : "Publicar la versión más reciente y revisar los logs de Render.");

  const settings = await authSettings();
  add("auth", "Autenticación Supabase", authConfigured() && settings.migration_complete ? "PASS" : "FAIL",
    authConfigured() ? (settings.migration_complete ? "Activa y migración de acceso finalizada." : "Configurada, pero el acceso seguro no está finalizado.") : "Variables de autenticación incompletas.",
    "Completar SUPABASE_PUBLISHABLE_KEY y activar la cuenta administradora.");

  const accessReview = (await pool.query(`SELECT reviewed_at,issue_count
    FROM inventory_access_reviews ORDER BY reviewed_at DESC LIMIT 1`)).rows[0];
  const accessReviewAge = accessReview
    ? Math.floor((Date.now() - new Date(accessReview.reviewed_at).getTime()) / 86_400_000) : null;
  add("accessReview", "Revisión de accesos",
    accessReviewAge === null || accessReviewAge > 90 || Number(accessReview?.issue_count || 0) > 0
      ? "WARN" : "PASS",
    accessReviewAge === null ? "Aún no se ha registrado una revisión."
      : `Última revisión hace ${accessReviewAge} día(s) · ${Number(accessReview.issue_count || 0)} observación(es).`,
    "Abrir Configuración y registrar la revisión de separación de funciones.");

  let storageStatus = "FAIL";
  let storageDetail = "Supabase Storage no está configurado.";
  if (storageConfigured()) {
    try {
      const endpoint = `${supabaseBaseUrl()}/storage/v1/bucket/${encodeURIComponent(process.env.SUPABASE_BUCKET)}`;
      const response = await fetchWithTimeout(endpoint, { headers: {
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY
      } }, { service: "Supabase Storage", timeoutMs: 8_000 });
      storageStatus = response.ok ? "PASS" : "FAIL";
      storageDetail = response.ok ? `Bucket ${process.env.SUPABASE_BUCKET} accesible.` : `Storage respondió HTTP ${response.status}.`;
    } catch (error) {
      storageDetail = error.message;
    }
  }
  add("storage", "Archivos y firmas", storageStatus, storageDetail,
    storageStatus === "PASS" ? "" : "Revisar SUPABASE_URL, SERVICE_ROLE_KEY y el bucket privado.");

  const audit = await pool.query(`SELECT COUNT(*)::int AS errors
    FROM logistics_audit_chain_verification WHERE NOT content_valid OR NOT link_valid`);
  add("audit", "Cadena de auditoría", Number(audit.rows[0]?.errors || 0) === 0 ? "PASS" : "FAIL",
    Number(audit.rows[0]?.errors || 0) === 0 ? "Cadena íntegra." : `${audit.rows[0].errors} evento(s) con diferencias.`,
    "Detener cambios y revisar inmediatamente la auditoría.");

  const backup = await pool.query(`SELECT generated_at,payload_sha256,audit_chain_valid
    FROM logistics_backup_manifests ORDER BY generated_at DESC LIMIT 1`);
  const backupAge = backup.rows[0]
    ? Math.floor((Date.now() - new Date(backup.rows[0].generated_at).getTime()) / 86_400_000)
    : null;
  add("backup", "Respaldo integral V2",
    backupAge === null || backupAge > 7 || !backup.rows[0]?.audit_chain_valid ? "WARN" : "PASS",
    backupAge === null ? "Nunca se ha exportado." : `Último respaldo hace ${backupAge} día(s) · SHA-256 ${backup.rows[0].payload_sha256.slice(0, 12)}…`,
    "Generar y guardar un respaldo V2 fuera de Render.");

  const documents = await pool.query(`SELECT COUNT(*)::int AS missing
    FROM logistics_documents WHERE status='ACTIVE' AND (sha256 IS NULL OR sha256='')`);
  add("documents", "Integridad documental", Number(documents.rows[0]?.missing || 0) ? "WARN" : "PASS",
    Number(documents.rows[0]?.missing || 0) ? `${documents.rows[0].missing} documento(s) sin huella SHA-256.` : "Todos los documentos activos tienen huella.",
    "Volver a archivar los documentos históricos sin huella.");

  const rls = await pool.query(`SELECT COUNT(*)::int AS disabled FROM pg_class relation
    JOIN pg_namespace schema ON schema.oid=relation.relnamespace
    WHERE schema.nspname='public' AND relation.relkind='r'
      AND relation.relname LIKE 'logistics_%'
      AND relation.relname<>'logistics_schema_migrations' AND NOT relation.relrowsecurity`);
  add("rls", "Seguridad por filas", Number(rls.rows[0]?.disabled || 0) === 0 ? "PASS" : "FAIL",
    Number(rls.rows[0]?.disabled || 0) === 0 ? "RLS activo en todas las tablas logísticas." : `${rls.rows[0].disabled} tabla(s) logísticas sin RLS.`,
    "Aplicar RLS antes de incorporar nuevos usuarios.");

  const critical = await pool.query(`SELECT COUNT(*)::int AS overdue FROM inventory_tasks
    WHERE status<>'Resuelta' AND priority='Crítica' AND due_at<NOW()`);
  add("criticalTasks", "Tareas críticas vencidas", Number(critical.rows[0]?.overdue || 0) ? "WARN" : "PASS",
    Number(critical.rows[0]?.overdue || 0) ? `${critical.rows[0].overdue} tarea(s) crítica(s) vencida(s).` : "Sin tareas críticas vencidas.",
    "Resolver o reasignar desde Tareas y notificaciones.");

  add("openai", "Digitalización con IA", process.env.OPENAI_API_KEY ? "PASS" : "WARN",
    process.env.OPENAI_API_KEY ? "Clave configurada; el consumo depende del saldo API." : "Función opcional desactivada.",
    "Configurar saldo API cuando se habilite la digitalización.");

  const scheduler = (await pool.query(`SELECT enabled,next_run_at,last_completed_at,
      last_status,last_error FROM logistics_scheduled_jobs
    WHERE organization_id=$1 AND job_code='KPI_DAILY_SNAPSHOT' LIMIT 1`,
  [logisticsOrganizationId])).rows[0];
  const schedulerOverdue = scheduler?.enabled && scheduler.next_run_at
    && new Date(scheduler.next_run_at).getTime() < Date.now() - 3_600_000;
  const schedulerStatus = !scheduler || scheduler.last_status === "FAILED" || schedulerOverdue
    ? "FAIL" : scheduler.enabled ? "PASS" : "WARN";
  const schedulerDetail = !scheduler ? "No existe una agenda de cierre diario."
    : scheduler.last_status === "FAILED" ? `Ultima ejecucion fallida: ${scheduler.last_error || "sin detalle"}.`
      : schedulerOverdue ? `Ejecucion atrasada desde ${new Date(scheduler.next_run_at).toLocaleString("es-CL")}.`
        : scheduler.enabled ? `Activa; proxima ejecucion ${new Date(scheduler.next_run_at).toLocaleString("es-CL")}.`
          : "La automatizacion esta detenida.";
  add("scheduler", "Cierre automatico de indicadores", schedulerStatus, schedulerDetail,
    schedulerStatus === "PASS" ? "" : "Abrir Reportes, entrar a Automatizacion y ejecutar la recuperacion.");

  const outbox = await listOutboxHealth(pool, logisticsOrganizationId);
  const deadLetters = Number(outbox.summary?.dead_letter || 0);
  const oldestPendingAge = outbox.summary?.oldest_pending_at
    ? (Date.now() - new Date(outbox.summary.oldest_pending_at).getTime()) / 60_000 : 0;
  add("outbox", "Entrega de eventos operativos",
    deadLetters ? "FAIL" : oldestPendingAge > 15 ? "WARN" : "PASS",
    deadLetters ? `${deadLetters} evento(s) agotaron sus reintentos.`
      : `${Number(outbox.summary?.pending || 0)} pendiente(s); ${Number(outbox.summary?.published_24h || 0)} publicados en 24 horas.`,
    deadLetters || oldestPendingAge > 15
      ? "Abrir Configuracion, revisar Cola de eventos y ejecutar la recuperacion." : "");

  const deviceChecks = await pool.query(`SELECT check_type,
      (ARRAY_AGG(status ORDER BY performed_at DESC))[1] AS status,
      MAX(performed_at) AS checked_at
    FROM logistics_device_checks WHERE organization_id=$1
      AND check_type IN ('CAMERA_QR','KEYBOARD_SCANNER','PRINT_LABEL')
    GROUP BY check_type`, [logisticsOrganizationId]);
  const verifiedTypes = new Map(deviceChecks.rows.map(row => [row.check_type, row]));
  const requiredDevices = ["CAMERA_QR", "KEYBOARD_SCANNER", "PRINT_LABEL"];
  const failedDevices = requiredDevices.filter(type => verifiedTypes.get(type)?.status === "FAIL");
  const staleDevices = requiredDevices.filter(type => {
    const row = verifiedTypes.get(type);
    return !row || Date.now() - new Date(row.checked_at).getTime() > 90 * 86_400_000;
  });
  add("fieldDevices", "Equipos de operación en terreno",
    failedDevices.length ? "FAIL" : staleDevices.length ? "WARN" : "PASS",
    failedDevices.length ? `${failedDevices.length} equipo(s) con prueba fallida.`
      : staleDevices.length ? `${staleDevices.length} prueba(s) sin vigencia de 90 días.`
        : "Cámara, lector USB e impresora verificados físicamente.",
    failedDevices.length || staleDevices.length
      ? "Abrir Configuración y ejecutar las pruebas de celular, lector e impresora." : "");

  const continuity = await pool.query(`SELECT
      COUNT(*) FILTER (WHERE status<>'RESOLVED' AND severity IN ('SEV1','SEV2'))::int AS critical,
      COUNT(*) FILTER (WHERE status<>'RESOLVED')::int AS open
    FROM logistics_operational_incidents WHERE organization_id=$1`, [logisticsOrganizationId]);
  const lastHealth = (await pool.query(`SELECT overall_status,checked_at
    FROM logistics_health_runs WHERE organization_id=$1
    ORDER BY checked_at DESC LIMIT 1`, [logisticsOrganizationId])).rows[0];
  const healthAge = lastHealth
    ? (Date.now() - new Date(lastHealth.checked_at).getTime()) / 60_000 : Infinity;
  const continuityFailed = Number(continuity.rows[0]?.critical || 0) > 0 ||
    lastHealth?.overall_status === "DOWN";
  add("continuity", "Continuidad operacional", continuityFailed ? "FAIL"
    : healthAge > 15 || !lastHealth ? "WARN" : "PASS",
  continuityFailed ? `${Number(continuity.rows[0]?.critical || 0)} incidente(s) crítico(s) abierto(s).`
    : !lastHealth ? "Sin diagnóstico persistente."
      : `${Number(continuity.rows[0]?.open || 0)} incidente(s) abierto(s); último control hace ${Math.floor(healthAge)} minuto(s).`,
  continuityFailed || healthAge > 15 || !lastHealth
    ? "Abrir Configuración y revisar Continuidad operacional." : "");

  const runtimeRelease = runtimeReleaseMetadata(latestMigration);
  const release = (await pool.query(`SELECT status,validated_at,approved_at,commit_sha
    FROM logistics_release_records WHERE organization_id=$1 AND release_key=$2`,
  [logisticsOrganizationId, runtimeRelease.releaseKey])).rows[0];
  add("release", "Versión publicada", release?.status === "APPROVED" ? "PASS"
    : release?.status === "FAILED" || release?.status === "ROLLED_BACK" ? "FAIL" : "WARN",
  !release ? "La versión activa aún no está registrada."
    : `${String(release.commit_sha || "").slice(0, 10)} · ${release.status}.`,
  release?.status === "APPROVED" ? ""
    : "Abrir Configuración, validar la versión y aprobarla después de las pruebas.");

  const cutover = await getCutoverStatus(pool, logisticsOrganizationId);
  const canonicalPrimary = cutover.control?.mode === "CANONICAL_PRIMARY";
  add("cutover", "Fuente oficial de inventario", canonicalPrimary ? "PASS" : "WARN",
    canonicalPrimary ? "El libro mayor canónico es la fuente oficial."
      : `${Number(cutover.control?.consecutive_clean_reconciliations || 0)} de ${Number(cutover.control?.required_clean_reconciliations || 3)} verificaciones limpias.`,
    canonicalPrimary ? "" : "Completar las verificaciones desde Configuración antes de activar el corte.");

  const overall = checks.some(check => check.status === "FAIL") ? "NOT_READY"
    : checks.some(check => check.status === "WARN") ? "DEGRADED" : "READY";
  return {
    overall,
    checkedAt: new Date().toISOString(),
    summary: {
      passed: checks.filter(check => check.status === "PASS").length,
      warnings: checks.filter(check => check.status === "WARN").length,
      failed: checks.filter(check => check.status === "FAIL").length
    },
    checks
  };
}

function sameCenter(left, right) {
  return Boolean(String(left || "").trim())
    && String(left || "").trim().toLocaleLowerCase("es")
      === String(right || "").trim().toLocaleLowerCase("es");
}

function filePayload(row) {
  if (row?.payload && typeof row.payload === "object") return row.payload;
  try {
    return JSON.parse(row?.payload || "{}");
  } catch {
    return {};
  }
}

async function profileMayAccessDocumentEntity(profile, entityType, entityId, declaredCenter = "") {
  if (!profile || !entityId) return false;
  if (profile.admin) return true;
  if (declaredCenter && !sameCenter(declaredCenter, profile.cost_center)) return false;
  const type = String(entityType || "").trim().toLowerCase();
  if (type === "inspection_run") {
    const result = await pool.query(`SELECT 1 FROM logistics_inspection_runs inspection
      JOIN logistics_warehouses warehouse ON warehouse.id=inspection.warehouse_id
      JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
      WHERE inspection.id=$1 AND center.name=$2`, [entityId, profile.cost_center]);
    return Boolean(result.rowCount);
  }
  if (type === "custody_assignment") {
    const result = await pool.query(`SELECT 1 FROM logistics_custody_assignments custody
      JOIN logistics_warehouses warehouse ON warehouse.id=custody.warehouse_id
      JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
      WHERE custody.id=$1 AND center.name=$2`, [entityId, profile.cost_center]);
    return Boolean(result.rowCount);
  }
  if (type === "asset_compliance") {
    const result = await pool.query(`SELECT 1
      FROM logistics_asset_compliance_records compliance
      JOIN logistics_asset_units unit ON unit.id=compliance.asset_unit_id
      JOIN logistics_stock_balances balance ON balance.asset_unit_id=unit.id AND balance.quantity>0
      JOIN logistics_locations location ON location.id=balance.location_id
      JOIN logistics_warehouses warehouse ON warehouse.id=location.warehouse_id
      JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
      WHERE compliance.id=$1 AND center.name=$2 LIMIT 1`, [entityId, profile.cost_center]);
    return Boolean(result.rowCount);
  }
  if (type === "worker") {
    const result = await pool.query(`SELECT 1 FROM inventory_worker_enrollments
      WHERE (id=$1 OR LOWER(name)=LOWER($1)) AND cost_center=$2`, [entityId, profile.cost_center]);
    return Boolean(result.rowCount) || sameCenter(declaredCenter, profile.cost_center);
  }
  return sameCenter(declaredCenter, profile.cost_center);
}

async function profileMayAccessFile(profile, row) {
  if (!profile || !row) return false;
  if (profile.admin) return true;
  const payload = filePayload(row);
  if (payload.center) return sameCenter(payload.center, profile.cost_center);
  const links = await pool.query(`SELECT link.entity_type,link.entity_id
    FROM logistics_documents document
    JOIN logistics_document_links link ON link.document_id=document.id
    WHERE document.file_object_id=$1`, [row.id]);
  for (const link of links.rows) {
    if (await profileMayAccessDocumentEntity(profile, link.entity_type, link.entity_id)) return true;
  }
  return !links.rowCount && sameCenter(payload.uploadedBy, profile.name);
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

async function syncNormalizedTables(client, state, savedBy = "Sistema", stateRevision = null) {
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
  const snapshot = asJson(state);
  await client.query(`INSERT INTO inventory_state_versions
    (saved_by, asset_count, movement_count, document_count, payload, state_revision, checksum)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,encode(digest(($5::jsonb)::text,'sha256'),'hex'))`,
    [savedBy || "Sistema", (state.assets || []).length, (state.movements || []).length,
      (state.documents || []).length, snapshot, stateRevision]);
  await client.query(`DELETE FROM inventory_state_versions WHERE id IN (
    SELECT id FROM inventory_state_versions
    WHERE state_revision IS NOT NULL
    ORDER BY saved_at DESC, id DESC OFFSET 30
  )`);
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

  const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5",
      input: [{ role: "user", content }]
    })
  }, { service: "OpenAI", timeoutMs: process.env.OPENAI_TIMEOUT_MS || 90_000 });
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
    await registerCurrentRelease();
  } catch (error) {
    console.error("Base de datos no disponible al iniciar; la app seguirá funcionando en modo temporal.", error.message);
  }
  finally {
    client.release();
  }
}

async function readinessSnapshot() {
  const checks = {
    database: { ok: false, detail: pool ? "Comprobando" : "DATABASE_URL no configurada" },
    logistics: { ok: Boolean(logisticsReady), detail: logisticsReady ? "Migraciones y modelo preparados" : "Modelo logístico no preparado" },
    authentication: { ok: authConfigured(), detail: authConfigured() ? "Supabase Auth configurado" : "Configuración de Auth incompleta" },
    fileStorage: { ok: storageConfigured(), detail: storageConfigured() ? "Storage configurado" : "Configuración de Storage incompleta" }
  };
  if (pool) {
    try {
      await pool.query({ text: "SELECT 1 AS ready", query_timeout: 3000 });
      checks.database = {
        ok: true,
        detail: "PostgreSQL responde",
        connections: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, maximum: databasePoolMax }
      };
    } catch {
      checks.database = { ok: false, detail: "PostgreSQL no responde dentro del plazo" };
    }
  }
  const ready = checks.database.ok && checks.logistics.ok;
  return { ready, checks };
}

async function handleHttpRequest(req, res, requestId) {
  applyBrowserSecurityHeaders(res);
  res.setHeader("X-Request-Id", requestId);
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/") && !requestOriginAllowed(req)) {
    return json(res, 403, {
      code: "SOLICITUD_ORIGEN_INVALIDO",
      error: "La solicitud fue bloqueada porque no proviene de la aplicación oficial.",
      requestId
    });
  }

  if (url.pathname === "/api/public/acceptance") {
    const rate = consumeRequestRate(req, "public-acceptance", 10, 15 * 60 * 1000);
    setRateLimitHeaders(res, rate);
    if (!rate.allowed) return json(res, 429, {
      error: "Demasiados intentos de consulta o aceptación. Espera unos minutos y vuelve a intentar.",
      requestId
    });
  } else if (url.pathname.startsWith("/api/") && isMutationMethod(req.method) && url.pathname !== "/api/auth/bootstrap") {
    const rate = consumeRequestRate(req, "api-mutation", 180, 60 * 1000);
    setRateLimitHeaders(res, rate);
    if (!rate.allowed) return json(res, 429, {
      error: "Se realizaron demasiadas operaciones en poco tiempo. Espera un minuto y vuelve a intentar.",
      requestId
    });
  }

  if (url.pathname === "/api/health/live") {
    return json(res, 200, {
      ok: true,
      service: "inventario-icc",
      status: "alive",
      uptimeSeconds: Math.floor(process.uptime())
    });
  }

  if (url.pathname === "/api/health/ready") {
    const readiness = await readinessSnapshot();
    return json(res, readiness.ready ? 200 : 503, {
      ok: readiness.ready,
      service: "inventario-icc",
      status: readiness.ready ? "ready" : "not_ready",
      ...readiness
    });
  }

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
      supabaseUrlConfigured: Boolean(supabaseBaseUrl()),
      serviceRoleConfigured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      publishableKeyConfigured: Boolean(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY),
      bootstrapTokenConfigured: Boolean(process.env.AUTH_BOOTSTRAP_TOKEN),
      appBaseUrlConfigured: Boolean(process.env.APP_BASE_URL),
      authIdleMinutes: Math.min(480, Math.max(10, Number(process.env.AUTH_IDLE_MINUTES || 30) || 30)),
      criticalReauthMinutes: criticalReauthMinutes(),
      migrationComplete: Boolean(settings.migration_complete),
      bootstrapUsed: Boolean(settings.bootstrap_used),
      appBaseUrl: process.env.APP_BASE_URL || "https://inventario-icc1.onrender.com",
      initialAdmin
    });
  }

  if (url.pathname === "/api/auth/bootstrap" && req.method === "POST") {
    if (!authConfigured()) return json(res, 503, { error: "Supabase Auth aún no está configurado en Render." });
    if (!process.env.AUTH_BOOTSTRAP_TOKEN) return json(res, 503, { error: "AUTH_BOOTSTRAP_TOKEN no está configurado en Render." });
    const attempt = consumeBootstrapAttempt(req);
    if (!attempt.allowed) {
      res.setHeader("Retry-After", String(attempt.retryAfterSeconds));
      await recordBootstrapSecurityEvent("BOOTSTRAP_RATE_LIMITED", req);
      return json(res, 429, { error: "Demasiados intentos de activación. Espera 15 minutos antes de volver a intentarlo." });
    }
    try {
      const settings = await authSettings();
      if (settings.migration_complete) {
        await recordBootstrapSecurityEvent("BOOTSTRAP_REJECTED_ALREADY_ACTIVE", req);
        return json(res, 409, { error: "La activación inicial ya fue completada. Ingresa con tu correo y contraseña." });
      }
      const body = await readJson(req);
      if (!safeTokenEqual(body.token, process.env.AUTH_BOOTSTRAP_TOKEN)) {
        await recordBootstrapSecurityEvent("BOOTSTRAP_TOKEN_REJECTED", req);
        return json(res, 403, { error: "Código de activación incorrecto." });
      }
      const result = await pool.query("SELECT * FROM inventory_user_profiles WHERE id=$1", [initialAdmin.legacyUserId]);
      const profile = result.rows[0];
      if (!profile) return json(res, 500, { error: "No se pudo preparar el perfil de Julio Febre." });
      await inviteProfile(profile, initialAdmin.email);
      await pool.query("UPDATE inventory_auth_settings SET bootstrap_used=TRUE, updated_at=NOW() WHERE id=1");
      await recordBootstrapSecurityEvent("BOOTSTRAP_INVITATION_SENT", req, { email: initialAdmin.email });
      return json(res, 200, { ok: true, message: `Invitación enviada a ${initialAdmin.email}.` });
    } catch (error) {
      await recordBootstrapSecurityEvent("BOOTSTRAP_INVITATION_FAILED", req, { code: error.code || "ERROR" });
      return json(res, error.status === 429 ? 429 : 400, { error: error.message || "No se pudo enviar la invitación inicial." });
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
      const result = await client.query("SELECT payload,revision FROM inventory_app_state WHERE id=1 FOR UPDATE");
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
      const updatedState = await client.query(`UPDATE inventory_app_state
        SET payload=$1::jsonb,revision=revision+1,updated_at=NOW()
        WHERE id=1 RETURNING revision`, [asJson(current)]);
      await syncNormalizedTables(client, current, assignment.acceptedBy, updatedState.rows[0]?.revision);
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

  if (apiProfile && requiresRecentAuthentication(url.pathname, req.method) && !hasRecentAuthentication(apiProfile)) {
    return json(res, 403, {
      code: "REAUTH_REQUIRED",
      error: "Esta acción sensible requiere volver a ingresar con tu correo y contraseña."
    });
  }

  if (url.pathname === "/api/admin/security" && req.method === "GET") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede revisar accesos." });
    }
    try {
      return json(res, 200, await securityGovernanceOverview());
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo revisar la seguridad." });
    }
  }

  if (url.pathname === "/api/admin/security/review" && req.method === "POST") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede revisar accesos." });
    }
    try {
      return json(res, 200, await completeAccessReview(apiProfile.id));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo cerrar la revisión de accesos." });
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
      const role = normalizedRole(body.role || "Usuario");
      const admin = role === "Administrador central";
      await pool.query(`INSERT INTO inventory_user_profiles
        (id, legacy_user_id, name, email, initials, role, cost_center, admin, permissions, active, invitation_status, updated_at)
        VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8::jsonb,TRUE,'Pendiente invitación',NOW())
        ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email, initials=EXCLUDED.initials,
        role=EXCLUDED.role, cost_center=EXCLUDED.cost_center, admin=EXCLUDED.admin, permissions=EXCLUDED.permissions,
        active=TRUE,security_version=inventory_user_profiles.security_version+1,
        last_security_change_at=NOW(),updated_at=NOW()`,
        [id, body.name || email, email, body.initials || "", role, body.costCenter || "Bodega Central", admin, asJson(defaultPermissions(role, admin))]);
      const profileResult = await pool.query("SELECT * FROM inventory_user_profiles WHERE id=$1", [id]);
      await inviteProfile(profileResult.rows[0], email);
      await pool.query(`INSERT INTO inventory_security_events
        (event_type,actor_profile_id,target_profile_id,after_data)
        VALUES ('ACCESS_PROFILE_INVITED',$1,$2,$3::jsonb)`,
      [apiProfile.id, id, asJson(profileResult.rows[0])]);
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
      const role = normalizedRole(body.role || current.rows[0].role);
      const admin = role === "Administrador central";
      const active = body.active !== false;
      const email = String(body.email ?? current.rows[0].email ?? "").trim().toLowerCase();
      if (current.rows[0].admin && (!admin || !active)) {
        const otherAdmins = await pool.query(`SELECT COUNT(*)::int AS count
          FROM inventory_user_profiles
          WHERE admin=TRUE AND active=TRUE AND id<>$1`, [id]);
        if (Number(otherAdmins.rows[0]?.count || 0) === 0) {
          throw new Error("Debe permanecer al menos un administrador central activo.");
        }
      }
      const updated = await pool.query(`UPDATE inventory_user_profiles SET name=$1, email=$2,
        initials=$3,role=$4,cost_center=$5,admin=$6,permissions=$7::jsonb,active=$8,
        invitation_status=CASE WHEN $8 THEN invitation_status ELSE 'Deshabilitado' END,
        security_version=security_version+1,last_security_change_at=NOW(),updated_at=NOW()
        WHERE id=$9 RETURNING *`,
        [body.name || current.rows[0].name, email, body.initials ?? current.rows[0].initials,
          role, body.costCenter || current.rows[0].cost_center, admin,
          asJson(defaultPermissions(role, admin)), active, id]);
      await pool.query(`INSERT INTO inventory_security_events
        (event_type,actor_profile_id,target_profile_id,before_data,after_data,metadata)
        VALUES ('ACCESS_PROFILE_CHANGED',$1,$2,$3::jsonb,$4::jsonb,$5::jsonb)`,
      [apiProfile.id, id, asJson(current.rows[0]), asJson(updated.rows[0]),
        asJson({ roleChanged: role !== current.rows[0].role,
          activeChanged: active !== current.rows[0].active })]);
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
    const taskType = await pool.query(`SELECT task_type FROM inventory_tasks
      WHERE id=$1 AND ($2::boolean OR assignee_auth_user_id=$3 OR center_name=$4)`,
    [id, Boolean(apiProfile.admin), apiProfile.auth_user_id, apiProfile.cost_center]);
    if (!taskType.rows[0]) return json(res, 404, { error: "Tarea no encontrada o sin permiso." });
    if (taskType.rows[0].task_type === "CYCLE_COUNT_REVIEW" && body.status === "Resuelta") {
      return json(res, 400, {
        error: "La tarea se resolverá automáticamente al contabilizar el conteo físico."
      });
    }
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
      const panelWarnings = [];
      const panelQuery = async (module, operation, fallback) => {
        try {
          return await operation();
        } catch (error) {
          panelWarnings.push({
            module,
            error: error.message || "No fue posible consultar este módulo."
          });
          return fallback;
        }
      };
      const [schema, items, warehouses, stock, transfers, custody, cycleCounts, suppliers, supplierCatalog, inboundReceipts,
        replenishmentSuggestions, purchaseRequisitions, materialRequests, maintenance, inventoryAnalytics, inventoryAccuracy, catalogQuality, inventoryClassifications, inventoryControl, procurement, assetDisposals, assetFinancials, assetCompliance, logisticsKpis, logisticsJobs, outboxHealth,
        warehouseDirectory, workers, reconciliation, cutover] = await Promise.all([
        logisticsHealth(pool),
        listCanonicalItems(pool, dashboardProfile, { search: "" }),
        listWarehouses(pool, dashboardProfile),
        stockSnapshot(pool, dashboardProfile, { itemId: "" }),
        listTransfers(pool, dashboardProfile),
        panelQuery("Custodias", () => listCustodyAssignments(pool, dashboardProfile, { status: "active" }), []),
        panelQuery("Conteos cíclicos", () => listCycleCounts(pool, dashboardProfile), []),
        panelQuery("Proveedores", () => listSuppliers(pool, logisticsOrganizationId), []),
        panelQuery("Catálogo de proveedores", () => listSupplierItemCatalog(pool, logisticsOrganizationId), []),
        panelQuery("Recepciones", () => listInboundReceipts(pool, dashboardProfile), []),
        panelQuery("Reposición", () => listReplenishmentSuggestions(pool, dashboardProfile, logisticsOrganizationId), []),
        panelQuery("Solicitudes de compra", () => listPurchaseRequisitions(pool, dashboardProfile), []),
        panelQuery("Solicitudes de materiales", () => listMaterialRequests(pool, dashboardProfile), []),
        panelQuery("Mantenimiento", () => listMaintenance(pool, dashboardProfile), { plans: [], workOrders: [] }),
        panelQuery("Analítica de inventario", () => listInventoryAnalytics(pool, dashboardProfile, logisticsOrganizationId), { rows: [], summary: {} }),
        panelQuery("Exactitud de inventario", () => listInventoryAccuracy(pool, dashboardProfile, logisticsOrganizationId, 90), { summary: {}, warehouses: [], causes: [], values: [], trend: [], periodDays: 90 }),
        dashboardProfile.admin ? panelQuery("Calidad del catálogo", () => listCatalogDataQuality(pool, logisticsOrganizationId), { rows: [], summary: {}, options: {} })
          : Promise.resolve({ rows: [], summary: {} }),
        panelQuery("Clasificación ABC/XYZ", () => listInventoryClassifications(pool, logisticsOrganizationId), { rows: [], policies: [], summary: {} }),
        panelQuery("Control de inventario", () => listInventoryControls(pool, dashboardProfile, logisticsOrganizationId), { periods: [], adjustments: [] }),
        panelQuery("Compras", () => listProcurement(pool, dashboardProfile, logisticsOrganizationId), { settings: null, purchaseOrders: [], supplierInvoices: [], supplierPerformance: [] }),
        panelQuery("Bajas de activos", () => listAssetDisposals(pool, dashboardProfile, logisticsOrganizationId), []),
        panelQuery("Registro financiero", () => listAssetFinancials(pool, dashboardProfile, logisticsOrganizationId), { rows: [], totals: {} }),
        panelQuery("Cumplimiento de activos", () => listAssetCompliance(pool, dashboardProfile, logisticsOrganizationId), { rows: [], summary: {} }),
        panelQuery("Indicadores logísticos", () => listLogisticsKpis(pool, dashboardProfile, logisticsOrganizationId, 90), { summary: {}, warehouses: [], snapshots: [], periodDays: 90 }),
        dashboardProfile.admin ? panelQuery("Trabajos programados", () => listScheduledLogisticsJobs(pool, logisticsOrganizationId), []) : Promise.resolve([]),
        dashboardProfile.admin ? panelQuery("Cola de eventos", () => listOutboxHealth(pool, logisticsOrganizationId), null) : Promise.resolve(null),
        panelQuery("Directorio de bodegas", () => pool.query(`SELECT warehouse.id,warehouse.name,center.name AS cost_center
          FROM logistics_warehouses warehouse
          LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
          WHERE warehouse.organization_id=$1 AND warehouse.active=TRUE
          ORDER BY center.name,warehouse.name`, [logisticsOrganizationId]).then(result => result.rows), []),
        panelQuery("Trabajadores", () => pool.query(`SELECT id,name,rut,email,phone,cost_center,status FROM inventory_worker_enrollments
          ${dashboardProfile.admin ? "" : "WHERE cost_center=$1"}
          ORDER BY cost_center,name`, dashboardProfile.admin ? [] : [dashboardProfile.cost_center]).then(result => result.rows), []),
        dashboardProfile.admin ? panelQuery("Conciliación", () => reconcileLegacyState(pool), null) : Promise.resolve(null),
        dashboardProfile.admin ? panelQuery("Corte canónico", () => getCutoverStatus(pool, logisticsOrganizationId), null) : Promise.resolve(null)
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
        cycleCounts,
        suppliers,
        supplierCatalog,
        inboundReceipts,
        replenishmentSuggestions,
        purchaseRequisitions,
        materialRequests,
        maintenance,
        inventoryAnalytics,
        inventoryAccuracy,
        catalogQuality,
        inventoryClassifications,
        inventoryControl,
        procurement,
        assetDisposals,
        assetFinancials,
        assetCompliance,
        logisticsKpis,
        logisticsJobs,
        outboxHealth,
        warehouseDirectory,
        workers,
        reconciliation,
        cutover,
        panelWarnings
      });
    } catch (error) {
      return json(res, 500, { error: error.message || "No se pudo preparar el panel logistico." });
    }
  }

  if (url.pathname === "/api/v1/logistics-kpis" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) {
      return json(res, 403, { error: "Tu perfil no puede consultar indicadores logísticos." });
    }
    try {
      const days = Number(url.searchParams.get("days") || 90);
      return json(res, 200, await listLogisticsKpis(pool, apiProfile, logisticsOrganizationId, days));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudieron calcular los indicadores." });
    }
  }

  if (url.pathname === "/api/v1/inventory-accuracy" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) {
      return json(res, 403, { error: "Tu perfil no puede consultar la exactitud del inventario." });
    }
    try {
      const days = Number(url.searchParams.get("days") || 90);
      return json(res, 200,
        await listInventoryAccuracy(pool, apiProfile, logisticsOrganizationId, days));
    } catch (error) {
      return json(res, 400, {
        error: error.message || "No se pudo calcular la exactitud del inventario."
      });
    }
  }

  if (url.pathname === "/api/v1/catalog-quality" && req.method === "GET") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo administración puede revisar la calidad del catálogo." });
    }
    try {
      return json(res, 200, await listCatalogDataQuality(pool, logisticsOrganizationId));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo consultar la calidad del catálogo." });
    }
  }

  if (url.pathname === "/api/v1/catalog-quality/review" && req.method === "POST") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo administración puede ejecutar esta revisión." });
    }
    try {
      const result = await reviewCatalogDataQuality(pool, logisticsOrganizationId);
      return json(res, 200, {
        ...result,
        catalogQuality: await listCatalogDataQuality(pool, logisticsOrganizationId)
      });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo revisar el catálogo." });
    }
  }

  const catalogRemediationRoute = url.pathname.match(
    /^\/api\/v1\/catalog-quality\/([^/]+)\/remediate$/
  );
  if (catalogRemediationRoute && req.method === "PATCH") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo administración puede corregir datos maestros." });
    }
    try {
      const body = await readJson(req);
      const remediation = await remediateCatalogDataIssue(
        pool,
        catalogRemediationRoute[1],
        { ...body, organizationId: logisticsOrganizationId },
        apiProfile.id
      );
      const review = await reviewCatalogDataQuality(pool, logisticsOrganizationId);
      return json(res, 200, {
        remediation,
        ...review,
        catalogQuality: await listCatalogDataQuality(pool, logisticsOrganizationId)
      });
    } catch (error) {
      const conflict = error.code === "23505";
      return json(res, conflict ? 409 : 400, {
        error: conflict
          ? "El valor ingresado ya está asociado a otro registro."
          : (error.message || "No se pudo aplicar la corrección.")
      });
    }
  }

  const catalogDuplicateReviewRoute = url.pathname.match(
    /^\/api\/v1\/catalog-quality\/([^/]+)\/duplicate-decision$/
  );
  if (catalogDuplicateReviewRoute && req.method === "PATCH") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo administración puede revisar duplicados." });
    }
    try {
      const body = await readJson(req);
      const issue = await reviewCatalogDuplicateDecision(
        pool,
        catalogDuplicateReviewRoute[1],
        { ...body, organizationId: logisticsOrganizationId },
        apiProfile.id
      );
      return json(res, 200, {
        issue,
        catalogQuality: await listCatalogDataQuality(pool, logisticsOrganizationId)
      });
    } catch (error) {
      return json(res, 400, {
        error: error.message || "No se pudo registrar la decisión."
      });
    }
  }

  if (url.pathname === "/api/v1/logistics-kpis/snapshot" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "Sólo administración puede guardar el cierre de indicadores." });
    }
    try {
      const body = await readJson(req);
      return json(res, 201, await snapshotLogisticsKpis(pool, apiProfile,
        logisticsOrganizationId, Number(body.periodDays || 90)));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo guardar el cierre de indicadores." });
    }
  }

  if (url.pathname === "/api/v1/logistics-kpi-targets" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) {
      return json(res, 403, { error: "Tu perfil no puede consultar metas logísticas." });
    }
    try {
      return json(res, 200, { targets: await listKpiTargets(pool, apiProfile, logisticsOrganizationId) });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudieron consultar las metas." });
    }
  }

  if (url.pathname === "/api/v1/logistics-kpi-targets" && req.method === "PATCH") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "Sólo administración puede modificar metas logísticas." });
    }
    try {
      const body = await readJson(req);
      const target = await upsertKpiTarget(pool, {
        ...body, organizationId: logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 200, { target });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo guardar la meta." });
    }
  }

  if (url.pathname === "/api/v1/logistics-jobs" && req.method === "GET") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "SÃ³lo administraciÃ³n puede consultar automatizaciones." });
    }
    try {
      return json(res, 200, {
        jobs: await listScheduledLogisticsJobs(pool, logisticsOrganizationId)
      });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudieron consultar las automatizaciones." });
    }
  }

  if (url.pathname === "/api/v1/logistics-jobs/kpi-daily" && req.method === "PATCH") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "SÃ³lo administraciÃ³n puede modificar automatizaciones." });
    }
    try {
      const body = await readJson(req);
      const job = await updateScheduledLogisticsJob(pool, {
        ...body, organizationId: logisticsOrganizationId, jobCode: "KPI_DAILY_SNAPSHOT"
      }, apiProfile.id);
      return json(res, 200, { job });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo guardar la automatizaciÃ³n." });
    }
  }

  if (url.pathname === "/api/v1/logistics-jobs/run-due" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "SÃ³lo administraciÃ³n puede ejecutar automatizaciones." });
    }
    try {
      return json(res, 200, await sweepScheduledLogisticsJobs());
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo ejecutar la automatizaciÃ³n." });
    }
  }

  if (url.pathname === "/api/v1/logistics-jobs/kpi-daily/run-now" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "SÃ³lo administraciÃ³n puede recuperar automatizaciones." });
    }
    try {
      const scheduled = await pool.query(`UPDATE logistics_scheduled_jobs
        SET enabled=TRUE,next_run_at=NOW(),updated_by=$2,updated_at=NOW()
        WHERE organization_id=$1 AND job_code='KPI_DAILY_SNAPSHOT' RETURNING id`,
      [logisticsOrganizationId, apiProfile.id]);
      if (!scheduled.rowCount) return json(res, 404, { error: "AutomatizaciÃ³n no encontrada." });
      return json(res, 200, await sweepScheduledLogisticsJobs());
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo recuperar la automatizaciÃ³n." });
    }
  }

  if (url.pathname === "/api/v1/outbox/status" && req.method === "GET") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "SÃ³lo administraciÃ³n puede supervisar la cola de eventos." });
    }
    try {
      return json(res, 200, await listOutboxHealth(pool, logisticsOrganizationId));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo consultar la cola de eventos." });
    }
  }

  if (url.pathname === "/api/v1/outbox/process-now" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "SÃ³lo administraciÃ³n puede procesar la cola de eventos." });
    }
    try {
      return json(res, 200, await sweepLogisticsOutbox());
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo procesar la cola de eventos." });
    }
  }

  if (url.pathname.startsWith("/api/v1/outbox/") && url.pathname.endsWith("/retry")
      && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "SÃ³lo administraciÃ³n puede reintentar eventos." });
    }
    try {
      const eventId = decodeURIComponent(url.pathname
        .replace("/api/v1/outbox/", "").replace(/\/retry$/, ""));
      const event = await retryOutboxEvent(pool, logisticsOrganizationId, eventId, apiProfile.id);
      const processing = await sweepLogisticsOutbox();
      return json(res, 200, { event, processing });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo reintentar el evento." });
    }
  }

  if (url.pathname === "/api/v1/inventory-analytics" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) {
      return json(res, 403, { error: "Tu perfil no puede consultar analítica de inventario." });
    }
    try {
      return json(res, 200, await listInventoryAnalytics(pool, apiProfile, logisticsOrganizationId));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo calcular la analítica de inventario." });
    }
  }

  if (url.pathname === "/api/v1/inventory-classifications" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) {
      return json(res, 403, { error: "Tu perfil no puede consultar clasificaciones." });
    }
    try {
      return json(res, 200, await listInventoryClassifications(pool, logisticsOrganizationId));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudieron consultar las clasificaciones." });
    }
  }

  if (url.pathname === "/api/v1/inventory-classifications/calculate" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "Sólo el administrador puede recalcular la clasificación." });
    }
    try {
      const body = await readJson(req);
      const summary = await calculateInventoryClassifications(pool, logisticsOrganizationId,
        body.analysisMonths, apiProfile.id);
      return json(res, 200, { summary });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo calcular la clasificación." });
    }
  }

  if (url.pathname === "/api/v1/inventory-classifications/review-counts" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "SÃ³lo administraciÃ³n puede revisar el programa de conteos." });
    }
    try {
      return json(res, 200, await reviewCycleCountTasks(pool, logisticsOrganizationId));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo revisar el programa de conteos." });
    }
  }

  if (url.pathname === "/api/v1/inventory-classification-policies" && req.method === "PATCH") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "Sólo el administrador puede cambiar las políticas de conteo." });
    }
    try {
      const body = await readJson(req);
      const policy = await updateClassificationPolicy(pool, {
        ...body, organizationId: logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 200, { policy });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo guardar la política de conteo." });
    }
  }

  if (url.pathname === "/api/v1/inventory-controls" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) {
      return json(res, 403, { error: "Tu perfil no puede consultar el control de inventario." });
    }
    try {
      return json(res, 200, await listInventoryControls(pool, apiProfile, logisticsOrganizationId));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo consultar el control de inventario." });
    }
  }

  if (url.pathname === "/api/v1/asset-disposals" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar bajas." });
    try {
      return json(res, 200, { assetDisposals: await listAssetDisposals(pool, apiProfile, logisticsOrganizationId) });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudieron consultar las bajas." });
    }
  }

  if (url.pathname === "/api/v1/asset-financials" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar valores." });
    try {
      return json(res, 200, await listAssetFinancials(pool, apiProfile, logisticsOrganizationId,
        url.searchParams.get("asOfDate")));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo calcular el registro financiero." });
    }
  }

  if (url.pathname === "/api/v1/asset-compliance" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) {
      return json(res, 403, { error: "Tu perfil no puede consultar cumplimiento técnico." });
    }
    try {
      return json(res, 200, await listAssetCompliance(pool, apiProfile, logisticsOrganizationId));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo consultar el cumplimiento técnico." });
    }
  }

  if (url.pathname === "/api/v1/asset-compliance/sweep" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "Sólo el administrador puede ejecutar la revisión general." });
    }
    try {
      return json(res, 200, { ok: true, ...(await sweepAssetComplianceTasks()) });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo revisar los vencimientos." });
    }
  }

  if (url.pathname === "/api/v1/asset-compliance" && req.method === "POST") {
    if (!profileCan(apiProfile, "inspect") && !profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "Tu perfil no puede registrar antecedentes técnicos." });
    }
    try {
      const body = await readJson(req);
      const scope = await pool.query(`SELECT location.warehouse_id
        FROM logistics_stock_balances balance
        JOIN logistics_locations location ON location.id=balance.location_id
        WHERE balance.asset_unit_id=$1 AND balance.quantity>0 LIMIT 1`, [body.assetUnitId]);
      if (!scope.rows[0]) return json(res, 404, { error: "El activo no tiene ubicación disponible." });
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scope.rows[0].warehouse_id))) {
        return json(res, 403, { error: "El activo pertenece a otro centro de costo." });
      }
      const result = await createAssetCompliance(pool, {
        ...body, organizationId: logisticsOrganizationId
      }, apiProfile.id);
      await syncAssetComplianceTask(result.compliance.id);
      return json(res, 201, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo registrar el antecedente técnico." });
    }
  }

  const assetComplianceAction = url.pathname.match(/^\/api\/v1\/asset-compliance\/([^/]+)$/);
  if (assetComplianceAction && req.method === "PATCH") {
    if (!profileCan(apiProfile, "approve") && !profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "Tu perfil no puede revocar antecedentes técnicos." });
    }
    try {
      const body = await readJson(req);
      const scope = await pool.query(`SELECT warehouse.id AS warehouse_id
        FROM logistics_asset_compliance_records compliance
        JOIN logistics_asset_units unit ON unit.id=compliance.asset_unit_id
        LEFT JOIN logistics_stock_balances balance
          ON balance.asset_unit_id=unit.id AND balance.quantity>0
        LEFT JOIN logistics_locations location ON location.id=balance.location_id
        LEFT JOIN logistics_warehouses warehouse ON warehouse.id=location.warehouse_id
        WHERE compliance.id=$1 LIMIT 1`, [assetComplianceAction[1]]);
      if (!scope.rows[0]) return json(res, 404, { error: "Antecedente técnico no encontrado." });
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scope.rows[0].warehouse_id))) {
        return json(res, 403, { error: "El antecedente pertenece a otro centro de costo." });
      }
      const result = await updateAssetCompliance(pool, assetComplianceAction[1],
        body.action, body, apiProfile.id);
      await syncAssetComplianceTask(assetComplianceAction[1]);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar el antecedente técnico." });
    }
  }

  if (url.pathname === "/api/v1/asset-financials" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) return json(res, 403, { error: "Sólo el administrador puede registrar valores." });
    try {
      const body = await readJson(req);
      return json(res, 200, await upsertAssetFinancial(pool, {
        ...body, organizationId: logisticsOrganizationId
      }, apiProfile.id));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo guardar el registro financiero." });
    }
  }

  if (url.pathname === "/api/v1/asset-depreciation-runs" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) return json(res, 403, { error: "Sólo el administrador puede cerrar depreciación." });
    try {
      const body = await readJson(req);
      return json(res, 200, await runAssetDepreciation(pool, logisticsOrganizationId,
        body.asOfDate, apiProfile.id));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo ejecutar la depreciación." });
    }
  }

  if (url.pathname === "/api/v1/asset-disposals" && req.method === "POST") {
    if (!profileCan(apiProfile, "move")) return json(res, 403, { error: "Tu perfil no puede solicitar bajas." });
    try {
      const body = await readJson(req);
      const scope = await pool.query(`SELECT location.warehouse_id
        FROM logistics_stock_balances balance
        JOIN logistics_locations location ON location.id=balance.location_id
        WHERE balance.asset_unit_id=$1 AND balance.quantity>0 LIMIT 1`, [body.assetUnitId]);
      if (!scope.rows[0]) return json(res, 404, { error: "El activo no tiene ubicación disponible." });
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scope.rows[0].warehouse_id))) {
        return json(res, 403, { error: "El activo pertenece a otro centro de costo." });
      }
      const result = await createAssetDisposal(pool, {
        ...body, organizationId: logisticsOrganizationId
      }, apiProfile.id);
      await syncAssetDisposalTask(result.disposal.id);
      return json(res, 201, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo solicitar la baja." });
    }
  }

  const assetDisposalAction = url.pathname.match(/^\/api\/v1\/asset-disposals\/([^/]+)$/);
  if (assetDisposalAction && req.method === "PATCH") {
    try {
      const body = await readJson(req);
      const action = String(body.action || "").toUpperCase();
      const permission = ["APPROVE", "REJECT", "POST"].includes(action) ? "approve" : "move";
      if (!profileCan(apiProfile, permission)) return json(res, 403, { error: "Tu perfil no puede completar esta etapa." });
      const scope = await pool.query("SELECT warehouse_id FROM logistics_asset_disposals WHERE id=$1",
        [assetDisposalAction[1]]);
      if (!scope.rows[0]) return json(res, 404, { error: "Solicitud de baja no encontrada." });
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scope.rows[0].warehouse_id))) {
        return json(res, 403, { error: "La baja pertenece a otro centro de costo." });
      }
      const result = await updateAssetDisposal(pool, assetDisposalAction[1], action, {
        ...body, allowSelfApproval: Boolean(apiProfile.admin), admin: Boolean(apiProfile.admin)
      }, apiProfile.id);
      await syncAssetDisposalTask(assetDisposalAction[1]);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar la baja." });
    }
  }

  if (url.pathname === "/api/v1/inventory-periods" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "Sólo el administrador puede abrir períodos." });
    }
    try {
      const body = await readJson(req);
      const period = await createInventoryPeriod(pool, {
        ...body, organizationId: logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 201, { period });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo abrir el período." });
    }
  }

  const closePeriodRoute = url.pathname.match(/^\/api\/v1\/inventory-periods\/([^/]+)\/close$/);
  if (closePeriodRoute && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "Sólo el administrador puede cerrar períodos." });
    }
    try {
      const body = await readJson(req);
      return json(res, 200, await closeInventoryPeriod(pool, closePeriodRoute[1], body, apiProfile.id));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo cerrar el período." });
    }
  }

  if (url.pathname === "/api/v1/inventory-adjustments" && req.method === "POST") {
    if (!profileCan(apiProfile, "move")) {
      return json(res, 403, { error: "Tu perfil no puede solicitar ajustes." });
    }
    try {
      const body = await readJson(req);
      if (!apiProfile.admin && !(await profileMayAccessLocation(apiProfile, body.locationId))) {
        return json(res, 403, { error: "Sólo puedes ajustar una ubicación de tu centro." });
      }
      const adjustment = await createInventoryAdjustment(pool, {
        ...body, organizationId: logisticsOrganizationId
      }, apiProfile.id);
      await syncInventoryAdjustmentTask(adjustment.id);
      return json(res, 201, { adjustment });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo solicitar el ajuste." });
    }
  }

  const adjustmentRoute = url.pathname.match(/^\/api\/v1\/inventory-adjustments\/([^/]+)$/);
  if (adjustmentRoute && req.method === "PATCH") {
    try {
      const body = await readJson(req);
      const action = String(body.action || "").toUpperCase();
      const permission = ["APPROVE", "REJECT", "POST"].includes(action) ? "approve" : "move";
      if (!profileCan(apiProfile, permission)) {
        return json(res, 403, { error: "Tu perfil no puede resolver este ajuste." });
      }
      const scope = await pool.query(`SELECT warehouse_id FROM logistics_inventory_adjustments
        WHERE id=$1`, [adjustmentRoute[1]]);
      if (!scope.rows[0]) return json(res, 404, { error: "Solicitud de ajuste inexistente." });
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scope.rows[0].warehouse_id))) {
        return json(res, 403, { error: "El ajuste pertenece a otro centro." });
      }
      const result = await updateInventoryAdjustment(pool, adjustmentRoute[1], action, body, apiProfile.id);
      await syncInventoryAdjustmentTask(adjustmentRoute[1]);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar el ajuste." });
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

  if (url.pathname === "/api/v1/devices/readiness" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) {
      return json(res, 403, { error: "Tu perfil no puede consultar dispositivos." });
    }
    try {
      return json(res, 200, await deviceReadinessOverview(apiProfile));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo consultar el diagnóstico." });
    }
  }

  if (url.pathname === "/api/v1/devices" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "Sólo administración puede configurar dispositivos." });
    }
    try {
      const body = await readJson(req);
      return json(res, 200, { profile: await upsertDeviceProfile(apiProfile, body) });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo guardar el dispositivo." });
    }
  }

  if (url.pathname === "/api/v1/devices/checks" && req.method === "POST") {
    if (!profileCan(apiProfile, "view")) {
      return json(res, 403, { error: "Tu perfil no puede registrar pruebas." });
    }
    try {
      const body = await readJson(req);
      return json(res, 200, { check: await recordDeviceCheck(apiProfile, body) });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo registrar la prueba." });
    }
  }

  if (url.pathname === "/api/v1/operations/continuity" && req.method === "GET") {
    if (!profileCan(apiProfile, "audit")) {
      return json(res, 403, { error: "Tu perfil no puede consultar continuidad operacional." });
    }
    try {
      return json(res, 200, await operationalContinuityOverview(apiProfile));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo consultar continuidad." });
    }
  }

  if (url.pathname === "/api/v1/operations/health-check" && req.method === "POST") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo administración puede ejecutar el diagnóstico." });
    }
    try {
      return json(res, 200, { healthRun: await captureOperationalHealth("MANUAL", apiProfile.id) });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo registrar el diagnóstico." });
    }
  }

  if (url.pathname === "/api/v1/operations/incidents" && req.method === "POST") {
    if (!profileCan(apiProfile, "audit")) {
      return json(res, 403, { error: "Tu perfil no puede reportar incidentes." });
    }
    try {
      const body = await readJson(req);
      return json(res, 200, { incident: await openOperationalIncident(apiProfile, body) });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo reportar el incidente." });
    }
  }

  const operationalIncidentRoute = url.pathname.match(/^\/api\/v1\/operations\/incidents\/([^/]+)$/);
  if (operationalIncidentRoute && req.method === "PATCH") {
    if (!profileCan(apiProfile, "audit")) {
      return json(res, 403, { error: "Tu perfil no puede gestionar incidentes." });
    }
    try {
      const body = await readJson(req);
      return json(res, 200, {
        incident: await updateOperationalIncident(apiProfile, operationalIncidentRoute[1], body)
      });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar el incidente." });
    }
  }

  if (url.pathname === "/api/v1/releases" && req.method === "GET") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo administración puede consultar versiones." });
    }
    try {
      return json(res, 200, await releasesOverview());
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudieron consultar las versiones." });
    }
  }

  const releaseRoute = url.pathname.match(/^\/api\/v1\/releases\/([^/]+)$/);
  if (releaseRoute && req.method === "POST") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo administración puede validar versiones." });
    }
    try {
      return json(res, 200, await validateRelease(releaseRoute[1], apiProfile.id));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo validar la versión." });
    }
  }

  if (releaseRoute && req.method === "PATCH") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo administración puede aprobar o revertir versiones." });
    }
    try {
      const body = await readJson(req);
      return json(res, 200, {
        release: await changeReleaseStatus(releaseRoute[1], body.action,
          apiProfile.id, body.reason)
      });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar la versión." });
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

  if (url.pathname === "/api/v1/cutover" && req.method === "GET") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede gestionar el corte de datos." });
    }
    try {
      return json(res, 200, await getCutoverStatus(pool, logisticsOrganizationId));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo revisar el corte de datos." });
    }
  }

  if (url.pathname === "/api/v1/cutover/assess" && req.method === "POST") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede gestionar el corte de datos." });
    }
    try {
      return json(res, 200, await assessCutoverReadiness(pool,
        logisticsOrganizationId, apiProfile.id));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo verificar el corte de datos." });
    }
  }

  if (url.pathname === "/api/v1/cutover" && req.method === "PATCH") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede gestionar el corte de datos." });
    }
    try {
      const body = await readJson(req);
      return json(res, 200, await updateCutoverMode(pool, logisticsOrganizationId,
        body.mode, apiProfile.id, body.reason));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo cambiar la fuente oficial." });
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

  const itemIdentifierRoute = url.pathname.match(/^\/api\/v1\/item-identifiers\/([^/]+)$/);
  if (itemIdentifierRoute && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar artículos." });
    try {
      const item = await resolveItemIdentifier(pool, logisticsOrganizationId,
        decodeURIComponent(itemIdentifierRoute[1]));
      return json(res, 200, { item });
    } catch (error) {
      return json(res, 404, { error: error.message || "Código no reconocido." });
    }
  }

  if (url.pathname === "/api/v1/item-presentations" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "Sólo el administrador puede configurar unidades y presentaciones." });
    }
    try {
      const body = await readJson(req);
      const result = await upsertItemPresentation(pool, {
        ...body,
        organizationId: logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 200, result);
    } catch (error) {
      const conflict = error.code === "23505";
      return json(res, conflict ? 409 : 400, {
        error: conflict ? "El código de barras ya está asignado a otro artículo." :
          (error.message || "No se pudo guardar la presentación.")
      });
    }
  }

  const itemCostRoute = url.pathname.match(/^\/api\/v1\/items\/([^/]+)\/cost$/);
  if (itemCostRoute && req.method === "PATCH") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "Sólo el administrador puede modificar costos." });
    }
    try {
      const body = await readJson(req);
      const item = await updateItemCost(pool, itemCostRoute[1], {
        ...body,
        organizationId: logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 200, { item });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar el costo." });
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
        organizationId: body.organizationId || logisticsOrganizationId,
        canOverrideDuplicate: Boolean(apiProfile.admin)
      }, apiProfile.id);
      return json(res, 201, result);
    } catch (error) {
      const conflict = error.code === "23505";
      const possibleDuplicate = error.code === "POSSIBLE_DUPLICATE";
      return json(res, conflict || possibleDuplicate ? 409 : 400, {
        error: conflict ? "El código o número de serie ya existe."
          : (error.message || "No se pudo registrar el artículo."),
        code: possibleDuplicate ? "POSSIBLE_DUPLICATE" : undefined,
        candidates: possibleDuplicate ? error.candidates : undefined
      });
    }
  }

  if (url.pathname === "/api/v1/lots/receive" && req.method === "POST") {
    if (!profileCan(apiProfile, "move")) return json(res, 403, { error: "Tu perfil no puede ingresar lotes." });
    try {
      const body = await readJson(req);
      if (!body.toLocationId) return json(res, 400, { error: "Selecciona la bodega de recepción." });
      if (!apiProfile.admin && !(await profileMayAccessLocation(apiProfile, body.toLocationId))) {
        return json(res, 403, { error: "Sólo puedes ingresar lotes en una bodega de tu centro." });
      }
      const result = await receiveLot(pool, {
        ...body,
        organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, result.replayed ? 200 : 201, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo registrar el lote." });
    }
  }

  if (url.pathname === "/api/v1/suppliers" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar proveedores." });
    try {
      return json(res, 200, { suppliers: await listSuppliers(pool, logisticsOrganizationId) });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudieron consultar los proveedores." });
    }
  }

  if (url.pathname === "/api/v1/suppliers" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) return json(res, 403, { error: "Sólo el administrador puede crear proveedores." });
    try {
      const body = await readJson(req);
      const supplier = await registerSupplier(pool, {
        ...body,
        organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 201, { supplier });
    } catch (error) {
      const conflict = error.code === "23505";
      return json(res, conflict ? 409 : 400, {
        error: conflict ? "El código o RUT del proveedor ya está registrado." : (error.message || "No se pudo registrar el proveedor.")
      });
    }
  }

  if (url.pathname === "/api/v1/supplier-items" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar el catálogo de proveedores." });
    try {
      return json(res, 200, {
        supplierCatalog: await listSupplierItemCatalog(pool, logisticsOrganizationId)
      });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo consultar el catálogo de proveedores." });
    }
  }

  if (url.pathname === "/api/v1/supplier-items" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "Sólo el administrador puede configurar el catálogo de proveedores." });
    }
    try {
      const body = await readJson(req);
      const supplierItem = await upsertSupplierItem(pool, {
        ...body,
        organizationId: logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 200, { supplierItem });
    } catch (error) {
      const conflict = error.code === "23505";
      return json(res, conflict ? 409 : 400, {
        error: conflict ? "El código del proveedor o proveedor preferente entra en conflicto con otro registro." :
          (error.message || "No se pudo guardar el producto del proveedor.")
      });
    }
  }

  if (url.pathname === "/api/v1/inbound-receipts" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar recepciones." });
    try {
      return json(res, 200, { inboundReceipts: await listInboundReceipts(pool, apiProfile) });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudieron consultar las recepciones." });
    }
  }

  if (url.pathname === "/api/v1/inbound-receipts" && req.method === "POST") {
    if (!profileCan(apiProfile, "move")) return json(res, 403, { error: "Tu perfil no puede recibir compras." });
    try {
      const body = await readJson(req);
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, body.warehouseId))) {
        return json(res, 403, { error: "Sólo puedes recibir compras en una bodega de tu centro." });
      }
      const result = await createInboundReceipt(pool, {
        ...body,
        allowNoPurchaseOrder: Boolean(apiProfile.admin && body.exceptionalWithoutPurchaseOrder),
        organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, result.replayed ? 200 : 201, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo registrar la recepción." });
    }
  }

  const inboundAction = url.pathname.match(/^\/api\/v1\/inbound-receipts\/([^/]+)$/);
  if (inboundAction && req.method === "PATCH") {
    try {
      const body = await readJson(req);
      const action = String(body.action || "").toUpperCase();
      const permission = action === "REJECT" ? "approve" : "receive";
      if (!profileCan(apiProfile, permission)) {
        return json(res, 403, { error: "Tu perfil no puede resolver esta recepción." });
      }
      const scope = await pool.query("SELECT warehouse_id FROM logistics_inbound_receipts WHERE id=$1", [inboundAction[1]]);
      if (!scope.rows[0]) return json(res, 404, { error: "Recepción no encontrada." });
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scope.rows[0].warehouse_id))) {
        return json(res, 403, { error: "La recepción pertenece a otro centro de costo." });
      }
      const result = await updateInboundReceipt(pool, inboundAction[1], action, body, apiProfile.id);
      if (result.supplierReturn?.id) await syncSupplierReturnTask(result.supplierReturn.id);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar la recepción." });
    }
  }

  const supplierReturnAction = url.pathname.match(/^\/api\/v1\/supplier-returns\/([^/]+)$/);
  if (supplierReturnAction && req.method === "PATCH") {
    if (!profileCan(apiProfile, "approve")) {
      return json(res, 403, { error: "Tu perfil no puede resolver devoluciones a proveedor." });
    }
    try {
      const body = await readJson(req);
      const scope = await pool.query("SELECT warehouse_id FROM logistics_supplier_returns WHERE id=$1",
        [supplierReturnAction[1]]);
      if (!scope.rows[0]) return json(res, 404, { error: "Devolución no encontrada." });
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scope.rows[0].warehouse_id))) {
        return json(res, 403, { error: "La devolución pertenece a otro centro de costo." });
      }
      const result = await updateSupplierReturn(pool, supplierReturnAction[1],
        body.action, body, apiProfile.id);
      await syncSupplierReturnTask(supplierReturnAction[1]);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar la devolución." });
    }
  }

  if (url.pathname === "/api/v1/replenishment" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar reposición." });
    try {
      return json(res, 200, {
        suggestions: await listReplenishmentSuggestions(pool, apiProfile, logisticsOrganizationId)
      });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo calcular la reposición." });
    }
  }

  if (url.pathname === "/api/v1/replenishment/review" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) {
      return json(res, 403, { error: "SÃ³lo administraciÃ³n puede ejecutar la revisiÃ³n general." });
    }
    try {
      const result = await reviewReplenishmentTasks(pool, logisticsOrganizationId);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo revisar el abastecimiento." });
    }
  }

  if (url.pathname === "/api/v1/replenishment/policies" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) return json(res, 403, { error: "Sólo el administrador puede configurar reposición." });
    try {
      const body = await readJson(req);
      const policy = await upsertReplenishmentPolicy(pool, {
        ...body,
        organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 200, { policy });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo guardar la política." });
    }
  }

  if (url.pathname === "/api/v1/purchase-requisitions" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar solicitudes." });
    try {
      return json(res, 200, { purchaseRequisitions: await listPurchaseRequisitions(pool, apiProfile) });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudieron consultar las solicitudes." });
    }
  }

  if (url.pathname === "/api/v1/purchase-requisitions" && req.method === "POST") {
    if (!profileCan(apiProfile, "move")) return json(res, 403, { error: "Tu perfil no puede solicitar compras." });
    try {
      const body = await readJson(req);
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, body.warehouseId))) {
        return json(res, 403, { error: "Sólo puedes solicitar para una bodega de tu centro." });
      }
      const result = await createPurchaseRequisition(pool, {
        ...body,
        organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 201, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo crear la solicitud." });
    }
  }

  const requisitionAction = url.pathname.match(/^\/api\/v1\/purchase-requisitions\/([^/]+)$/);
  if (requisitionAction && req.method === "PATCH") {
    try {
      const body = await readJson(req);
      const action = String(body.action || "").toUpperCase();
      const permission = ["APPROVE", "ORDER"].includes(action) ? "approve" : "move";
      if (!profileCan(apiProfile, permission)) {
        return json(res, 403, { error: "Tu perfil no puede completar esta etapa de compra." });
      }
      const scope = await pool.query("SELECT warehouse_id FROM logistics_purchase_requisitions WHERE id=$1", [requisitionAction[1]]);
      if (!scope.rows[0]) return json(res, 404, { error: "Solicitud no encontrada." });
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scope.rows[0].warehouse_id))) {
        return json(res, 403, { error: "La solicitud pertenece a otro centro de costo." });
      }
      const result = await updatePurchaseRequisition(pool, requisitionAction[1], action, {
        ...body, allowSelfApproval: Boolean(apiProfile.admin)
      }, apiProfile.id);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar la solicitud." });
    }
  }

  if (url.pathname === "/api/v1/procurement" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar compras." });
    try {
      return json(res, 200, await listProcurement(pool, apiProfile, logisticsOrganizationId));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo consultar compras." });
    }
  }

  if (url.pathname === "/api/v1/procurement/settings" && req.method === "PATCH") {
    if (!profileCan(apiProfile, "admin")) return json(res, 403, { error: "Sólo el administrador puede configurar tolerancias." });
    try {
      const body = await readJson(req);
      const settings = await updateProcurementSettings(pool, {
        ...body, organizationId: logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 200, { settings });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudieron guardar las tolerancias." });
    }
  }

  if (url.pathname === "/api/v1/purchase-orders" && req.method === "POST") {
    if (!profileCan(apiProfile, "move")) return json(res, 403, { error: "Tu perfil no puede crear órdenes." });
    try {
      const body = await readJson(req);
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, body.warehouseId))) {
        return json(res, 403, { error: "Sólo puedes crear órdenes para tu centro." });
      }
      const result = await createPurchaseOrder(pool, {
        ...body, organizationId: logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 201, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo crear la orden." });
    }
  }

  const purchaseOrderRoute = url.pathname.match(/^\/api\/v1\/purchase-orders\/([^/]+)$/);
  if (purchaseOrderRoute && req.method === "PATCH") {
    try {
      const body = await readJson(req);
      const action = String(body.action || "").toUpperCase();
      const permission = ["APPROVE", "CLOSE"].includes(action) ? "approve" : "move";
      if (!profileCan(apiProfile, permission)) return json(res, 403, { error: "Tu perfil no puede actualizar la orden." });
      const scope = await pool.query(`SELECT warehouse_id FROM logistics_purchase_orders WHERE id=$1`, [purchaseOrderRoute[1]]);
      if (!scope.rows[0]) return json(res, 404, { error: "Orden inexistente." });
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scope.rows[0].warehouse_id))) {
        return json(res, 403, { error: "La orden pertenece a otro centro." });
      }
      return json(res, 200, await updatePurchaseOrder(pool, purchaseOrderRoute[1], action, body, apiProfile.id));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar la orden." });
    }
  }

  if (url.pathname === "/api/v1/supplier-invoices" && req.method === "POST") {
    if (!profileCan(apiProfile, "receive")) return json(res, 403, { error: "Tu perfil no puede registrar facturas." });
    try {
      const body = await readJson(req);
      const scope = await pool.query(`SELECT warehouse_id FROM logistics_purchase_orders WHERE id=$1`, [body.purchaseOrderId]);
      if (!scope.rows[0]) return json(res, 404, { error: "Orden inexistente." });
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scope.rows[0].warehouse_id))) {
        return json(res, 403, { error: "La orden pertenece a otro centro." });
      }
      const result = await createSupplierInvoice(pool, {
        ...body, organizationId: logisticsOrganizationId
      }, apiProfile.id);
      await syncSupplierInvoiceTask(result.invoice.id);
      return json(res, 201, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo registrar o conciliar la factura." });
    }
  }

  const supplierInvoiceRoute = url.pathname.match(/^\/api\/v1\/supplier-invoices\/([^/]+)$/);
  if (supplierInvoiceRoute && req.method === "PATCH") {
    if (!profileCan(apiProfile, "approve")) return json(res, 403, { error: "Tu perfil no puede aprobar facturas." });
    try {
      const body = await readJson(req);
      const scope = await pool.query(`SELECT purchase_order.warehouse_id
        FROM logistics_supplier_invoices invoice
        JOIN logistics_purchase_orders purchase_order ON purchase_order.id=invoice.purchase_order_id
        WHERE invoice.id=$1`, [supplierInvoiceRoute[1]]);
      if (!scope.rows[0]) return json(res, 404, { error: "Factura inexistente." });
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scope.rows[0].warehouse_id))) {
        return json(res, 403, { error: "La factura pertenece a otro centro." });
      }
      const result = await updateSupplierInvoice(pool, supplierInvoiceRoute[1], body.action, {
        ...body, allowException: Boolean(apiProfile.admin)
      }, apiProfile.id);
      await syncSupplierInvoiceTask(supplierInvoiceRoute[1]);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo resolver la factura." });
    }
  }

  if (url.pathname === "/api/v1/material-requests" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar solicitudes internas." });
    try {
      return json(res, 200, { materialRequests: await listMaterialRequests(pool, apiProfile) });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudieron consultar las solicitudes internas." });
    }
  }

  if (url.pathname === "/api/v1/material-requests" && req.method === "POST") {
    if (!profileCan(apiProfile, "move")) return json(res, 403, { error: "Tu perfil no puede solicitar materiales." });
    try {
      const body = await readJson(req);
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, body.requestingWarehouseId))) {
        return json(res, 403, { error: "Sólo puedes solicitar materiales para una bodega de tu centro." });
      }
      const result = await createMaterialRequest(pool, {
        ...body,
        organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 201, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo crear la solicitud interna." });
    }
  }

  const materialRequestAction = url.pathname.match(/^\/api\/v1\/material-requests\/([^/]+)$/);
  if (materialRequestAction && req.method === "PATCH") {
    try {
      const body = await readJson(req);
      const action = String(body.action || "").toUpperCase();
      const permission = action === "APPROVE" ? "approve" : "move";
      if (!profileCan(apiProfile, permission)) {
        return json(res, 403, { error: "Tu perfil no puede completar esta etapa de la solicitud." });
      }
      const scope = (await pool.query(`SELECT requesting_warehouse_id,fulfillment_warehouse_id
        FROM logistics_material_requests WHERE id=$1`, [materialRequestAction[1]])).rows[0];
      if (!scope) return json(res, 404, { error: "Solicitud interna no encontrada." });
      if (!apiProfile.admin) {
        const operational = ["ALLOCATE", "START_PICK", "ISSUE"].includes(action);
        const warehouseId = operational ? scope.fulfillment_warehouse_id : scope.requesting_warehouse_id;
        if (!(await profileMayAccessWarehouse(apiProfile, warehouseId))) {
          return json(res, 403, {
            error: operational
              ? "La preparación corresponde a otra bodega."
              : "La solicitud pertenece a otro centro de costo."
          });
        }
      }
      const result = await updateMaterialRequest(pool, materialRequestAction[1], action, {
        ...body, allowSelfApproval: Boolean(apiProfile.admin)
      }, apiProfile.id);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar la solicitud interna." });
    }
  }

  const pickTaskAction = url.pathname.match(/^\/api\/v1\/pick-tasks\/([^/]+)$/);
  if (pickTaskAction && req.method === "PATCH") {
    if (!profileCan(apiProfile, "move")) {
      return json(res, 403, { error: "Tu perfil no puede preparar materiales." });
    }
    try {
      const body = await readJson(req);
      const scope = (await pool.query(`SELECT task.warehouse_id
        FROM logistics_pick_tasks task WHERE task.id=$1`, [pickTaskAction[1]])).rows[0];
      if (!scope) return json(res, 404, { error: "Tarea de preparación no encontrada." });
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scope.warehouse_id))) {
        return json(res, 403, { error: "La preparación corresponde a otra bodega." });
      }
      const result = await updatePickTask(pool, pickTaskAction[1], body.action, body, apiProfile.id);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar la tarea de preparación." });
    }
  }

  if (url.pathname === "/api/v1/maintenance" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar mantenimiento." });
    try {
      return json(res, 200, await listMaintenance(pool, apiProfile));
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo consultar mantenimiento." });
    }
  }

  if (url.pathname === "/api/v1/maintenance/plans" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) return json(res, 403, { error: "Sólo el administrador puede configurar planes." });
    try {
      const body = await readJson(req);
      const plan = await createMaintenancePlan(pool, {
        ...body, organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 201, { plan });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo guardar el plan de mantenimiento." });
    }
  }

  if (url.pathname === "/api/v1/maintenance/work-orders" && req.method === "POST") {
    if (!profileCan(apiProfile, "move")) return json(res, 403, { error: "Tu perfil no puede crear órdenes de trabajo." });
    try {
      const body = await readJson(req);
      if (body.warehouseId && !apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, body.warehouseId))) {
        return json(res, 403, { error: "Sólo puedes crear órdenes para tu centro de costo." });
      }
      const result = await createWorkOrder(pool, {
        ...body, organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 201, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo crear la orden de trabajo." });
    }
  }

  const workOrderAction = url.pathname.match(/^\/api\/v1\/maintenance\/work-orders\/([^/]+)$/);
  if (workOrderAction && req.method === "PATCH") {
    try {
      const body = await readJson(req);
      const action = String(body.action || "").toUpperCase();
      const permission = action === "APPROVE" ? "approve" : "move";
      if (!profileCan(apiProfile, permission)) {
        return json(res, 403, { error: "Tu perfil no puede completar esta etapa del mantenimiento." });
      }
      const scope = (await pool.query("SELECT warehouse_id FROM logistics_work_orders WHERE id=$1",
        [workOrderAction[1]])).rows[0];
      if (!scope) return json(res, 404, { error: "Orden de trabajo no encontrada." });
      if (scope.warehouse_id && !apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scope.warehouse_id))) {
        return json(res, 403, { error: "La orden pertenece a otro centro de costo." });
      }
      const result = await updateWorkOrder(pool, workOrderAction[1], action, {
        ...body, allowSelfApproval: Boolean(apiProfile.admin)
      }, apiProfile.id);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar la orden de trabajo." });
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

  if (url.pathname === "/api/v1/putaway-suggestions" && req.method === "GET") {
    if (!profileCan(apiProfile, "receive")) return json(res, 403, { error: "Tu perfil no puede consultar almacenamiento dirigido." });
    try {
      const warehouseId = url.searchParams.get("warehouseId") || "";
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, warehouseId))) {
        return json(res, 403, { error: "La bodega pertenece a otro centro de costo." });
      }
      const suggestions = await suggestPutawayLocations(pool, apiProfile, {
        organizationId: logisticsOrganizationId,
        warehouseId,
        itemId: url.searchParams.get("itemId") || "",
        quantity: url.searchParams.get("quantity") || 1
      });
      return json(res, 200, { suggestions });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo sugerir una ubicación." });
    }
  }

  if (url.pathname === "/api/v1/locations" && req.method === "POST") {
    if (!profileCan(apiProfile, "admin")) return json(res, 403, { error: "Sólo el administrador puede crear ubicaciones." });
    try {
      const body = await readJson(req);
      const location = await registerStorageLocation(pool, {
        ...body, organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 201, { location });
    } catch (error) {
      const conflict = error.code === "23505";
      return json(res, conflict ? 409 : 400, {
        error: conflict ? "El código o QR de ubicación ya existe." : (error.message || "No se pudo crear la ubicación.")
      });
    }
  }

  const locationAction = url.pathname.match(/^\/api\/v1\/locations\/([^/]+)$/);
  if (locationAction && req.method === "PATCH") {
    if (!profileCan(apiProfile, "admin")) return json(res, 403, { error: "Sólo el administrador puede modificar ubicaciones." });
    try {
      const body = await readJson(req);
      const location = await updateStorageLocation(pool, locationAction[1], body, apiProfile.id);
      return json(res, 200, { location });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo modificar la ubicación." });
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

  if (url.pathname === "/api/v1/cycle-counts" && req.method === "GET") {
    if (!profileCan(apiProfile, "view")) return json(res, 403, { error: "Tu perfil no puede consultar conteos." });
    try {
      return json(res, 200, { cycleCounts: await listCycleCounts(pool, apiProfile) });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudieron consultar los conteos." });
    }
  }

  if (url.pathname === "/api/v1/cycle-counts" && req.method === "POST") {
    if (!profileCan(apiProfile, "move")) return json(res, 403, { error: "Tu perfil no puede iniciar conteos." });
    try {
      const body = await readJson(req);
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, body.warehouseId))) {
        return json(res, 403, { error: "Sólo puedes contar una bodega de tu centro." });
      }
      const result = await createCycleCount(pool, {
        ...body,
        organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 201, result);
    } catch (error) {
      const conflict = error.code === "23505";
      return json(res, conflict ? 409 : 400, {
        error: conflict ? "El número de conteo ya existe." : (error.message || "No se pudo iniciar el conteo.")
      });
    }
  }

  const cycleCountAction = url.pathname.match(/^\/api\/v1\/cycle-counts\/([^/]+)$/);
  if (cycleCountAction && req.method === "PATCH") {
    try {
      const body = await readJson(req);
      const action = String(body.action || "").toUpperCase();
      const permission = ["APPROVE", "POST"].includes(action) ? "approve" : "move";
      if (!profileCan(apiProfile, permission)) {
        return json(res, 403, { error: "Tu perfil no puede completar esta etapa del conteo." });
      }
      const scope = await pool.query("SELECT warehouse_id FROM logistics_cycle_counts WHERE id=$1", [cycleCountAction[1]]);
      if (!scope.rows[0]) return json(res, 404, { error: "Conteo no encontrado." });
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scope.rows[0].warehouse_id))) {
        return json(res, 403, { error: "El conteo pertenece a otro centro de costo." });
      }
      const result = await updateCycleCount(pool, cycleCountAction[1], action, {
        ...body,
        allowSelfApproval: Boolean(apiProfile.admin)
      }, apiProfile.id);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar el conteo." });
    }
  }

  if (url.pathname === "/api/v1/stock/movements" && req.method === "POST") {
    if (!profileCan(apiProfile, "move")) return json(res, 403, { error: "Tu perfil no puede mover inventario." });
    try {
      const body = await readJson(req);
      body.idempotencyKey = requireStableOperationKey(body.idempotencyKey);
      if (String(body.movementType || "").toUpperCase() === "ADJUSTMENT") {
        return json(res, 409, { error: "Los ajustes deben solicitarse y aprobarse antes de contabilizarse." });
      }
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
      return json(res, error.status || 400, { code: error.code, error: error.message || "No se pudo registrar el movimiento." });
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
      body.externalReference = requireStableOperationKey(body.externalReference, "externalReference");
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, body.warehouseId))) {
        return json(res, 403, { error: "Sólo puedes entregar desde una bodega de tu centro." });
      }
      const result = await createCustodyAssignment(pool, {
        ...body,
        organizationId: body.organizationId || logisticsOrganizationId,
        allowComplianceOverride: Boolean(apiProfile.admin && body.allowComplianceOverride),
        complianceOverrideReason: apiProfile.admin ? body.complianceOverrideReason : ""
      }, apiProfile.id);
      return json(res, result.replayed ? 200 : 201, result);
    } catch (error) {
      return json(res, error.status || 400, { code: error.code, error: error.message || "No se pudo registrar la entrega a terreno." });
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
      const body = await readJson(req);
      body.idempotencyKey = requireStableOperationKey(body.idempotencyKey);
      const result = await returnCustodyAssignment(pool, assignmentId, body, apiProfile.id);
      return json(res, 200, result);
    } catch (error) {
      return json(res, error.status || 400, { code: error.code, error: error.message || "No se pudo registrar la devolución." });
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
      body.transferNumber = requireStableOperationKey(body.transferNumber, "transferNumber");
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, body.sourceWarehouseId))) {
        return json(res, 403, { error: "Sólo puedes despachar desde una bodega de tu centro." });
      }
      const transfer = await createTransfer(pool, {
        ...body,
        organizationId: body.organizationId || logisticsOrganizationId
      }, apiProfile.id);
      return json(res, 201, { transfer });
    } catch (error) {
      return json(res, error.status || 400, { code: error.code, error: error.message || "No se pudo crear el traslado." });
    }
  }

  const transferAction = url.pathname.match(/^\/api\/v1\/transfers\/([^/]+)\/(dispatch|receive)$/);
  if (transferAction && req.method === "POST") {
    const [, transferId, action] = transferAction;
    const permission = action === "receive" ? "receive" : "move";
    if (!profileCan(apiProfile, permission)) return json(res, 403, { error: "Tu perfil no puede completar esta operación." });
    try {
      const body = await readJson(req);
      body.idempotencyKey = requireStableOperationKey(body.idempotencyKey);
      const transferResult = await pool.query("SELECT * FROM logistics_transfer_orders WHERE id=$1", [transferId]);
      const transfer = transferResult.rows[0];
      if (!transfer) return json(res, 404, { error: "Traslado no encontrado." });
      const scopedWarehouse = action === "receive" ? transfer.destination_warehouse_id : transfer.source_warehouse_id;
      if (!apiProfile.admin && !(await profileMayAccessWarehouse(apiProfile, scopedWarehouse))) {
        return json(res, 403, { error: `El ${action === "receive" ? "destino" : "origen"} no pertenece a tu centro.` });
      }
      const updated = action === "receive"
        ? await receiveTransfer(pool, transferId, body, apiProfile.id)
        : await dispatchTransfer(pool, transferId, {
          ...body,
          allowComplianceOverride: Boolean(apiProfile.admin && body.allowComplianceOverride),
          complianceOverrideReason: apiProfile.admin ? body.complianceOverrideReason : ""
        }, apiProfile.id);
      return json(res, 200, { transfer: updated });
    } catch (error) {
      return json(res, error.status || 400, { code: error.code, error: error.message || "No se pudo actualizar el traslado." });
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
    if (!apiProfile?.admin) return json(res, 403, { error: "Sólo el administrador puede consultar el diagnóstico de archivos." });
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
        const response = await fetchWithTimeout(endpoint, { headers: { "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY } }, { service: "Supabase Storage", timeoutMs: 8_000 });
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

  if (url.pathname === "/api/admin/state-versions" && req.method === "GET") {
    if (!apiProfile?.admin) return json(res, 403, { error: "Sólo el administrador puede consultar respaldos." });
    const versions = await pool.query(`SELECT id,saved_at,saved_by,asset_count,movement_count,
      document_count,state_revision,checksum,
      checksum=encode(digest(payload::text,'sha256'),'hex') AS checksum_valid
      FROM inventory_state_versions
      WHERE state_revision IS NOT NULL
      ORDER BY saved_at DESC,id DESC LIMIT 30`);
    return json(res, 200, { versions: versions.rows });
  }

  if (url.pathname === "/api/admin/canonical-backups" && req.method === "GET") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede consultar respaldos V2." });
    }
    const result = await pool.query(`SELECT * FROM logistics_backup_manifests
      WHERE organization_id=$1 ORDER BY generated_at DESC LIMIT 30`, [logisticsOrganizationId]);
    return json(res, 200, { manifests: result.rows });
  }

  if (url.pathname === "/api/admin/readiness" && req.method === "GET") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede revisar la preparación productiva." });
    }
    try {
      return json(res, 200, await productionReadiness());
    } catch (error) {
      return json(res, 503, { error: error.message || "No se pudo completar el diagnóstico productivo." });
    }
  }

  if (url.pathname === "/api/admin/canonical-backups" && req.method === "POST") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede exportar el libro mayor." });
    }
    if (!logisticsReady) return json(res, 503, { error: "El libro mayor V2 todavía no está disponible." });
    try {
      const backup = await createCanonicalBackup(apiProfile);
      const date = new Date(backup.manifest.generated_at).toISOString().replace(/[:.]/g, "-");
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="ICC_Logistica_V2_${date}.json"`,
        "X-Content-SHA256": backup.manifest.payload_sha256,
        "Cache-Control": "no-store"
      });
      return res.end(backup.body);
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo exportar el libro mayor V2." });
    }
  }

  if (url.pathname === "/api/admin/document-governance" && req.method === "GET") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede consultar conservación documental." });
    }
    const [policies, holds, reviews] = await Promise.all([
      pool.query(`SELECT policy.*,creator.name AS created_by_name,updater.name AS updated_by_name
        FROM logistics_retention_policies policy
        LEFT JOIN inventory_user_profiles creator ON creator.id::text=policy.created_by::text
        LEFT JOIN inventory_user_profiles updater ON updater.id::text=policy.updated_by::text
        WHERE policy.organization_id=$1 ORDER BY policy.document_type`, [logisticsOrganizationId]),
      pool.query(`SELECT hold.*,placer.name AS placed_by_name,releaser.name AS released_by_name
        FROM logistics_legal_holds hold
        LEFT JOIN inventory_user_profiles placer ON placer.id::text=hold.placed_by::text
        LEFT JOIN inventory_user_profiles releaser ON releaser.id::text=hold.released_by::text
        WHERE hold.organization_id=$1 ORDER BY hold.placed_at DESC LIMIT 100`, [logisticsOrganizationId]),
      pool.query(`SELECT review.*,profile.name AS reviewed_by_name
        FROM logistics_retention_reviews review
        LEFT JOIN inventory_user_profiles profile ON profile.id::text=review.reviewed_by::text
        WHERE review.organization_id=$1 ORDER BY review.reviewed_at DESC LIMIT 30`, [logisticsOrganizationId])
    ]);
    return json(res, 200, {
      policies: policies.rows,
      holds: holds.rows,
      reviews: reviews.rows
    });
  }

  const retentionPolicyRoute = url.pathname.match(/^\/api\/admin\/retention-policies\/([0-9a-f-]+)$/i);
  if (retentionPolicyRoute && req.method === "PATCH") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede modificar conservación documental." });
    }
    try {
      const body = await readJson(req);
      const years = Number(body.retentionYears);
      if (!Number.isInteger(years) || years < 1 || years > 30) {
        throw new Error("El plazo debe estar entre 1 y 30 años.");
      }
      const disposition = String(body.disposition || "REVIEW").toUpperCase();
      if (!["REVIEW", "ARCHIVE"].includes(disposition)) throw new Error("Disposición documental no permitida.");
      const policy = (await pool.query(`UPDATE logistics_retention_policies SET
        retention_years=$1,disposition=$2,legal_basis=$3,active=$4,updated_by=$5,updated_at=NOW()
        WHERE id=$6 AND organization_id=$7 RETURNING *`, [years, disposition,
        String(body.legalBasis || "").trim() || null, body.active !== false, apiProfile.id,
        retentionPolicyRoute[1], logisticsOrganizationId])).rows[0];
      if (!policy) throw new Error("Política de conservación no encontrada.");
      await pool.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data)
        VALUES ($1,'RETENTION_POLICY_UPDATED','retention_policy',$2,$3,$4,'WEB',$5::jsonb)`,
      [logisticsOrganizationId, policy.id, apiProfile.id,
        `retention-policy:${policy.id}:${Date.now()}`, asJson(policy)]);
      return json(res, 200, { policy });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar la política." });
    }
  }

  if (url.pathname === "/api/admin/legal-holds" && req.method === "POST") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede crear bloqueos documentales." });
    }
    try {
      const body = await readJson(req);
      const title = String(body.title || "").trim();
      const reason = String(body.reason || "").trim();
      if (title.length < 5 || reason.length < 10) throw new Error("Indica título y fundamento del bloqueo.");
      const holdNumber = `LH-${new Date().toISOString().replace(/\D/g, "").slice(0, 17)}`;
      const hold = (await pool.query(`INSERT INTO logistics_legal_holds
        (organization_id,hold_number,title,reason,document_type,entity_type,entity_id,placed_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [logisticsOrganizationId,
        holdNumber, title, reason, String(body.documentType || "").trim() || null,
        String(body.entityType || "").trim() || null, String(body.entityId || "").trim() || null,
        apiProfile.id])).rows[0];
      await pool.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data)
        VALUES ($1,'LEGAL_HOLD_PLACED','legal_hold',$2,$3,$4,'WEB',$5::jsonb)`,
      [logisticsOrganizationId, hold.id, apiProfile.id, `legal-hold:${hold.id}`, asJson(hold)]);
      return json(res, 201, { hold });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo crear el bloqueo documental." });
    }
  }

  const legalHoldRoute = url.pathname.match(/^\/api\/admin\/legal-holds\/([0-9a-f-]+)$/i);
  if (legalHoldRoute && req.method === "PATCH") {
    if (!apiProfile?.admin) return json(res, 403, { error: "Sólo el administrador puede liberar bloqueos." });
    try {
      const body = await readJson(req);
      const reason = String(body.reason || "").trim();
      if (reason.length < 10) throw new Error("Indica el fundamento para liberar el bloqueo.");
      const hold = (await pool.query(`UPDATE logistics_legal_holds SET status='RELEASED',
        released_by=$1,released_at=NOW(),release_reason=$2,updated_at=NOW()
        WHERE id=$3 AND organization_id=$4 AND status='ACTIVE' RETURNING *`,
      [apiProfile.id, reason, legalHoldRoute[1], logisticsOrganizationId])).rows[0];
      if (!hold) throw new Error("El bloqueo no existe o ya fue liberado.");
      await pool.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data)
        VALUES ($1,'LEGAL_HOLD_RELEASED','legal_hold',$2,$3,$4,'WEB',$5::jsonb)`,
      [logisticsOrganizationId, hold.id, apiProfile.id,
        `legal-hold:${hold.id}:released`, asJson(hold)]);
      return json(res, 200, { hold });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo liberar el bloqueo." });
    }
  }

  if (url.pathname === "/api/admin/retention-reviews" && req.method === "POST") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede revisar conservación documental." });
    }
    try {
      const result = await pool.query(`WITH candidates AS (
          SELECT document.id,document.document_type,policy.retention_years
          FROM logistics_documents document
          JOIN logistics_retention_policies policy
            ON policy.organization_id=document.organization_id
           AND policy.document_type=document.document_type AND policy.active=TRUE
          WHERE document.organization_id=$1
            AND document.created_at<NOW()-(policy.retention_years::text||' years')::interval
        ), classified AS (
          SELECT candidate.*,
            EXISTS (SELECT 1 FROM logistics_legal_holds hold
              WHERE hold.organization_id=$1 AND hold.status='ACTIVE'
                AND (hold.document_type IS NULL OR hold.document_type=candidate.document_type))
              AS protected
          FROM candidates candidate
        )
        SELECT COUNT(*)::int AS candidate_count,
          COUNT(*) FILTER (WHERE protected)::int AS protected_count,
          COALESCE(jsonb_object_agg(document_type,type_count)
            FILTER (WHERE document_type IS NOT NULL),'{}'::jsonb) AS by_type
        FROM (SELECT document_type,protected,COUNT(*) OVER (PARTITION BY document_type)::int AS type_count
          FROM classified) summary`, [logisticsOrganizationId]);
      const summary = result.rows[0] || { candidate_count: 0, protected_count: 0, by_type: {} };
      const review = (await pool.query(`INSERT INTO logistics_retention_reviews
        (organization_id,reviewed_by,candidate_count,protected_count,summary,notes)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`, [logisticsOrganizationId,
        apiProfile.id, Number(summary.candidate_count || 0), Number(summary.protected_count || 0),
        asJson(summary), "Revisión informativa; no elimina archivos automáticamente."])).rows[0];
      await pool.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data)
        VALUES ($1,'RETENTION_REVIEW_COMPLETED','retention_review',$2,$3,$4,'SYSTEM',$5::jsonb)`,
      [logisticsOrganizationId, review.id, apiProfile.id,
        `retention-review:${review.id}`, asJson(review)]);
      return json(res, 200, { review });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo revisar la conservación documental." });
    }
  }

  if (url.pathname === "/api/admin/privacy-governance" && req.method === "GET") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede consultar datos personales." });
    }
    const [activities, requests, accessLog, privacyIncidents] = await Promise.all([
      pool.query(`SELECT * FROM logistics_privacy_activities
        WHERE organization_id=$1 ORDER BY activity_code`, [logisticsOrganizationId]),
      pool.query(`SELECT request.*,assignee.name AS assigned_to_name,
          creator.name AS created_by_name,updater.name AS updated_by_name
        FROM logistics_data_subject_requests request
        LEFT JOIN inventory_user_profiles assignee
          ON assignee.id::text=request.assigned_to::text
        LEFT JOIN inventory_user_profiles creator
          ON creator.id::text=request.created_by::text
        LEFT JOIN inventory_user_profiles updater
          ON updater.id::text=request.updated_by::text
        WHERE request.organization_id=$1
        ORDER BY request.received_at DESC LIMIT 100`, [logisticsOrganizationId]),
      pool.query(`SELECT access.id,access.purpose,access.data_category,
          access.subject_reference,access.entity_type,access.entity_id,
          access.accessed_at,profile.name AS actor_name
        FROM logistics_personal_data_access_log access
        LEFT JOIN inventory_user_profiles profile
          ON profile.id::text=access.actor_profile_id::text
        WHERE access.organization_id=$1
        ORDER BY access.accessed_at DESC LIMIT 50`, [logisticsOrganizationId]),
      pool.query(`SELECT incident.*,owner.name AS owner_name,detector.name AS detected_by_name
        FROM logistics_privacy_incidents incident
        LEFT JOIN inventory_user_profiles owner
          ON owner.id::text=incident.owner_profile_id::text
        LEFT JOIN inventory_user_profiles detector
          ON detector.id::text=incident.detected_by::text
        WHERE incident.organization_id=$1
        ORDER BY incident.detected_at DESC LIMIT 100`, [logisticsOrganizationId])
    ]);
    await pool.query(`INSERT INTO logistics_personal_data_access_log
      (organization_id,actor_profile_id,purpose,data_category,metadata)
      VALUES ($1,$2,'Administración y revisión de cumplimiento','GOVERNANCE',$3::jsonb)`,
    [logisticsOrganizationId, apiProfile.id,
      asJson({ requestCount: requests.rowCount, activityCount: activities.rowCount })]);
    return json(res, 200, {
      activities: activities.rows,
      requests: requests.rows,
      accessLog: accessLog.rows,
      incidents: privacyIncidents.rows
    });
  }

  if (url.pathname === "/api/admin/data-subject-requests" && req.method === "POST") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede registrar solicitudes de titulares." });
    }
    try {
      const body = await readJson(req);
      const requestType = String(body.requestType || "").toUpperCase();
      if (!["ACCESS", "CORRECTION", "RESTRICTION", "OBJECTION"].includes(requestType)) {
        throw new Error("Tipo de solicitud no permitido.");
      }
      const subjectName = String(body.subjectName || "").trim();
      const scope = String(body.requestedScope || "").trim();
      if (subjectName.length < 3 || scope.length < 10) {
        throw new Error("Indica el titular y el alcance de su solicitud.");
      }
      const dueDays = Number(body.dueDays || 20);
      if (!Number.isInteger(dueDays) || dueDays < 1 || dueDays > 90) {
        throw new Error("El plazo interno debe estar entre 1 y 90 días.");
      }
      const requestNumber = `DSR-${new Date().toISOString().replace(/\D/g, "").slice(0, 17)}`;
      const request = (await pool.query(`INSERT INTO logistics_data_subject_requests
        (organization_id,request_number,request_type,subject_name,subject_identifier,
         subject_email,due_at,assigned_to,requested_scope,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,NOW()+($7::text||' days')::interval,$8,$9,$8)
        RETURNING *`, [logisticsOrganizationId, requestNumber, requestType, subjectName,
        String(body.subjectIdentifier || "").trim() || null,
        String(body.subjectEmail || "").trim() || null, dueDays, apiProfile.id, scope])).rows[0];
      await pool.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,
         correlation_id,source,after_data)
        VALUES ($1,'DATA_SUBJECT_REQUEST_RECEIVED','data_subject_request',$2,$3,$4,'WEB',$5::jsonb)`,
      [logisticsOrganizationId, request.id, apiProfile.id,
        `data-subject-request:${request.id}`, asJson({
          id: request.id,
          request_number: request.request_number,
          request_type: request.request_type,
          status: request.status,
          due_at: request.due_at
        })]);
      return json(res, 201, { request });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo registrar la solicitud." });
    }
  }

  const dataSubjectRoute = url.pathname.match(
    /^\/api\/admin\/data-subject-requests\/([0-9a-f-]+)$/i);
  if (dataSubjectRoute && req.method === "PATCH") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede tramitar solicitudes de titulares." });
    }
    try {
      const body = await readJson(req);
      const action = String(body.action || "").toUpperCase();
      const current = (await pool.query(`SELECT * FROM logistics_data_subject_requests
        WHERE id=$1 AND organization_id=$2`, [dataSubjectRoute[1], logisticsOrganizationId])).rows[0];
      if (!current) throw new Error("Solicitud no encontrada.");
      if (["COMPLETED", "REJECTED"].includes(current.status)) {
        throw new Error("La solicitud ya está cerrada y no puede modificarse.");
      }
      let status;
      let verificationMethod = current.verification_method;
      let responseSummary = current.response_summary;
      let rejectionReason = current.rejection_reason;
      if (action === "VERIFY") {
        verificationMethod = String(body.verificationMethod || "").trim();
        if (verificationMethod.length < 5) throw new Error("Registra cómo se verificó la identidad.");
        status = "IN_PROGRESS";
      } else if (action === "START") {
        status = current.status === "RECEIVED" ? "VERIFYING" : "IN_PROGRESS";
      } else if (action === "COMPLETE") {
        responseSummary = String(body.responseSummary || "").trim();
        if (!verificationMethod) throw new Error("Verifica la identidad antes de responder.");
        if (responseSummary.length < 10) throw new Error("Resume la respuesta entregada al titular.");
        status = "COMPLETED";
      } else if (action === "REJECT") {
        rejectionReason = String(body.rejectionReason || "").trim();
        if (rejectionReason.length < 10) throw new Error("Fundamenta el rechazo.");
        status = "REJECTED";
      } else {
        throw new Error("Acción de solicitud no permitida.");
      }
      const request = (await pool.query(`UPDATE logistics_data_subject_requests SET
        status=$1,verification_method=$2,response_summary=$3,rejection_reason=$4,
        completed_at=CASE WHEN $1 IN ('COMPLETED','REJECTED') THEN NOW() ELSE NULL END,
        updated_by=$5,updated_at=NOW()
        WHERE id=$6 AND organization_id=$7 RETURNING *`, [status, verificationMethod,
        responseSummary, rejectionReason, apiProfile.id, current.id,
        logisticsOrganizationId])).rows[0];
      await pool.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,
         correlation_id,source,before_data,after_data)
        VALUES ($1,'DATA_SUBJECT_REQUEST_UPDATED','data_subject_request',$2,$3,$4,
          'WEB',$5::jsonb,$6::jsonb)`, [logisticsOrganizationId, request.id,
        apiProfile.id, `data-subject-request:${request.id}:${action}`,
        asJson({ status: current.status }), asJson({ status: request.status })]);
      return json(res, 200, { request });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo actualizar la solicitud." });
    }
  }

  if (url.pathname === "/api/admin/privacy-incidents" && req.method === "POST") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede registrar incidentes de privacidad." });
    }
    const client = await pool.connect();
    try {
      const body = await readJson(req);
      const title = String(body.title || "").trim();
      const description = String(body.description || "").trim();
      const dataCategories = Array.isArray(body.dataCategories)
        ? body.dataCategories.map(value => String(value).trim()).filter(Boolean) : [];
      if (title.length < 5 || description.length < 10 || !dataCategories.length) {
        throw new Error("Indica título, descripción y al menos una categoría de datos.");
      }
      const riskScore = Number(body.riskScore ?? 40);
      if (!Number.isInteger(riskScore) || riskScore < 0 || riskScore > 100) {
        throw new Error("El riesgo debe estar entre 0 y 100.");
      }
      const affectedCount = body.affectedCount === "" || body.affectedCount == null
        ? null : Number(body.affectedCount);
      if (affectedCount != null && (!Number.isInteger(affectedCount) || affectedCount < 0)) {
        throw new Error("La cantidad de personas afectadas debe ser un entero positivo.");
      }
      const severity = riskScore >= 80 ? "CRITICAL"
        : riskScore >= 60 ? "HIGH" : riskScore >= 30 ? "MEDIUM" : "LOW";
      const incidentNumber = `PI-${new Date().toISOString().replace(/\D/g, "").slice(0, 17)}`;
      await client.query("BEGIN");
      const incident = (await client.query(`INSERT INTO logistics_privacy_incidents
        (organization_id,incident_number,title,description,detected_by,owner_profile_id,
         data_categories,subject_categories,affected_count,confidentiality_affected,
         integrity_affected,availability_affected,severity,risk_score)
        VALUES ($1,$2,$3,$4,$5,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13)
        RETURNING *`, [logisticsOrganizationId, incidentNumber, title, description,
        apiProfile.id, asJson(dataCategories),
        asJson(Array.isArray(body.subjectCategories) ? body.subjectCategories : []),
        affectedCount,
        body.confidentialityAffected !== false, Boolean(body.integrityAffected),
        Boolean(body.availabilityAffected), severity, riskScore])).rows[0];
      await client.query(`INSERT INTO logistics_privacy_incident_events
        (organization_id,incident_id,event_type,new_status,actor_profile_id,detail,payload)
        VALUES ($1,$2,'INCIDENT_DETECTED','DETECTED',$3,$4,$5::jsonb)`,
      [logisticsOrganizationId, incident.id, apiProfile.id, description,
        asJson({ severity, riskScore, dataCategories })]);
      const taskId = `privacy-incident-${incident.id}`;
      await client.query(`INSERT INTO inventory_tasks
        (id,task_type,title,detail,priority,status,center_name,assignee_auth_user_id,
         entity_type,entity_id,payload,updated_at)
        VALUES ($1,'Incidente de privacidad',$2,$3,$4,'Pendiente','Bodega Central',$5,
          'privacy_incident',$6,$7::jsonb,NOW())
        ON CONFLICT (id) DO NOTHING`, [taskId,
        `Evaluar incidente ${incident.incident_number}: ${incident.title}`,
        incident.description, ["HIGH", "CRITICAL"].includes(severity) ? "Crítica" : "Alta",
        apiProfile.auth_user_id || null, incident.id, asJson(incident)]);
      await client.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,
         correlation_id,source,after_data)
        VALUES ($1,'PRIVACY_INCIDENT_DETECTED','privacy_incident',$2,$3,$4,'WEB',$5::jsonb)`,
      [logisticsOrganizationId, incident.id, apiProfile.id,
        `privacy-incident:${incident.id}`, asJson(incident)]);
      await client.query("COMMIT");
      return json(res, 201, { incident });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return json(res, 400, { error: error.message || "No se pudo registrar el incidente." });
    } finally {
      client.release();
    }
  }

  const privacyIncidentRoute = url.pathname.match(
    /^\/api\/admin\/privacy-incidents\/([0-9a-f-]+)$/i);
  if (privacyIncidentRoute && req.method === "PATCH") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede gestionar incidentes de privacidad." });
    }
    const client = await pool.connect();
    try {
      const body = await readJson(req);
      const action = String(body.action || "").toUpperCase();
      await client.query("BEGIN");
      const current = (await client.query(`SELECT * FROM logistics_privacy_incidents
        WHERE id=$1 AND organization_id=$2 FOR UPDATE`,
      [privacyIncidentRoute[1], logisticsOrganizationId])).rows[0];
      if (!current) throw new Error("Incidente de privacidad no encontrado.");
      if (current.status === "CLOSED") throw new Error("El incidente ya está cerrado.");
      let status;
      const values = {
        dataCategories: current.data_categories,
        subjectCategories: current.subject_categories,
        affectedCount: current.affected_count,
        confidentialityAffected: current.confidentiality_affected,
        integrityAffected: current.integrity_affected,
        availabilityAffected: current.availability_affected,
        riskScore: current.risk_score,
        severity: current.severity,
        containmentActions: current.containment_actions,
        notificationRequired: current.notification_required,
        notificationReason: current.notification_reason,
        authorityNotifiedAt: current.authority_notified_at,
        subjectsNotifiedAt: current.subjects_notified_at,
        rootCause: current.root_cause,
        correctiveActions: current.corrective_actions
      };
      if (action === "ASSESS") {
        values.riskScore = Number(body.riskScore);
        if (!Number.isInteger(values.riskScore) || values.riskScore < 0 || values.riskScore > 100) {
          throw new Error("El riesgo debe estar entre 0 y 100.");
        }
        values.severity = values.riskScore >= 80 ? "CRITICAL"
          : values.riskScore >= 60 ? "HIGH" : values.riskScore >= 30 ? "MEDIUM" : "LOW";
        values.affectedCount = body.affectedCount === "" || body.affectedCount == null
          ? null : Number(body.affectedCount);
        if (values.affectedCount != null
            && (!Number.isInteger(values.affectedCount) || values.affectedCount < 0)) {
          throw new Error("La cantidad de personas afectadas debe ser un entero positivo.");
        }
        values.dataCategories = Array.isArray(body.dataCategories)
          ? body.dataCategories : values.dataCategories;
        values.subjectCategories = Array.isArray(body.subjectCategories)
          ? body.subjectCategories : values.subjectCategories;
        values.confidentialityAffected = body.confidentialityAffected !== false;
        values.integrityAffected = Boolean(body.integrityAffected);
        values.availabilityAffected = Boolean(body.availabilityAffected);
        status = "ASSESSING";
      } else if (action === "CONTAIN") {
        values.containmentActions = String(body.containmentActions || "").trim();
        if (values.containmentActions.length < 10) {
          throw new Error("Describe las medidas de contención aplicadas.");
        }
        status = "CONTAINED";
      } else if (action === "DECIDE_NOTIFICATION") {
        if (!["CONTAINED", "NOTIFICATION_DECIDED"].includes(current.status)) {
          throw new Error("Primero registra la contención del incidente.");
        }
        if (typeof body.notificationRequired !== "boolean") {
          throw new Error("Indica si corresponde notificar.");
        }
        values.notificationReason = String(body.notificationReason || "").trim();
        if (values.notificationReason.length < 10) {
          throw new Error("Fundamenta la decisión de notificación.");
        }
        values.notificationRequired = body.notificationRequired;
        values.authorityNotifiedAt = body.authorityNotifiedAt || null;
        values.subjectsNotifiedAt = body.subjectsNotifiedAt || null;
        status = "NOTIFICATION_DECIDED";
      } else if (action === "CLOSE") {
        if (current.notification_required == null) {
          throw new Error("Registra la decisión de notificación antes de cerrar.");
        }
        values.rootCause = String(body.rootCause || "").trim();
        values.correctiveActions = String(body.correctiveActions || "").trim();
        if (values.rootCause.length < 10 || values.correctiveActions.length < 10) {
          throw new Error("Registra causa raíz y acciones correctivas.");
        }
        status = "CLOSED";
      } else {
        throw new Error("Acción de incidente no permitida.");
      }
      const incident = (await client.query(`UPDATE logistics_privacy_incidents SET
        data_categories=$1::jsonb,subject_categories=$2::jsonb,affected_count=$3,
        confidentiality_affected=$4,integrity_affected=$5,availability_affected=$6,
        risk_score=$7,severity=$8,status=$9,containment_actions=$10,
        notification_required=$11,notification_reason=$12,authority_notified_at=$13,
        subjects_notified_at=$14,root_cause=$15,corrective_actions=$16,
        contained_at=CASE WHEN $9='CONTAINED' THEN NOW() ELSE contained_at END,
        closed_at=CASE WHEN $9='CLOSED' THEN NOW() ELSE NULL END,
        updated_by=$17,updated_at=NOW()
        WHERE id=$18 AND organization_id=$19 RETURNING *`, [
        asJson(values.dataCategories), asJson(values.subjectCategories),
        values.affectedCount, values.confidentialityAffected, values.integrityAffected,
        values.availabilityAffected, values.riskScore, values.severity, status,
        values.containmentActions, values.notificationRequired, values.notificationReason,
        values.authorityNotifiedAt, values.subjectsNotifiedAt, values.rootCause,
        values.correctiveActions, apiProfile.id, current.id, logisticsOrganizationId
      ])).rows[0];
      await client.query(`INSERT INTO logistics_privacy_incident_events
        (organization_id,incident_id,event_type,previous_status,new_status,
         actor_profile_id,detail,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [logisticsOrganizationId,
        incident.id, `INCIDENT_${action}`, current.status, status, apiProfile.id,
        String(body.detail || body.notificationReason || body.containmentActions || "").trim() || null,
        asJson({ action, severity: incident.severity, riskScore: incident.risk_score })]);
      if (status === "CLOSED") {
        await client.query(`UPDATE inventory_tasks SET status='Resuelta',
          resolved_at=COALESCE(resolved_at,NOW()),updated_at=NOW()
          WHERE id=$1`, [`privacy-incident-${incident.id}`]);
      }
      await client.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,
         correlation_id,source,before_data,after_data)
        VALUES ($1,'PRIVACY_INCIDENT_UPDATED','privacy_incident',$2,$3,$4,
          'WEB',$5::jsonb,$6::jsonb)`, [logisticsOrganizationId, incident.id,
        apiProfile.id, `privacy-incident:${incident.id}:${action}`,
        asJson({ status: current.status, severity: current.severity }),
        asJson({ status: incident.status, severity: incident.severity })]);
      await client.query("COMMIT");
      return json(res, 200, { incident });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return json(res, 400, { error: error.message || "No se pudo actualizar el incidente." });
    } finally {
      client.release();
    }
  }

  if (url.pathname === "/api/admin/recovery-drills" && req.method === "GET") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede consultar pruebas de recuperación." });
    }
    const result = await pool.query(`SELECT drill.*,manifest.payload_sha256,
        owner.name AS owner_name,reviewer.name AS reviewer_name
      FROM logistics_recovery_drills drill
      LEFT JOIN logistics_backup_manifests manifest ON manifest.id=drill.backup_manifest_id
      LEFT JOIN inventory_user_profiles owner ON owner.id::text=drill.owner_profile_id::text
      LEFT JOIN inventory_user_profiles reviewer ON reviewer.id::text=drill.reviewed_by::text
      WHERE drill.organization_id=$1
      ORDER BY drill.planned_at DESC,drill.created_at DESC LIMIT 100`, [logisticsOrganizationId]);
    return json(res, 200, { drills: result.rows });
  }

  if (url.pathname === "/api/admin/recovery-drills" && req.method === "POST") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede programar pruebas de recuperación." });
    }
    try {
      const body = await readJson(req);
      const drillType = String(body.drillType || "EXPORT_VERIFY").toUpperCase();
      if (!["TABLETOP", "EXPORT_VERIFY", "ISOLATED_RESTORE"].includes(drillType)) {
        throw new Error("Tipo de prueba de recuperación no permitido.");
      }
      const targetRpo = Number(body.targetRpoMinutes || 1440);
      const targetRto = Number(body.targetRtoMinutes || 240);
      if (!Number.isInteger(targetRpo) || targetRpo <= 0 || !Number.isInteger(targetRto) || targetRto <= 0) {
        throw new Error("Los objetivos RPO y RTO deben expresarse en minutos positivos.");
      }
      const scope = String(body.scope || "").trim();
      if (scope.length < 10) throw new Error("Describe el alcance de la prueba.");
      const latestManifest = (await pool.query(`SELECT id FROM logistics_backup_manifests
        WHERE organization_id=$1 ORDER BY generated_at DESC LIMIT 1`, [logisticsOrganizationId])).rows[0];
      const drillNumber = `DR-${new Date().toISOString().replace(/\D/g, "").slice(0, 17)}`;
      const checklist = [
        { code: "BACKUP_IDENTIFIED", label: "Respaldo y punto de recuperación identificados", status: "PENDING" },
        { code: "INTEGRITY_VERIFIED", label: "Integridad SHA-256 verificada", status: "PENDING" },
        { code: "DATA_VALIDATED", label: "Catálogo, saldos, movimientos y auditoría validados", status: "PENDING" },
        { code: "ACCESS_VALIDATED", label: "Acceso y permisos validados en ambiente aislado", status: "PENDING" }
      ];
      const drill = (await pool.query(`INSERT INTO logistics_recovery_drills
        (organization_id,drill_number,drill_type,environment,backup_manifest_id,
         target_rpo_minutes,target_rto_minutes,scope,checklist,owner_profile_id,planned_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,COALESCE($11::timestamptz,NOW()))
        RETURNING *`, [logisticsOrganizationId, drillNumber, drillType,
        String(body.environment || "isolated"), body.backupManifestId || latestManifest?.id || null,
        targetRpo, targetRto, scope, asJson(checklist), apiProfile.id, body.plannedAt || null])).rows[0];
      await pool.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data)
        VALUES ($1,'RECOVERY_DRILL_PLANNED','recovery_drill',$2,$3,$4,'WEB',$5::jsonb)`,
      [logisticsOrganizationId, drill.id, apiProfile.id, `recovery-drill:${drill.id}`, asJson(drill)]);
      return json(res, 201, { drill });
    } catch (error) {
      return json(res, 400, { error: error.message || "No se pudo programar la prueba de recuperación." });
    }
  }

  const recoveryDrillRoute = url.pathname.match(/^\/api\/admin\/recovery-drills\/([0-9a-f-]+)$/i);
  if (recoveryDrillRoute && req.method === "PATCH") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "Sólo el administrador puede actualizar pruebas de recuperación." });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const body = await readJson(req);
      const action = String(body.action || "").toUpperCase();
      const before = (await client.query(`SELECT * FROM logistics_recovery_drills
        WHERE id=$1 AND organization_id=$2 FOR UPDATE`,
      [recoveryDrillRoute[1], logisticsOrganizationId])).rows[0];
      if (!before) throw new Error("Prueba de recuperación no encontrada.");
      let drill;
      if (action === "START") {
        if (before.status !== "PLANNED") throw new Error("Sólo una prueba planificada puede iniciarse.");
        drill = (await client.query(`UPDATE logistics_recovery_drills SET
          status='IN_PROGRESS',started_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,
        [before.id])).rows[0];
      } else if (action === "COMPLETE") {
        if (!["PLANNED", "IN_PROGRESS"].includes(before.status)) throw new Error("La prueba ya está cerrada.");
        const result = String(body.result || "").toUpperCase();
        if (!["PASSED", "FAILED"].includes(result)) throw new Error("Indica si la prueba fue aprobada o fallida.");
        const measuredRpo = Number(body.measuredRpoMinutes);
        const measuredRto = Number(body.measuredRtoMinutes);
        if (!Number.isInteger(measuredRpo) || measuredRpo < 0 || !Number.isInteger(measuredRto) || measuredRto < 0) {
          throw new Error("Registra los tiempos RPO y RTO medidos.");
        }
        const findings = String(body.findings || "").trim();
        const correctiveActions = String(body.correctiveActions || "").trim();
        if (result === "FAILED" && (findings.length < 10 || correctiveActions.length < 10)) {
          throw new Error("Una prueba fallida requiere hallazgos y acciones correctivas.");
        }
        const checklist = Array.isArray(body.checklist) ? body.checklist : before.checklist;
        drill = (await client.query(`UPDATE logistics_recovery_drills SET
          status=$2,measured_rpo_minutes=$3,measured_rto_minutes=$4,checklist=$5::jsonb,
          findings=$6,corrective_actions=$7,evidence_file_id=$8,reviewed_by=$9,
          completed_at=NOW(),reviewed_at=NOW(),updated_at=NOW()
          WHERE id=$1 RETURNING *`, [before.id, result, measuredRpo, measuredRto,
          asJson(checklist), findings || null, correctiveActions || null,
          body.evidenceFileId || null, apiProfile.id])).rows[0];
      } else {
        throw new Error("Acción de recuperación no permitida.");
      }
      await client.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,
         source,before_data,after_data)
        VALUES ($1,$2,'recovery_drill',$3,$4,$5,'WEB',$6::jsonb,$7::jsonb)`,
      [logisticsOrganizationId, `RECOVERY_DRILL_${action}`, before.id, apiProfile.id,
        `recovery-drill:${before.id}:${action}`, asJson(before), asJson(drill)]);
      await client.query("COMMIT");
      return json(res, 200, { drill });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      return json(res, 400, { error: error.message || "No se pudo actualizar la prueba de recuperación." });
    } finally {
      client.release();
    }
  }

  if (url.pathname.startsWith("/api/admin/state-versions/") && url.pathname.endsWith("/restore") && req.method === "POST") {
    if (!apiProfile?.admin) return json(res, 403, { error: "Sólo el administrador puede restaurar respaldos." });
    if (!logisticsReady) return json(res, 503, { error: "El modelo logístico todavía no está disponible." });
    const versionId = url.pathname.split("/")[4];
    if (!/^\d+$/.test(versionId || "")) return json(res, 400, { error: "Respaldo inválido." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM inventory_app_state WHERE id=1 FOR UPDATE");
      const version = await client.query(`SELECT *,
        checksum=encode(digest(payload::text,'sha256'),'hex') AS checksum_valid
        FROM inventory_state_versions WHERE id=$1`, [versionId]);
      const snapshot = version.rows[0];
      if (!snapshot) throw new Error("Respaldo no encontrado.");
      if (!snapshot.checksum_valid) throw new Error("El respaldo no supera la verificación de integridad.");
      const written = await client.query(`UPDATE inventory_app_state
        SET payload=$1::jsonb,revision=revision+1,updated_at=NOW()
        WHERE id=1 RETURNING revision,updated_at`, [asJson(snapshot.payload)]);
      const revision = Number(written.rows[0]?.revision || 0);
      await syncNormalizedTables(client, snapshot.payload, `${apiProfile.name} · restauración`, revision);
      await syncOperationalTasks(client, snapshot.payload);
      await client.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data,metadata)
        VALUES ($1,'STATE_SNAPSHOT_RESTORED','state_snapshot',$2,$3,$4,'SYSTEM',$5::jsonb,$6::jsonb)`,
        [logisticsOrganizationId, String(versionId), apiProfile.id, `state-restore:${versionId}:${revision}`,
          asJson({ revision, restoredAt: written.rows[0]?.updated_at }),
          asJson({ snapshotRevision: snapshot.state_revision, checksum: snapshot.checksum })]);
      await client.query("COMMIT");
      return json(res, 200, { ok: true, revision, updatedAt: written.rows[0]?.updated_at });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      return json(res, 400, { error: error.message || "No se pudo restaurar el respaldo." });
    } finally {
      client.release();
    }
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    if (!pool) return json(res, 503, { error: "DATABASE_URL no configurada" });
    try {
      const result = await pool.query("SELECT payload,revision,updated_at FROM inventory_app_state WHERE id = 1");
      const current = result.rows[0]?.payload || null;
      return json(res, 200, {
        state: current ? stateForProfile(current, apiProfile) : null,
        revision: Number(result.rows[0]?.revision || 0),
        updatedAt: result.rows[0]?.updated_at || null
      });
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
      const currentResult = await client.query("SELECT payload,revision FROM inventory_app_state WHERE id=1 FOR UPDATE");
      const currentRevision = Number(currentResult.rows[0]?.revision || 0);
      const hasBaseRevision = body.baseRevision !== undefined && body.baseRevision !== null;
      if (hasBaseRevision && Number(body.baseRevision) !== currentRevision) {
        await client.query("ROLLBACK");
        return json(res, 409, {
          error: "El respaldo cambió en otra sesión. Actualiza la pantalla antes de volver a guardar.",
          code: "STATE_REVISION_CONFLICT",
          currentRevision
        });
      }
      const nextState = mergeStateForProfile(currentResult.rows[0]?.payload || {}, body.state, apiProfile);
      const written = await client.query(`INSERT INTO inventory_app_state (id,payload,revision,updated_at)
        VALUES (1,$1::jsonb,1,NOW())
        ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload,
          revision=inventory_app_state.revision+1,updated_at=NOW()
        RETURNING revision,updated_at`, [JSON.stringify(nextState)]);
      const revision = Number(written.rows[0]?.revision || currentRevision + 1);
      await syncNormalizedTables(client, nextState, apiProfile?.name || body.savedBy || "Sistema", revision);
      await syncOperationalTasks(client, nextState);
      await client.query("COMMIT");
      return json(res, 200, { ok: true, normalized: true, revision, updatedAt: written.rows[0]?.updated_at });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      return json(res, 400, { error: error.message || "No se pudo guardar" });
    } finally {
      client.release();
    }
  }

  if (url.pathname === "/api/state" && req.method === "PUT") {
    if (!apiProfile?.admin) {
      return json(res, 403, { error: "La restauración heredada está reservada al administrador." });
    }
    if (!pool) return json(res, 503, { error: "DATABASE_URL no configurada" });
    try {
      const body = await readJson(req);
      if (!body.state || typeof body.state !== "object") return json(res, 400, { error: "Estado de inventario inválido" });
      const currentResult = await pool.query("SELECT payload FROM inventory_app_state WHERE id=1");
      const nextState = mergeStateForProfile(currentResult.rows[0]?.payload || {}, body.state, apiProfile);
      const written = await pool.query(`INSERT INTO inventory_app_state (id,payload,revision,updated_at)
        VALUES (1,$1::jsonb,1,NOW())
        ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload,
          revision=inventory_app_state.revision+1,updated_at=NOW()
        RETURNING revision,updated_at`, [JSON.stringify(nextState)]);
      return json(res, 200, { ok: true, revision: Number(written.rows[0]?.revision || 0), updatedAt: written.rows[0]?.updated_at });
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
    if (!apiProfile) return json(res, 401, { error: "Debes iniciar sesión para archivar documentos." });
    try {
      const body = await readJson(req);
      if (!body.filename || !body.dataUrl) return json(res, 400, { error: "Falta archivo" });
      if (!apiProfile.admin) {
        if (!body.center || !sameCenter(body.center, apiProfile.cost_center)) {
          return json(res, 403, { error: "Sólo puedes archivar documentos de tu centro de costo." });
        }
        if (!(await profileMayAccessDocumentEntity(apiProfile, body.entityType, body.entityId || body.ref, body.center))) {
          return json(res, 403, { error: "El registro asociado no pertenece a tu centro de costo." });
        }
      }
      const result = await uploadFileObject(body);
      let canonical = null;
      if (logisticsReady) {
        canonical = await registerCanonicalDocument(pool, {
          organizationId: logisticsOrganizationId,
          fileObjectId: result.id,
          legacyId: body.documentLegacyId || result.id,
          documentType: body.documentType || body.category || "OTHER",
          documentNumber: body.documentNumber || "",
          title: body.documentTitle || body.filename,
          sha256: result.sha256,
          entityType: body.entityType || (body.ref ? "legacy_record" : ""),
          entityId: body.entityId || body.ref || "",
          relationship: body.relationship || "EVIDENCE"
        }, apiProfile.id);
        if (canonical?.document?.id && String(body.entityType || "").toLowerCase() === "asset_compliance") {
          await pool.query(`UPDATE logistics_asset_compliance_records
            SET canonical_document_id=$1,updated_by=$2,updated_at=NOW() WHERE id=$3`,
          [canonical.document.id, apiProfile.id, body.entityId]);
        }
      }
      return json(res, 200, { ...result, canonicalDocumentId: canonical?.document?.id || "" });
    } catch (error) {
      console.error("Error subiendo archivo:", error.message);
      return json(res, 400, { error: error.message || "No se pudo guardar el archivo" });
    }
  }

  if (url.pathname === "/api/inspection/pdf" && req.method === "POST") {
    if (!profileCan(apiProfile, "inspect") && !profileCan(apiProfile, "view")) {
      return json(res, 403, { error: "Tu perfil no puede descargar inspecciones." });
    }
    try {
      const body = await readJson(req);
      const inspectionCenter = body?.asset?.location || body?.inspection?.project || "";
      if (!apiProfile.admin && !sameCenter(inspectionCenter, apiProfile.cost_center)) {
        return json(res, 403, { error: "La inspección pertenece a otro centro de costo." });
      }
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
    if (!apiProfile) return json(res, 401, { error: "Debes iniciar sesión para descargar archivos." });
    if (!pool) return json(res, 503, { error: "DATABASE_URL no configurada" });
    try {
      const id = decodeURIComponent(url.pathname.replace("/api/files/", ""));
      const result = await pool.query("SELECT * FROM inventory_file_objects WHERE id = $1", [id]);
      const row = result.rows[0];
      if (!row) return json(res, 404, { error: "Archivo no encontrado" });
      if (!(await profileMayAccessFile(apiProfile, row))) {
        return json(res, 403, { error: "El archivo pertenece a otro centro de costo." });
      }
      if (row.provider === "supabase" && row.storage_path && storageConfigured()) {
        const endpoint = `${supabaseBaseUrl()}/storage/v1/object/${encodeURIComponent(process.env.SUPABASE_BUCKET)}/${String(row.storage_path).split("/").map(encodeURIComponent).join("/")}`;
        const response = await fetchWithTimeout(endpoint, { headers: { "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY } }, { service: "Supabase Storage", timeoutMs: process.env.STORAGE_TIMEOUT_MS || 30_000 });
        if (!response.ok) throw new Error("No se pudo leer archivo desde Supabase");
        const body = Buffer.from(await response.arrayBuffer());
        const integrity = await verifyFileIntegrity(row, body, apiProfile);
        res.writeHead(200, { "Content-Type": row.mime_type || "application/octet-stream", "Content-Disposition": `attachment; filename="${safeName(row.filename)}"`, ...fileIntegrityHeaders(integrity, body.length) });
        return res.end(body);
      }
      const body = Buffer.from(row.data_base64 || "", "base64");
      const integrity = await verifyFileIntegrity(row, body, apiProfile);
      res.writeHead(200, { "Content-Type": row.mime_type || "application/octet-stream", "Content-Disposition": `attachment; filename="${safeName(row.filename)}"`, ...fileIntegrityHeaders(integrity, body.length) });
      return res.end(body);
    } catch (error) {
      return json(res, error.status || 400, { code: error.code, error: error.message || "No se pudo descargar el archivo" });
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
    const extension = extname(file).toLowerCase();
    const headers = { "Content-Type": mime[extension] || "application/octet-stream" };
    if ([".html", ".js", ".css"].includes(extension)) headers["Cache-Control"] = "no-cache";
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    try {
      const body = await readFile(join(root, "index.html"));
      res.writeHead(200, { "Content-Type": mime[".html"], "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      json(res, 500, { error: "No se pudo cargar la aplicación" });
    }
  }
}

const server = http.createServer((req, res) => {
  const requestId = randomUUID();
  const startedAt = process.hrtime.bigint();
  const pathname = (() => {
    try { return new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname; }
    catch { return "/ruta-invalida"; }
  })();
  res.once("finish", () => {
    if (pathname === "/api/health" && res.statusCode < 400) return;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    console.info(JSON.stringify({
      type: "http_request",
      requestId,
      method: req.method,
      path: pathname,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(1))
    }));
  });
  handleHttpRequest(req, res, requestId).catch((error) => {
    console.error(JSON.stringify({
      type: "http_unhandled_error",
      requestId,
      method: req.method,
      path: pathname,
      error: error?.message || "Error inesperado"
    }));
    if (!res.headersSent) {
      applyBrowserSecurityHeaders(res);
      res.setHeader("X-Request-Id", requestId);
      const safeStatus = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
      return json(res, safeStatus, {
        code: safeStatus < 500 ? error.code : "INTERNAL_ERROR",
        error: safeStatus < 500 ? error.message : "Ocurrió un error inesperado. Informa el código de seguimiento al administrador.",
        requestId
      });
    }
    if (!res.writableEnded) res.destroy();
  });
});

server.on("clientError", (error, socket) => {
  console.warn(JSON.stringify({ type: "http_client_error", error: error?.message || "Solicitud inválida" }));
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(JSON.stringify({ type: "service_shutdown", signal }));
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  server.close(async () => {
    try { if (pool) await pool.end(); }
    catch (error) { console.error("No se pudo cerrar PostgreSQL correctamente:", error.message); }
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => gracefulShutdown("SIGINT"));

setupDatabase()
  .then(() => {
    startComplianceScheduler();
    startLogisticsJobScheduler();
    startLogisticsOutboxScheduler();
    startOperationalHealthScheduler();
    server.listen(port, "0.0.0.0", () => console.log(`Inventario ICC escuchando en puerto ${port}`));
  })
  .catch((error) => {
    console.error("No se pudo preparar la base de datos; la app seguirá iniciando.", error.message);
    server.listen(port, "0.0.0.0", () => console.log(`Inventario ICC escuchando en puerto ${port}`));
  });
