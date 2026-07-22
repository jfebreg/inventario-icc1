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
    if (size > 2_000_000) throw new Error("Solicitud demasiado grande");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function setupDatabase() {
  if (!pool) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS inventory_app_state (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  } catch (error) {
    console.error("Base de datos no disponible al iniciar; la app seguirá funcionando en modo temporal.", error.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/health") {
    return json(res, 200, { ok: true, service: "inventario-icc", databaseConfigured: Boolean(pool), openaiConfigured: Boolean(process.env.OPENAI_API_KEY) });
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

  if (url.pathname === "/api/qr" && req.method === "GET") {
    const data = url.searchParams.get("data");
    if (!data) return json(res, 400, { error: "Falta dato para QR" });
    try {
      const svg = await QRCode.toString(data, { type: "svg", errorCorrectionLevel: "M", margin: 1, width: 240 });
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
