import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, logistics, server, app] = await Promise.all([
  readFile(new URL("../migrations/028_logistics_scheduled_jobs.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/logistics.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

test("la agenda persiste horario, zona y estado de cada trabajo", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS logistics_scheduled_jobs/);
  assert.match(migration, /timezone_name TEXT NOT NULL/);
  assert.match(migration, /local_hour INTEGER NOT NULL/);
  assert.match(migration, /last_status IN \('PENDING','RUNNING','SUCCESS','FAILED'\)/);
  assert.match(migration, /UNIQUE \(organization_id,job_code\)/);
});

test("cada organización recibe un cierre diario inicial", () => {
  assert.match(migration, /KPI_DAILY_SNAPSHOT/);
  assert.match(migration, /America\/Santiago/);
  assert.match(migration, /ON CONFLICT \(organization_id,job_code\) DO NOTHING/);
});

test("la configuración valida zona horaria y calcula la próxima ejecución", () => {
  assert.match(logistics, /export async function updateScheduledLogisticsJob/);
  assert.match(logistics, /pg_timezone_names/);
  assert.match(logistics, /make_interval\(hours=>\$5\)/);
  assert.match(logistics, /LOGISTICS_SCHEDULE_UPDATED/);
});

test("el ejecutor usa bloqueo global y registra resultado o error", () => {
  assert.match(logistics, /export async function runDueLogisticsJobs/);
  assert.match(logistics, /pg_try_advisory_lock/);
  assert.match(logistics, /snapshotLogisticsKpis/);
  assert.match(logistics, /last_status='SUCCESS'/);
  assert.match(logistics, /last_status='FAILED'/);
  assert.match(logistics, /pg_advisory_unlock/);
});

test("servidor protege las API y revisa trabajos cada quince minutos", () => {
  assert.match(server, /startLogisticsJobScheduler/);
  assert.match(server, /15 \* 60 \* 1000/);
  assert.match(server, /\/api\/v1\/logistics-jobs\/kpi-daily/);
  assert.match(server, /profileCan\(apiProfile, "admin"\)/);
  assert.match(server, /sweepScheduledLogisticsJobs/);
});

test("la interfaz permite administrar y visualizar el cierre automático", () => {
  assert.match(app, /data-kpi-schedule/);
  assert.match(app, /function kpiScheduleModal/);
  assert.match(app, /id="kpiScheduleForm"/);
  assert.match(app, /Próxima ejecución/);
  assert.match(app, /Automatización logística actualizada y auditada/);
});
