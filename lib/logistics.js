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
      COALESCE((SELECT SUM(b.quantity) FROM logistics_stock_balances b WHERE b.item_id=i.id),0)::numeric AS company_quantity,
      COALESCE((SELECT json_agg(json_build_object(
        'id',u.id,'unitCode',u.unit_code,'manufacturerSerial',u.manufacturer_serial,'status',u.status
      ) ORDER BY u.unit_code) FROM logistics_asset_units u WHERE u.item_id=i.id),'[]'::json) AS units
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
  if (!organizationId || !sku || !name) throw new Error("Organización, código y nombre son obligatorios.");
  if (!allowedItemTypes.has(itemType) || !allowedTracking.has(trackingType)) throw new Error("Clasificación de artículo no permitida.");
  const client = await pool.connect();
  let item;
  let units = [];
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
  return { item, units, openingMovements };
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
      organizationId, itemId, assetUnitId, lotId: null, locationId: location.id
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
       assignment_type,status,acceptance_token_hash,issued_by,notes,external_reference)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [assignmentId, organizationId, itemId, assetUnitId, workerId, warehouseId, quantity,
        assignmentType, status, tokenHash, actorProfileId, text(input.notes) || null, externalReference]);

    let movement = null;
    if (consumesStock) {
      const posted = await postMovementWithClient(client, {
        organizationId,
        itemId,
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
      u.unit_code,w.name AS warehouse_name,cc.name AS cost_center,
      worker.name AS worker_name,worker.rut AS worker_rut,worker.email AS worker_email,
      worker.phone AS worker_phone
    FROM logistics_custody_assignments c
    JOIN logistics_items i ON i.id=c.item_id
    LEFT JOIN logistics_asset_units u ON u.id=c.asset_unit_id
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
      ["DISPATCH", "Despacho"]
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
      COALESCE(json_agg(json_build_object('id',loc.id,'code',loc.code,'name',loc.name,'type',loc.location_type))
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
    (SELECT COUNT(*) FROM logistics_stock_movements) AS movements,
    (SELECT COUNT(*) FROM logistics_stock_ledger) AS ledger_entries,
    (SELECT COUNT(*) FROM logistics_audit_events) AS audit_events,
    (SELECT COUNT(*) FROM logistics_audit_chain_verification
      WHERE NOT content_valid OR NOT link_valid) AS audit_chain_errors,
    (SELECT COUNT(*) FROM logistics_cycle_counts) AS cycle_counts,
    (SELECT COUNT(*) FROM logistics_cycle_counts
      WHERE status NOT IN ('POSTED','CANCELLED')) AS open_cycle_counts,
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
