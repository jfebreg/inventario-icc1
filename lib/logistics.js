import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_ORG = {
  code: "ICC",
  name: "Ingeniería y Construcción Chile",
  taxId: "76.267.071-2",
  address: "Panamá 8854, La Florida, Santiago"
};

function text(value) {
  return String(value ?? "").trim();
}

function slug(value, fallback = "SIN-CODIGO") {
  return text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function balanceKey({ organizationId, itemId, assetUnitId, lotId, locationId }) {
  return createHash("sha256")
    .update([organizationId, itemId, assetUnitId || "-", lotId || "-", locationId].join("|"))
    .digest("hex");
}

function assertPositiveQuantity(value) {
  const quantity = number(value);
  if (!(quantity > 0)) throw new Error("La cantidad debe ser mayor que cero.");
  return quantity;
}

function assertMovementType(value) {
  const allowed = new Set(["OPENING", "RECEIPT", "ISSUE", "TRANSFER_DISPATCH", "TRANSFER_RECEIPT", "CUSTODY_ISSUE", "CUSTODY_RETURN", "CONSUMPTION", "ADJUSTMENT", "REVERSAL"]);
  const type = text(value).toUpperCase();
  if (!allowed.has(type)) throw new Error("Tipo de movimiento no permitido.");
  return type;
}

export async function runLogisticsMigrations(pool, migrationsDir) {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS logistics_schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const files = (await readdir(migrationsDir)).filter(file => /^\d+.*\.sql$/i.test(file)).sort();
    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = await client.query("SELECT checksum FROM logistics_schema_migrations WHERE version=$1", [file]);
      if (previous.rows[0]) {
        if (previous.rows[0].checksum !== checksum) throw new Error(`La migración ${file} cambió después de ser aplicada.`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO logistics_schema_migrations (version, checksum) VALUES ($1,$2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

export async function ensureDefaultOrganization(pool, organization = DEFAULT_ORG) {
  const result = await pool.query(`INSERT INTO logistics_organizations (code, name, tax_id, address, updated_at)
    VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, tax_id=EXCLUDED.tax_id,
      address=EXCLUDED.address, updated_at=NOW()
    RETURNING *`, [organization.code, organization.name, organization.taxId, organization.address]);
  return result.rows[0];
}

async function upsertBalance(client, entry) {
  const key = balanceKey(entry);
  await client.query(`INSERT INTO logistics_stock_balances
    (balance_key, organization_id, item_id, asset_unit_id, lot_id, location_id, quantity, version, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,1,NOW())
    ON CONFLICT (balance_key) DO UPDATE SET quantity=logistics_stock_balances.quantity + EXCLUDED.quantity,
      version=logistics_stock_balances.version + 1, updated_at=NOW()`,
    [key, entry.organizationId, entry.itemId, entry.assetUnitId || null, entry.lotId || null, entry.locationId, entry.quantity]);
}

async function currentQuantity(client, { organizationId, itemId, assetUnitId, lotId, locationId }) {
  const key = balanceKey({ organizationId, itemId, assetUnitId, lotId, locationId });
  const result = await client.query("SELECT quantity FROM logistics_stock_balances WHERE balance_key=$1 FOR UPDATE", [key]);
  return number(result.rows[0]?.quantity);
}

async function postMovementWithClient(client, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const itemId = text(input.itemId);
  const assetUnitId = text(input.assetUnitId) || null;
  const lotId = text(input.lotId) || null;
  const fromLocationId = text(input.fromLocationId) || null;
  const toLocationId = text(input.toLocationId) || null;
  const quantity = assertPositiveQuantity(input.quantity);
  const movementType = assertMovementType(input.movementType);
  const idempotencyKey = text(input.idempotencyKey) || randomUUID();
  if (!organizationId || !itemId) throw new Error("Faltan organización o artículo.");
  if (!fromLocationId && !toLocationId) throw new Error("El movimiento debe tener origen o destino.");
  if (fromLocationId && toLocationId && fromLocationId === toLocationId) throw new Error("El origen y el destino deben ser distintos.");

  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [[organizationId, itemId, assetUnitId || "-", lotId || "-", fromLocationId || "-", toLocationId || "-"].join("|")]);
  const replay = await client.query("SELECT * FROM logistics_stock_movements WHERE organization_id=$1 AND idempotency_key=$2", [organizationId, idempotencyKey]);
  if (replay.rows[0]) return { movement: replay.rows[0], replayed: true };

  const itemResult = await client.query("SELECT * FROM logistics_items WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR SHARE", [itemId, organizationId]);
  const item = itemResult.rows[0];
  if (!item) throw new Error("Artículo inexistente o inactivo.");
  if (item.tracking_type === "SERIAL" && (!assetUnitId || quantity !== 1)) {
    throw new Error("Los activos serializados requieren una unidad física y cantidad 1.");
  }
  if (item.tracking_type === "LOT" && !lotId) throw new Error("Este artículo requiere lote.");

  if (fromLocationId) {
    const available = await currentQuantity(client, { organizationId, itemId, assetUnitId, lotId, locationId: fromLocationId });
    if (available < quantity && movementType !== "ADJUSTMENT" && movementType !== "REVERSAL") {
      throw new Error(`Stock insuficiente. Disponible: ${available}.`);
    }
  }

  const movementId = randomUUID();
  const movementResult = await client.query(`INSERT INTO logistics_stock_movements
    (id, organization_id, movement_type, status, reference_type, reference_id, idempotency_key,
     source, actor_profile_id, reversal_of, notes, occurred_at)
    VALUES ($1,$2,$3,'POSTED',$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz,NOW()))
    RETURNING *`,
    [movementId, organizationId, movementType, text(input.referenceType) || null, text(input.referenceId) || null,
      idempotencyKey, text(input.source).toUpperCase() || "MANUAL", actorProfileId, input.reversalOf || null,
      text(input.notes) || null, input.occurredAt || null]);

  const entries = [];
  if (fromLocationId) entries.push({ organizationId, itemId, assetUnitId, lotId, locationId: fromLocationId, quantity: -quantity });
  if (toLocationId) entries.push({ organizationId, itemId, assetUnitId, lotId, locationId: toLocationId, quantity });
  for (const entry of entries) {
    await client.query(`INSERT INTO logistics_stock_ledger
      (organization_id, movement_id, item_id, asset_unit_id, lot_id, location_id, quantity, occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,NOW()))`,
      [entry.organizationId, movementId, entry.itemId, entry.assetUnitId, entry.lotId, entry.locationId, entry.quantity, input.occurredAt || null]);
    await upsertBalance(client, entry);
  }

  if (assetUnitId) {
    const status = movementType === "TRANSFER_DISPATCH" ? "IN_TRANSIT"
      : movementType === "CUSTODY_ISSUE" ? "IN_CUSTODY"
      : movementType === "ISSUE" || movementType === "CONSUMPTION" ? "RETIRED"
      : "AVAILABLE";
    await client.query("UPDATE logistics_asset_units SET status=$1, updated_at=NOW() WHERE id=$2", [status, assetUnitId]);
  }

  await client.query(`INSERT INTO logistics_audit_events
    (organization_id, event_type, entity_type, entity_id, actor_profile_id, correlation_id, source, after_data, metadata)
    VALUES ($1,'STOCK_MOVEMENT_POSTED','stock_movement',$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [organizationId, movementId, actorProfileId, idempotencyKey, text(input.source).toUpperCase() || "MANUAL",
      json(movementResult.rows[0]), json({ entries })]);
  await client.query(`INSERT INTO logistics_outbox_events
    (organization_id, event_type, aggregate_type, aggregate_id, payload)
    VALUES ($1,'stock.movement.posted','stock_movement',$2,$3::jsonb)`,
    [organizationId, movementId, json({ movement: movementResult.rows[0], entries })]);
  return { movement: movementResult.rows[0], entries, replayed: false };
}

export async function postStockMovement(pool, input, actorProfileId = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await postMovementWithClient(client, input, actorProfileId);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listCanonicalItems(pool, profile, query = {}) {
  const values = [];
  const filters = ["i.active=TRUE"];
  if (text(query.search)) {
    values.push(`%${text(query.search)}%`);
    filters.push(`(i.sku ILIKE $${values.length} OR i.name ILIKE $${values.length} OR i.brand ILIKE $${values.length})`);
  }
  const result = await pool.query(`SELECT i.*, f.code AS family_code, f.name AS family_name,
      COALESCE(SUM(b.quantity),0)::numeric AS company_quantity
    FROM logistics_items i
    LEFT JOIN logistics_item_families f ON f.id=i.family_id
    LEFT JOIN logistics_stock_balances b ON b.item_id=i.id
    WHERE ${filters.join(" AND ")}
    GROUP BY i.id, f.code, f.name
    ORDER BY i.name, i.sku LIMIT 500`, values);
  return result.rows;
}

export async function stockSnapshot(pool, profile, query = {}) {
  const values = [];
  const filters = ["1=1"];
  if (text(query.itemId)) {
    values.push(text(query.itemId));
    filters.push(`b.item_id=$${values.length}`);
  }
  if (!profile?.admin) {
    values.push(profile.cost_center);
    filters.push(`cc.name=$${values.length}`);
  }
  const result = await pool.query(`SELECT b.item_id, i.sku, i.name AS item_name, i.tracking_type,
      b.asset_unit_id, u.unit_code, b.lot_id, lot.lot_number, b.location_id,
      loc.code AS location_code, loc.name AS location_name, loc.location_type,
      w.id AS warehouse_id, w.name AS warehouse_name, cc.name AS cost_center,
      b.quantity, b.version, b.updated_at
    FROM logistics_stock_balances b
    JOIN logistics_items i ON i.id=b.item_id
    JOIN logistics_locations loc ON loc.id=b.location_id
    LEFT JOIN logistics_warehouses w ON w.id=loc.warehouse_id
    LEFT JOIN logistics_cost_centers cc ON cc.id=w.cost_center_id
    LEFT JOIN logistics_asset_units u ON u.id=b.asset_unit_id
    LEFT JOIN logistics_lots lot ON lot.id=b.lot_id
    WHERE ${filters.join(" AND ")} AND b.quantity<>0
    ORDER BY i.name, w.name, loc.name, u.unit_code`, values);
  return result.rows;
}

export async function createTransfer(pool, input, actorProfileId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const organizationId = text(input.organizationId);
    const lines = Array.isArray(input.lines) ? input.lines : [];
    if (!organizationId || !text(input.sourceWarehouseId) || !text(input.destinationWarehouseId) || !lines.length) {
      throw new Error("Completa origen, destino y al menos una línea.");
    }
    if (input.sourceWarehouseId === input.destinationWarehouseId) throw new Error("Origen y destino deben ser distintos.");
    const sequence = await client.query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(transfer_number,'\\D','','g'),'')::bigint),0)+1 AS next
      FROM logistics_transfer_orders WHERE organization_id=$1`, [organizationId]);
    const transferNumber = text(input.transferNumber) || `TR-${String(sequence.rows[0].next).padStart(6, "0")}`;
    const transfer = await client.query(`INSERT INTO logistics_transfer_orders
      (organization_id, transfer_number, source_warehouse_id, destination_warehouse_id, transit_location_id,
       status, requested_by, notes)
      VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,$7) RETURNING *`,
      [organizationId, transferNumber, input.sourceWarehouseId, input.destinationWarehouseId,
        input.transitLocationId || null, actorProfileId, text(input.notes) || null]);
    for (const line of lines) {
      const quantity = assertPositiveQuantity(line.quantity);
      await client.query(`INSERT INTO logistics_transfer_lines
        (transfer_id, item_id, asset_unit_id, lot_id, quantity_requested)
        VALUES ($1,$2,$3,$4,$5)`,
        [transfer.rows[0].id, line.itemId, line.assetUnitId || null, line.lotId || null, quantity]);
    }
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,after_data)
      VALUES ($1,'TRANSFER_CREATED','transfer',$2,$3,'MANUAL',$4::jsonb)`,
      [organizationId, transfer.rows[0].id, actorProfileId, json({ transfer: transfer.rows[0], lines })]);
    await client.query("COMMIT");
    return transfer.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function warehouseLocation(client, warehouseId, preferredType = "STORAGE") {
  const result = await client.query(`SELECT * FROM logistics_locations
    WHERE warehouse_id=$1 AND active=TRUE
    ORDER BY CASE WHEN location_type=$2 THEN 0 ELSE 1 END, created_at
    LIMIT 1`, [warehouseId, preferredType]);
  if (!result.rows[0]) throw new Error("La bodega no tiene una ubicación operativa configurada.");
  return result.rows[0];
}

export async function dispatchTransfer(pool, transferId, input, actorProfileId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const transferResult = await client.query("SELECT * FROM logistics_transfer_orders WHERE id=$1 FOR UPDATE", [transferId]);
    const transfer = transferResult.rows[0];
    if (!transfer) throw new Error("Traslado no encontrado.");
    if (!["DRAFT", "RELEASED"].includes(transfer.status)) {
      if (transfer.status === "IN_TRANSIT") {
        await client.query("COMMIT");
        return { ...transfer, replayed: true };
      }
      throw new Error("El traslado no se puede despachar en su estado actual.");
    }
    const source = await warehouseLocation(client, transfer.source_warehouse_id, "STORAGE");
    let transit = transfer.transit_location_id
      ? (await client.query("SELECT * FROM logistics_locations WHERE id=$1", [transfer.transit_location_id])).rows[0]
      : null;
    if (!transit) {
      transit = (await client.query(`SELECT * FROM logistics_locations
        WHERE organization_id=$1 AND location_type='TRANSIT' AND active=TRUE ORDER BY created_at LIMIT 1`,
        [transfer.organization_id])).rows[0];
    }
    if (!transit) throw new Error("No existe una ubicación de tránsito.");
    const lines = (await client.query("SELECT * FROM logistics_transfer_lines WHERE transfer_id=$1 ORDER BY created_at FOR UPDATE", [transferId])).rows;
    for (const line of lines) {
      await postMovementWithClient(client, {
        organizationId: transfer.organization_id,
        itemId: line.item_id,
        assetUnitId: line.asset_unit_id,
        lotId: line.lot_id,
        fromLocationId: source.id,
        toLocationId: transit.id,
        quantity: line.quantity_requested,
        movementType: "TRANSFER_DISPATCH",
        referenceType: "transfer",
        referenceId: transfer.id,
        idempotencyKey: `${text(input.idempotencyKey) || `transfer:${transfer.id}:dispatch`}:${line.id}`,
        source: input.source || "MANUAL",
        notes: input.notes || transfer.notes
      }, actorProfileId);
      await client.query(`UPDATE logistics_transfer_lines SET quantity_dispatched=quantity_requested,updated_at=NOW() WHERE id=$1`, [line.id]);
    }
    const updated = await client.query(`UPDATE logistics_transfer_orders SET status='IN_TRANSIT',
      transit_location_id=$1,dispatched_by=$2,dispatched_at=NOW(),updated_at=NOW() WHERE id=$3 RETURNING *`,
      [transit.id, actorProfileId, transfer.id]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,'transfer.dispatched','transfer',$2,$3::jsonb)`,
      [transfer.organization_id, transfer.id, json({ transfer: updated.rows[0] })]);
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function receiveTransfer(pool, transferId, input, actorProfileId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const transferResult = await client.query("SELECT * FROM logistics_transfer_orders WHERE id=$1 FOR UPDATE", [transferId]);
    const transfer = transferResult.rows[0];
    if (!transfer) throw new Error("Traslado no encontrado.");
    if (transfer.status === "RECEIVED") {
      await client.query("COMMIT");
      return { ...transfer, replayed: true };
    }
    if (!["IN_TRANSIT", "PARTIALLY_RECEIVED"].includes(transfer.status)) {
      throw new Error("El traslado todavía no está disponible para recepción.");
    }
    const destination = await warehouseLocation(client, transfer.destination_warehouse_id, "STORAGE");
    const transit = (await client.query("SELECT * FROM logistics_locations WHERE id=$1", [transfer.transit_location_id])).rows[0];
    if (!transit) throw new Error("El traslado no tiene ubicación de tránsito.");
    const requestedLines = new Map((Array.isArray(input.lines) ? input.lines : []).map(line => [text(line.lineId), line]));
    const lines = (await client.query("SELECT * FROM logistics_transfer_lines WHERE transfer_id=$1 ORDER BY created_at FOR UPDATE", [transferId])).rows;
    let receivedSomething = false;
    for (const line of lines) {
      const remaining = number(line.quantity_dispatched) - number(line.quantity_received);
      if (remaining <= 0) continue;
      const request = requestedLines.get(line.id);
      const quantity = request ? assertPositiveQuantity(request.quantity) : (requestedLines.size ? 0 : remaining);
      if (!quantity) continue;
      if (quantity > remaining) throw new Error("La recepción supera la cantidad pendiente.");
      const newTotal = number(line.quantity_received) + quantity;
      await postMovementWithClient(client, {
        organizationId: transfer.organization_id,
        itemId: line.item_id,
        assetUnitId: line.asset_unit_id,
        lotId: line.lot_id,
        fromLocationId: transit.id,
        toLocationId: destination.id,
        quantity,
        movementType: "TRANSFER_RECEIPT",
        referenceType: "transfer",
        referenceId: transfer.id,
        idempotencyKey: `${text(input.idempotencyKey) || `transfer:${transfer.id}:receive:${newTotal}`}:${line.id}`,
        source: input.source || "MANUAL",
        notes: request?.discrepancyReason || input.notes || ""
      }, actorProfileId);
      await client.query(`UPDATE logistics_transfer_lines SET quantity_received=$1,
        discrepancy_reason=COALESCE($2,discrepancy_reason),updated_at=NOW() WHERE id=$3`,
        [newTotal, text(request?.discrepancyReason) || null, line.id]);
      receivedSomething = true;
    }
    if (!receivedSomething) throw new Error("No hay cantidades pendientes para recibir.");
    const pending = await client.query(`SELECT COUNT(*)::int AS count FROM logistics_transfer_lines
      WHERE transfer_id=$1 AND quantity_received < quantity_dispatched`, [transfer.id]);
    const complete = pending.rows[0].count === 0;
    const updated = await client.query(`UPDATE logistics_transfer_orders SET status=$1,received_by=$2,
      received_at=CASE WHEN $1='RECEIVED' THEN NOW() ELSE received_at END,updated_at=NOW()
      WHERE id=$3 RETURNING *`, [complete ? "RECEIVED" : "PARTIALLY_RECEIVED", actorProfileId, transfer.id]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,$2,'transfer',$3,$4::jsonb)`,
      [transfer.organization_id, complete ? "transfer.received" : "transfer.partially_received",
        transfer.id, json({ transfer: updated.rows[0] })]);
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listWarehouses(pool, profile) {
  const values = [];
  let filter = "w.active=TRUE";
  if (!profile?.admin) {
    values.push(profile.cost_center);
    filter += ` AND cc.name=$${values.length}`;
  }
  const result = await pool.query(`SELECT w.*,cc.name AS cost_center,s.name AS site_name,
      COALESCE(json_agg(json_build_object('id',loc.id,'code',loc.code,'name',loc.name,'type',loc.location_type))
        FILTER (WHERE loc.id IS NOT NULL),'[]'::json) AS locations
    FROM logistics_warehouses w
    LEFT JOIN logistics_cost_centers cc ON cc.id=w.cost_center_id
    LEFT JOIN logistics_sites s ON s.id=w.site_id
    LEFT JOIN logistics_locations loc ON loc.warehouse_id=w.id AND loc.active=TRUE
    WHERE ${filter}
    GROUP BY w.id,cc.name,s.name ORDER BY w.name`, values);
  return result.rows;
}

export async function listTransfers(pool, profile) {
  const values = [];
  let filter = "1=1";
  if (!profile?.admin) {
    values.push(profile.cost_center);
    filter += ` AND (source_cc.name=$${values.length} OR destination_cc.name=$${values.length})`;
  }
  const result = await pool.query(`SELECT t.*,source_w.name AS source_warehouse,
      destination_w.name AS destination_warehouse,
      COALESCE(json_agg(json_build_object(
        'id',line.id,'itemId',line.item_id,'sku',item.sku,'name',item.name,
        'assetUnitId',line.asset_unit_id,'unitCode',unit.unit_code,'lotId',line.lot_id,
        'requested',line.quantity_requested,'dispatched',line.quantity_dispatched,
        'received',line.quantity_received,'discrepancyReason',line.discrepancy_reason
      ) ORDER BY line.created_at) FILTER (WHERE line.id IS NOT NULL),'[]'::json) AS lines
    FROM logistics_transfer_orders t
    JOIN logistics_warehouses source_w ON source_w.id=t.source_warehouse_id
    JOIN logistics_warehouses destination_w ON destination_w.id=t.destination_warehouse_id
    LEFT JOIN logistics_cost_centers source_cc ON source_cc.id=source_w.cost_center_id
    LEFT JOIN logistics_cost_centers destination_cc ON destination_cc.id=destination_w.cost_center_id
    LEFT JOIN logistics_transfer_lines line ON line.transfer_id=t.id
    LEFT JOIN logistics_items item ON item.id=line.item_id
    LEFT JOIN logistics_asset_units unit ON unit.id=line.asset_unit_id
    WHERE ${filter}
    GROUP BY t.id,source_w.name,destination_w.name
    ORDER BY t.requested_at DESC LIMIT 250`, values);
  return result.rows;
}

export async function backfillLegacyState(pool) {
  const stateResult = await pool.query("SELECT payload FROM inventory_app_state WHERE id=1");
  const state = stateResult.rows[0]?.payload;
  if (!state) return { skipped: true, reason: "Sin estado anterior" };
  const organizationData = state.organization || {};
  const organization = await ensureDefaultOrganization(pool, {
    ...DEFAULT_ORG,
    name: organizationData.name || DEFAULT_ORG.name,
    taxId: organizationData.rut || organizationData.taxId || DEFAULT_ORG.taxId,
    address: organizationData.address || DEFAULT_ORG.address
  });

  const centerMap = new Map();
  const warehouseMap = new Map();
  const locationMap = new Map();
  for (const center of state.costCenters || []) {
    const legacyKey = text(center.id || center.name);
    const code = slug(center.id || center.name, `CC-${centerMap.size + 1}`);
    const cc = await pool.query(`INSERT INTO logistics_cost_centers
      (organization_id, legacy_key, code, name, updated_at)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (organization_id, legacy_key) DO UPDATE SET name=EXCLUDED.name, updated_at=NOW()
      RETURNING *`, [organization.id, legacyKey, code, center.name]);
    centerMap.set(center.name, cc.rows[0]);
    const site = await pool.query(`INSERT INTO logistics_sites (organization_id,cost_center_id,code,name,active,updated_at)
      VALUES ($1,$2,$3,$4,TRUE,NOW())
      ON CONFLICT (organization_id,code) DO UPDATE SET name=EXCLUDED.name,cost_center_id=EXCLUDED.cost_center_id,updated_at=NOW()
      RETURNING *`, [organization.id, cc.rows[0].id, `SITE-${code}`, center.name]);
    const warehouseType = /tr[aá]nsito/i.test(center.name) ? "TRANSIT" : "PHYSICAL";
    const warehouse = await pool.query(`INSERT INTO logistics_warehouses
      (organization_id,site_id,cost_center_id,legacy_key,code,name,warehouse_type,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (organization_id,legacy_key) DO UPDATE SET name=EXCLUDED.name,cost_center_id=EXCLUDED.cost_center_id,updated_at=NOW()
      RETURNING *`, [organization.id, site.rows[0].id, cc.rows[0].id, legacyKey, `WH-${code}`, center.name, warehouseType]);
    warehouseMap.set(center.name, warehouse.rows[0]);
    const locationType = warehouseType === "TRANSIT" ? "TRANSIT" : "STORAGE";
    const location = await pool.query(`INSERT INTO logistics_locations
      (organization_id,warehouse_id,legacy_key,code,name,location_type,barcode,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (organization_id,legacy_key) DO UPDATE SET name=EXCLUDED.name,warehouse_id=EXCLUDED.warehouse_id,updated_at=NOW()
      RETURNING *`, [organization.id, warehouse.rows[0].id, legacyKey, `LOC-${code}`, center.name, locationType, `LOC-${code}`]);
    locationMap.set(center.name, location.rows[0]);
  }
  if (!locationMap.has("En tránsito")) {
    const cc = await pool.query(`INSERT INTO logistics_cost_centers (organization_id,legacy_key,code,name)
      VALUES ($1,'transit','TRANSIT','En tránsito')
      ON CONFLICT (organization_id,legacy_key) DO UPDATE SET name=EXCLUDED.name RETURNING *`, [organization.id]);
    const warehouse = await pool.query(`INSERT INTO logistics_warehouses
      (organization_id,cost_center_id,legacy_key,code,name,warehouse_type)
      VALUES ($1,$2,'transit','WH-TRANSIT','En tránsito','TRANSIT')
      ON CONFLICT (organization_id,legacy_key) DO UPDATE SET name=EXCLUDED.name RETURNING *`, [organization.id, cc.rows[0].id]);
    const location = await pool.query(`INSERT INTO logistics_locations
      (organization_id,warehouse_id,legacy_key,code,name,location_type,barcode)
      VALUES ($1,$2,'transit','LOC-TRANSIT','En tránsito','TRANSIT','LOC-TRANSIT')
      ON CONFLICT (organization_id,legacy_key) DO UPDATE SET name=EXCLUDED.name RETURNING *`, [organization.id, warehouse.rows[0].id]);
    centerMap.set("En tránsito", cc.rows[0]);
    warehouseMap.set("En tránsito", warehouse.rows[0]);
    locationMap.set("En tránsito", location.rows[0]);
  }

  const familyMap = new Map();
  for (const family of state.families || []) {
    const legacyKey = text(family.id || family.prefix || family.name);
    const familyResult = await pool.query(`INSERT INTO logistics_item_families
      (organization_id,legacy_key,code,name,inspection_template_legacy_key,updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (organization_id,legacy_key) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name,
        inspection_template_legacy_key=EXCLUDED.inspection_template_legacy_key,updated_at=NOW()
      RETURNING *`, [organization.id, legacyKey, slug(family.prefix || family.name), family.name, family.inspection || null]);
    familyMap.set(family.id, familyResult.rows[0]);
  }

  let importedItems = 0;
  let importedUnits = 0;
  let openingMovements = 0;
  for (const asset of state.assets || []) {
    const baseCode = text(asset.baseCode || asset.code);
    const itemLegacyKey = `item:${baseCode}`;
    const consumable = asset.type === "Consumible";
    const isPpe = Boolean(asset.isPpe || asset.epp || /epp/i.test(text(asset.type)));
    const itemType = isPpe ? "PPE" : consumable ? "CONSUMABLE" : "ASSET";
    const family = familyMap.get(asset.family);
    const itemResult = await pool.query(`INSERT INTO logistics_items
      (organization_id,family_id,legacy_key,sku,name,description,item_type,tracking_type,brand,minimum_stock,metadata,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,NOW())
      ON CONFLICT (organization_id,legacy_key) DO UPDATE SET name=EXCLUDED.name,family_id=EXCLUDED.family_id,
        brand=EXCLUDED.brand,minimum_stock=EXCLUDED.minimum_stock,metadata=EXCLUDED.metadata,updated_at=NOW()
      RETURNING *`, [organization.id, family?.id || null, itemLegacyKey, baseCode, asset.name,
        asset.description || "", itemType, consumable ? "NONE" : "SERIAL", asset.brand || "",
        number(asset.minimum), json({ legacy: true, original: asset })]);
    const item = itemResult.rows[0];
    importedItems += 1;
    let assetUnitId = null;
    if (!consumable) {
      const unitResult = await pool.query(`INSERT INTO logistics_asset_units
        (organization_id,item_id,legacy_key,unit_code,manufacturer_serial,status,metadata,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW())
        ON CONFLICT (organization_id,legacy_key) DO UPDATE SET unit_code=EXCLUDED.unit_code,
          manufacturer_serial=EXCLUDED.manufacturer_serial,metadata=EXCLUDED.metadata,updated_at=NOW()
        RETURNING *`, [organization.id, item.id, `unit:${asset.id}`, asset.code, asset.serial || null,
          String(asset.status || "").toLowerCase() === "bloqueado" ? "BLOCKED" : "AVAILABLE",
          json({ legacy: true, original: asset })]);
      assetUnitId = unitResult.rows[0].id;
      importedUnits += 1;
    }

    let stocks = Object.entries(asset.stocks || {}).filter(([, qty]) => number(qty) > 0);
    if (!stocks.length && number(asset.stock) > 0) stocks = [[asset.location || "Bodega Central", number(asset.stock)]];
    if (!stocks.length && !consumable) stocks = [[asset.location || "Bodega Central", 1]];
    if (assetUnitId && stocks.length > 1) stocks = [stocks.sort((a, b) => number(b[1]) - number(a[1]))[0]];
    for (const [centerName, rawQuantity] of stocks) {
      const location = locationMap.get(centerName) || locationMap.get(asset.location) || locationMap.get("Bodega Central");
      if (!location) continue;
      const quantity = assetUnitId ? 1 : number(rawQuantity);
      const result = await postStockMovement(pool, {
        organizationId: organization.id,
        itemId: item.id,
        assetUnitId,
        toLocationId: location.id,
        quantity,
        movementType: "OPENING",
        referenceType: "legacy_asset",
        referenceId: asset.id,
        idempotencyKey: `legacy-opening:${asset.id}:${centerName}`,
        source: "LEGACY_BACKFILL",
        notes: "Saldo inicial migrado sin alterar el sistema anterior."
      });
      if (!result.replayed) openingMovements += 1;
    }
  }

  for (const [index, movement] of (state.movements || []).entries()) {
    const entityId = text(movement.id || `legacy-${index}-${movement.code}-${movement.date}`);
    await pool.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,source,after_data,metadata,occurred_at)
      VALUES ($1,'LEGACY_MOVEMENT','legacy_movement',$2,'LEGACY_BACKFILL',$3::jsonb,$4::jsonb,
        COALESCE($5::timestamptz,NOW()))
      ON CONFLICT DO NOTHING`, [organization.id, entityId, json(movement), json({ importedOnlyForHistory: true }),
        /^\d{4}-\d{2}-\d{2}/.test(text(movement.date)) ? movement.date : null]);
  }

  return { organizationId: organization.id, importedItems, importedUnits, openingMovements };
}

export async function logisticsHealth(pool) {
  const result = await pool.query(`SELECT
    (SELECT COUNT(*) FROM logistics_items) AS items,
    (SELECT COUNT(*) FROM logistics_asset_units) AS asset_units,
    (SELECT COUNT(*) FROM logistics_stock_movements) AS movements,
    (SELECT COUNT(*) FROM logistics_stock_ledger) AS ledger_entries,
    (SELECT COUNT(*) FROM logistics_transfer_orders) AS transfers,
    (SELECT COUNT(*) FROM logistics_schema_migrations) AS migrations`);
  return result.rows[0];
}

export const logisticsValidation = {
  assertPositiveQuantity,
  assertMovementType,
  balanceKey,
  slug
};
