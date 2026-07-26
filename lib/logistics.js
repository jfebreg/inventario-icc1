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

  if (item.tracking_type === "LOT") {
    const lot = (await client.query(`SELECT * FROM logistics_lots
      WHERE id=$1 AND organization_id=$2 AND item_id=$3 FOR SHARE`, [lotId, organizationId, itemId])).rows[0];
    if (!lot) throw new Error("El lote no pertenece a este artículo.");
    const quarantineReceipt = lot.status === "QUARANTINE" && movementType === "RECEIPT";
    if (lot.status !== "ACTIVE" && !quarantineReceipt) {
      throw new Error(`El lote ${lot.lot_number} no está disponible: ${lot.status}.`);
    }
    if (lot.expires_at && String(lot.expires_at).slice(0, 10) < new Date().toISOString().slice(0, 10)
      && !["ADJUSTMENT", "REVERSAL"].includes(movementType)) {
      throw new Error(`El lote ${lot.lot_number} está vencido y no puede utilizarse.`);
    }
  } else if (lotId) {
    throw new Error("Este artículo no admite control por lote.");
  }

  const movementLocations = [fromLocationId, toLocationId].filter(Boolean);
  if (movementLocations.length && text(input.referenceType) !== "cycle_count") {
    const frozen = await client.query(`SELECT cycle.count_number
      FROM logistics_cycle_count_lines line
      JOIN logistics_cycle_counts cycle ON cycle.id=line.count_id
      WHERE cycle.organization_id=$1 AND line.item_id=$2
        AND line.location_id=ANY($3::uuid[])
        AND cycle.status IN ('DRAFT','IN_PROGRESS')
      LIMIT 1`, [organizationId, itemId, movementLocations]);
    if (frozen.rows[0]) {
      throw new Error(`El producto está temporalmente bloqueado por el conteo ${frozen.rows[0].count_number}.`);
    }
  }

  if (fromLocationId) {
    const onHand = await currentQuantity(client, { organizationId, itemId, assetUnitId, lotId, locationId: fromLocationId });
    const ownRequestId = text(input.referenceType) === "material_request" ? text(input.referenceId) || null : null;
    const reservedResult = await client.query(`SELECT COALESCE(SUM(quantity),0)::numeric AS quantity
      FROM logistics_stock_reservations
      WHERE organization_id=$1 AND item_id=$2 AND location_id=$3 AND status='ACTIVE'
        AND asset_unit_id IS NOT DISTINCT FROM $4::uuid
        AND lot_id IS NOT DISTINCT FROM $5::uuid
        AND ($6::uuid IS NULL OR request_id<>$6::uuid)`,
      [organizationId, itemId, fromLocationId, assetUnitId, lotId, ownRequestId]);
    const available = onHand - number(reservedResult.rows[0]?.quantity);
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
      COALESCE((SELECT SUM(b.quantity) FROM logistics_stock_balances b WHERE b.item_id=i.id),0)::numeric AS company_quantity,
      COALESCE((SELECT json_agg(json_build_object(
        'id',u.id,'unitCode',u.unit_code,'manufacturerSerial',u.manufacturer_serial,'status',u.status
      ) ORDER BY u.unit_code) FROM logistics_asset_units u WHERE u.item_id=i.id),'[]'::json) AS units,
      COALESCE((SELECT json_agg(json_build_object(
        'id',lot.id,'lotNumber',lot.lot_number,'manufacturedAt',lot.manufactured_at,
        'expiresAt',lot.expires_at,'status',lot.status,'supplierId',lot.supplier_id
      ) ORDER BY lot.expires_at NULLS LAST,lot.lot_number)
      FROM logistics_lots lot WHERE lot.item_id=i.id),'[]'::json) AS lots
    FROM logistics_items i
    LEFT JOIN logistics_item_families f ON f.id=i.family_id
    WHERE ${filters.join(" AND ")}
    ORDER BY i.name, i.sku LIMIT 500`, values);
  return result.rows;
}

export async function registerItemFamily(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const legacyKey = text(input.legacyKey);
  const code = slug(input.code);
  const name = text(input.name);
  if (!organizationId || !legacyKey || !code || !name) {
    throw new Error("Organización, identificador, abreviatura y nombre de familia son obligatorios.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`family:${organizationId}:${legacyKey}`]);
    const beforeResult = await client.query(`SELECT * FROM logistics_item_families
      WHERE organization_id=$1 AND legacy_key=$2 FOR UPDATE`, [organizationId, legacyKey]);
    const result = await client.query(`INSERT INTO logistics_item_families
      (organization_id,legacy_key,code,name,inspection_template_legacy_key,active,updated_at)
      VALUES ($1,$2,$3,$4,$5,TRUE,NOW())
      ON CONFLICT (organization_id,legacy_key) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name,
        inspection_template_legacy_key=EXCLUDED.inspection_template_legacy_key,active=TRUE,updated_at=NOW()
      RETURNING *`, [organizationId, legacyKey, code, name, text(input.inspectionTemplateKey) || null]);
    const family = result.rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,before_data,after_data,metadata)
      VALUES ($1,$2,'item_family',$3,$4,$5,'WEB',$6::jsonb,$7::jsonb,$8::jsonb)`,
      [organizationId, beforeResult.rows[0] ? "ITEM_FAMILY_UPDATED" : "ITEM_FAMILY_REGISTERED",
        family.id, actorProfileId, legacyKey, json(beforeResult.rows[0] || null), json(family),
        json({ serial: Boolean(input.serial) })]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,$2,'item_family',$3,$4::jsonb)`,
      [organizationId, beforeResult.rows[0] ? "item_family.updated" : "item_family.registered",
        family.id, json({ family })]);
    await client.query("COMMIT");
    return { family, created: !beforeResult.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function registerCanonicalDocument(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const fileObjectId = text(input.fileObjectId);
  const legacyId = text(input.legacyId) || fileObjectId;
  const documentType = text(input.documentType) || "OTHER";
  const title = text(input.title);
  if (!organizationId || !fileObjectId || !title) throw new Error("Organización, archivo y título son obligatorios.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`document:${organizationId}:${legacyId}`]);
    const previous = await client.query(`SELECT canonical_id FROM logistics_legacy_links
      WHERE organization_id=$1 AND legacy_type='file_document' AND legacy_id=$2`, [organizationId, legacyId]);
    if (previous.rows[0]) {
      const existing = await client.query("SELECT * FROM logistics_documents WHERE id=$1", [previous.rows[0].canonical_id]);
      await client.query("COMMIT");
      return { document: existing.rows[0], replayed: true };
    }
    const fileExists = await client.query("SELECT 1 FROM inventory_file_objects WHERE id=$1", [fileObjectId]);
    if (!fileExists.rowCount) throw new Error("El archivo almacenado no existe.");
    const result = await client.query(`INSERT INTO logistics_documents
      (organization_id,file_object_id,document_type,document_number,title,sha256,version,status,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,1,'ACTIVE',$7) RETURNING *`,
      [organizationId, fileObjectId, documentType, text(input.documentNumber) || null,
        title, text(input.sha256) || null, actorProfileId]);
    const document = result.rows[0];
    if (text(input.entityType) && text(input.entityId)) {
      await client.query(`INSERT INTO logistics_document_links
        (document_id,entity_type,entity_id,relationship) VALUES ($1,$2,$3,$4)
        ON CONFLICT DO NOTHING`, [document.id, text(input.entityType), text(input.entityId),
          text(input.relationship).toUpperCase() || "EVIDENCE"]);
    }
    await client.query(`INSERT INTO logistics_legacy_links
      (organization_id,legacy_type,legacy_id,canonical_type,canonical_id,metadata)
      VALUES ($1,'file_document',$2,'document',$3,$4::jsonb)`,
      [organizationId, legacyId, document.id, json({ fileObjectId, entityType: text(input.entityType), entityId: text(input.entityId) })]);
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data,metadata)
      VALUES ($1,'DOCUMENT_REGISTERED','document',$2,$3,$4,'UPLOAD',$5::jsonb,$6::jsonb)`,
      [organizationId, document.id, actorProfileId, legacyId, json(document),
        json({ entityType: text(input.entityType), entityId: text(input.entityId), sha256: text(input.sha256) })]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,'document.registered','document',$2,$3::jsonb)`,
      [organizationId, document.id, json({ document, entityType: text(input.entityType), entityId: text(input.entityId) })]);
    await client.query("COMMIT");
    return { document, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function registerCanonicalItem(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const sku = text(input.sku).toUpperCase();
  const name = text(input.name);
  const family = input.family || {};
  const itemType = text(input.itemType || "ASSET").toUpperCase();
  const trackingType = text(input.trackingType || "SERIAL").toUpperCase();
  const allowedItemTypes = new Set(["ASSET", "CONSUMABLE", "PPE", "TOOL", "SPARE_PART"]);
  const allowedTracking = new Set(["NONE", "LOT", "SERIAL"]);
  if (trackingType === "LOT" && !(input.lots || []).length) {
    throw new Error("El artículo controlado por lote requiere al menos un lote.");
  }
  if (!organizationId || !sku || !name) throw new Error("Organización, código y nombre son obligatorios.");
  if (!allowedItemTypes.has(itemType) || !allowedTracking.has(trackingType)) throw new Error("Clasificación de artículo no permitida.");
  const client = await pool.connect();
  let item;
  let units = [];
  let lots = [];
  try {
    await client.query("BEGIN");
    const familyCode = text(family.code || "GENERAL").toUpperCase();
    const familyResult = await client.query(`INSERT INTO logistics_item_families
      (organization_id,legacy_key,code,name,inspection_template_legacy_key,updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (organization_id,code) DO UPDATE SET name=EXCLUDED.name,
        inspection_template_legacy_key=EXCLUDED.inspection_template_legacy_key,updated_at=NOW()
      RETURNING *`, [organizationId, text(family.legacyKey) || familyCode, familyCode,
        text(family.name) || familyCode, text(family.inspection) || null]);
    const itemResult = await client.query(`INSERT INTO logistics_items
      (organization_id,family_id,legacy_key,sku,name,description,item_type,tracking_type,
       unit_of_measure,brand,minimum_stock,metadata,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,NOW())
      ON CONFLICT (organization_id,sku) DO UPDATE SET name=EXCLUDED.name,
        family_id=EXCLUDED.family_id,description=EXCLUDED.description,item_type=EXCLUDED.item_type,
        tracking_type=EXCLUDED.tracking_type,unit_of_measure=EXCLUDED.unit_of_measure,
        brand=EXCLUDED.brand,minimum_stock=EXCLUDED.minimum_stock,metadata=EXCLUDED.metadata,updated_at=NOW()
      RETURNING *`, [organizationId, familyResult.rows[0].id, text(input.legacyKey) || sku, sku, name,
        text(input.description) || null, itemType, trackingType, text(input.unitOfMeasure) || "UN",
        text(input.brand) || null, Math.max(0, number(input.minimumStock)), json(input.metadata)]);
    item = itemResult.rows[0];
    for (const unitInput of input.units || []) {
      const unitCode = text(unitInput.unitCode).toUpperCase();
      if (!unitCode) throw new Error("Cada unidad serializada requiere un código.");
      const unitResult = await client.query(`INSERT INTO logistics_asset_units
        (organization_id,item_id,legacy_key,unit_code,manufacturer_serial,status,metadata,updated_at)
        VALUES ($1,$2,$3,$4,$5,'AVAILABLE',$6::jsonb,NOW())
        ON CONFLICT (organization_id,unit_code) DO UPDATE SET item_id=EXCLUDED.item_id,
          manufacturer_serial=COALESCE(EXCLUDED.manufacturer_serial,logistics_asset_units.manufacturer_serial),
          metadata=EXCLUDED.metadata,updated_at=NOW()
        RETURNING *`, [organizationId, item.id, text(unitInput.legacyKey) || unitCode, unitCode,
          text(unitInput.manufacturerSerial) || null, json(unitInput.metadata)]);
      units.push(unitResult.rows[0]);
    }
    for (const lotInput of input.lots || []) {
      const lotNumber = text(lotInput.lotNumber).toUpperCase();
      if (!lotNumber) throw new Error("Cada lote requiere un número identificador.");
      const manufacturedAt = text(lotInput.manufacturedAt) || null;
      const expiresAt = text(lotInput.expiresAt) || null;
      if (manufacturedAt && expiresAt && manufacturedAt > expiresAt) {
        throw new Error(`El lote ${lotNumber} vence antes de su fecha de fabricación.`);
      }
      const lotResult = await client.query(`INSERT INTO logistics_lots
        (organization_id,item_id,lot_number,manufactured_at,expires_at,supplier_id,status,metadata,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7::jsonb,NOW())
        ON CONFLICT (organization_id,item_id,lot_number) DO UPDATE SET
          manufactured_at=COALESCE(EXCLUDED.manufactured_at,logistics_lots.manufactured_at),
          expires_at=COALESCE(EXCLUDED.expires_at,logistics_lots.expires_at),
          supplier_id=COALESCE(EXCLUDED.supplier_id,logistics_lots.supplier_id),
          metadata=logistics_lots.metadata || EXCLUDED.metadata,updated_at=NOW()
        RETURNING *`, [organizationId, item.id, lotNumber, manufacturedAt, expiresAt,
        text(lotInput.supplierId) || null, json(lotInput.metadata)]);
      lots.push({ ...lotResult.rows[0], openingQuantity: Math.max(0, number(lotInput.quantity)) });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const locationId = text(input.initialLocationId);
  const openingMovements = [];
  if (locationId) {
    if (trackingType === "SERIAL") {
      for (const unit of units) {
        openingMovements.push(await postStockMovement(pool, {
          organizationId, itemId: item.id, assetUnitId: unit.id, quantity: 1,
          toLocationId: locationId, movementType: "OPENING", source: "MANUAL",
          referenceType: "item_registration", referenceId: unit.unit_code,
          idempotencyKey: `item-opening:${unit.unit_code}:${locationId}`,
          notes: text(input.notes) || "Registro inicial de unidad"
        }, actorProfileId));
      }
    } else if (trackingType === "LOT") {
      for (const lot of lots) {
        if (!(lot.openingQuantity > 0)) continue;
        openingMovements.push(await postStockMovement(pool, {
          organizationId, itemId: item.id, lotId: lot.id, quantity: lot.openingQuantity,
          toLocationId: locationId, movementType: "OPENING", source: "MANUAL",
          referenceType: "lot_registration", referenceId: lot.lot_number,
          idempotencyKey: `lot-opening:${item.id}:${lot.id}:${locationId}`,
          notes: text(input.notes) || `Registro inicial del lote ${lot.lot_number}`
        }, actorProfileId));
      }
    } else if (number(input.initialQuantity) > 0) {
      openingMovements.push(await postStockMovement(pool, {
        organizationId, itemId: item.id, quantity: number(input.initialQuantity),
        toLocationId: locationId, movementType: "OPENING", source: "MANUAL",
        referenceType: "item_registration", referenceId: sku,
        idempotencyKey: `item-opening:${sku}:${locationId}`,
        notes: text(input.notes) || "Registro inicial de artículo"
      }, actorProfileId));
    }
  }
  return { item, units, lots, openingMovements };
}

export async function receiveLot(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const itemId = text(input.itemId);
  const locationId = text(input.toLocationId);
  const lotNumber = text(input.lotNumber).toUpperCase();
  const quantity = assertPositiveQuantity(input.quantity);
  if (!organizationId || !itemId || !locationId || !lotNumber) {
    throw new Error("Completa artículo, ubicación, lote y cantidad.");
  }
  const manufacturedAt = text(input.manufacturedAt) || null;
  const expiresAt = text(input.expiresAt) || null;
  if (manufacturedAt && expiresAt && manufacturedAt > expiresAt) {
    throw new Error("La fecha de vencimiento no puede ser anterior a la fabricación.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",
      [`lot-receipt:${organizationId}:${itemId}:${lotNumber}`]);
    const item = (await client.query(`SELECT * FROM logistics_items
      WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR SHARE`, [itemId, organizationId])).rows[0];
    if (!item) throw new Error("Artículo inexistente o inactivo.");
    if (item.tracking_type !== "LOT") throw new Error("Este artículo no está configurado para control por lote.");
    const location = (await client.query(`SELECT * FROM logistics_locations
      WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR SHARE`, [locationId, organizationId])).rows[0];
    if (!location) throw new Error("La ubicación de recepción no existe o está inactiva.");
    const lot = (await client.query(`INSERT INTO logistics_lots
      (organization_id,item_id,lot_number,manufactured_at,expires_at,supplier_id,status,metadata,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7::jsonb,NOW())
      ON CONFLICT (organization_id,item_id,lot_number) DO UPDATE SET
        manufactured_at=COALESCE(EXCLUDED.manufactured_at,logistics_lots.manufactured_at),
        expires_at=COALESCE(EXCLUDED.expires_at,logistics_lots.expires_at),
        supplier_id=COALESCE(EXCLUDED.supplier_id,logistics_lots.supplier_id),
        metadata=logistics_lots.metadata || EXCLUDED.metadata,updated_at=NOW()
      RETURNING *`, [organizationId, itemId, lotNumber, manufacturedAt, expiresAt,
      text(input.supplierId) || null, json(input.metadata)])).rows[0];
    const posted = await postMovementWithClient(client, {
      organizationId, itemId, lotId: lot.id, quantity, toLocationId: locationId,
      movementType: "RECEIPT", referenceType: text(input.referenceType) || "lot_receipt",
      referenceId: text(input.referenceId) || lotNumber,
      idempotencyKey: text(input.idempotencyKey) || `lot-receipt:${itemId}:${lotNumber}:${locationId}:${quantity}`,
      source: input.source || "MANUAL", notes: input.notes
    }, actorProfileId);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,'lot.received','lot',$2,$3::jsonb)`,
      [organizationId, lot.id, json({ lot, quantity, movementId: posted.movement.id, locationId })]);
    await client.query("COMMIT");
    return { lot, movement: posted.movement, replayed: posted.replayed };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function registerSupplier(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const name = text(input.name);
  const code = slug(input.code || name);
  if (!organizationId || !name) throw new Error("Organización y nombre del proveedor son obligatorios.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`supplier:${organizationId}:${code}`]);
    const result = await client.query(`INSERT INTO logistics_suppliers
      (organization_id,code,tax_id,name,email,phone,address,status,metadata,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8::jsonb,NOW())
      ON CONFLICT (organization_id,code) DO UPDATE SET
        tax_id=COALESCE(EXCLUDED.tax_id,logistics_suppliers.tax_id),name=EXCLUDED.name,
        email=COALESCE(EXCLUDED.email,logistics_suppliers.email),
        phone=COALESCE(EXCLUDED.phone,logistics_suppliers.phone),
        address=COALESCE(EXCLUDED.address,logistics_suppliers.address),
        metadata=logistics_suppliers.metadata || EXCLUDED.metadata,status='ACTIVE',updated_at=NOW()
      RETURNING *`, [organizationId, code, text(input.taxId) || null, name, text(input.email) || null,
      text(input.phone) || null, text(input.address) || null, json(input.metadata)]);
    const supplier = result.rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,after_data)
      VALUES ($1,'SUPPLIER_REGISTERED','supplier',$2,$3,'MANUAL',$4::jsonb)`,
      [organizationId, supplier.id, actorProfileId, json(supplier)]);
    await client.query("COMMIT");
    return supplier;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listSuppliers(pool, organizationId) {
  const result = await pool.query(`SELECT * FROM logistics_suppliers
    WHERE organization_id=$1 AND status<>'INACTIVE' ORDER BY name`, [organizationId]);
  return result.rows;
}

export async function createInboundReceipt(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const supplierId = text(input.supplierId);
  const warehouseId = text(input.warehouseId);
  const requisitionId = text(input.requisitionId) || null;
  const documentType = text(input.documentType || "DELIVERY_NOTE").toUpperCase();
  const documentNumber = text(input.documentNumber);
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!organizationId || !supplierId || !warehouseId || !documentNumber || !lines.length) {
    throw new Error("Completa proveedor, bodega, documento y al menos una línea.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",
      [`inbound:${organizationId}:${supplierId}:${documentType}:${documentNumber}`]);
    const replay = await client.query(`SELECT * FROM logistics_inbound_receipts
      WHERE organization_id=$1 AND supplier_id=$2 AND document_type=$3 AND document_number=$4`,
      [organizationId, supplierId, documentType, documentNumber]);
    if (replay.rows[0]) {
      await client.query("COMMIT");
      return { receipt: replay.rows[0], replayed: true };
    }
    const supplier = (await client.query(`SELECT * FROM logistics_suppliers
      WHERE id=$1 AND organization_id=$2 AND status='ACTIVE' FOR SHARE`, [supplierId, organizationId])).rows[0];
    if (!supplier) throw new Error("Proveedor inexistente, bloqueado o inactivo.");
    const warehouse = (await client.query(`SELECT * FROM logistics_warehouses
      WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR SHARE`, [warehouseId, organizationId])).rows[0];
    if (!warehouse) throw new Error("Bodega inexistente o inactiva.");
    if (requisitionId) {
      const requisition = (await client.query(`SELECT * FROM logistics_purchase_requisitions
        WHERE id=$1 AND organization_id=$2 AND warehouse_id=$3
          AND status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED') FOR UPDATE`,
        [requisitionId, organizationId, warehouseId])).rows[0];
      if (!requisition) throw new Error("La solicitud asociada no está aprobada o corresponde a otra bodega.");
    }
    const quarantine = await warehouseLocation(client, warehouseId, "QUARANTINE");
    const sequence = await client.query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(receipt_number,'\\D','','g'),'')::bigint),0)+1 AS next
      FROM logistics_inbound_receipts WHERE organization_id=$1`, [organizationId]);
    const receiptNumber = text(input.receiptNumber)
      || `REC-${String(sequence.rows[0].next).padStart(7, "0")}`;
    const receipt = (await client.query(`INSERT INTO logistics_inbound_receipts
      (organization_id,receipt_number,supplier_id,warehouse_id,document_type,document_number,
       status,received_by,received_at,notes,requisition_id)
      VALUES ($1,$2,$3,$4,$5,$6,'QUARANTINE',$7,COALESCE($8::timestamptz,NOW()),$9,$10)
      RETURNING *`, [organizationId, receiptNumber, supplierId, warehouseId, documentType,
      documentNumber, actorProfileId, input.receivedAt || null, text(input.notes) || null, requisitionId])).rows[0];
    const receiptLines = [];
    for (const [index, lineInput] of lines.entries()) {
      const itemId = text(lineInput.itemId);
      const assetUnitId = text(lineInput.assetUnitId) || null;
      const quantity = assertPositiveQuantity(lineInput.quantity);
      const item = (await client.query(`SELECT * FROM logistics_items
        WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR SHARE`, [itemId, organizationId])).rows[0];
      if (!item) throw new Error(`Línea ${index + 1}: artículo inexistente o inactivo.`);
      if (item.tracking_type === "SERIAL" && (!assetUnitId || quantity !== 1)) {
        throw new Error(`Línea ${index + 1}: identifica la unidad serializada con cantidad 1.`);
      }
      let lotId = text(lineInput.lotId) || null;
      if (item.tracking_type === "LOT") {
        const lotNumber = text(lineInput.lotNumber).toUpperCase();
        if (!lotId && !lotNumber) throw new Error(`Línea ${index + 1}: ingresa el número de lote.`);
        if (!lotId) {
          const lot = (await client.query(`INSERT INTO logistics_lots
            (organization_id,item_id,lot_number,manufactured_at,expires_at,supplier_id,status,metadata,updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,'QUARANTINE',$7::jsonb,NOW())
            ON CONFLICT (organization_id,item_id,lot_number) DO UPDATE SET
              manufactured_at=COALESCE(EXCLUDED.manufactured_at,logistics_lots.manufactured_at),
              expires_at=COALESCE(EXCLUDED.expires_at,logistics_lots.expires_at),
              supplier_id=COALESCE(EXCLUDED.supplier_id,logistics_lots.supplier_id),
              metadata=logistics_lots.metadata || EXCLUDED.metadata,updated_at=NOW()
            RETURNING *`, [organizationId, itemId, lotNumber, text(lineInput.manufacturedAt) || null,
            text(lineInput.expiresAt) || null, supplier.id, json({ inboundReceipt: receipt.id })])).rows[0];
          lotId = lot.id;
        }
      }
      const posted = await postMovementWithClient(client, {
        organizationId, itemId, assetUnitId, lotId, quantity, toLocationId: quarantine.id,
        movementType: "RECEIPT", referenceType: "inbound_receipt", referenceId: receipt.id,
        idempotencyKey: `inbound:${receipt.id}:${index}`, source: input.source || "MANUAL",
        notes: text(lineInput.notes) || `Recepción en cuarentena ${receiptNumber}`
      }, actorProfileId);
      const line = (await client.query(`INSERT INTO logistics_inbound_receipt_lines
        (receipt_id,item_id,asset_unit_id,lot_id,quantity,condition_status,receipt_movement_id,notes)
        VALUES ($1,$2,$3,$4,$5,'QUARANTINE',$6,$7) RETURNING *`,
        [receipt.id, itemId, assetUnitId, lotId, quantity, posted.movement.id,
          text(lineInput.notes) || null])).rows[0];
      receiptLines.push(line);
    }
    if (requisitionId) {
      for (const line of receiptLines) {
        await client.query(`UPDATE logistics_purchase_requisition_lines SET
          quantity_received=LEAST(quantity_requested,quantity_received+$1),updated_at=NOW()
          WHERE requisition_id=$2 AND item_id=$3`,
          [line.quantity, requisitionId, line.item_id]);
      }
      const pending = await client.query(`SELECT COUNT(*)::int AS count
        FROM logistics_purchase_requisition_lines
        WHERE requisition_id=$1 AND quantity_received<quantity_requested`, [requisitionId]);
      await client.query(`UPDATE logistics_purchase_requisitions SET status=$1,updated_at=NOW()
        WHERE id=$2`, [pending.rows[0].count ? "PARTIALLY_RECEIVED" : "RECEIVED", requisitionId]);
    }
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data,metadata)
      VALUES ($1,'INBOUND_RECEIVED','inbound_receipt',$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [organizationId, receipt.id, actorProfileId, receiptNumber, text(input.source).toUpperCase() || "MANUAL",
        json(receipt), json({ supplier: supplier.name, warehouse: warehouse.name, lineCount: receiptLines.length })]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,'inbound.quarantined','inbound_receipt',$2,$3::jsonb)`,
      [organizationId, receipt.id, json({ receipt, lines: receiptLines })]);
    await client.query("COMMIT");
    return { receipt, lines: receiptLines, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listInboundReceipts(pool, profile) {
  const params = [];
  const scope = profile?.admin ? "" : `AND center.name=$${params.push(profile?.cost_center || "")}`;
  const result = await pool.query(`SELECT receipt.*,supplier.name AS supplier_name,
      supplier.tax_id AS supplier_tax_id,warehouse.name AS warehouse_name,center.name AS cost_center,
      COALESCE(jsonb_agg(jsonb_build_object(
        'id',line.id,'itemId',line.item_id,'sku',item.sku,'itemName',item.name,
        'assetUnitId',line.asset_unit_id,'unitCode',unit.unit_code,
        'lotId',line.lot_id,'lotNumber',lot.lot_number,'expiresAt',lot.expires_at,
        'quantity',line.quantity,'conditionStatus',line.condition_status
      ) ORDER BY line.created_at) FILTER (WHERE line.id IS NOT NULL),'[]'::jsonb) AS lines
    FROM logistics_inbound_receipts receipt
    JOIN logistics_suppliers supplier ON supplier.id=receipt.supplier_id
    JOIN logistics_warehouses warehouse ON warehouse.id=receipt.warehouse_id
    LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
    LEFT JOIN logistics_inbound_receipt_lines line ON line.receipt_id=receipt.id
    LEFT JOIN logistics_items item ON item.id=line.item_id
    LEFT JOIN logistics_asset_units unit ON unit.id=line.asset_unit_id
    LEFT JOIN logistics_lots lot ON lot.id=line.lot_id
    WHERE 1=1 ${scope}
    GROUP BY receipt.id,supplier.name,supplier.tax_id,warehouse.name,center.name
    ORDER BY receipt.received_at DESC LIMIT 250`, params);
  return result.rows;
}

export async function updateInboundReceipt(pool, receiptId, action, input, actorProfileId = null) {
  const normalizedAction = text(action).toUpperCase();
  if (!["RELEASE", "REJECT"].includes(normalizedAction)) throw new Error("Acción de recepción no permitida.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = (await client.query(`SELECT * FROM logistics_inbound_receipts
      WHERE id=$1 FOR UPDATE`, [receiptId])).rows[0];
    if (!receipt) throw new Error("Recepción no encontrada.");
    const targetStatus = normalizedAction === "RELEASE" ? "RELEASED" : "REJECTED";
    if (receipt.status === targetStatus) {
      await client.query("COMMIT");
      return { receipt, replayed: true };
    }
    if (receipt.status !== "QUARANTINE") throw new Error("La recepción ya no está en cuarentena.");
    const quarantine = await warehouseLocation(client, receipt.warehouse_id, "QUARANTINE");
    let storage = null;
    if (normalizedAction === "RELEASE") {
      if (text(input.targetLocationId)) {
        storage = (await client.query(`SELECT * FROM logistics_locations
          WHERE id=$1 AND warehouse_id=$2 AND location_type='STORAGE'
            AND active=TRUE AND operational_status='AVAILABLE' FOR UPDATE`,
          [text(input.targetLocationId), receipt.warehouse_id])).rows[0];
        if (!storage) throw new Error("La ubicación elegida no está disponible para almacenamiento.");
      } else {
        storage = await warehouseLocation(client, receipt.warehouse_id, "STORAGE");
      }
    }
    const lines = (await client.query(`SELECT line.*,item.tracking_type,lot.status AS lot_status
      FROM logistics_inbound_receipt_lines line
      JOIN logistics_items item ON item.id=line.item_id
      LEFT JOIN logistics_lots lot ON lot.id=line.lot_id
      WHERE line.receipt_id=$1 ORDER BY line.created_at FOR UPDATE OF line`, [receipt.id])).rows;
    if (storage) {
      const occupancy = (await client.query(`SELECT COALESCE(SUM(quantity),0)::numeric AS total,
          COUNT(DISTINCT item_id) FILTER (WHERE quantity>0)::int AS distinct_items,
          COUNT(DISTINCT lot_id) FILTER (WHERE quantity>0 AND lot_id IS NOT NULL)::int AS distinct_lots,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT item_id) FILTER (WHERE quantity>0),NULL) AS item_ids
        FROM logistics_stock_balances WHERE location_id=$1`, [storage.id])).rows[0];
      const incoming = lines.reduce((sum, line) => sum + number(line.quantity), 0);
      if (storage.capacity_quantity && number(occupancy.total) + incoming > number(storage.capacity_quantity)) {
        throw new Error(`La ubicación ${storage.name} no tiene capacidad para recibir ${incoming} unidades.`);
      }
      const incomingItems = new Set(lines.map(line => line.item_id));
      const storedItems = new Set(occupancy.item_ids || []);
      if (!storage.allows_mixed_items && storedItems.size && [...incomingItems].some(id => !storedItems.has(id))) {
        throw new Error(`La ubicación ${storage.name} no permite mezclar productos.`);
      }
      if (!storage.allows_mixed_lots && occupancy.distinct_lots > 0
        && lines.some(line => line.lot_id)) {
        const existingLots = await client.query(`SELECT DISTINCT lot_id FROM logistics_stock_balances
          WHERE location_id=$1 AND quantity>0 AND lot_id IS NOT NULL`, [storage.id]);
        const storedLots = new Set(existingLots.rows.map(row => row.lot_id));
        if (lines.some(line => line.lot_id && !storedLots.has(line.lot_id))) {
          throw new Error(`La ubicación ${storage.name} no permite mezclar lotes.`);
        }
      }
    }
    for (const line of lines) {
      if (normalizedAction === "RELEASE" && line.lot_id && line.lot_status === "QUARANTINE") {
        await client.query("UPDATE logistics_lots SET status='ACTIVE',updated_at=NOW() WHERE id=$1", [line.lot_id]);
      }
      const posted = await postMovementWithClient(client, {
        organizationId: receipt.organization_id, itemId: line.item_id,
        assetUnitId: line.asset_unit_id, lotId: line.lot_id, quantity: line.quantity,
        fromLocationId: quarantine.id, toLocationId: storage?.id || null,
        movementType: normalizedAction === "RELEASE" ? "TRANSFER_RECEIPT" : "ISSUE",
        referenceType: normalizedAction === "RELEASE" ? "inbound_release" : "supplier_return",
        referenceId: receipt.id, idempotencyKey: `inbound:${receipt.id}:${normalizedAction}:${line.id}`,
        source: input.source || "MANUAL", notes: input.notes
      }, actorProfileId);
      await client.query(`UPDATE logistics_inbound_receipt_lines SET condition_status=$1,
        release_movement_id=$2,notes=CASE WHEN $3='' THEN notes ELSE CONCAT_WS(E'\\n',notes,$3) END,
        updated_at=NOW() WHERE id=$4`,
        [normalizedAction === "RELEASE" ? "ACCEPTED" : "REJECTED", posted.movement.id,
          text(input.notes), line.id]);
    }
    const updated = (await client.query(`UPDATE logistics_inbound_receipts SET status=$1,
      released_by=$2,released_at=NOW(),notes=CASE WHEN $3='' THEN notes ELSE CONCAT_WS(E'\\n',notes,$3) END,
      updated_at=NOW() WHERE id=$4 RETURNING *`,
      [targetStatus, actorProfileId, text(input.notes), receipt.id])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,before_data,after_data)
      VALUES ($1,$2,'inbound_receipt',$3,$4,$5,'MANUAL',$6::jsonb,$7::jsonb)`,
      [receipt.organization_id, normalizedAction === "RELEASE" ? "INBOUND_RELEASED" : "INBOUND_REJECTED",
        receipt.id, actorProfileId, receipt.receipt_number, json(receipt), json(updated)]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,$2,'inbound_receipt',$3,$4::jsonb)`,
      [receipt.organization_id, normalizedAction === "RELEASE" ? "inbound.released" : "inbound.rejected",
        receipt.id, json({ receipt: updated })]);
    await client.query("COMMIT");
    return { receipt: updated, lines, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertReplenishmentPolicy(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const itemId = text(input.itemId);
  const warehouseId = text(input.warehouseId);
  const minimumStock = Math.max(0, number(input.minimumStock));
  const reorderPoint = Math.max(minimumStock, number(input.reorderPoint, minimumStock));
  const maximumStock = Math.max(reorderPoint, number(input.maximumStock, reorderPoint));
  if (!organizationId || !itemId || !warehouseId) throw new Error("Completa artículo y bodega.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const valid = await client.query(`SELECT 1 FROM logistics_items item
      JOIN logistics_warehouses warehouse ON warehouse.organization_id=item.organization_id
      WHERE item.id=$1 AND warehouse.id=$2 AND item.organization_id=$3
        AND item.active=TRUE AND warehouse.active=TRUE`, [itemId, warehouseId, organizationId]);
    if (!valid.rowCount) throw new Error("El artículo o la bodega no pertenecen a la organización.");
    const result = await client.query(`INSERT INTO logistics_replenishment_policies
      (organization_id,item_id,warehouse_id,preferred_supplier_id,minimum_stock,reorder_point,
       maximum_stock,safety_stock,lead_time_days,active,metadata,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10::jsonb,NOW())
      ON CONFLICT (organization_id,item_id,warehouse_id) DO UPDATE SET
        preferred_supplier_id=EXCLUDED.preferred_supplier_id,minimum_stock=EXCLUDED.minimum_stock,
        reorder_point=EXCLUDED.reorder_point,maximum_stock=EXCLUDED.maximum_stock,
        safety_stock=EXCLUDED.safety_stock,lead_time_days=EXCLUDED.lead_time_days,
        active=TRUE,metadata=logistics_replenishment_policies.metadata || EXCLUDED.metadata,updated_at=NOW()
      RETURNING *`, [organizationId, itemId, warehouseId, text(input.preferredSupplierId) || null,
      minimumStock, reorderPoint, maximumStock, Math.max(0, number(input.safetyStock)),
      Math.max(0, Math.round(number(input.leadTimeDays))), json(input.metadata)]);
    const policy = result.rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,after_data)
      VALUES ($1,'REPLENISHMENT_POLICY_SAVED','replenishment_policy',$2,$3,'MANUAL',$4::jsonb)`,
      [organizationId, policy.id, actorProfileId, json(policy)]);
    await client.query("COMMIT");
    return policy;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listReplenishmentSuggestions(pool, profile) {
  const params = [];
  const scope = profile?.admin ? "" : `AND center.name=$${params.push(profile?.cost_center || "")}`;
  const result = await pool.query(`WITH available AS (
      SELECT balance.item_id,location.warehouse_id,
        SUM(balance.quantity) FILTER (WHERE location.location_type='STORAGE') AS available_quantity,
        SUM(balance.quantity) FILTER (WHERE location.location_type='QUARANTINE') AS quarantine_quantity
      FROM logistics_stock_balances balance
      JOIN logistics_locations location ON location.id=balance.location_id
      GROUP BY balance.item_id,location.warehouse_id
    ), pipeline AS (
      SELECT line.item_id,requisition.warehouse_id,
        SUM(line.quantity_requested-line.quantity_received) AS pending_quantity
      FROM logistics_purchase_requisition_lines line
      JOIN logistics_purchase_requisitions requisition ON requisition.id=line.requisition_id
      WHERE requisition.status IN ('DRAFT','SUBMITTED','APPROVED','ORDERED','PARTIALLY_RECEIVED')
      GROUP BY line.item_id,requisition.warehouse_id
    )
    SELECT item.id AS item_id,item.sku,item.name AS item_name,item.unit_of_measure,
      warehouse.id AS warehouse_id,warehouse.name AS warehouse_name,center.name AS cost_center,
      policy.id AS policy_id,policy.preferred_supplier_id,supplier.name AS preferred_supplier_name,
      COALESCE(policy.minimum_stock,item.minimum_stock,0)::numeric AS minimum_stock,
      COALESCE(policy.reorder_point,policy.minimum_stock,item.minimum_stock,0)::numeric AS reorder_point,
      GREATEST(COALESCE(policy.maximum_stock,0),COALESCE(policy.reorder_point,policy.minimum_stock,item.minimum_stock,0),
        COALESCE(item.minimum_stock,0)*2)::numeric AS maximum_stock,
      COALESCE(policy.safety_stock,0)::numeric AS safety_stock,COALESCE(policy.lead_time_days,0) AS lead_time_days,
      COALESCE(available.available_quantity,0)::numeric AS available_quantity,
      COALESCE(available.quarantine_quantity,0)::numeric AS quarantine_quantity,
      COALESCE(pipeline.pending_quantity,0)::numeric AS pending_quantity,
      GREATEST(0,GREATEST(COALESCE(policy.maximum_stock,0),
        COALESCE(policy.reorder_point,policy.minimum_stock,item.minimum_stock,0),
        COALESCE(item.minimum_stock,0)*2)-COALESCE(available.available_quantity,0)-COALESCE(pipeline.pending_quantity,0))::numeric
        AS suggested_quantity
    FROM logistics_items item
    CROSS JOIN logistics_warehouses warehouse
    LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
    LEFT JOIN logistics_replenishment_policies policy ON policy.item_id=item.id
      AND policy.warehouse_id=warehouse.id AND policy.active=TRUE
    LEFT JOIN logistics_suppliers supplier ON supplier.id=policy.preferred_supplier_id
    LEFT JOIN available ON available.item_id=item.id AND available.warehouse_id=warehouse.id
    LEFT JOIN pipeline ON pipeline.item_id=item.id AND pipeline.warehouse_id=warehouse.id
    WHERE item.active=TRUE AND warehouse.active=TRUE
      AND item.organization_id=warehouse.organization_id
      AND (policy.id IS NOT NULL OR item.minimum_stock>0) ${scope}
      AND COALESCE(available.available_quantity,0)
        <= COALESCE(policy.reorder_point,policy.minimum_stock,item.minimum_stock,0)
    ORDER BY suggested_quantity DESC,item.name,warehouse.name`, params);
  return result.rows;
}

export async function createPurchaseRequisition(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const warehouseId = text(input.warehouseId);
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!organizationId || !warehouseId || !lines.length) throw new Error("Completa bodega y productos solicitados.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const warehouse = (await client.query(`SELECT * FROM logistics_warehouses
      WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR SHARE`, [warehouseId, organizationId])).rows[0];
    if (!warehouse) throw new Error("Bodega inexistente o inactiva.");
    const sequence = await client.query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(requisition_number,'\\D','','g'),'')::bigint),0)+1 AS next
      FROM logistics_purchase_requisitions WHERE organization_id=$1`, [organizationId]);
    const numberValue = text(input.requisitionNumber)
      || `SC-${String(sequence.rows[0].next).padStart(7, "0")}`;
    const requisition = (await client.query(`INSERT INTO logistics_purchase_requisitions
      (organization_id,requisition_number,warehouse_id,preferred_supplier_id,status,requested_by,notes)
      VALUES ($1,$2,$3,$4,'DRAFT',$5,$6) RETURNING *`,
      [organizationId, numberValue, warehouseId, text(input.preferredSupplierId) || null,
        actorProfileId, text(input.notes) || null])).rows[0];
    const savedLines = [];
    for (const lineInput of lines) {
      const quantity = assertPositiveQuantity(lineInput.quantity);
      const item = (await client.query(`SELECT * FROM logistics_items
        WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR SHARE`,
        [lineInput.itemId, organizationId])).rows[0];
      if (!item) throw new Error("Uno de los productos solicitados no existe.");
      const line = (await client.query(`INSERT INTO logistics_purchase_requisition_lines
        (requisition_id,item_id,quantity_requested,unit_of_measure,reason)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [requisition.id, item.id, quantity, item.unit_of_measure, text(lineInput.reason) || null])).rows[0];
      savedLines.push(line);
    }
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,after_data,metadata)
      VALUES ($1,'PURCHASE_REQUISITION_CREATED','purchase_requisition',$2,$3,'MANUAL',$4::jsonb,$5::jsonb)`,
      [organizationId, requisition.id, actorProfileId, json(requisition), json({ lineCount: savedLines.length })]);
    await client.query("COMMIT");
    return { requisition, lines: savedLines };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listPurchaseRequisitions(pool, profile) {
  const params = [];
  const scope = profile?.admin ? "" : `AND center.name=$${params.push(profile?.cost_center || "")}`;
  const result = await pool.query(`SELECT requisition.*,warehouse.name AS warehouse_name,
      center.name AS cost_center,supplier.name AS supplier_name,
      COALESCE(jsonb_agg(jsonb_build_object(
        'id',line.id,'itemId',line.item_id,'sku',item.sku,'itemName',item.name,
        'quantityRequested',line.quantity_requested,'quantityReceived',line.quantity_received,
        'unit',line.unit_of_measure,'reason',line.reason
      ) ORDER BY line.created_at) FILTER (WHERE line.id IS NOT NULL),'[]'::jsonb) AS lines
    FROM logistics_purchase_requisitions requisition
    JOIN logistics_warehouses warehouse ON warehouse.id=requisition.warehouse_id
    LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
    LEFT JOIN logistics_suppliers supplier ON supplier.id=requisition.preferred_supplier_id
    LEFT JOIN logistics_purchase_requisition_lines line ON line.requisition_id=requisition.id
    LEFT JOIN logistics_items item ON item.id=line.item_id
    WHERE 1=1 ${scope}
    GROUP BY requisition.id,warehouse.name,center.name,supplier.name
    ORDER BY requisition.created_at DESC LIMIT 250`, params);
  return result.rows;
}

export async function updatePurchaseRequisition(pool, requisitionId, action, input, actorProfileId = null) {
  const normalizedAction = text(action).toUpperCase();
  const transitions = {
    SUBMIT: { from: ["DRAFT"], to: "SUBMITTED" },
    APPROVE: { from: ["SUBMITTED"], to: "APPROVED" },
    ORDER: { from: ["APPROVED"], to: "ORDERED" },
    CANCEL: { from: ["DRAFT", "SUBMITTED", "APPROVED"], to: "CANCELLED" }
  };
  const transition = transitions[normalizedAction];
  if (!transition) throw new Error("Acción de solicitud no permitida.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query(`SELECT * FROM logistics_purchase_requisitions
      WHERE id=$1 FOR UPDATE`, [requisitionId])).rows[0];
    if (!current) throw new Error("Solicitud de compra no encontrada.");
    if (current.status === transition.to) {
      await client.query("COMMIT");
      return { requisition: current, replayed: true };
    }
    if (!transition.from.includes(current.status)) throw new Error(`La solicitud está en estado ${current.status}.`);
    if (normalizedAction === "APPROVE" && current.requested_by === actorProfileId && !input.allowSelfApproval) {
      throw new Error("Quien solicitó la compra no puede aprobarla.");
    }
    const updated = (await client.query(`UPDATE logistics_purchase_requisitions SET status=$1,
      submitted_at=CASE WHEN $1='SUBMITTED' THEN NOW() ELSE submitted_at END,
      approved_at=CASE WHEN $1='APPROVED' THEN NOW() ELSE approved_at END,
      approved_by=CASE WHEN $1='APPROVED' THEN $2 ELSE approved_by END,
      ordered_at=CASE WHEN $1='ORDERED' THEN NOW() ELSE ordered_at END,
      notes=CASE WHEN $3='' THEN notes ELSE CONCAT_WS(E'\\n',notes,$3) END,updated_at=NOW()
      WHERE id=$4 RETURNING *`, [transition.to, actorProfileId, text(input.notes), requisitionId])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,before_data,after_data)
      VALUES ($1,$2,'purchase_requisition',$3,$4,$5,'MANUAL',$6::jsonb,$7::jsonb)`,
      [current.organization_id, `PURCHASE_REQUISITION_${transition.to}`, current.id, actorProfileId,
        current.requisition_number, json(current), json(updated)]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,$2,'purchase_requisition',$3,$4::jsonb)`,
      [current.organization_id, `purchase_requisition.${transition.to.toLowerCase()}`,
        current.id, json({ requisition: updated })]);
    await client.query("COMMIT");
    return { requisition: updated, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createMaterialRequest(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const requestingWarehouseId = text(input.requestingWarehouseId);
  const fulfillmentWarehouseId = text(input.fulfillmentWarehouseId);
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!organizationId || !requestingWarehouseId || !fulfillmentWarehouseId || !lines.length) {
    throw new Error("Completa bodega solicitante, bodega de despacho y productos.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const warehouses = await client.query(`SELECT id FROM logistics_warehouses
      WHERE organization_id=$1 AND active=TRUE AND id=ANY($2::uuid[])`,
      [organizationId, [requestingWarehouseId, fulfillmentWarehouseId]]);
    if (new Set(warehouses.rows.map(row => row.id)).size !== new Set([requestingWarehouseId, fulfillmentWarehouseId]).size) {
      throw new Error("Una de las bodegas no existe o está inactiva.");
    }
    const sequence = await client.query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(request_number,'\\D','','g'),'')::bigint),0)+1 AS next
      FROM logistics_material_requests WHERE organization_id=$1`, [organizationId]);
    const requestNumber = text(input.requestNumber) || `SM-${String(sequence.rows[0].next).padStart(7, "0")}`;
    const request = (await client.query(`INSERT INTO logistics_material_requests
      (organization_id,request_number,requesting_warehouse_id,fulfillment_warehouse_id,status,
       requested_by,purpose,needed_at,notes)
      VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8) RETURNING *`,
      [organizationId, requestNumber, requestingWarehouseId, fulfillmentWarehouseId,
        actorProfileId, text(input.purpose) || null, text(input.neededAt) || null, text(input.notes) || null])).rows[0];
    const savedLines = [];
    for (const lineInput of lines) {
      const quantity = assertPositiveQuantity(lineInput.quantity);
      const item = (await client.query(`SELECT * FROM logistics_items
        WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR SHARE`,
        [lineInput.itemId, organizationId])).rows[0];
      if (!item) throw new Error("Uno de los productos solicitados no existe.");
      if (item.tracking_type === "SERIAL") {
        throw new Error(`${item.sku} es serializado. Utiliza entrega a terreno o traslado de activos.`);
      }
      const line = (await client.query(`INSERT INTO logistics_material_request_lines
        (request_id,item_id,quantity_requested,unit_of_measure,notes)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [request.id, item.id, quantity, item.unit_of_measure, text(lineInput.notes) || null])).rows[0];
      savedLines.push(line);
    }
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,after_data,metadata)
      VALUES ($1,'MATERIAL_REQUEST_CREATED','material_request',$2,$3,'MANUAL',$4::jsonb,$5::jsonb)`,
      [organizationId, request.id, actorProfileId, json(request), json({ lineCount: savedLines.length })]);
    await client.query("COMMIT");
    return { request, lines: savedLines };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listMaterialRequests(pool, profile) {
  const params = [];
  const scope = profile?.admin ? "" : `AND (request_center.name=$${params.push(profile?.cost_center || "")}
    OR fulfillment_center.name=$${params.length})`;
  const result = await pool.query(`SELECT request.*,
      requesting.name AS requesting_warehouse_name,request_center.name AS requesting_cost_center,
      fulfillment.name AS fulfillment_warehouse_name,fulfillment_center.name AS fulfillment_cost_center,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',line.id,'itemId',line.item_id,'sku',item.sku,'itemName',item.name,
        'trackingType',item.tracking_type,'quantityRequested',line.quantity_requested,
        'quantityReserved',line.quantity_reserved,'quantityIssued',line.quantity_issued,
        'unit',line.unit_of_measure,'notes',line.notes
      ) ORDER BY line.created_at)
      FROM logistics_material_request_lines line
      JOIN logistics_items item ON item.id=line.item_id
      WHERE line.request_id=request.id),'[]'::jsonb) AS lines,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',reservation.id,'lineId',reservation.request_line_id,'itemId',reservation.item_id,
        'assetUnitId',reservation.asset_unit_id,'lotId',reservation.lot_id,
        'lotNumber',lot.lot_number,'locationId',reservation.location_id,
        'locationName',location.name,'quantity',reservation.quantity,'status',reservation.status
      ) ORDER BY lot.expires_at NULLS LAST,reservation.reserved_at)
      FROM logistics_stock_reservations reservation
      JOIN logistics_locations location ON location.id=reservation.location_id
      LEFT JOIN logistics_lots lot ON lot.id=reservation.lot_id
      WHERE reservation.request_id=request.id),'[]'::jsonb) AS reservations
    FROM logistics_material_requests request
    JOIN logistics_warehouses requesting ON requesting.id=request.requesting_warehouse_id
    JOIN logistics_warehouses fulfillment ON fulfillment.id=request.fulfillment_warehouse_id
    LEFT JOIN logistics_cost_centers request_center ON request_center.id=requesting.cost_center_id
    LEFT JOIN logistics_cost_centers fulfillment_center ON fulfillment_center.id=fulfillment.cost_center_id
    WHERE 1=1 ${scope}
    ORDER BY request.created_at DESC LIMIT 250`, params);
  return result.rows;
}

export async function updateMaterialRequest(pool, requestId, action, input, actorProfileId = null) {
  const normalizedAction = text(action).toUpperCase();
  const transitions = {
    SUBMIT: { from: ["DRAFT"], to: "SUBMITTED" },
    APPROVE: { from: ["SUBMITTED"], to: "APPROVED" },
    ALLOCATE: { from: ["APPROVED"], to: "ALLOCATED" },
    START_PICK: { from: ["ALLOCATED"], to: "PICKING" },
    ISSUE: { from: ["ALLOCATED", "PICKING"], to: "ISSUED" },
    CANCEL: { from: ["DRAFT", "SUBMITTED", "APPROVED", "ALLOCATED", "PICKING"], to: "CANCELLED" }
  };
  const transition = transitions[normalizedAction];
  if (!transition) throw new Error("Acción de solicitud interna no permitida.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`material-request:${requestId}`]);
    const current = (await client.query(`SELECT * FROM logistics_material_requests
      WHERE id=$1 FOR UPDATE`, [requestId])).rows[0];
    if (!current) throw new Error("Solicitud interna no encontrada.");
    if (current.status === transition.to) {
      await client.query("COMMIT");
      return { request: current, replayed: true };
    }
    if (!transition.from.includes(current.status)) throw new Error(`La solicitud está en estado ${current.status}.`);
    if (normalizedAction === "APPROVE" && current.requested_by === actorProfileId && !input.allowSelfApproval) {
      throw new Error("Quien solicitó materiales no puede aprobar su propia solicitud.");
    }

    if (normalizedAction === "ALLOCATE") {
      const lines = (await client.query(`SELECT line.*,item.sku,item.name,item.tracking_type
        FROM logistics_material_request_lines line
        JOIN logistics_items item ON item.id=line.item_id
        WHERE line.request_id=$1 ORDER BY line.created_at FOR UPDATE OF line`, [requestId])).rows;
      for (const line of lines) {
        let remaining = number(line.quantity_requested) - number(line.quantity_reserved);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",
          [`stock-reservation:${current.organization_id}:${current.fulfillment_warehouse_id}:${line.item_id}`]);
        const candidates = (await client.query(`SELECT balance.item_id,balance.asset_unit_id,balance.lot_id,
            balance.location_id,balance.quantity,lot.lot_number,lot.expires_at,
            GREATEST(0,balance.quantity-COALESCE((
              SELECT SUM(reservation.quantity) FROM logistics_stock_reservations reservation
              WHERE reservation.organization_id=balance.organization_id
                AND reservation.item_id=balance.item_id
                AND reservation.location_id=balance.location_id
                AND reservation.asset_unit_id IS NOT DISTINCT FROM balance.asset_unit_id
                AND reservation.lot_id IS NOT DISTINCT FROM balance.lot_id
                AND reservation.status='ACTIVE'
            ),0))::numeric AS available_quantity
          FROM logistics_stock_balances balance
          JOIN logistics_locations location ON location.id=balance.location_id
          LEFT JOIN logistics_lots lot ON lot.id=balance.lot_id
          WHERE balance.organization_id=$1 AND balance.item_id=$2
            AND location.warehouse_id=$3 AND location.location_type='STORAGE'
            AND location.active=TRUE AND location.operational_status='AVAILABLE'
            AND balance.quantity>0
            AND (lot.id IS NULL OR (lot.status='ACTIVE' AND (lot.expires_at IS NULL OR lot.expires_at>=CURRENT_DATE)))
          ORDER BY location.picking_sequence,lot.expires_at NULLS LAST,balance.updated_at,balance.location_id
          FOR UPDATE OF balance`, [current.organization_id, line.item_id, current.fulfillment_warehouse_id])).rows;
        for (const candidate of candidates) {
          if (!(remaining > 0)) break;
          const quantity = Math.min(remaining, number(candidate.available_quantity));
          if (!(quantity > 0)) continue;
          await client.query(`INSERT INTO logistics_stock_reservations
            (organization_id,request_id,request_line_id,item_id,asset_unit_id,lot_id,
             location_id,quantity,status,reserved_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9)`,
            [current.organization_id, current.id, line.id, line.item_id, candidate.asset_unit_id,
              candidate.lot_id, candidate.location_id, quantity, actorProfileId]);
          remaining -= quantity;
        }
        if (remaining > 0.000001) {
          throw new Error(`Stock disponible insuficiente para ${line.sku}. Faltan ${remaining.toFixed(4)} ${line.unit_of_measure}.`);
        }
        await client.query(`UPDATE logistics_material_request_lines SET
          quantity_reserved=quantity_requested,updated_at=NOW() WHERE id=$1`, [line.id]);
      }
    }

    if (normalizedAction === "ISSUE") {
      const reservations = (await client.query(`SELECT reservation.*,item.item_type,item.sku
        FROM logistics_stock_reservations reservation
        JOIN logistics_items item ON item.id=reservation.item_id
        WHERE reservation.request_id=$1 AND reservation.status='ACTIVE'
        ORDER BY reservation.reserved_at FOR UPDATE OF reservation`, [requestId])).rows;
      if (!reservations.length) throw new Error("La solicitud no tiene stock reservado para entregar.");
      for (const reservation of reservations) {
        await postMovementWithClient(client, {
          organizationId: current.organization_id,
          itemId: reservation.item_id,
          assetUnitId: reservation.asset_unit_id,
          lotId: reservation.lot_id,
          quantity: reservation.quantity,
          fromLocationId: reservation.location_id,
          movementType: reservation.item_type === "ASSET" || reservation.item_type === "TOOL" ? "ISSUE" : "CONSUMPTION",
          referenceType: "material_request",
          referenceId: current.id,
          idempotencyKey: `material-request:${current.id}:reservation:${reservation.id}:issue`,
          source: "MANUAL",
          notes: text(input.notes) || `Entrega solicitud ${current.request_number}`
        }, actorProfileId);
        await client.query(`UPDATE logistics_stock_reservations SET status='ISSUED',
          issued_at=NOW() WHERE id=$1`, [reservation.id]);
      }
      await client.query(`UPDATE logistics_material_request_lines line SET
        quantity_issued=quantity_reserved,updated_at=NOW() WHERE request_id=$1`, [requestId]);
    }

    if (normalizedAction === "CANCEL") {
      await client.query(`UPDATE logistics_stock_reservations SET status='RELEASED',
        released_at=NOW(),release_reason=$2 WHERE request_id=$1 AND status='ACTIVE'`,
        [requestId, text(input.notes) || "Solicitud cancelada"]);
      await client.query(`UPDATE logistics_material_request_lines SET
        quantity_reserved=0,updated_at=NOW() WHERE request_id=$1`, [requestId]);
    }

    const updated = (await client.query(`UPDATE logistics_material_requests SET status=$1,
      submitted_at=CASE WHEN $1='SUBMITTED' THEN NOW() ELSE submitted_at END,
      approved_at=CASE WHEN $1='APPROVED' THEN NOW() ELSE approved_at END,
      approved_by=CASE WHEN $1='APPROVED' THEN $2 ELSE approved_by END,
      allocated_at=CASE WHEN $1='ALLOCATED' THEN NOW() ELSE allocated_at END,
      picking_at=CASE WHEN $1='PICKING' THEN NOW() ELSE picking_at END,
      prepared_by=CASE WHEN $1='PICKING' THEN $2 ELSE prepared_by END,
      issued_at=CASE WHEN $1='ISSUED' THEN NOW() ELSE issued_at END,
      issued_by=CASE WHEN $1='ISSUED' THEN $2 ELSE issued_by END,
      cancelled_at=CASE WHEN $1='CANCELLED' THEN NOW() ELSE cancelled_at END,
      notes=CASE WHEN $3='' THEN notes ELSE CONCAT_WS(E'\\n',notes,$3) END,updated_at=NOW()
      WHERE id=$4 RETURNING *`, [transition.to, actorProfileId, text(input.notes), requestId])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,
       source,before_data,after_data,metadata)
      VALUES ($1,$2,'material_request',$3,$4,$5,'MANUAL',$6::jsonb,$7::jsonb,$8::jsonb)`,
      [current.organization_id, `MATERIAL_REQUEST_${transition.to}`, current.id, actorProfileId,
        current.request_number, json(current), json(updated), json({ action: normalizedAction })]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,$2,'material_request',$3,$4::jsonb)`,
      [current.organization_id, `material_request.${transition.to.toLowerCase()}`,
        current.id, json({ request: updated })]);
    await client.query("COMMIT");
    return { request: updated, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createInspectionRun(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const legacyId = text(input.legacyId);
  const assetUnitId = text(input.assetUnitId);
  const warehouseId = text(input.warehouseId) || null;
  const answers = Array.isArray(input.answers) ? input.answers : [];
  if (!organizationId || !legacyId || !assetUnitId) throw new Error("Faltan organización, inspección o unidad serializada.");
  if (!answers.length) throw new Error("La inspección debe contener al menos una respuesta.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`inspection:${organizationId}:${legacyId}`]);
    const previous = await client.query(`SELECT canonical_id FROM logistics_legacy_links
      WHERE organization_id=$1 AND legacy_type='inspection' AND legacy_id=$2`, [organizationId, legacyId]);
    if (previous.rows[0]) {
      const existing = await client.query("SELECT * FROM logistics_inspection_runs WHERE id=$1", [previous.rows[0].canonical_id]);
      await client.query("COMMIT");
      return { inspection: existing.rows[0], replayed: true };
    }
    const unitResult = await client.query(`SELECT u.*,i.sku,i.name AS item_name,i.family_id,
        f.inspection_template_legacy_key,f.name AS family_name
      FROM logistics_asset_units u
      JOIN logistics_items i ON i.id=u.item_id
      LEFT JOIN logistics_item_families f ON f.id=i.family_id
      WHERE u.id=$1 AND u.organization_id=$2 AND u.status<>'RETIRED'`, [assetUnitId, organizationId]);
    const unit = unitResult.rows[0];
    if (!unit) throw new Error("La unidad serializada no existe en el catálogo V2.");
    const templateKey = slug(input.templateKey || unit.inspection_template_legacy_key || `INSPECTION-${unit.sku}`);
    const templateName = text(input.templateName) || `Inspección ${unit.family_name || unit.item_name}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`inspection-template:${organizationId}:${templateKey}`]);
    const definitions = answers.map((answer, index) => ({
      code: slug(answer?.key || `ITEM-${index + 1}`),
      label: text(answer?.label || answer?.item) || `Punto ${index + 1}`,
      order: index + 1
    }));
    const latestResult = await client.query(`SELECT * FROM logistics_inspection_template_versions
      WHERE organization_id=$1 AND template_key=$2 ORDER BY version DESC LIMIT 1`, [organizationId, templateKey]);
    let template = latestResult.rows[0] || null;
    let existingItems = [];
    if (template) {
      const result = await client.query(`SELECT * FROM logistics_inspection_template_items
        WHERE template_version_id=$1 ORDER BY item_order`, [template.id]);
      existingItems = result.rows;
    }
    const sameDefinition = template && existingItems.length === definitions.length &&
      existingItems.every((item, index) => item.code === definitions[index].code && item.label === definitions[index].label);
    if (!sameDefinition) {
      await client.query(`UPDATE logistics_inspection_template_versions SET status='RETIRED'
        WHERE organization_id=$1 AND template_key=$2 AND status='ACTIVE'`, [organizationId, templateKey]);
      const nextVersion = Number(template?.version || 0) + 1;
      const templateResult = await client.query(`INSERT INTO logistics_inspection_template_versions
        (organization_id,template_key,name,version,family_id,status,effective_from,created_by)
        VALUES ($1,$2,$3,$4,$5,'ACTIVE',CURRENT_DATE,$6) RETURNING *`,
        [organizationId, templateKey, templateName, nextVersion, unit.family_id || null, actorProfileId]);
      template = templateResult.rows[0];
      existingItems = [];
    }
    const itemByCode = new Map();
    if (existingItems.length) {
      existingItems.forEach(item => itemByCode.set(item.code, item));
    } else {
      for (const definition of definitions) {
        const inserted = await client.query(`INSERT INTO logistics_inspection_template_items
          (template_version_id,item_order,code,label,response_type,required,requires_evidence_on_failure)
          VALUES ($1,$2,$3,$4,'COMPLIANCE',TRUE,TRUE) RETURNING *`,
          [template.id, definition.order, definition.code, definition.label]);
        itemByCode.set(definition.code, inserted.rows[0]);
      }
    }
    const failed = answers.some(answer => /no\s*cumple|non.?compliant|fail/i.test(text(answer.result)));
    const runResult = await client.query(`INSERT INTO logistics_inspection_runs
      (organization_id,template_version_id,asset_unit_id,warehouse_id,status,result,
       inspector_profile_id,inspected_at,submitted_at,notes,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,NOW()),NOW(),$9,NOW()) RETURNING *`,
      [organizationId, template.id, assetUnitId, warehouseId,
        failed ? "CORRECTION_PENDING" : "SUBMITTED", failed ? "NON_COMPLIANT" : "COMPLIANT",
        actorProfileId, input.inspectedAt || null, text(input.notes) || null]);
    const inspection = runResult.rows[0];
    for (let index = 0; index < answers.length; index += 1) {
      const answer = answers[index] || {};
      const code = slug(answer.key || `ITEM-${index + 1}`);
      const templateItem = itemByCode.get(code);
      const rawResult = text(answer.result);
      const normalizedResult = /no\s*cumple|non.?compliant|fail/i.test(rawResult) ? "NON_COMPLIANT"
        : /no\s*aplica|not.?applicable/i.test(rawResult) ? "NOT_APPLICABLE" : "COMPLIANT";
      await client.query(`INSERT INTO logistics_inspection_answers
        (inspection_id,template_item_id,result,value_text,notes) VALUES ($1,$2,$3,$4,$5)`,
        [inspection.id, templateItem.id, normalizedResult, rawResult, text(answer.note) || null]);
      if (normalizedResult === "NON_COMPLIANT") {
        await client.query(`INSERT INTO logistics_inspection_findings
          (inspection_id,template_item_id,description,severity,corrective_action,status)
          VALUES ($1,$2,$3,'HIGH',$4,'OPEN')`, [inspection.id, templateItem.id,
            `${templateItem.label}: ${text(answer.note) || "No cumple"}`, text(input.correctiveAction) || null]);
      }
    }
    const metadata = { inspectorName: text(input.inspectorName), approverName: text(input.approverName),
      approverEmail: text(input.approverEmail), project: text(input.project), documentName: text(input.documentName) };
    await client.query(`INSERT INTO logistics_legacy_links
      (organization_id,legacy_type,legacy_id,canonical_type,canonical_id,metadata)
      VALUES ($1,'inspection',$2,'inspection_run',$3,$4::jsonb)`,
      [organizationId, legacyId, inspection.id, json(metadata)]);
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data,metadata)
      VALUES ($1,'INSPECTION_SUBMITTED','inspection_run',$2,$3,$4,'MOBILE',$5::jsonb,$6::jsonb)`,
      [organizationId, inspection.id, actorProfileId, legacyId, json(inspection), json(metadata)]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,'inspection.submitted','inspection_run',$2,$3::jsonb)`,
      [organizationId, inspection.id, json({ inspection, metadata, failed })]);
    await client.query("COMMIT");
    return { inspection, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateInspectionRun(pool, inspectionId, input, actorProfileId) {
  const action = text(input.action).toUpperCase();
  const allowed = new Set(["SET_DEADLINE", "RECORD_CORRECTION", "APPROVE", "VERIFY_CORRECTION"]);
  if (!allowed.has(action)) throw new Error("Acción de inspección no permitida.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`inspection-action:${inspectionId}`]);
    const currentResult = await client.query("SELECT * FROM logistics_inspection_runs WHERE id=$1 FOR UPDATE", [inspectionId]);
    const current = currentResult.rows[0];
    if (!current) throw new Error("La inspección V2 no existe.");
    let replayed = false;
    if (action === "SET_DEADLINE") {
      if (!input.dueAt) throw new Error("La fecha límite es obligatoria.");
      await client.query(`UPDATE logistics_inspection_runs SET status='CORRECTION_PENDING',
        due_at=$1::timestamptz,updated_at=NOW() WHERE id=$2`, [input.dueAt, inspectionId]);
      await client.query(`UPDATE logistics_inspection_findings SET due_at=$1::timestamptz,
        corrective_action=$2,status=CASE WHEN status='OPEN' THEN 'IN_PROGRESS' ELSE status END,updated_at=NOW()
        WHERE inspection_id=$3 AND status NOT IN ('VERIFIED','CLOSED')`,
        [input.dueAt, text(input.notes) || null, inspectionId]);
    } else if (action === "RECORD_CORRECTION") {
      if (!text(input.notes)) throw new Error("Describe la corrección realizada.");
      const corrected = await client.query(`UPDATE logistics_inspection_findings SET corrected_at=COALESCE($1::timestamptz,NOW()),
        corrective_action=COALESCE($2,corrective_action),status='CORRECTED',updated_at=NOW()
        WHERE inspection_id=$3 AND status IN ('OPEN','IN_PROGRESS','CORRECTED') RETURNING id`,
        [input.correctedAt || null, text(input.notes), inspectionId]);
      if (!corrected.rowCount) replayed = true;
      await client.query("UPDATE logistics_inspection_runs SET updated_at=NOW() WHERE id=$1", [inspectionId]);
    } else {
      const verifying = action === "VERIFY_CORRECTION";
      if (verifying) {
        const pending = await client.query(`SELECT COUNT(*)::int AS count FROM logistics_inspection_findings
          WHERE inspection_id=$1 AND status NOT IN ('CORRECTED','VERIFIED','CLOSED')`, [inspectionId]);
        if (Number(pending.rows[0]?.count) > 0) throw new Error("Aún existen hallazgos sin corrección registrada.");
        await client.query(`UPDATE logistics_inspection_findings SET status='VERIFIED',verified_by=$1,updated_at=NOW()
          WHERE inspection_id=$2 AND status IN ('CORRECTED','VERIFIED')`, [actorProfileId, inspectionId]);
      }
      const finalStatus = verifying ? "CLOSED" : "APPROVED";
      if (current.status === finalStatus) replayed = true;
      await client.query(`UPDATE logistics_inspection_runs SET status=$1,approver_profile_id=$2,
        approved_at=COALESCE(approved_at,NOW()),updated_at=NOW() WHERE id=$3`,
        [finalStatus, actorProfileId, inspectionId]);
      const decisionExists = await client.query(`SELECT 1 FROM logistics_inspection_approvals
        WHERE inspection_id=$1 AND approver_profile_id=$2 AND decision='APPROVED'`, [inspectionId, actorProfileId]);
      if (!decisionExists.rowCount) {
        await client.query(`INSERT INTO logistics_inspection_approvals
          (inspection_id,approver_profile_id,decision,comments) VALUES ($1,$2,'APPROVED',$3)`,
          [inspectionId, actorProfileId, text(input.notes) || null]);
      }
    }
    const updatedResult = await client.query("SELECT * FROM logistics_inspection_runs WHERE id=$1", [inspectionId]);
    const updated = updatedResult.rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,before_data,after_data,metadata)
      VALUES ($1,$2,'inspection_run',$3,$4,$5,'WEB',$6::jsonb,$7::jsonb,$8::jsonb)`,
      [current.organization_id, `INSPECTION_${action}`, inspectionId, actorProfileId,
        text(input.idempotencyKey) || `${action}:${inspectionId}`, json(current), json(updated), json({ notes: text(input.notes) })]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,$2,'inspection_run',$3,$4::jsonb)`,
      [current.organization_id, `inspection.${action.toLowerCase()}`, inspectionId, json({ inspection: updated, action })]);
    await client.query("COMMIT");
    return { inspection: updated, replayed };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
      b.asset_unit_id, u.unit_code, b.lot_id, lot.lot_number, lot.manufactured_at,
      lot.expires_at, lot.status AS lot_status, lot.supplier_id, b.location_id,
      loc.code AS location_code, loc.name AS location_name, loc.location_type,
      w.id AS warehouse_id, w.name AS warehouse_name, cc.name AS cost_center,
      b.quantity,
      COALESCE((SELECT SUM(reservation.quantity) FROM logistics_stock_reservations reservation
        WHERE reservation.organization_id=b.organization_id AND reservation.item_id=b.item_id
          AND reservation.location_id=b.location_id
          AND reservation.asset_unit_id IS NOT DISTINCT FROM b.asset_unit_id
          AND reservation.lot_id IS NOT DISTINCT FROM b.lot_id
          AND reservation.status='ACTIVE'),0)::numeric AS reserved_quantity,
      GREATEST(0,b.quantity-COALESCE((SELECT SUM(reservation.quantity)
        FROM logistics_stock_reservations reservation
        WHERE reservation.organization_id=b.organization_id AND reservation.item_id=b.item_id
          AND reservation.location_id=b.location_id
          AND reservation.asset_unit_id IS NOT DISTINCT FROM b.asset_unit_id
          AND reservation.lot_id IS NOT DISTINCT FROM b.lot_id
          AND reservation.status='ACTIVE'),0))::numeric AS available_quantity,
      b.version, b.updated_at
    FROM logistics_stock_balances b
    JOIN logistics_items i ON i.id=b.item_id
    JOIN logistics_locations loc ON loc.id=b.location_id
    LEFT JOIN logistics_warehouses w ON w.id=loc.warehouse_id
    LEFT JOIN logistics_cost_centers cc ON cc.id=w.cost_center_id
    LEFT JOIN logistics_asset_units u ON u.id=b.asset_unit_id
    LEFT JOIN logistics_lots lot ON lot.id=b.lot_id
    WHERE ${filters.join(" AND ")} AND b.quantity<>0
    ORDER BY i.name, w.name, loc.name, lot.expires_at NULLS LAST, lot.lot_number, u.unit_code`, values);
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
    if (text(input.transferNumber)) {
      const replay = await client.query(`SELECT * FROM logistics_transfer_orders
        WHERE organization_id=$1 AND transfer_number=$2`, [organizationId, text(input.transferNumber)]);
      if (replay.rows[0]) {
        await client.query("COMMIT");
        return { ...replay.rows[0], replayed: true };
      }
    }
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
  if (preferredType === "QUARANTINE" && result.rows[0]?.location_type !== "QUARANTINE") {
    throw new Error("La bodega no tiene una ubicación de cuarentena configurada.");
  }
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

export async function createCustodyAssignment(pool, input, actorProfileId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const organizationId = text(input.organizationId);
    const itemId = text(input.itemId);
    const warehouseId = text(input.warehouseId);
    const workerId = text(input.workerId);
    const assetUnitId = text(input.assetUnitId) || null;
    const lotId = text(input.lotId) || null;
    const quantity = assertPositiveQuantity(input.quantity);
    const externalReference = text(input.externalReference) || randomUUID();
    if (!organizationId || !itemId || !warehouseId || !workerId) {
      throw new Error("Completa artículo, bodega y trabajador.");
    }

    const replay = await client.query(`SELECT * FROM logistics_custody_assignments
      WHERE organization_id=$1 AND external_reference=$2`, [organizationId, externalReference]);
    if (replay.rows[0]) {
      await client.query("COMMIT");
      return { assignment: replay.rows[0], replayed: true };
    }

    const item = (await client.query(`SELECT * FROM logistics_items
      WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR SHARE`, [itemId, organizationId])).rows[0];
    if (!item) throw new Error("Artículo inexistente o inactivo.");
    const warehouse = (await client.query(`SELECT w.*,cc.name AS cost_center FROM logistics_warehouses w
      LEFT JOIN logistics_cost_centers cc ON cc.id=w.cost_center_id
      WHERE w.id=$1 AND w.organization_id=$2 AND w.active=TRUE FOR SHARE OF w`, [warehouseId, organizationId])).rows[0];
    if (!warehouse) throw new Error("Bodega inexistente o inactiva.");
    const worker = (await client.query(`SELECT * FROM inventory_worker_enrollments
      WHERE id=$1 AND status<>'Inactivo' FOR SHARE`, [workerId])).rows[0];
    if (!worker) throw new Error("Trabajador no enrolado o inactivo.");
    if (worker.cost_center !== warehouse.cost_center) {
      throw new Error("El trabajador no pertenece al centro de costo de la bodega.");
    }

    const consumable = item.item_type === "CONSUMABLE";
    const ppe = item.item_type === "PPE";
    const consumesStock = consumable || (ppe && item.tracking_type !== "SERIAL");
    if (item.tracking_type === "SERIAL" && (!assetUnitId || quantity !== 1)) {
      throw new Error("La entrega serializada requiere una unidad física y cantidad 1.");
    }
    if (!consumesStock && !assetUnitId) throw new Error("Selecciona la unidad física entregada.");

    if (item.tracking_type === "LOT" && !lotId) {
      throw new Error("La entrega requiere identificar el lote.");
    }

    let unit = null;
    if (assetUnitId) {
      unit = (await client.query(`SELECT * FROM logistics_asset_units
        WHERE id=$1 AND item_id=$2 AND organization_id=$3 FOR UPDATE`,
        [assetUnitId, itemId, organizationId])).rows[0];
      if (!unit) throw new Error("Unidad física inexistente.");
      if (unit.status !== "AVAILABLE") throw new Error(`La unidad no está disponible: ${unit.status}.`);
    }

    const location = await warehouseLocation(client, warehouseId, "STORAGE");
    const available = await currentQuantity(client, {
      organizationId, itemId, assetUnitId, lotId, locationId: location.id
    });
    if (available < quantity) throw new Error(`Stock insuficiente. Disponible: ${available}.`);

    const assignmentId = randomUUID();
    const assignmentType = consumable ? "CONSUMABLE_DELIVERY" : ppe ? "PPE_DELIVERY" : "ASSET_CUSTODY";
    const status = consumable ? "CONSUMED" : ppe ? "PENDING" : "ACTIVE";
    const tokenHash = text(input.acceptanceToken)
      ? createHash("sha256").update(text(input.acceptanceToken)).digest("hex")
      : null;
    const inserted = await client.query(`INSERT INTO logistics_custody_assignments
      (id,organization_id,item_id,asset_unit_id,worker_id,warehouse_id,quantity,
       assignment_type,status,acceptance_token_hash,issued_by,notes,external_reference,lot_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [assignmentId, organizationId, itemId, assetUnitId, workerId, warehouseId, quantity,
        assignmentType, status, tokenHash, actorProfileId, text(input.notes) || null, externalReference, lotId]);

    let movement = null;
    if (consumesStock) {
      const posted = await postMovementWithClient(client, {
        organizationId,
        itemId,
        lotId,
        fromLocationId: location.id,
        quantity,
        movementType: "CONSUMPTION",
        referenceType: "custody_assignment",
        referenceId: assignmentId,
        idempotencyKey: `custody:${externalReference}:consumption`,
        source: input.source || "QR",
        notes: input.notes
      }, actorProfileId);
      movement = posted.movement;
    } else {
      await client.query("UPDATE logistics_asset_units SET status='IN_CUSTODY',updated_at=NOW() WHERE id=$1", [assetUnitId]);
    }

    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data,metadata)
      VALUES ($1,'CUSTODY_ASSIGNED','custody_assignment',$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [organizationId, assignmentId, actorProfileId, externalReference, text(input.source).toUpperCase() || "QR",
        json(inserted.rows[0]), json({ worker: worker.name, warehouse: warehouse.name, movementId: movement?.id || null })]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,'custody.assigned','custody_assignment',$2,$3::jsonb)`,
      [organizationId, assignmentId, json({ assignment: inserted.rows[0], movement })]);
    await client.query("COMMIT");
    return { assignment: inserted.rows[0], movement, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function returnCustodyAssignment(pool, assignmentId, input, actorProfileId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`SELECT c.*,i.item_type,u.status AS unit_status
      FROM logistics_custody_assignments c
      JOIN logistics_items i ON i.id=c.item_id
      LEFT JOIN logistics_asset_units u ON u.id=c.asset_unit_id
      WHERE c.id=$1 FOR UPDATE OF c`, [assignmentId]);
    const assignment = result.rows[0];
    if (!assignment) throw new Error("Entrega a terreno no encontrada.");
    if (assignment.status === "RETURNED") {
      await client.query("COMMIT");
      return { assignment, replayed: true };
    }
    if (assignment.assignment_type === "CONSUMABLE_DELIVERY" || assignment.status === "CONSUMED"
      || (assignment.assignment_type === "PPE_DELIVERY" && !assignment.asset_unit_id)) {
      throw new Error("Los consumibles entregados no admiten devolución.");
    }
    if (!["ACTIVE", "ACCEPTED", "PENDING"].includes(assignment.status)) {
      throw new Error("La entrega no está activa.");
    }
    const updated = await client.query(`UPDATE logistics_custody_assignments
      SET status='RETURNED',returned_at=NOW(),notes=CASE WHEN $2='' THEN notes
        ELSE CONCAT_WS(E'\\n',notes,$2) END,updated_at=NOW()
      WHERE id=$1 RETURNING *`, [assignmentId, text(input.notes)]);
    if (assignment.asset_unit_id) {
      await client.query("UPDATE logistics_asset_units SET status='AVAILABLE',updated_at=NOW() WHERE id=$1", [assignment.asset_unit_id]);
    }
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,before_data,after_data)
      VALUES ($1,'CUSTODY_RETURNED','custody_assignment',$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [assignment.organization_id, assignmentId, actorProfileId, text(input.idempotencyKey) || randomUUID(),
        text(input.source).toUpperCase() || "QR", json(assignment), json(updated.rows[0])]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,'custody.returned','custody_assignment',$2,$3::jsonb)`,
      [assignment.organization_id, assignmentId, json({ assignment: updated.rows[0] })]);
    await client.query("COMMIT");
    return { assignment: updated.rows[0], replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listCustodyAssignments(pool, profile, query = {}) {
  const values = [];
  const filters = ["1=1"];
  if (!profile?.admin) {
    values.push(profile.cost_center);
    filters.push(`cc.name=$${values.length}`);
  }
  if (text(query.status) === "active") {
    filters.push("c.status IN ('PENDING','ACTIVE','ACCEPTED')");
  }
  const result = await pool.query(`SELECT c.*,i.sku,i.name AS item_name,i.item_type,
      u.unit_code,lot.lot_number,lot.expires_at,w.name AS warehouse_name,cc.name AS cost_center,
      worker.name AS worker_name,worker.rut AS worker_rut,worker.email AS worker_email,
      worker.phone AS worker_phone
    FROM logistics_custody_assignments c
    JOIN logistics_items i ON i.id=c.item_id
    LEFT JOIN logistics_asset_units u ON u.id=c.asset_unit_id
    LEFT JOIN logistics_lots lot ON lot.id=c.lot_id
    JOIN logistics_warehouses w ON w.id=c.warehouse_id
    LEFT JOIN logistics_cost_centers cc ON cc.id=w.cost_center_id
    LEFT JOIN inventory_worker_enrollments worker ON worker.id=c.worker_id
    WHERE ${filters.join(" AND ")}
    ORDER BY c.created_at DESC LIMIT 500`, values);
  return result.rows;
}

export async function registerWarehouse(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const name = text(input.name);
  const code = slug(input.code || name);
  const legacyKey = text(input.legacyKey) || code;
  if (!organizationId || !name) throw new Error("Organización y nombre de bodega son obligatorios.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`warehouse:${organizationId}:${code}`]);
    const costCenterResult = await client.query(`INSERT INTO logistics_cost_centers
      (organization_id,legacy_key,code,name,active,updated_at)
      VALUES ($1,$2,$3,$4,TRUE,NOW())
      ON CONFLICT (organization_id,code) DO UPDATE SET name=EXCLUDED.name,active=TRUE,updated_at=NOW()
      RETURNING *`, [organizationId, legacyKey, code, name]);
    const costCenter = costCenterResult.rows[0];
    const siteResult = await client.query(`INSERT INTO logistics_sites
      (organization_id,cost_center_id,code,name,address,active,updated_at)
      VALUES ($1,$2,$3,$4,$5,TRUE,NOW())
      ON CONFLICT (organization_id,code) DO UPDATE SET cost_center_id=EXCLUDED.cost_center_id,
        name=EXCLUDED.name,address=EXCLUDED.address,active=TRUE,updated_at=NOW() RETURNING *`,
      [organizationId, costCenter.id, `SITE-${code}`, name, text(input.address) || null]);
    const site = siteResult.rows[0];
    const warehouseResult = await client.query(`INSERT INTO logistics_warehouses
      (organization_id,site_id,cost_center_id,legacy_key,code,name,warehouse_type,active,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'PHYSICAL',TRUE,NOW())
      ON CONFLICT (organization_id,code) DO UPDATE SET site_id=EXCLUDED.site_id,
        cost_center_id=EXCLUDED.cost_center_id,name=EXCLUDED.name,active=TRUE,updated_at=NOW() RETURNING *`,
      [organizationId, site.id, costCenter.id, legacyKey, `WH-${code}`, name]);
    const warehouse = warehouseResult.rows[0];
    const locationTypes = [
      ["STORAGE", "Almacenamiento"],
      ["RECEIVING", "Recepción"],
      ["DISPATCH", "Despacho"],
      ["QUARANTINE", "Cuarentena"]
    ];
    const locations = [];
    for (const [locationType, label] of locationTypes) {
      const locationCode = `LOC-${code}-${locationType}`;
      const locationResult = await client.query(`INSERT INTO logistics_locations
        (organization_id,warehouse_id,legacy_key,code,name,location_type,barcode,active,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$4,TRUE,NOW())
        ON CONFLICT (organization_id,code) DO UPDATE SET warehouse_id=EXCLUDED.warehouse_id,
          name=EXCLUDED.name,location_type=EXCLUDED.location_type,active=TRUE,updated_at=NOW() RETURNING *`,
        [organizationId, warehouse.id, `${legacyKey}:${locationType.toLowerCase()}`,
          locationCode, `${name} · ${label}`, locationType]);
      locations.push(locationResult.rows[0]);
    }
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data,metadata)
      VALUES ($1,'WAREHOUSE_REGISTERED','warehouse',$2,$3,$4,'WEB',$5::jsonb,$6::jsonb)`,
      [organizationId, warehouse.id, actorProfileId, legacyKey, json(warehouse), json({ costCenter, site, locations })]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,'warehouse.registered','warehouse',$2,$3::jsonb)`,
      [organizationId, warehouse.id, json({ warehouse, costCenter, site, locations })]);
    await client.query("COMMIT");
    return { warehouse, costCenter, site, locations };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listWarehouses(pool, profile) {
  const result = await pool.query(`SELECT w.*,cc.name AS cost_center,s.name AS site_name,
      COALESCE(json_agg(json_build_object(
        'id',loc.id,'code',loc.code,'name',loc.name,'type',loc.location_type,'barcode',loc.barcode,
        'zone',loc.zone_code,'aisle',loc.aisle_code,'rack',loc.rack_code,'level',loc.level_code,
        'position',loc.position_code,'capacity',loc.capacity_quantity,'maxWeightKg',loc.max_weight_kg,
        'maxVolumeM3',loc.max_volume_m3,'pickingSequence',loc.picking_sequence,
        'status',loc.operational_status,'allowsMixedItems',loc.allows_mixed_items,
        'allowsMixedLots',loc.allows_mixed_lots,'occupancy',
          COALESCE((SELECT SUM(balance.quantity) FROM logistics_stock_balances balance
            WHERE balance.location_id=loc.id),0)
      ) ORDER BY loc.location_type,loc.picking_sequence,loc.code)
        FILTER (WHERE loc.id IS NOT NULL),'[]'::json) AS locations
    FROM logistics_warehouses w
    LEFT JOIN logistics_cost_centers cc ON cc.id=w.cost_center_id
    LEFT JOIN logistics_sites s ON s.id=w.site_id
    LEFT JOIN logistics_locations loc ON loc.warehouse_id=w.id AND loc.active=TRUE
    WHERE w.active=TRUE
    GROUP BY w.id,cc.name,s.name ORDER BY w.name`);
  return result.rows.map(row => ({
    ...row,
    can_operate: Boolean(profile?.admin || row.cost_center === profile?.cost_center)
  }));
}

export async function registerStorageLocation(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const warehouseId = text(input.warehouseId);
  const zone = slug(input.zoneCode || "Z");
  const aisle = slug(input.aisleCode || "A");
  const rack = slug(input.rackCode || "R");
  const level = slug(input.levelCode || "N");
  const position = slug(input.positionCode || "P");
  if (!organizationId || !warehouseId) throw new Error("Selecciona la bodega.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const warehouse = (await client.query(`SELECT * FROM logistics_warehouses
      WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR SHARE`,
      [warehouseId, organizationId])).rows[0];
    if (!warehouse) throw new Error("Bodega inexistente o inactiva.");
    const code = text(input.code).toUpperCase()
      || `${warehouse.code}-${zone}-${aisle}-${rack}-${level}-${position}`;
    const name = text(input.name) || `${zone}-${aisle}-${rack}-${level}-${position}`;
    const barcode = text(input.barcode).toUpperCase() || `LOC:${code}`;
    const location = (await client.query(`INSERT INTO logistics_locations
      (organization_id,warehouse_id,legacy_key,code,name,location_type,barcode,zone_code,
       aisle_code,rack_code,level_code,position_code,capacity_quantity,max_weight_kg,
       max_volume_m3,picking_sequence,operational_status,allows_mixed_items,
       allows_mixed_lots,metadata,active,updated_at)
      VALUES ($1,$2,$3,$4,$5,'STORAGE',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'AVAILABLE',
        $16,$17,$18::jsonb,TRUE,NOW()) RETURNING *`,
      [organizationId, warehouseId, `bin:${code}`, code, name, barcode, zone, aisle, rack,
        level, position, number(input.capacityQuantity) > 0 ? number(input.capacityQuantity) : null,
        number(input.maxWeightKg) > 0 ? number(input.maxWeightKg) : null,
        number(input.maxVolumeM3) > 0 ? number(input.maxVolumeM3) : null,
        Math.max(0, Math.round(number(input.pickingSequence, 100))),
        input.allowsMixedItems !== false, input.allowsMixedLots !== false, json(input.metadata)])).rows[0];
    if (text(input.preferredItemId)) {
      await client.query(`INSERT INTO logistics_item_location_rules
        (organization_id,item_id,location_id,priority,maximum_quantity,is_pick_face,active,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,TRUE,NOW())
        ON CONFLICT (organization_id,item_id,location_id) DO UPDATE SET
          priority=EXCLUDED.priority,maximum_quantity=EXCLUDED.maximum_quantity,
          is_pick_face=EXCLUDED.is_pick_face,active=TRUE,updated_at=NOW()`,
        [organizationId, text(input.preferredItemId), location.id,
          Math.max(0, Math.round(number(input.priority, 100))),
          number(input.itemMaximumQuantity) > 0 ? number(input.itemMaximumQuantity) : null,
          Boolean(input.isPickFace)]);
    }
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,after_data)
      VALUES ($1,'STORAGE_LOCATION_CREATED','location',$2,$3,'MANUAL',$4::jsonb)`,
      [organizationId, location.id, actorProfileId, json(location)]);
    await client.query("COMMIT");
    return location;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateStorageLocation(pool, locationId, input, actorProfileId = null) {
  const status = text(input.status).toUpperCase();
  if (!["AVAILABLE", "BLOCKED", "COUNTING", "MAINTENANCE"].includes(status)) {
    throw new Error("Estado de ubicación no permitido.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query(`SELECT * FROM logistics_locations
      WHERE id=$1 AND location_type='STORAGE' FOR UPDATE`, [locationId])).rows[0];
    if (!current) throw new Error("Ubicación de almacenamiento no encontrada.");
    if (status === "BLOCKED") {
      const reservations = await client.query(`SELECT COUNT(*)::int AS count
        FROM logistics_stock_reservations WHERE location_id=$1 AND status='ACTIVE'`, [locationId]);
      if (reservations.rows[0].count) throw new Error("Libera o entrega las reservas activas antes de bloquear esta ubicación.");
    }
    const updated = (await client.query(`UPDATE logistics_locations SET
      operational_status=$1,capacity_quantity=$2,picking_sequence=$3,
      allows_mixed_items=$4,allows_mixed_lots=$5,updated_at=NOW()
      WHERE id=$6 RETURNING *`, [status,
      number(input.capacityQuantity) > 0 ? number(input.capacityQuantity) : current.capacity_quantity,
      input.pickingSequence === undefined ? current.picking_sequence : Math.max(0, Math.round(number(input.pickingSequence))),
      input.allowsMixedItems === undefined ? current.allows_mixed_items : Boolean(input.allowsMixedItems),
      input.allowsMixedLots === undefined ? current.allows_mixed_lots : Boolean(input.allowsMixedLots),
      locationId])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,before_data,after_data)
      VALUES ($1,'STORAGE_LOCATION_UPDATED','location',$2,$3,'MANUAL',$4::jsonb,$5::jsonb)`,
      [current.organization_id, current.id, actorProfileId, json(current), json(updated)]);
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function suggestPutawayLocations(pool, profile, input) {
  const organizationId = text(input.organizationId);
  const warehouseId = text(input.warehouseId);
  const itemId = text(input.itemId);
  const quantity = assertPositiveQuantity(input.quantity || 1);
  if (!organizationId || !warehouseId || !itemId) throw new Error("Completa bodega, producto y cantidad.");
  const params = [organizationId, warehouseId, itemId, quantity];
  const scope = profile?.admin ? "" : `AND center.name=$${params.push(profile?.cost_center || "")}`;
  const result = await pool.query(`SELECT location.id,location.code,location.name,location.barcode,
      location.zone_code,location.aisle_code,location.rack_code,location.level_code,
      location.position_code,location.capacity_quantity,location.picking_sequence,
      location.allows_mixed_items,location.allows_mixed_lots,
      rule.priority,rule.is_pick_face,rule.maximum_quantity,
      COALESCE(occupancy.total_quantity,0)::numeric AS occupancy_quantity,
      COALESCE(occupancy.item_quantity,0)::numeric AS item_quantity,
      CASE WHEN location.capacity_quantity IS NULL THEN NULL
        ELSE GREATEST(0,location.capacity_quantity-COALESCE(occupancy.total_quantity,0)) END::numeric AS free_capacity,
      CASE WHEN location.capacity_quantity IS NULL THEN TRUE
        ELSE location.capacity_quantity-COALESCE(occupancy.total_quantity,0)>=$4 END AS fits_quantity
    FROM logistics_locations location
    JOIN logistics_warehouses warehouse ON warehouse.id=location.warehouse_id
    LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
    LEFT JOIN logistics_item_location_rules rule ON rule.location_id=location.id
      AND rule.item_id=$3 AND rule.active=TRUE
    LEFT JOIN LATERAL (
      SELECT SUM(balance.quantity) AS total_quantity,
        SUM(balance.quantity) FILTER (WHERE balance.item_id=$3) AS item_quantity,
        COUNT(DISTINCT balance.item_id) FILTER (WHERE balance.quantity>0) AS distinct_items
      FROM logistics_stock_balances balance WHERE balance.location_id=location.id
    ) occupancy ON TRUE
    WHERE location.organization_id=$1 AND location.warehouse_id=$2
      AND location.location_type='STORAGE' AND location.active=TRUE
      AND location.operational_status='AVAILABLE'
      AND (location.allows_mixed_items OR COALESCE(occupancy.distinct_items,0)=0
        OR (COALESCE(occupancy.distinct_items,0)=1 AND COALESCE(occupancy.item_quantity,0)>0))
      AND (rule.maximum_quantity IS NULL
        OR rule.maximum_quantity-COALESCE(occupancy.item_quantity,0)>=$4)
      ${scope}
    ORDER BY CASE WHEN rule.id IS NULL THEN 1 ELSE 0 END,rule.priority,
      CASE WHEN location.capacity_quantity IS NULL
        OR location.capacity_quantity-COALESCE(occupancy.total_quantity,0)>=$4 THEN 0 ELSE 1 END,
      location.picking_sequence,location.code
    LIMIT 20`, params);
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
        'assetUnitId',line.asset_unit_id,'unitCode',unit.unit_code,'lotId',line.lot_id,'lotNumber',lot.lot_number,
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
    LEFT JOIN logistics_lots lot ON lot.id=line.lot_id
    WHERE ${filter}
    GROUP BY t.id,source_w.name,destination_w.name
    ORDER BY t.requested_at DESC LIMIT 250`, values);
  return result.rows;
}

export async function reconcileLegacyState(pool) {
  const stateResult = await pool.query("SELECT payload,updated_at FROM inventory_app_state WHERE id=1");
  const state = stateResult.rows[0]?.payload || {};
  const organization = await ensureDefaultOrganization(pool);
  const canonicalResult = await pool.query(`SELECT i.sku,COALESCE(cc.name,w.name,loc.name) AS center,
      SUM(b.quantity)::numeric AS quantity
    FROM logistics_stock_balances b
    JOIN logistics_items i ON i.id=b.item_id
    JOIN logistics_locations loc ON loc.id=b.location_id
    LEFT JOIN logistics_warehouses w ON w.id=loc.warehouse_id
    LEFT JOIN logistics_cost_centers cc ON cc.id=w.cost_center_id
    WHERE b.organization_id=$1 AND loc.location_type NOT IN ('SUPPLIER','CUSTOMER','SCRAP')
    GROUP BY i.sku,COALESCE(cc.name,w.name,loc.name)`, [organization.id]);
  const canonical = new Map();
  for (const row of canonicalResult.rows) {
    const key = `${slug(row.sku)}|${text(row.center).toLowerCase()}`;
    canonical.set(key, number(row.quantity));
  }
  const legacy = new Map();
  for (const asset of state.assets || []) {
    const sku = text(asset.baseCode || asset.code);
    let stocks = Object.entries(asset.stocks || {});
    if (!stocks.length && number(asset.stock) !== 0) stocks = [[asset.location || "Bodega Central", asset.stock]];
    for (const [center, rawQuantity] of stocks) {
      const key = `${slug(sku)}|${text(center).toLowerCase()}`;
      legacy.set(key, number(legacy.get(key)) + number(rawQuantity));
    }
  }
  const keys = new Set([...legacy.keys(), ...canonical.keys()]);
  const differences = [...keys].map(key => {
    const [sku, centerKey] = key.split("|");
    const legacyQuantity = number(legacy.get(key));
    const canonicalQuantity = number(canonical.get(key));
    return {
      sku,
      center: [...(state.costCenters || []).map(item => item.name), ...canonicalResult.rows.map(item => item.center)]
        .find(name => text(name).toLowerCase() === centerKey) || centerKey,
      legacyQuantity,
      canonicalQuantity,
      delta: canonicalQuantity - legacyQuantity,
      status: canonicalQuantity === legacyQuantity ? "MATCH" : "DIFFERENCE"
    };
  }).sort((a, b) => (a.status === b.status ? `${a.sku}${a.center}`.localeCompare(`${b.sku}${b.center}`) : a.status === "DIFFERENCE" ? -1 : 1));
  const mismatches = differences.filter(row => row.status === "DIFFERENCE");
  return {
    ok: mismatches.length === 0,
    organizationId: organization.id,
    generatedAt: new Date().toISOString(),
    legacyUpdatedAt: stateResult.rows[0]?.updated_at || null,
    summary: {
      comparedBalances: differences.length,
      matchingBalances: differences.length - mismatches.length,
      differences: mismatches.length,
      legacyTotal: differences.reduce((sum, row) => sum + row.legacyQuantity, 0),
      canonicalTotal: differences.reduce((sum, row) => sum + row.canonicalQuantity, 0)
    },
    differences
  };
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
  const itemMap = new Map();
  const unitMap = new Map();
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
    itemMap.set(slug(asset.code), item);
    itemMap.set(slug(baseCode), item);
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
      unitMap.set(slug(asset.code), unitResult.rows[0]);
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

  let pendingTransfers = 0;
  for (const [index, movement] of (state.movements || []).entries()) {
    if (movement.status !== "En tránsito" || movement.received || /proveedor|compra/i.test(`${movement.from || ""} ${movement.action || ""}`)) continue;
    const legacyId = text(movement.id || `pending-${index}-${movement.code}-${movement.date}`);
    const linked = await pool.query(`SELECT canonical_id FROM logistics_legacy_links
      WHERE organization_id=$1 AND legacy_type='movement' AND legacy_id=$2`, [organization.id, legacyId]);
    if (linked.rows[0]) continue;
    if (text(movement.canonicalTransferId)) {
      await pool.query(`INSERT INTO logistics_legacy_links
        (organization_id,legacy_type,legacy_id,canonical_type,canonical_id,status,metadata)
        VALUES ($1,'movement',$2,'transfer',$3,'LINKED',$4::jsonb)
        ON CONFLICT (organization_id,legacy_type,legacy_id) DO NOTHING`,
        [organization.id, legacyId, movement.canonicalTransferId, json({ linkedFromUi: true })]);
      continue;
    }
    const asset = (state.assets || []).find(candidate => slug(candidate.code) === slug(movement.code));
    const item = itemMap.get(slug(asset?.baseCode || movement.code)) || itemMap.get(slug(movement.code));
    const unit = unitMap.get(slug(movement.code));
    const sourceWarehouse = warehouseMap.get(movement.from);
    const destinationWarehouse = warehouseMap.get(movement.to);
    const transitLocation = locationMap.get("En tránsito");
    if (!item || !sourceWarehouse || !destinationWarehouse || !transitLocation || sourceWarehouse.id === destinationWarehouse.id) continue;
    const transferNumber = `LEGACY-${slug(legacyId).slice(0, 70)}`;
    const transferResult = await pool.query(`INSERT INTO logistics_transfer_orders
      (organization_id,transfer_number,source_warehouse_id,destination_warehouse_id,transit_location_id,
       status,requested_at,dispatched_at,notes)
      VALUES ($1,$2,$3,$4,$5,'IN_TRANSIT',COALESCE($6::timestamptz,NOW()),COALESCE($6::timestamptz,NOW()),$7)
      ON CONFLICT (organization_id,transfer_number) DO UPDATE SET updated_at=NOW()
      RETURNING *`, [organization.id, transferNumber, sourceWarehouse.id, destinationWarehouse.id, transitLocation.id,
        /^\d{4}-\d{2}-\d{2}/.test(text(movement.date)) ? movement.date : null,
        movement.detail || "Traslado pendiente migrado desde el sistema anterior."]);
    const quantity = unit ? 1 : Math.max(1, number(movement.qty, 1));
    await pool.query(`INSERT INTO logistics_transfer_lines
      (transfer_id,item_id,asset_unit_id,quantity_requested,quantity_dispatched,quantity_received)
      VALUES ($1,$2,$3,$4,$4,0)
      ON CONFLICT DO NOTHING`, [transferResult.rows[0].id, item.id, unit?.id || null, quantity]);
    await pool.query(`INSERT INTO logistics_legacy_links
      (organization_id,legacy_type,legacy_id,canonical_type,canonical_id,status,metadata)
      VALUES ($1,'movement',$2,'transfer',$3,'LINKED',$4::jsonb)
      ON CONFLICT (organization_id,legacy_type,legacy_id) DO NOTHING`,
      [organization.id, legacyId, transferResult.rows[0].id, json({ code: movement.code, migratedPendingTransfer: true })]);
    pendingTransfers += 1;
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

  return { organizationId: organization.id, importedItems, importedUnits, openingMovements, pendingTransfers };
}

export async function createCycleCount(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const warehouseId = text(input.warehouseId);
  const countNumber = text(input.countNumber).toUpperCase()
    || `CC-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 6).toUpperCase()}`;
  if (!organizationId || !warehouseId) throw new Error("Selecciona la bodega que se contará.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const warehouseResult = await client.query(`SELECT warehouse.* FROM logistics_warehouses warehouse
      WHERE warehouse.id=$1 AND warehouse.organization_id=$2 AND warehouse.active=TRUE FOR SHARE`,
      [warehouseId, organizationId]);
    if (!warehouseResult.rows[0]) throw new Error("La bodega no existe o está inactiva.");
    const activeCount = await client.query(`SELECT count_number FROM logistics_cycle_counts
      WHERE organization_id=$1 AND warehouse_id=$2
        AND status IN ('DRAFT','IN_PROGRESS','SUBMITTED','APPROVED') LIMIT 1`,
      [organizationId, warehouseId]);
    if (activeCount.rows[0]) throw new Error(`La bodega ya tiene el conteo abierto ${activeCount.rows[0].count_number}.`);
    const inserted = await client.query(`INSERT INTO logistics_cycle_counts
      (organization_id,warehouse_id,count_number,status,blind_count,notes,created_by)
      VALUES ($1,$2,$3,'DRAFT',$4,$5,$6) RETURNING *`,
      [organizationId, warehouseId, countNumber, input.blindCount !== false, text(input.notes) || null, actorProfileId]);
    const cycleCount = inserted.rows[0];
    const lines = await client.query(`INSERT INTO logistics_cycle_count_lines
      (count_id,item_id,lot_id,location_id,expected_quantity)
      SELECT $1,balance.item_id,balance.lot_id,balance.location_id,SUM(balance.quantity)
      FROM logistics_stock_balances balance
      JOIN logistics_locations location ON location.id=balance.location_id
      JOIN logistics_items item ON item.id=balance.item_id
      WHERE location.warehouse_id=$2 AND balance.quantity<>0 AND item.tracking_type<>'SERIAL'
      GROUP BY balance.item_id,balance.lot_id,balance.location_id
      RETURNING *`, [cycleCount.id, warehouseId]);
    if (!lines.rowCount) throw new Error("La bodega no tiene consumibles con saldo para contar.");
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data,metadata)
      VALUES ($1,'CYCLE_COUNT_CREATED','cycle_count',$2,$3,$4,'MANUAL',$5::jsonb,$6::jsonb)`,
      [organizationId, cycleCount.id, actorProfileId, countNumber, json(cycleCount),
        json({ lineCount: lines.rowCount, blindCount: cycleCount.blind_count })]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,'cycle_count.created','cycle_count',$2,$3::jsonb)`,
      [organizationId, cycleCount.id, json({ cycleCount, lineCount: lines.rowCount })]);
    await client.query("COMMIT");
    return { cycleCount, lineCount: lines.rowCount };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listCycleCounts(pool, profile) {
  const params = [];
  const scope = profile?.admin ? "" : `AND center.name=$${params.push(profile?.cost_center || "")}`;
  const result = await pool.query(`SELECT cycle.*,warehouse.name AS warehouse_name,center.name AS cost_center,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id',line.id,
          'item_id',line.item_id,
          'sku',item.sku,
          'item_name',item.name,
          'lot_number',lot.lot_number,
          'location_id',line.location_id,
          'location_name',location.name,
          'expected_quantity',CASE WHEN cycle.blind_count AND cycle.status IN ('DRAFT','IN_PROGRESS')
            THEN NULL ELSE line.expected_quantity END,
          'counted_quantity',line.counted_quantity,
          'variance',CASE WHEN cycle.status IN ('DRAFT','IN_PROGRESS') OR line.counted_quantity IS NULL
            THEN NULL ELSE line.counted_quantity-line.expected_quantity END,
          'notes',line.notes,
          'posted_movement_id',line.posted_movement_id
        ) ORDER BY item.name,location.name)
        FROM logistics_cycle_count_lines line
        JOIN logistics_items item ON item.id=line.item_id
        JOIN logistics_locations location ON location.id=line.location_id
        LEFT JOIN logistics_lots lot ON lot.id=line.lot_id
        WHERE line.count_id=cycle.id
      ),'[]'::jsonb) AS lines
    FROM logistics_cycle_counts cycle
    JOIN logistics_warehouses warehouse ON warehouse.id=cycle.warehouse_id
    JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
    WHERE 1=1 ${scope}
    ORDER BY count.created_at DESC LIMIT 100`, params);
  return result.rows;
}

export async function updateCycleCount(pool, countId, action, input, actorProfileId = null) {
  const normalizedAction = text(action).toUpperCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query(`SELECT cycle.*,warehouse.name AS warehouse_name
      FROM logistics_cycle_counts cycle
      JOIN logistics_warehouses warehouse ON warehouse.id=cycle.warehouse_id
      WHERE cycle.id=$1 FOR UPDATE OF cycle`, [countId]);
    const current = currentResult.rows[0];
    if (!current) throw new Error("Conteo cíclico no encontrado.");

    if (normalizedAction === "COUNT") {
      if (!["DRAFT", "IN_PROGRESS"].includes(current.status)) throw new Error("Este conteo ya no admite cambios.");
      const lines = Array.isArray(input.lines) ? input.lines : [];
      if (!lines.length) throw new Error("No se recibieron cantidades contadas.");
      for (const line of lines) {
        const counted = number(line.countedQuantity, NaN);
        if (!Number.isFinite(counted) || counted < 0) throw new Error("Las cantidades contadas deben ser cero o mayores.");
        const updated = await client.query(`UPDATE logistics_cycle_count_lines
          SET counted_quantity=$1,counted_by=$2,counted_at=NOW(),notes=$3,updated_at=NOW()
          WHERE id=$4 AND count_id=$5 RETURNING id`,
          [counted, actorProfileId, text(line.notes) || null, line.id, countId]);
        if (!updated.rowCount) throw new Error("Una línea del conteo ya no existe.");
      }
      const cycleCount = (await client.query(`UPDATE logistics_cycle_counts
        SET status='IN_PROGRESS',updated_at=NOW() WHERE id=$1 RETURNING *`, [countId])).rows[0];
      await client.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data,metadata)
        VALUES ($1,'CYCLE_COUNT_RECORDED','cycle_count',$2,$3,$4,'MANUAL',$5::jsonb,$6::jsonb)`,
        [current.organization_id, countId, actorProfileId, `cycle-count:${countId}:count:${Date.now()}`,
          json(cycleCount), json({ updatedLines: lines.length })]);
      await client.query("COMMIT");
      return { cycleCount };
    }

    if (normalizedAction === "SUBMIT") {
      if (!["DRAFT", "IN_PROGRESS"].includes(current.status)) throw new Error("El conteo no está disponible para envío.");
      const missing = await client.query(`SELECT COUNT(*)::integer AS total FROM logistics_cycle_count_lines
        WHERE count_id=$1 AND counted_quantity IS NULL`, [countId]);
      if (Number(missing.rows[0]?.total || 0) > 0) throw new Error("Completa todas las cantidades antes de enviar.");
      const cycleCount = (await client.query(`UPDATE logistics_cycle_counts
        SET status='SUBMITTED',submitted_by=$2,submitted_at=NOW(),updated_at=NOW()
        WHERE id=$1 RETURNING *`, [countId, actorProfileId])).rows[0];
      await client.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data)
        VALUES ($1,'CYCLE_COUNT_SUBMITTED','cycle_count',$2,$3,$4,'MANUAL',$5::jsonb)`,
        [current.organization_id, countId, actorProfileId, `cycle-count:${countId}:submit`, json(cycleCount)]);
      await client.query("COMMIT");
      return { cycleCount };
    }

    if (normalizedAction === "APPROVE") {
      if (current.status !== "SUBMITTED") throw new Error("El conteo debe estar enviado antes de aprobarse.");
      if (!input.allowSelfApproval) {
        const selfCounted = await client.query(`SELECT 1 FROM logistics_cycle_count_lines
          WHERE count_id=$1 AND counted_by=$2 LIMIT 1`, [countId, actorProfileId]);
        if (selfCounted.rowCount) throw new Error("Quien realizó el conteo no puede aprobarlo.");
      }
      const cycleCount = (await client.query(`UPDATE logistics_cycle_counts
        SET status='APPROVED',approved_by=$2,approved_at=NOW(),updated_at=NOW()
        WHERE id=$1 RETURNING *`, [countId, actorProfileId])).rows[0];
      await client.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data)
        VALUES ($1,'CYCLE_COUNT_APPROVED','cycle_count',$2,$3,$4,'MANUAL',$5::jsonb)`,
        [current.organization_id, countId, actorProfileId, `cycle-count:${countId}:approve`, json(cycleCount)]);
      await client.query("COMMIT");
      return { cycleCount };
    }

    if (normalizedAction === "CANCEL") {
      if (!["DRAFT", "IN_PROGRESS"].includes(current.status)) throw new Error("Este conteo ya no puede cancelarse.");
      const cycleCount = (await client.query(`UPDATE logistics_cycle_counts
        SET status='CANCELLED',updated_at=NOW() WHERE id=$1 RETURNING *`, [countId])).rows[0];
      await client.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data)
        VALUES ($1,'CYCLE_COUNT_CANCELLED','cycle_count',$2,$3,$4,'MANUAL',$5::jsonb)`,
        [current.organization_id, countId, actorProfileId, `cycle-count:${countId}:cancel`, json(cycleCount)]);
      await client.query("COMMIT");
      return { cycleCount };
    }

    if (normalizedAction === "POST") {
      if (current.status === "POSTED") {
        await client.query("COMMIT");
        return { cycleCount: current, replayed: true };
      }
      if (current.status !== "APPROVED") throw new Error("El conteo debe estar aprobado antes de contabilizarse.");
      const lines = await client.query(`SELECT line.*,item.sku FROM logistics_cycle_count_lines line
        JOIN logistics_items item ON item.id=line.item_id WHERE line.count_id=$1 ORDER BY line.id`, [countId]);
      let adjustedLines = 0;
      for (const line of lines.rows) {
        const currentStock = await currentQuantity(client, {
          organizationId: current.organization_id,
          itemId: line.item_id,
          assetUnitId: null,
          lotId: line.lot_id,
          locationId: line.location_id
        });
        const difference = number(line.counted_quantity) - number(line.expected_quantity);
        let movement = null;
        if (Math.abs(difference) > 0.00001) {
          const posted = await postMovementWithClient(client, {
            organizationId: current.organization_id,
            itemId: line.item_id,
            lotId: line.lot_id,
            fromLocationId: difference < 0 ? line.location_id : null,
            toLocationId: difference > 0 ? line.location_id : null,
            quantity: Math.abs(difference),
            movementType: "ADJUSTMENT",
            referenceType: "cycle_count",
            referenceId: countId,
            idempotencyKey: `cycle-count:${countId}:${line.id}`,
            source: "MANUAL",
            notes: `Ajuste por conteo ${current.count_number}. Saldo inicial: ${line.expected_quantity}; contado: ${line.counted_quantity}; saldo antes de ajuste: ${currentStock}.`
          }, actorProfileId);
          movement = posted.movement;
          adjustedLines += 1;
        }
        await client.query(`UPDATE logistics_cycle_count_lines
          SET posted_movement_id=$1,updated_at=NOW() WHERE id=$2`, [movement?.id || null, line.id]);
      }
      const cycleCount = (await client.query(`UPDATE logistics_cycle_counts
        SET status='POSTED',posted_by=$2,posted_at=NOW(),updated_at=NOW()
        WHERE id=$1 RETURNING *`, [countId, actorProfileId])).rows[0];
      await client.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data,metadata)
        VALUES ($1,'CYCLE_COUNT_POSTED','cycle_count',$2,$3,$4,'MANUAL',$5::jsonb,$6::jsonb)`,
        [current.organization_id, countId, actorProfileId, `cycle-count:${countId}:post`,
          json(cycleCount), json({ adjustedLines })]);
      await client.query(`INSERT INTO logistics_outbox_events
        (organization_id,event_type,aggregate_type,aggregate_id,payload)
        VALUES ($1,'cycle_count.posted','cycle_count',$2,$3::jsonb)`,
        [current.organization_id, countId, json({ cycleCount, adjustedLines })]);
      await client.query("COMMIT");
      return { cycleCount, adjustedLines };
    }

    throw new Error("Acción de conteo no permitida.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function logisticsHealth(pool) {
  const result = await pool.query(`SELECT
    (SELECT COUNT(*) FROM logistics_items) AS items,
    (SELECT COUNT(*) FROM logistics_asset_units) AS asset_units,
    (SELECT COUNT(*) FROM logistics_lots) AS lots,
    (SELECT COUNT(DISTINCT balance.lot_id) FROM logistics_stock_balances balance
      JOIN logistics_lots lot ON lot.id=balance.lot_id
      WHERE balance.quantity>0 AND lot.expires_at<CURRENT_DATE) AS expired_lots_with_stock,
    (SELECT COUNT(*) FROM logistics_stock_movements) AS movements,
    (SELECT COUNT(*) FROM logistics_stock_ledger) AS ledger_entries,
    (SELECT COUNT(*) FROM logistics_audit_events) AS audit_events,
    (SELECT COUNT(*) FROM logistics_audit_chain_verification
      WHERE NOT content_valid OR NOT link_valid) AS audit_chain_errors,
    (SELECT COUNT(*) FROM logistics_cycle_counts) AS cycle_counts,
    (SELECT COUNT(*) FROM logistics_cycle_counts
      WHERE status NOT IN ('POSTED','CANCELLED')) AS open_cycle_counts,
    (SELECT COUNT(*) FROM logistics_suppliers WHERE status='ACTIVE') AS active_suppliers,
    (SELECT COUNT(*) FROM logistics_inbound_receipts) AS inbound_receipts,
    (SELECT COUNT(*) FROM logistics_inbound_receipts WHERE status='QUARANTINE') AS quarantine_receipts,
    (SELECT COUNT(*) FROM logistics_replenishment_policies WHERE active=TRUE) AS replenishment_policies,
    (SELECT COUNT(*) FROM logistics_purchase_requisitions) AS purchase_requisitions,
    (SELECT COUNT(*) FROM logistics_purchase_requisitions
      WHERE status NOT IN ('RECEIVED','CANCELLED')) AS open_purchase_requisitions,
    (SELECT COUNT(*) FROM logistics_material_requests) AS material_requests,
    (SELECT COUNT(*) FROM logistics_material_requests
      WHERE status NOT IN ('ISSUED','CANCELLED')) AS open_material_requests,
    (SELECT COALESCE(SUM(quantity),0) FROM logistics_stock_reservations
      WHERE status='ACTIVE') AS reserved_quantity,
    (SELECT COUNT(*) FROM logistics_transfer_orders) AS transfers,
    (SELECT COUNT(*) FROM logistics_schema_migrations) AS migrations`);
  const health = result.rows[0];
  return { ...health, audit_chain_valid: Number(health.audit_chain_errors || 0) === 0 };
}

export const logisticsValidation = {
  assertPositiveQuantity,
  assertMovementType,
  balanceKey,
  slug
};
