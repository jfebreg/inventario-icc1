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

async function assertAssetComplianceOperational(client, assetUnitId, input = {}) {
  if (!assetUnitId) return null;
  const result = await client.query(`SELECT id,compliance_type,requirement_name,expires_at
    FROM logistics_asset_compliance_records
    WHERE asset_unit_id=$1 AND status='ACTIVE' AND critical=TRUE
      AND expires_at IS NOT NULL AND expires_at<CURRENT_DATE
    ORDER BY expires_at LIMIT 1`, [assetUnitId]);
  const blocker = result.rows[0];
  if (!blocker) return null;
  if (input.allowComplianceOverride === true && text(input.complianceOverrideReason).length >= 10) {
    return blocker;
  }
  throw new Error(`Equipo bloqueado por cumplimiento vencido: ${blocker.requirement_name} (${String(blocker.expires_at).slice(0, 10)}). Registra su renovación antes de moverlo.`);
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
  const closedPeriod = await client.query(`SELECT period_code FROM logistics_inventory_periods
    WHERE organization_id=$1 AND status='CLOSED'
      AND COALESCE($2::timestamptz,NOW())::date BETWEEN starts_on AND ends_on
    LIMIT 1`, [organizationId, input.occurredAt || null]);
  if (closedPeriod.rows[0]) {
    throw new Error(`El período ${closedPeriod.rows[0].period_code} está cerrado y no admite movimientos.`);
  }

  const itemResult = await client.query("SELECT * FROM logistics_items WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR SHARE", [itemId, organizationId]);
  const item = itemResult.rows[0];
  if (!item) throw new Error("Artículo inexistente o inactivo.");
  const unitCost = Math.max(0, number(input.unitCost, number(item.standard_cost)));
  const currency = text(input.currency || item.currency || "CLP").toUpperCase();
  if (!["CLP", "USD", "EUR", "UF"].includes(currency)) throw new Error("Moneda no permitida.");
  const totalValue = Number((quantity * unitCost).toFixed(4));
  if (item.tracking_type === "SERIAL" && (!assetUnitId || quantity !== 1)) {
    throw new Error("Los activos serializados requieren una unidad física y cantidad 1.");
  }
  if (item.tracking_type === "LOT" && !lotId) throw new Error("Este artículo requiere lote.");

  if (assetUnitId) {
    const unit = (await client.query(`SELECT * FROM logistics_asset_units
      WHERE id=$1 AND item_id=$2 AND organization_id=$3 FOR SHARE`,
      [assetUnitId, itemId, organizationId])).rows[0];
    if (!unit) throw new Error("La unidad serializada no pertenece al artículo.");
    if (["BLOCKED", "REPAIR"].includes(unit.status)
      && !["CUSTODY_RETURN", "ADJUSTMENT", "REVERSAL"].includes(movementType)) {
      throw new Error(`La unidad ${unit.unit_code} está ${unit.status} y no puede moverse.`);
    }
  }

  if (assetUnitId && !["TRANSFER_RECEIPT", "CUSTODY_RETURN", "ADJUSTMENT", "REVERSAL"].includes(movementType)) {
    const complianceOverride = await assertAssetComplianceOperational(client, assetUnitId, input);
    if (complianceOverride) {
      await client.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,
         source,after_data,metadata)
        VALUES ($1,'ASSET_COMPLIANCE_OVERRIDE','asset_unit',$2,$3,$4,'MANUAL',$5::jsonb,$6::jsonb)`,
      [organizationId, assetUnitId, actorProfileId, idempotencyKey,
        json({ reason: text(input.complianceOverrideReason) }),
        json({ complianceRecordId: complianceOverride.id, movementType })]);
    }
  }

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
     source, actor_profile_id, reversal_of, notes, unit_cost, total_value, currency, occurred_at)
    VALUES ($1,$2,$3,'POSTED',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14::timestamptz,NOW()))
    RETURNING *`,
    [movementId, organizationId, movementType, text(input.referenceType) || null, text(input.referenceId) || null,
      idempotencyKey, text(input.source).toUpperCase() || "MANUAL", actorProfileId, input.reversalOf || null,
      text(input.notes) || null, unitCost, totalValue, currency, input.occurredAt || null]);

  const entries = [];
  if (fromLocationId) entries.push({ organizationId, itemId, assetUnitId, lotId, locationId: fromLocationId, quantity: -quantity });
  if (toLocationId) entries.push({ organizationId, itemId, assetUnitId, lotId, locationId: toLocationId, quantity });
  for (const entry of entries) {
    await client.query(`INSERT INTO logistics_stock_ledger
      (organization_id, movement_id, item_id, asset_unit_id, lot_id, location_id, quantity,
       unit_cost, total_value, currency, occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz,NOW()))`,
      [entry.organizationId, movementId, entry.itemId, entry.assetUnitId, entry.lotId,
        entry.locationId, entry.quantity, unitCost, Number((entry.quantity * unitCost).toFixed(4)),
        currency, input.occurredAt || null]);
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
    filters.push(`(i.sku ILIKE $${values.length} OR i.name ILIKE $${values.length}
      OR i.brand ILIKE $${values.length} OR i.gtin ILIKE $${values.length}
      OR EXISTS (SELECT 1 FROM logistics_item_uoms search_presentation
        WHERE search_presentation.item_id=i.id AND search_presentation.active=TRUE
          AND (search_presentation.barcode ILIKE $${values.length}
            OR search_presentation.supplier_code ILIKE $${values.length})))`);
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
      FROM logistics_lots lot WHERE lot.item_id=i.id),'[]'::json) AS lots,
      COALESCE((SELECT json_agg(json_build_object(
        'id',presentation.id,'uomId',uom.id,'code',uom.code,'name',uom.name,
        'dimension',uom.dimension,'decimalAllowed',uom.decimal_allowed,
        'conversionToBase',presentation.conversion_to_base,'packageLevel',presentation.package_level,
        'barcode',presentation.barcode,'supplierCode',presentation.supplier_code,
        'isBase',presentation.is_base,'useForPurchase',presentation.use_for_purchase,
        'useForIssue',presentation.use_for_issue,'active',presentation.active
      ) ORDER BY presentation.is_base DESC,presentation.conversion_to_base,presentation.package_level)
      FROM logistics_item_uoms presentation
      JOIN logistics_units_of_measure uom ON uom.id=presentation.uom_id
      WHERE presentation.item_id=i.id AND presentation.active=TRUE),'[]'::json) AS presentations
    FROM logistics_items i
    LEFT JOIN logistics_item_families f ON f.id=i.family_id
    WHERE ${filters.join(" AND ")}
    ORDER BY i.name, i.sku LIMIT 500`, values);
  return result.rows;
}

export async function upsertItemPresentation(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const itemId = text(input.itemId);
  const code = slug(input.uomCode || "UN");
  const name = text(input.uomName) || code;
  const dimension = text(input.dimension || "COUNT").toUpperCase();
  const packageLevel = text(input.packageLevel || "EACH").toUpperCase();
  const conversion = number(input.conversionToBase, 1);
  const barcode = text(input.barcode).toUpperCase().replace(/\s+/g, "") || null;
  const supplierCode = text(input.supplierCode).toUpperCase() || null;
  const allowedDimensions = new Set(["COUNT", "MASS", "LENGTH", "AREA", "VOLUME", "OTHER"]);
  const allowedPackages = new Set(["EACH", "INNER", "CASE", "PALLET", "BULK"]);
  if (!organizationId || !itemId) throw new Error("Organización y artículo son obligatorios.");
  if (!allowedDimensions.has(dimension) || !allowedPackages.has(packageLevel)) {
    throw new Error("Unidad o nivel de empaque no permitido.");
  }
  if (!(conversion > 0)) throw new Error("La conversión a unidad base debe ser mayor que cero.");
  if (input.isBase && conversion !== 1) throw new Error("La unidad base siempre debe equivaler a 1.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const item = (await client.query(`SELECT * FROM logistics_items
      WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR UPDATE`, [itemId, organizationId])).rows[0];
    if (!item) throw new Error("Artículo no encontrado.");
    if (item.tracking_type === "SERIAL" && conversion !== 1) {
      throw new Error("Los activos serializados se administran individualmente; su conversión debe ser 1.");
    }
    const uom = (await client.query(`INSERT INTO logistics_units_of_measure
      (organization_id,code,name,dimension,decimal_allowed,active,updated_at)
      VALUES ($1,$2,$3,$4,$5,TRUE,NOW())
      ON CONFLICT (organization_id,code) DO UPDATE SET name=EXCLUDED.name,
        dimension=EXCLUDED.dimension,decimal_allowed=EXCLUDED.decimal_allowed,
        active=TRUE,updated_at=NOW() RETURNING *`,
    [organizationId, code, name, dimension, Boolean(input.decimalAllowed)])).rows[0];
    const previous = await client.query(`SELECT presentation.* FROM logistics_item_uoms presentation
      WHERE presentation.item_id=$1 AND presentation.uom_id=$2 AND presentation.package_level=$3
      FOR UPDATE`, [itemId, uom.id, packageLevel]);
    if (input.isBase) {
      await client.query(`UPDATE logistics_item_uoms SET is_base=FALSE,updated_at=NOW()
        WHERE item_id=$1 AND is_base=TRUE`, [itemId]);
    }
    const presentation = (await client.query(`INSERT INTO logistics_item_uoms
      (organization_id,item_id,uom_id,conversion_to_base,package_level,barcode,supplier_code,
       is_base,use_for_purchase,use_for_issue,active,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,NOW())
      ON CONFLICT (item_id,uom_id,package_level) DO UPDATE SET
        conversion_to_base=EXCLUDED.conversion_to_base,barcode=EXCLUDED.barcode,
        supplier_code=EXCLUDED.supplier_code,is_base=EXCLUDED.is_base,
        use_for_purchase=EXCLUDED.use_for_purchase,use_for_issue=EXCLUDED.use_for_issue,
        active=TRUE,updated_at=NOW() RETURNING *`,
    [organizationId, itemId, uom.id, conversion, packageLevel, barcode, supplierCode,
      Boolean(input.isBase), Boolean(input.useForPurchase), input.useForIssue !== false])).rows[0];
    if (input.isBase) {
      await client.query("UPDATE logistics_items SET unit_of_measure=$1,updated_at=NOW() WHERE id=$2",
        [code, itemId]);
    }
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,before_data,after_data,metadata)
      VALUES ($1,$2,'item_presentation',$3,$4,$5,'WEB',$6::jsonb,$7::jsonb,$8::jsonb)`,
    [organizationId, previous.rowCount ? "ITEM_PRESENTATION_UPDATED" : "ITEM_PRESENTATION_REGISTERED",
      presentation.id, actorProfileId, `item-presentation:${itemId}:${code}:${packageLevel}`,
      json(previous.rows[0] || null), json({ ...presentation, uom }),
      json({ itemId, barcode, conversionToBase: conversion })]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,'item.presentation.updated','item',$2,$3::jsonb)`,
    [organizationId, itemId, json({ itemId, presentation, uom })]);
    await client.query("COMMIT");
    return { presentation: { ...presentation, uom } };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveItemIdentifier(pool, organizationId, identifier) {
  const normalized = text(identifier).toUpperCase().replace(/\s+/g, "");
  if (!organizationId || !normalized) throw new Error("Ingresa un código para buscar.");
  const result = await pool.query(`SELECT item.*,presentation.id AS presentation_id,
      presentation.conversion_to_base,presentation.package_level,presentation.barcode,
      presentation.supplier_code,uom.code AS presentation_uom,uom.name AS presentation_uom_name
    FROM logistics_items item
    LEFT JOIN logistics_item_uoms presentation ON presentation.item_id=item.id
      AND presentation.active=TRUE
      AND (UPPER(COALESCE(presentation.barcode,''))=$2
        OR UPPER(COALESCE(presentation.supplier_code,''))=$2)
    LEFT JOIN logistics_units_of_measure uom ON uom.id=presentation.uom_id
    WHERE item.organization_id=$1 AND item.active=TRUE
      AND (UPPER(item.sku)=$2 OR UPPER(COALESCE(item.gtin,''))=$2 OR presentation.id IS NOT NULL)
    ORDER BY (UPPER(item.sku)=$2) DESC,presentation.is_base DESC LIMIT 1`,
  [organizationId, normalized]);
  if (!result.rows[0]) throw new Error("Código no reconocido en el catálogo.");
  return result.rows[0];
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
    const baseUomCode = text(input.unitOfMeasure).toUpperCase() || "UN";
    const baseUom = (await client.query(`INSERT INTO logistics_units_of_measure
      (organization_id,code,name,dimension,decimal_allowed,active,updated_at)
      VALUES ($1,$2,$3,'COUNT',$4,TRUE,NOW())
      ON CONFLICT (organization_id,code) DO UPDATE SET active=TRUE,updated_at=NOW()
      RETURNING *`, [organizationId, baseUomCode, baseUomCode, baseUomCode !== "UN"])).rows[0];
    await client.query(`UPDATE logistics_item_uoms SET is_base=FALSE,updated_at=NOW()
      WHERE item_id=$1 AND uom_id<>$2 AND is_base=TRUE`, [item.id, baseUom.id]);
    await client.query(`INSERT INTO logistics_item_uoms
      (organization_id,item_id,uom_id,conversion_to_base,package_level,is_base,use_for_purchase,use_for_issue,active,updated_at)
      VALUES ($1,$2,$3,1,'EACH',TRUE,TRUE,TRUE,TRUE,NOW())
      ON CONFLICT (item_id,uom_id,package_level) DO UPDATE SET
        conversion_to_base=1,is_base=TRUE,active=TRUE,updated_at=NOW()`,
    [organizationId, item.id, baseUom.id]);
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

export async function listSupplierItemCatalog(pool, organizationId) {
  const result = await pool.query(`SELECT catalog.*,supplier.code AS supplier_code,
      supplier.name AS supplier_name,item.sku,item.name AS item_name,item.unit_of_measure,
      uom.code AS purchase_uom,presentation.package_level,presentation.conversion_to_base
    FROM logistics_supplier_items catalog
    JOIN logistics_suppliers supplier ON supplier.id=catalog.supplier_id
    JOIN logistics_items item ON item.id=catalog.item_id
    LEFT JOIN logistics_item_uoms presentation ON presentation.id=catalog.item_uom_id
    LEFT JOIN logistics_units_of_measure uom ON uom.id=presentation.uom_id
    WHERE catalog.organization_id=$1 AND catalog.active=TRUE
    ORDER BY item.name,catalog.preferred DESC,supplier.name`, [organizationId]);
  return result.rows;
}

export async function upsertSupplierItem(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const supplierId = text(input.supplierId);
  const itemId = text(input.itemId);
  const itemUomId = text(input.itemUomId) || null;
  const supplierItemCode = text(input.supplierItemCode).toUpperCase() || null;
  const manufacturerPartNumber = text(input.manufacturerPartNumber).toUpperCase() || null;
  const leadTimeDays = Math.max(0, Math.trunc(number(input.leadTimeDays)));
  const minimumOrderQuantity = number(input.minimumOrderQuantity, 1);
  const orderMultiple = number(input.orderMultiple, 1);
  const lastUnitPrice = input.lastUnitPrice === "" || input.lastUnitPrice == null
    ? null : number(input.lastUnitPrice, -1);
  const currency = text(input.currency || "CLP").toUpperCase();
  if (!organizationId || !supplierId || !itemId) {
    throw new Error("Organización, proveedor y artículo son obligatorios.");
  }
  if (!(minimumOrderQuantity > 0) || !(orderMultiple > 0)) {
    throw new Error("La compra mínima y el múltiplo de pedido deben ser mayores que cero.");
  }
  if (lastUnitPrice != null && lastUnitPrice < 0) throw new Error("El precio no puede ser negativo.");
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("La moneda debe usar un código ISO de tres letras.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const scope = await client.query(`SELECT supplier.id AS supplier_id,item.id AS item_id,item.tracking_type
      FROM logistics_suppliers supplier CROSS JOIN logistics_items item
      WHERE supplier.id=$1 AND item.id=$2 AND supplier.organization_id=$3 AND item.organization_id=$3
        AND supplier.status='ACTIVE' AND item.active=TRUE`, [supplierId, itemId, organizationId]);
    if (!scope.rowCount) throw new Error("Proveedor o artículo no válido para esta organización.");
    if (itemUomId) {
      const presentation = await client.query(`SELECT 1 FROM logistics_item_uoms
        WHERE id=$1 AND item_id=$2 AND active=TRUE`, [itemUomId, itemId]);
      if (!presentation.rowCount) throw new Error("La presentación de compra no corresponde al artículo.");
    }
    const previous = await client.query(`SELECT * FROM logistics_supplier_items
      WHERE supplier_id=$1 AND item_id=$2 FOR UPDATE`, [supplierId, itemId]);
    if (input.preferred) {
      await client.query(`UPDATE logistics_supplier_items SET preferred=FALSE,updated_at=NOW()
        WHERE item_id=$1 AND preferred=TRUE AND active=TRUE`, [itemId]);
    }
    const catalog = (await client.query(`INSERT INTO logistics_supplier_items
      (organization_id,supplier_id,item_id,item_uom_id,supplier_item_code,manufacturer_part_number,
       lead_time_days,minimum_order_quantity,order_multiple,last_unit_price,currency,preferred,
       active,valid_from,valid_until,notes,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,$13,$14,$15,NOW())
      ON CONFLICT (supplier_id,item_id) DO UPDATE SET
        item_uom_id=EXCLUDED.item_uom_id,supplier_item_code=EXCLUDED.supplier_item_code,
        manufacturer_part_number=EXCLUDED.manufacturer_part_number,
        lead_time_days=EXCLUDED.lead_time_days,minimum_order_quantity=EXCLUDED.minimum_order_quantity,
        order_multiple=EXCLUDED.order_multiple,last_unit_price=EXCLUDED.last_unit_price,
        currency=EXCLUDED.currency,preferred=EXCLUDED.preferred,active=TRUE,
        valid_from=EXCLUDED.valid_from,valid_until=EXCLUDED.valid_until,
        notes=EXCLUDED.notes,updated_at=NOW() RETURNING *`,
    [organizationId, supplierId, itemId, itemUomId, supplierItemCode, manufacturerPartNumber,
      leadTimeDays, minimumOrderQuantity, orderMultiple, lastUnitPrice, currency,
      Boolean(input.preferred), text(input.validFrom) || null, text(input.validUntil) || null,
      text(input.notes) || null])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,before_data,after_data,metadata)
      VALUES ($1,$2,'supplier_item',$3,$4,$5,'WEB',$6::jsonb,$7::jsonb,$8::jsonb)`,
    [organizationId, previous.rowCount ? "SUPPLIER_ITEM_UPDATED" : "SUPPLIER_ITEM_REGISTERED",
      catalog.id, actorProfileId, `supplier-item:${supplierId}:${itemId}`,
      json(previous.rows[0] || null), json(catalog),
      json({ preferred: catalog.preferred, leadTimeDays, currency })]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,'supplier.item.updated','supplier_item',$2,$3::jsonb)`,
    [organizationId, catalog.id, json({ catalog })]);
    await client.query("COMMIT");
    return catalog;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createInboundReceipt(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const supplierId = text(input.supplierId);
  const warehouseId = text(input.warehouseId);
  const requisitionId = text(input.requisitionId) || null;
  const purchaseOrderId = text(input.purchaseOrderId) || null;
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
    const procurementSettings = (await client.query(`SELECT * FROM logistics_procurement_settings
      WHERE organization_id=$1 FOR SHARE`, [organizationId])).rows[0]
      || { require_purchase_order: true };
    const noPurchaseOrderReason = text(input.noPurchaseOrderReason);
    if (procurementSettings.require_purchase_order && !purchaseOrderId) {
      if (!input.allowNoPurchaseOrder) {
        throw new Error("La política de compras exige seleccionar una orden de compra emitida.");
      }
      if (noPurchaseOrderReason.length < 10) {
        throw new Error("La recepción excepcional sin orden requiere una justificación de al menos 10 caracteres.");
      }
    }
    let purchaseOrder = null;
    if (purchaseOrderId) {
      purchaseOrder = (await client.query(`SELECT * FROM logistics_purchase_orders
        WHERE id=$1 AND organization_id=$2 AND warehouse_id=$3 AND supplier_id=$4
          AND status IN ('SENT','PARTIALLY_RECEIVED') FOR UPDATE`,
      [purchaseOrderId, organizationId, warehouseId, supplierId])).rows[0];
      if (!purchaseOrder) throw new Error("La orden no está emitida o no corresponde a proveedor y bodega.");
    }
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
       status,received_by,received_at,notes,requisition_id,purchase_order_id)
      VALUES ($1,$2,$3,$4,$5,$6,'QUARANTINE',$7,COALESCE($8::timestamptz,NOW()),$9,$10,$11)
      RETURNING *`, [organizationId, receiptNumber, supplierId, warehouseId, documentType,
      documentNumber, actorProfileId, input.receivedAt || null, text(input.notes) || null,
      requisitionId, purchaseOrderId])).rows[0];
    const receiptLines = [];
    for (const [index, lineInput] of lines.entries()) {
      const itemId = text(lineInput.itemId);
      const assetUnitId = text(lineInput.assetUnitId) || null;
      const quantity = assertPositiveQuantity(lineInput.quantity);
      const item = (await client.query(`SELECT * FROM logistics_items
        WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR SHARE`, [itemId, organizationId])).rows[0];
      if (!item) throw new Error(`Línea ${index + 1}: artículo inexistente o inactivo.`);
      let purchaseOrderLine = null;
      if (purchaseOrder) {
        purchaseOrderLine = (await client.query(`SELECT * FROM logistics_purchase_order_lines
          WHERE purchase_order_id=$1 AND item_id=$2 FOR UPDATE`, [purchaseOrder.id, item.id])).rows[0];
        if (!purchaseOrderLine) throw new Error(`Línea ${index + 1}: el producto no pertenece a la orden.`);
        const remaining = number(purchaseOrderLine.quantity_ordered) - number(purchaseOrderLine.quantity_received);
        if (quantity > remaining) {
          throw new Error(`Línea ${index + 1}: quedan ${remaining} unidades pendientes en la orden.`);
        }
      }
      const purchaseUnitCost = purchaseOrder
        ? number(purchaseOrderLine.unit_cost)
        : Math.max(0, number(lineInput.unitCost, number(item.standard_cost)));
      const currency = purchaseOrder
        ? purchaseOrder.currency
        : text(lineInput.currency || item.currency || "CLP").toUpperCase();
      if (!["CLP", "USD", "EUR", "UF"].includes(currency)) {
        throw new Error(`Línea ${index + 1}: moneda no permitida.`);
      }
      if (purchaseUnitCost > 0 && number(item.standard_cost) > 0 && currency !== item.currency) {
        throw new Error(`Línea ${index + 1}: el costo debe expresarse en ${item.currency}; no hay tipo de cambio configurado.`);
      }
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
        notes: text(lineInput.notes) || `Recepción en cuarentena ${receiptNumber}`,
        unitCost: purchaseUnitCost, currency
      }, actorProfileId);
      const line = (await client.query(`INSERT INTO logistics_inbound_receipt_lines
        (receipt_id,item_id,asset_unit_id,lot_id,quantity,condition_status,receipt_movement_id,
         unit_cost,currency,notes,purchase_order_line_id)
        VALUES ($1,$2,$3,$4,$5,'QUARANTINE',$6,$7,$8,$9,$10) RETURNING *`,
        [receipt.id, itemId, assetUnitId, lotId, quantity, posted.movement.id,
          purchaseUnitCost, currency, text(lineInput.notes) || null, purchaseOrderLine?.id || null])).rows[0];
      if (purchaseUnitCost > 0) {
        const stockAfterReceipt = (await client.query(`SELECT COALESCE(SUM(quantity),0)::numeric AS quantity
          FROM logistics_stock_balances WHERE organization_id=$1 AND item_id=$2`,
        [organizationId, itemId])).rows[0];
        const previousQuantity = Math.max(0, number(stockAfterReceipt.quantity) - quantity);
        const previousCost = number(item.standard_cost);
        const newCost = previousQuantity + quantity > 0
          ? Number(((previousQuantity * previousCost + quantity * purchaseUnitCost)
            / (previousQuantity + quantity)).toFixed(4))
          : purchaseUnitCost;
        await client.query(`UPDATE logistics_items SET standard_cost=$1,currency=$2,updated_at=NOW()
          WHERE id=$3`, [newCost, currency, itemId]);
        await client.query(`INSERT INTO logistics_item_cost_history
          (organization_id,item_id,source_type,source_id,previous_cost,new_cost,received_quantity,
           purchase_unit_cost,currency,actor_profile_id,metadata)
          VALUES ($1,$2,'INBOUND_RECEIPT',$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [organizationId, itemId, receipt.id, previousCost, newCost, quantity, purchaseUnitCost,
          currency, actorProfileId, json({ receiptNumber, supplierId, documentNumber })]);
      }
      receiptLines.push(line);
    }
    if (purchaseOrder) {
      for (const line of receiptLines) {
        await client.query(`UPDATE logistics_purchase_order_lines SET
          quantity_received=quantity_received+$1,updated_at=NOW()
          WHERE id=$2`, [line.quantity, line.purchase_order_line_id]);
      }
      const pendingOrder = await client.query(`SELECT COUNT(*)::int AS count
        FROM logistics_purchase_order_lines
        WHERE purchase_order_id=$1 AND quantity_received<quantity_ordered`, [purchaseOrder.id]);
      await client.query(`UPDATE logistics_purchase_orders SET status=$1,updated_at=NOW()
        WHERE id=$2`, [pendingOrder.rows[0].count ? "PARTIALLY_RECEIVED" : "RECEIVED", purchaseOrder.id]);
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
        json(receipt), json({
          supplier: supplier.name,
          warehouse: warehouse.name,
          lineCount: receiptLines.length,
          purchaseOrderId,
          exceptionalWithoutPurchaseOrder: !purchaseOrderId,
          noPurchaseOrderReason: noPurchaseOrderReason || null
        })]);
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
      purchase_order.purchase_order_number,supplier_return.id AS supplier_return_id,
      supplier_return.return_number,supplier_return.status AS return_status,
      supplier_return.reason_code AS return_reason_code,supplier_return.document_number AS return_document_number,
      supplier_return.carrier AS return_carrier,supplier_return.tracking_number AS return_tracking_number,
      supplier_return.credit_note_number,supplier_return.credit_amount,
      COALESCE(jsonb_agg(jsonb_build_object(
        'id',line.id,'itemId',line.item_id,'sku',item.sku,'itemName',item.name,
        'assetUnitId',line.asset_unit_id,'unitCode',unit.unit_code,
        'lotId',line.lot_id,'lotNumber',lot.lot_number,'expiresAt',lot.expires_at,
        'quantity',line.quantity,'conditionStatus',line.condition_status,
        'unitCost',line.unit_cost,'currency',line.currency,
        'totalValue',ROUND(line.quantity * line.unit_cost,4),
        'purchaseOrderLineId',line.purchase_order_line_id
      ) ORDER BY line.created_at) FILTER (WHERE line.id IS NOT NULL),'[]'::jsonb) AS lines
    FROM logistics_inbound_receipts receipt
    JOIN logistics_suppliers supplier ON supplier.id=receipt.supplier_id
    JOIN logistics_warehouses warehouse ON warehouse.id=receipt.warehouse_id
    LEFT JOIN logistics_purchase_orders purchase_order ON purchase_order.id=receipt.purchase_order_id
    LEFT JOIN logistics_supplier_returns supplier_return ON supplier_return.receipt_id=receipt.id
    LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
    LEFT JOIN logistics_inbound_receipt_lines line ON line.receipt_id=receipt.id
    LEFT JOIN logistics_items item ON item.id=line.item_id
    LEFT JOIN logistics_asset_units unit ON unit.id=line.asset_unit_id
    LEFT JOIN logistics_lots lot ON lot.id=line.lot_id
    WHERE 1=1 ${scope}
    GROUP BY receipt.id,supplier.name,supplier.tax_id,warehouse.name,center.name,
      purchase_order.purchase_order_number,supplier_return.id
    ORDER BY receipt.received_at DESC LIMIT 250`, params);
  return result.rows;
}

export async function listInventoryAnalytics(pool, profile, organizationId) {
  const params = [organizationId];
  const scope = profile?.admin ? "" : `AND center.name=$${params.push(profile?.cost_center || "")}`;
  const result = await pool.query(`WITH stock AS (
      SELECT balance.item_id,location.warehouse_id,
        COALESCE(SUM(balance.quantity),0)::numeric AS on_hand
      FROM logistics_stock_balances balance
      JOIN logistics_locations location ON location.id=balance.location_id
      WHERE balance.organization_id=$1 AND location.location_type='STORAGE'
      GROUP BY balance.item_id,location.warehouse_id
    ), consumption AS (
      SELECT ledger.item_id,location.warehouse_id,
        COALESCE(SUM(-ledger.quantity) FILTER (
          WHERE ledger.occurred_at>=NOW()-INTERVAL '30 days'),0)::numeric AS consumption_30,
        COALESCE(SUM(-ledger.quantity) FILTER (
          WHERE ledger.occurred_at>=NOW()-INTERVAL '90 days'),0)::numeric AS consumption_90,
        COALESCE(SUM(-ledger.quantity) FILTER (
          WHERE ledger.occurred_at>=NOW()-INTERVAL '365 days'),0)::numeric AS consumption_365,
        MAX(ledger.occurred_at) AS last_consumption_at
      FROM logistics_stock_ledger ledger
      JOIN logistics_stock_movements movement ON movement.id=ledger.movement_id
      JOIN logistics_locations location ON location.id=ledger.location_id
      WHERE ledger.organization_id=$1 AND ledger.quantity<0
        AND movement.status='POSTED' AND movement.movement_type='CONSUMPTION'
      GROUP BY ledger.item_id,location.warehouse_id
    ), activity AS (
      SELECT COALESCE(stock.item_id,consumption.item_id) AS item_id,
        COALESCE(stock.warehouse_id,consumption.warehouse_id) AS warehouse_id,
        COALESCE(stock.on_hand,0)::numeric AS on_hand,
        COALESCE(consumption.consumption_30,0)::numeric AS consumption_30,
        COALESCE(consumption.consumption_90,0)::numeric AS consumption_90,
        COALESCE(consumption.consumption_365,0)::numeric AS consumption_365,
        consumption.last_consumption_at
      FROM stock FULL OUTER JOIN consumption
        ON consumption.item_id=stock.item_id AND consumption.warehouse_id=stock.warehouse_id
    )
    SELECT item.id AS item_id,item.sku,item.name,item.item_type,item.tracking_type,item.unit_of_measure,
      item.standard_cost,item.currency,item.minimum_stock,item.valuation_method,
      warehouse.id AS warehouse_id,warehouse.name AS warehouse_name,center.name AS cost_center,
      activity.on_hand,activity.consumption_30,activity.consumption_90,activity.consumption_365,
      activity.last_consumption_at,
      ROUND(activity.on_hand * item.standard_cost,4) AS stock_value,
      ROUND(activity.consumption_365 * item.standard_cost,4) AS annual_consumption_value,
      CASE WHEN activity.consumption_90>0
        THEN ROUND(activity.on_hand / (activity.consumption_90 / 90),1) ELSE NULL END AS days_cover,
      COALESCE(policy.lead_time_days,0) AS lead_time_days,
      COALESCE(policy.safety_stock,0) AS safety_stock,
      COALESCE(policy.reorder_point,item.minimum_stock,0) AS reorder_point
    FROM activity
    JOIN logistics_items item ON item.id=activity.item_id AND item.active=TRUE
    JOIN logistics_warehouses warehouse ON warehouse.id=activity.warehouse_id
    LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
    LEFT JOIN logistics_replenishment_policies policy
      ON policy.item_id=item.id AND policy.warehouse_id=warehouse.id AND policy.active=TRUE
    WHERE item.organization_id=$1 ${scope}
    ORDER BY item.currency,item.name,center.name,warehouse.name`, params);

  const rows = result.rows.map(row => {
    const onHand = number(row.on_hand);
    const consumption90 = number(row.consumption_90);
    const stockValue = number(row.stock_value);
    const annualConsumptionValue = number(row.annual_consumption_value);
    const daysCover = row.days_cover === null ? null : number(row.days_cover);
    const reorderPoint = number(row.reorder_point);
    const leadTimeDays = number(row.lead_time_days);
    return {
      ...row,
      on_hand: onHand,
      consumption_30: number(row.consumption_30),
      consumption_90: consumption90,
      consumption_365: number(row.consumption_365),
      standard_cost: number(row.standard_cost),
      stock_value: stockValue,
      annual_consumption_value: annualConsumptionValue,
      days_cover: daysCover,
      dead_stock: onHand > 0 && consumption90 === 0,
      shortage_risk: onHand <= reorderPoint
        || (daysCover !== null && leadTimeDays > 0 && daysCover < leadTimeDays)
    };
  });
  const currencies = [...new Set(rows.map(row => row.currency || "CLP"))];
  for (const currency of currencies) {
    const currencyRows = rows.filter(row => (row.currency || "CLP") === currency)
      .sort((a, b) => b.annual_consumption_value - a.annual_consumption_value);
    const total = currencyRows.reduce((sum, row) => sum + row.annual_consumption_value, 0);
    let accumulated = 0;
    for (const row of currencyRows) {
      const previousShare = total > 0 ? accumulated / total : 1;
      accumulated += row.annual_consumption_value;
      row.abc_class = previousShare < 0.80 ? "A" : previousShare < 0.95 ? "B" : "C";
    }
  }
  const byCurrency = currencies.map(currency => {
    const currencyRows = rows.filter(row => (row.currency || "CLP") === currency);
    return {
      currency,
      stockValue: currencyRows.reduce((sum, row) => sum + row.stock_value, 0),
      annualConsumptionValue: currencyRows.reduce((sum, row) => sum + row.annual_consumption_value, 0),
      deadStockValue: currencyRows.filter(row => row.dead_stock)
        .reduce((sum, row) => sum + row.stock_value, 0)
    };
  });
  return {
    rows,
    summary: {
      byCurrency,
      itemWarehouses: rows.length,
      deadStock: rows.filter(row => row.dead_stock).length,
      shortageRisk: rows.filter(row => row.shortage_risk).length,
      classA: rows.filter(row => row.abc_class === "A").length
    }
  };
}

export async function listInventoryClassifications(pool, organizationId) {
  const [result, policyResult] = await Promise.all([
    pool.query(`SELECT classification.*,item.sku,item.name AS item_name,
      item.item_type,item.unit_of_measure,item.standard_cost,item.currency,
      policy.tolerance_percent,
      (SELECT MAX(cycle.posted_at) FROM logistics_cycle_count_lines line
        JOIN logistics_cycle_counts cycle ON cycle.id=line.count_id
        WHERE line.item_id=item.id AND cycle.status='POSTED') AS last_counted_at
    FROM logistics_inventory_classifications classification
    JOIN logistics_items item ON item.id=classification.item_id
    JOIN logistics_classification_policies policy
      ON policy.organization_id=classification.organization_id
     AND policy.abc_class=classification.abc_class AND policy.active=TRUE
    WHERE classification.organization_id=$1 AND item.active=TRUE
    ORDER BY classification.abc_class,classification.xyz_class,
      classification.consumption_value DESC,item.name`, [organizationId]),
    pool.query(`SELECT * FROM logistics_classification_policies
      WHERE organization_id=$1 AND active=TRUE ORDER BY abc_class`, [organizationId])
  ]);
  const rows = result.rows.map(row => {
    const last = row.last_counted_at ? new Date(row.last_counted_at) : null;
    const next = last
      ? new Date(last.getTime() + number(row.recommended_count_interval_days) * 86_400_000)
      : new Date(row.calculated_at);
    return {
      ...row,
      next_count_due: next.toISOString(),
      count_overdue: next.getTime() <= Date.now()
    };
  });
  return {
    rows,
    policies: policyResult.rows,
    summary: {
      total: rows.length,
      classA: rows.filter(row => row.abc_class === "A").length,
      classB: rows.filter(row => row.abc_class === "B").length,
      classC: rows.filter(row => row.abc_class === "C").length,
      overdue: rows.filter(row => row.count_overdue).length,
      calculatedAt: rows[0]?.calculated_at || null
    }
  };
}

export async function updateClassificationPolicy(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const abcClass = text(input.abcClass).toUpperCase();
  const countIntervalDays = Math.trunc(number(input.countIntervalDays));
  const tolerancePercent = number(input.tolerancePercent);
  if (!organizationId || !["A", "B", "C"].includes(abcClass)) throw new Error("Clase ABC no válida.");
  if (!(countIntervalDays > 0) || tolerancePercent < 0) {
    throw new Error("Intervalo y tolerancia deben ser valores válidos.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const previous = await client.query(`SELECT * FROM logistics_classification_policies
      WHERE organization_id=$1 AND abc_class=$2 FOR UPDATE`, [organizationId, abcClass]);
    const policy = (await client.query(`INSERT INTO logistics_classification_policies
      (organization_id,abc_class,count_interval_days,tolerance_percent,active,updated_at)
      VALUES ($1,$2,$3,$4,TRUE,NOW())
      ON CONFLICT (organization_id,abc_class) DO UPDATE SET
        count_interval_days=EXCLUDED.count_interval_days,
        tolerance_percent=EXCLUDED.tolerance_percent,active=TRUE,updated_at=NOW()
      RETURNING *`, [organizationId, abcClass, countIntervalDays, tolerancePercent])).rows[0];
    await client.query(`UPDATE logistics_inventory_classifications
      SET recommended_count_interval_days=$1
      WHERE organization_id=$2 AND abc_class=$3`, [countIntervalDays, organizationId, abcClass]);
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,before_data,after_data)
      VALUES ($1,'CLASSIFICATION_POLICY_UPDATED','classification_policy',$2,$3,$4,'WEB',$5::jsonb,$6::jsonb)`,
    [organizationId, policy.id, actorProfileId, `classification-policy:${abcClass}`,
      json(previous.rows[0] || null), json(policy)]);
    await client.query("COMMIT");
    return policy;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function calculateInventoryClassifications(pool, organizationId, analysisMonths = 12,
  actorProfileId = null) {
  const months = Math.min(36, Math.max(3, Math.trunc(number(analysisMonths, 12))));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const policyResult = await client.query(`SELECT * FROM logistics_classification_policies
      WHERE organization_id=$1 AND active=TRUE`, [organizationId]);
    const policies = new Map(policyResult.rows.map(row => [row.abc_class, row]));
    const demand = await client.query(`WITH months AS (
        SELECT generate_series(
          date_trunc('month',CURRENT_DATE)-($2::int-1)*INTERVAL '1 month',
          date_trunc('month',CURRENT_DATE),INTERVAL '1 month') AS month_start
      ), monthly AS (
        SELECT item.id AS item_id,item.currency,item.standard_cost,months.month_start,
          COALESCE(SUM(CASE WHEN movement.id IS NOT NULL AND ledger.quantity<0
            THEN -ledger.quantity ELSE 0 END),0)::numeric AS quantity
        FROM logistics_items item CROSS JOIN months
        LEFT JOIN logistics_stock_ledger ledger ON ledger.item_id=item.id
          AND ledger.organization_id=item.organization_id
          AND ledger.occurred_at>=months.month_start
          AND ledger.occurred_at<months.month_start+INTERVAL '1 month'
        LEFT JOIN logistics_stock_movements movement ON movement.id=ledger.movement_id
          AND movement.status='POSTED' AND movement.movement_type='CONSUMPTION'
        WHERE item.organization_id=$1 AND item.active=TRUE
        GROUP BY item.id,item.currency,item.standard_cost,months.month_start
      )
      SELECT item_id,currency,standard_cost,SUM(quantity)::numeric AS consumption_quantity,
        AVG(quantity)::numeric AS monthly_average,
        COALESCE(STDDEV_POP(quantity),0)::numeric AS demand_stddev
      FROM monthly GROUP BY item_id,currency,standard_cost`, [organizationId, months]);
    const rows = demand.rows.map(row => {
      const quantity = number(row.consumption_quantity);
      const value = quantity * number(row.standard_cost);
      const average = number(row.monthly_average);
      const stddev = number(row.demand_stddev);
      const cv = average > 0 ? stddev / average : null;
      return {
        ...row,
        consumptionQuantity: quantity,
        consumptionValue: value,
        monthlyAverage: average,
        demandStddev: stddev,
        coefficientVariation: cv,
        xyzClass: cv == null ? "Z" : cv <= 0.5 ? "X" : cv <= 1 ? "Y" : "Z"
      };
    });
    for (const currency of [...new Set(rows.map(row => row.currency || "CLP"))]) {
      const group = rows.filter(row => (row.currency || "CLP") === currency)
        .sort((a, b) => b.consumptionValue - a.consumptionValue);
      const total = group.reduce((sum, row) => sum + row.consumptionValue, 0);
      let accumulated = 0;
      for (const row of group) {
        const previousShare = total > 0 ? accumulated / total : 1;
        row.abcClass = total <= 0 ? "C" : previousShare < 0.80 ? "A" : previousShare < 0.95 ? "B" : "C";
        accumulated += row.consumptionValue;
      }
    }
    for (const row of rows) {
      const policy = policies.get(row.abcClass);
      if (!policy) throw new Error(`Falta política para la clase ${row.abcClass}.`);
      await client.query(`INSERT INTO logistics_inventory_classifications
        (organization_id,item_id,abc_class,xyz_class,analysis_months,consumption_quantity,
         consumption_value,monthly_average,demand_stddev,coefficient_variation,
         recommended_count_interval_days,calculated_at,metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12::jsonb)
        ON CONFLICT (organization_id,item_id) DO UPDATE SET
          abc_class=EXCLUDED.abc_class,xyz_class=EXCLUDED.xyz_class,
          analysis_months=EXCLUDED.analysis_months,
          consumption_quantity=EXCLUDED.consumption_quantity,
          consumption_value=EXCLUDED.consumption_value,
          monthly_average=EXCLUDED.monthly_average,demand_stddev=EXCLUDED.demand_stddev,
          coefficient_variation=EXCLUDED.coefficient_variation,
          recommended_count_interval_days=EXCLUDED.recommended_count_interval_days,
          calculated_at=NOW(),metadata=EXCLUDED.metadata`,
      [organizationId, row.item_id, row.abcClass, row.xyzClass, months,
        row.consumptionQuantity, row.consumptionValue, row.monthlyAverage,
        row.demandStddev, row.coefficientVariation, policy.count_interval_days,
        json({ currency: row.currency || "CLP", thresholds: { A: 0.80, B: 0.95, X: 0.5, Y: 1 } })]);
    }
    const summary = {
      items: rows.length,
      classA: rows.filter(row => row.abcClass === "A").length,
      classB: rows.filter(row => row.abcClass === "B").length,
      classC: rows.filter(row => row.abcClass === "C").length,
      stableX: rows.filter(row => row.xyzClass === "X").length,
      irregularZ: rows.filter(row => row.xyzClass === "Z").length,
      analysisMonths: months
    };
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data,metadata)
      VALUES ($1,'INVENTORY_CLASSIFICATION_CALCULATED','organization',$1,$2,$3,'SYSTEM',$4::jsonb,$5::jsonb)`,
    [organizationId, actorProfileId, `inventory-classification:${new Date().toISOString().slice(0, 10)}`,
      json(summary), json({ thresholds: { A: 0.80, B: 0.95, X: 0.5, Y: 1 } })]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,'inventory.classification.calculated','organization',$1,$2::jsonb)`,
    [organizationId, json(summary)]);
    await client.query("COMMIT");
    return summary;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateItemCost(pool, itemId, input, actorProfileId = null) {
  const newCost = number(input.standardCost, -1);
  const currency = text(input.currency || "CLP").toUpperCase();
  const valuationMethod = text(input.valuationMethod || "MOVING_AVERAGE").toUpperCase();
  if (newCost < 0) throw new Error("El costo no puede ser negativo.");
  if (!["CLP", "USD", "EUR", "UF"].includes(currency)) throw new Error("Moneda no permitida.");
  if (!["MOVING_AVERAGE", "STANDARD"].includes(valuationMethod)) throw new Error("Método de valorización no permitido.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const item = (await client.query(`SELECT * FROM logistics_items
      WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR UPDATE`,
    [itemId, text(input.organizationId)])).rows[0];
    if (!item) throw new Error("Artículo inexistente o inactivo.");
    const updated = (await client.query(`UPDATE logistics_items
      SET standard_cost=$1,currency=$2,valuation_method=$3,updated_at=NOW()
      WHERE id=$4 RETURNING *`,
    [newCost, currency, valuationMethod, itemId])).rows[0];
    await client.query(`INSERT INTO logistics_item_cost_history
      (organization_id,item_id,source_type,source_id,previous_cost,new_cost,received_quantity,
       purchase_unit_cost,currency,actor_profile_id,metadata)
      VALUES ($1,$2,'MANUAL_STANDARD',$3,$4,$5,0,0,$6,$7,$8::jsonb)`,
    [item.organization_id, item.id, text(input.reference) || null, number(item.standard_cost),
      newCost, currency, actorProfileId, json({ notes: text(input.notes), previousCurrency: item.currency })]);
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,
       before_data,after_data,metadata)
      VALUES ($1,'ITEM_COST_UPDATED','item',$2,$3,$4,'MANUAL',$5::jsonb,$6::jsonb,$7::jsonb)`,
    [item.organization_id, item.id, actorProfileId, `item-cost:${item.id}:${Date.now()}`,
      json({ standardCost: item.standard_cost, currency: item.currency }),
      json({ standardCost: newCost, currency, valuationMethod: updated.valuation_method }),
      json({ reference: text(input.reference), notes: text(input.notes) })]);
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listInventoryControls(pool, profile, organizationId) {
  const params = [organizationId];
  const scope = profile?.admin ? "" : `AND center.name=$${params.push(profile?.cost_center || "")}`;
  const [periods, adjustments] = await Promise.all([
    pool.query(`SELECT period.*,opener.name AS opened_by_name,closer.name AS closed_by_name
      FROM logistics_inventory_periods period
      LEFT JOIN inventory_user_profiles opener ON opener.id=period.opened_by
      LEFT JOIN inventory_user_profiles closer ON closer.id=period.closed_by
      WHERE period.organization_id=$1 ORDER BY period.starts_on DESC LIMIT 36`, [organizationId]),
    pool.query(`SELECT adjustment.*,item.sku,item.name AS item_name,item.tracking_type,
        warehouse.name AS warehouse_name,center.name AS cost_center,location.name AS location_name,
        requester.name AS requested_by_name,approver.name AS approved_by_name,poster.name AS posted_by_name,
        unit.unit_code,lot.lot_number
      FROM logistics_inventory_adjustments adjustment
      JOIN logistics_items item ON item.id=adjustment.item_id
      JOIN logistics_warehouses warehouse ON warehouse.id=adjustment.warehouse_id
      JOIN logistics_locations location ON location.id=adjustment.location_id
      LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
      LEFT JOIN inventory_user_profiles requester ON requester.id=adjustment.requested_by
      LEFT JOIN inventory_user_profiles approver ON approver.id=adjustment.approved_by
      LEFT JOIN inventory_user_profiles poster ON poster.id=adjustment.posted_by
      LEFT JOIN logistics_asset_units unit ON unit.id=adjustment.asset_unit_id
      LEFT JOIN logistics_lots lot ON lot.id=adjustment.lot_id
      WHERE adjustment.organization_id=$1 ${scope}
      ORDER BY adjustment.requested_at DESC LIMIT 250`, params)
  ]);
  return { periods: periods.rows, adjustments: adjustments.rows };
}

const KPI_DEFINITIONS = {
  FILL_RATE: { label: "Nivel de servicio", summaryKey: "fillRate", warehouseKey: "fill_rate", evidenceKey: "completedRequests" },
  ON_TIME_RATE: { label: "Entregas a tiempo", summaryKey: "onTimeRate", evidenceKey: "timedCompletedRequests" },
  PICKING_ACCURACY: { label: "Exactitud de picking", summaryKey: "pickingAccuracy", evidenceKey: "handledPickTasks" },
  INVENTORY_ACCURACY: { label: "Exactitud de inventario", summaryKey: "inventoryAccuracy", evidenceKey: "countedLines" },
  AVERAGE_CYCLE_HOURS: { label: "Tiempo de ciclo", summaryKey: "averageCycleHours", warehouseKey: "cycle_hours", evidenceKey: "completedRequests" },
  OVERDUE_OPEN_REQUESTS: { label: "Solicitudes atrasadas", summaryKey: "overdueOpenRequests" }
};

function kpiSeverity(target, value) {
  const direction = target.direction;
  const critical = direction === "MINIMUM"
    ? value <= number(target.critical_value) : value >= number(target.critical_value);
  const warning = direction === "MINIMUM"
    ? value <= number(target.warning_value) : value >= number(target.warning_value);
  const missed = direction === "MINIMUM"
    ? value < number(target.target_value) : value > number(target.target_value);
  return critical ? "Crítica" : warning ? "Alta" : missed ? "Media" : "";
}

function evaluateKpiTargets(targets, summary, warehouses) {
  const globalTargets = new Map(targets.filter(target => !target.warehouse_id)
    .map(target => [target.metric_code, target]));
  const warehouseTargets = new Map(targets.filter(target => target.warehouse_id)
    .map(target => [`${target.warehouse_id}:${target.metric_code}`, target]));
  const breaches = [];
  for (const target of globalTargets.values()) {
    const definition = KPI_DEFINITIONS[target.metric_code];
    if (!definition) continue;
    if (definition.evidenceKey && !(number(summary[definition.evidenceKey]) > 0)) continue;
    const value = number(summary[definition.summaryKey]);
    const priority = kpiSeverity(target, value);
    if (priority) breaches.push({
      metricCode: target.metric_code, label: definition.label, value,
      target: number(target.target_value), priority, direction: target.direction,
      warehouseId: null, warehouseName: "Toda la organización", costCenter: null
    });
  }
  for (const warehouse of warehouses) {
    for (const metricCode of ["FILL_RATE", "AVERAGE_CYCLE_HOURS"]) {
      const definition = KPI_DEFINITIONS[metricCode];
      const target = warehouseTargets.get(`${warehouse.warehouse_id}:${metricCode}`)
        || globalTargets.get(metricCode);
      if (!target || !(number(warehouse.completed_requests) > 0)) continue;
      const value = number(warehouse[definition.warehouseKey]);
      const priority = kpiSeverity(target, value);
      if (priority) breaches.push({
        metricCode, label: definition.label, value, target: number(target.target_value),
        priority, direction: target.direction, warehouseId: warehouse.warehouse_id,
        warehouseName: warehouse.warehouse_name, costCenter: warehouse.cost_center
      });
    }
  }
  return breaches;
}

export async function listKpiTargets(pool, profile, organizationId) {
  const center = profile?.admin ? null : text(profile?.cost_center);
  return (await pool.query(`SELECT target.*,warehouse.name AS warehouse_name,
      center_name.name AS cost_center
    FROM logistics_kpi_targets target
    LEFT JOIN logistics_warehouses warehouse ON warehouse.id=target.warehouse_id
    LEFT JOIN logistics_cost_centers center_name ON center_name.id=warehouse.cost_center_id
    WHERE target.organization_id=$1 AND target.enabled=TRUE
      AND (target.warehouse_id IS NULL OR $2::text IS NULL OR center_name.name=$2)
    ORDER BY target.warehouse_id NULLS FIRST,target.metric_code`,
    [organizationId, center])).rows;
}

export async function upsertKpiTarget(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const metricCode = text(input.metricCode).toUpperCase();
  const direction = text(input.direction).toUpperCase();
  const targetValue = number(input.targetValue);
  const warningValue = number(input.warningValue);
  const criticalValue = number(input.criticalValue);
  if (!organizationId || !KPI_DEFINITIONS[metricCode] || !["MINIMUM", "MAXIMUM"].includes(direction)) {
    throw new Error("Indicador o dirección de meta no válidos.");
  }
  const ordered = direction === "MINIMUM"
    ? targetValue >= warningValue && warningValue >= criticalValue
    : targetValue <= warningValue && warningValue <= criticalValue;
  if (!ordered) throw new Error("Los niveles objetivo, alerta y crítico no están ordenados correctamente.");
  const result = await pool.query(`INSERT INTO logistics_kpi_targets
    (organization_id,warehouse_id,metric_code,direction,target_value,warning_value,
     critical_value,enabled,created_by,updated_by,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8,$8,NOW())
    ON CONFLICT (organization_id,warehouse_id,metric_code) DO UPDATE SET
      direction=EXCLUDED.direction,target_value=EXCLUDED.target_value,
      warning_value=EXCLUDED.warning_value,critical_value=EXCLUDED.critical_value,
      enabled=TRUE,updated_by=EXCLUDED.updated_by,updated_at=NOW()
    RETURNING *`, [organizationId, input.warehouseId || null, metricCode, direction,
      targetValue, warningValue, criticalValue, actorProfileId]);
  await pool.query(`INSERT INTO logistics_audit_events
    (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,after_data)
    VALUES ($1,'LOGISTICS_KPI_TARGET_UPDATED','kpi_target',$2,$3,'WEB',$4::jsonb)`,
    [organizationId, result.rows[0].id, actorProfileId, json(result.rows[0])]);
  return result.rows[0];
}

export async function listLogisticsKpis(pool, profile, organizationId, periodDays = 90) {
  const days = Math.max(1, Math.min(730, Math.round(number(periodDays, 90))));
  const center = profile?.admin ? null : text(profile?.cost_center);
  const params = [organizationId, days, center];
  const requestScope = `request.organization_id=$1
    AND request.created_at>=NOW()-($2::text||' days')::interval
    AND ($3::text IS NULL OR request_center.name=$3 OR fulfillment_center.name=$3)`;
  const summary = (await pool.query(`WITH visible_requests AS (
      SELECT request.* FROM logistics_material_requests request
      JOIN logistics_warehouses requesting ON requesting.id=request.requesting_warehouse_id
      JOIN logistics_warehouses fulfillment ON fulfillment.id=request.fulfillment_warehouse_id
      LEFT JOIN logistics_cost_centers request_center ON request_center.id=requesting.cost_center_id
      LEFT JOIN logistics_cost_centers fulfillment_center ON fulfillment_center.id=fulfillment.cost_center_id
      WHERE ${requestScope}
    ), quantities AS (
      SELECT request.id,request.status,request.created_at,request.needed_at,
        request.issued_at,request.received_at,request.picking_at,
        COALESCE(SUM(line.quantity_requested),0)::numeric AS requested,
        COALESCE(SUM(line.quantity_issued),0)::numeric AS issued
      FROM visible_requests request
      LEFT JOIN logistics_material_request_lines line ON line.request_id=request.id
      GROUP BY request.id,request.status,request.created_at,request.needed_at,
        request.issued_at,request.received_at,request.picking_at
    )
    SELECT COUNT(*)::int AS total_requests,
      COUNT(*) FILTER (WHERE status IN ('ISSUED','RECEIVED'))::int AS completed_requests,
      COUNT(*) FILTER (WHERE status IN ('ISSUED','RECEIVED') AND needed_at IS NOT NULL)::int
        AS timed_completed_requests,
      COUNT(*) FILTER (WHERE status NOT IN ('ISSUED','RECEIVED','CANCELLED')
        AND created_at<NOW()-INTERVAL '48 hours')::int AS overdue_open_requests,
      COUNT(*) FILTER (WHERE status='IN_TRANSIT')::int AS in_transit_requests,
      ROUND(COALESCE(100*SUM(issued) FILTER (WHERE status IN ('ISSUED','RECEIVED'))
        /NULLIF(SUM(requested) FILTER (WHERE status IN ('ISSUED','RECEIVED')),0),0),2) AS fill_rate,
      ROUND(COALESCE(100.0*COUNT(*) FILTER (WHERE status IN ('ISSUED','RECEIVED')
          AND needed_at IS NOT NULL AND COALESCE(received_at,issued_at)<=needed_at)
        /NULLIF(COUNT(*) FILTER (WHERE status IN ('ISSUED','RECEIVED') AND needed_at IS NOT NULL),0),0),2)
        AS on_time_rate,
      ROUND(COALESCE(AVG(EXTRACT(EPOCH FROM
        (COALESCE(received_at,issued_at)-created_at))/3600)
        FILTER (WHERE status IN ('ISSUED','RECEIVED')),0)::numeric,2) AS average_cycle_hours,
      ROUND(COALESCE(AVG(EXTRACT(EPOCH FROM (issued_at-picking_at))/3600)
        FILTER (WHERE issued_at IS NOT NULL AND picking_at IS NOT NULL),0)::numeric,2)
        AS average_pick_hours
    FROM quantities`, params)).rows[0] || {};

  const picking = (await pool.query(`WITH visible_tasks AS (
      SELECT task.id,task.status FROM logistics_pick_tasks task
      JOIN logistics_material_requests request ON request.id=task.request_id
      JOIN logistics_warehouses requesting ON requesting.id=request.requesting_warehouse_id
      JOIN logistics_warehouses fulfillment ON fulfillment.id=request.fulfillment_warehouse_id
      LEFT JOIN logistics_cost_centers request_center ON request_center.id=requesting.cost_center_id
      LEFT JOIN logistics_cost_centers fulfillment_center ON fulfillment_center.id=fulfillment.cost_center_id
      WHERE ${requestScope}
    )
    SELECT COUNT(*) FILTER (WHERE task.status='PICKED')::int AS completed_tasks,
      COUNT(*) FILTER (WHERE task.status IN ('PICKED','EXCEPTION'))::int AS handled_tasks,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM logistics_audit_events event
        WHERE event.entity_type='pick_task' AND event.entity_id=task.id
          AND event.event_type='PICK_TASK_EXCEPTION'
      ))::int AS tasks_with_exception
    FROM visible_tasks task`, params)).rows[0] || {};

  const counts = (await pool.query(`SELECT
      COUNT(*)::int AS counted_lines,
      COUNT(*) FILTER (WHERE ABS(line.counted_quantity-line.expected_quantity)<0.000001)::int AS exact_lines
    FROM logistics_cycle_count_lines line
    JOIN logistics_cycle_counts cycle ON cycle.id=line.count_id
    JOIN logistics_warehouses warehouse ON warehouse.id=cycle.warehouse_id
    LEFT JOIN logistics_cost_centers center_name ON center_name.id=warehouse.cost_center_id
    WHERE cycle.organization_id=$1 AND cycle.status='POSTED'
      AND cycle.posted_at>=NOW()-($2::text||' days')::interval
      AND ($3::text IS NULL OR center_name.name=$3)`, params)).rows[0] || {};

  const warehouses = (await pool.query(`WITH request_quantities AS (
      SELECT request.id,request.fulfillment_warehouse_id,request.status,request.created_at,
        request.issued_at,request.received_at,
        COALESCE(SUM(line.quantity_requested),0)::numeric AS requested,
        COALESCE(SUM(line.quantity_issued),0)::numeric AS issued
      FROM logistics_material_requests request
      LEFT JOIN logistics_material_request_lines line ON line.request_id=request.id
      WHERE request.organization_id=$1
        AND request.created_at>=NOW()-($2::text||' days')::interval
      GROUP BY request.id,request.fulfillment_warehouse_id,request.status,request.created_at,
        request.issued_at,request.received_at
    )
    SELECT warehouse.id AS warehouse_id,warehouse.name AS warehouse_name,
      center_name.name AS cost_center,
      COUNT(request.id)::int AS requests,
      COUNT(request.id) FILTER (WHERE request.status IN ('ISSUED','RECEIVED'))::int
        AS completed_requests,
      COUNT(request.id) FILTER (WHERE request.status NOT IN ('ISSUED','RECEIVED','CANCELLED'))::int AS open_requests,
      ROUND(COALESCE(100*SUM(request.issued) FILTER (WHERE request.status IN ('ISSUED','RECEIVED'))
        /NULLIF(SUM(request.requested) FILTER (WHERE request.status IN ('ISSUED','RECEIVED')),0),0),2)
        AS fill_rate,
      ROUND(COALESCE(AVG(EXTRACT(EPOCH FROM
        (COALESCE(request.received_at,request.issued_at)-request.created_at))/3600)
        FILTER (WHERE request.status IN ('ISSUED','RECEIVED')),0)::numeric,2) AS cycle_hours
    FROM logistics_warehouses warehouse
    LEFT JOIN logistics_cost_centers center_name ON center_name.id=warehouse.cost_center_id
    LEFT JOIN request_quantities request ON request.fulfillment_warehouse_id=warehouse.id
    WHERE warehouse.organization_id=$1 AND warehouse.active=TRUE
      AND ($3::text IS NULL OR center_name.name=$3)
    GROUP BY warehouse.id,warehouse.name,center_name.name ORDER BY warehouse.name`, params)).rows;

  const completedTasks = number(picking.completed_tasks);
  const handledTasks = number(picking.handled_tasks);
  const pickingAccuracy = handledTasks
    ? Math.max(0, 100 * (handledTasks - number(picking.tasks_with_exception)) / handledTasks) : 0;
  const countedLines = number(counts.counted_lines);
  const inventoryAccuracy = countedLines ? 100 * number(counts.exact_lines) / countedLines : 0;
  const normalizedSummary = {
    totalRequests: number(summary.total_requests),
    completedRequests: number(summary.completed_requests),
    timedCompletedRequests: number(summary.timed_completed_requests),
    overdueOpenRequests: number(summary.overdue_open_requests),
    inTransitRequests: number(summary.in_transit_requests),
    fillRate: number(summary.fill_rate),
    onTimeRate: number(summary.on_time_rate),
    averageCycleHours: number(summary.average_cycle_hours),
    averagePickHours: number(summary.average_pick_hours),
    pickingAccuracy: Number(pickingAccuracy.toFixed(2)),
    inventoryAccuracy: Number(inventoryAccuracy.toFixed(2)),
    completedPickTasks: completedTasks,
    handledPickTasks: handledTasks,
    countedLines
  };
  const targets = await listKpiTargets(pool, profile, organizationId);
  const breaches = evaluateKpiTargets(targets, normalizedSummary, warehouses);
  const snapshots = (await pool.query(`SELECT snapshot.snapshot_date,snapshot.period_days,
      snapshot.metrics,warehouse.name AS warehouse_name
    FROM logistics_kpi_snapshots snapshot
    LEFT JOIN logistics_warehouses warehouse ON warehouse.id=snapshot.warehouse_id
    LEFT JOIN logistics_cost_centers center_name ON center_name.id=warehouse.cost_center_id
    WHERE snapshot.organization_id=$1
      AND (($2::text IS NULL AND snapshot.warehouse_id IS NULL)
        OR ($2::text IS NOT NULL AND center_name.name=$2))
    ORDER BY snapshot.snapshot_date DESC,warehouse.name LIMIT 30`, [organizationId, center])).rows;
  return { periodDays: days, summary: normalizedSummary, warehouses, targets, breaches, snapshots };
}

export async function snapshotLogisticsKpis(pool, profile, organizationId, periodDays = 90) {
  const kpis = await listLogisticsKpis(pool, { ...profile, admin: true }, organizationId, periodDays);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const overall = (await client.query(`INSERT INTO logistics_kpi_snapshots
      (organization_id,warehouse_id,period_days,snapshot_date,metrics,created_by)
      VALUES ($1,NULL,$2,CURRENT_DATE,$3::jsonb,$4)
      ON CONFLICT (organization_id,warehouse_id,period_days,snapshot_date) DO UPDATE SET
        metrics=EXCLUDED.metrics,created_by=EXCLUDED.created_by,created_at=NOW()
      RETURNING *`, [organizationId, kpis.periodDays, json(kpis.summary), profile?.id || null])).rows[0];
    for (const warehouse of kpis.warehouses) {
      await client.query(`INSERT INTO logistics_kpi_snapshots
        (organization_id,warehouse_id,period_days,snapshot_date,metrics,created_by)
        VALUES ($1,$2,$3,CURRENT_DATE,$4::jsonb,$5)
        ON CONFLICT (organization_id,warehouse_id,period_days,snapshot_date) DO UPDATE SET
          metrics=EXCLUDED.metrics,created_by=EXCLUDED.created_by,created_at=NOW()`,
        [organizationId, warehouse.warehouse_id, kpis.periodDays, json(warehouse), profile?.id || null]);
    }
    await client.query(`UPDATE inventory_tasks SET status='Resuelta',resolved_at=NOW(),updated_at=NOW()
      WHERE task_type='KPI_DEVIATION' AND status<>'Resuelta'
        AND payload->>'organizationId'=$1`, [organizationId]);
    for (const breach of kpis.breaches || []) {
      const taskKey = createHash("sha256")
        .update(`${organizationId}|${breach.warehouseId || "organization"}|${breach.metricCode}`)
        .digest("hex").slice(0, 24);
      const taskId = `kpi-${taskKey}`;
      const comparison = breach.direction === "MINIMUM" ? "mínimo" : "máximo";
      const detail = `${breach.label}: valor ${breach.value}; objetivo ${comparison} ${breach.target}.`;
      await client.query(`INSERT INTO inventory_tasks
        (id,task_type,title,detail,priority,status,center_name,entity_type,entity_id,
         due_at,payload,updated_at)
        VALUES ($1,'KPI_DEVIATION',$2,$3,$4,'Pendiente',$5,'kpi',$6,
          NOW()+CASE WHEN $4='Crítica' THEN INTERVAL '1 day' ELSE INTERVAL '3 days' END,
          $7::jsonb,NOW())
        ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,detail=EXCLUDED.detail,
          priority=EXCLUDED.priority,status='Pendiente',center_name=EXCLUDED.center_name,
          due_at=EXCLUDED.due_at,resolved_at=NULL,payload=EXCLUDED.payload,updated_at=NOW()`,
        [taskId, `${breach.label} fuera de meta · ${breach.warehouseName}`, detail,
          breach.priority, breach.costCenter, breach.metricCode,
          json({ ...breach, organizationId, snapshotId: overall.id })]);
      const notificationId = `notification-${taskId}-${new Date().toISOString().slice(0, 10)}`;
      await client.query(`INSERT INTO inventory_notifications
        (id,center_name,notification_type,title,body,severity,entity_type,entity_id,payload)
        VALUES ($1,$2,'KPI_DEVIATION',$3,$4,$5,'kpi',$6,$7::jsonb)
        ON CONFLICT (id) DO NOTHING`,
        [notificationId, breach.costCenter, `Alerta: ${breach.label}`, detail,
          breach.priority === "Crítica" ? "critical" : "warning", breach.metricCode,
          json({ ...breach, organizationId, snapshotId: overall.id })]);
    }
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,after_data)
      VALUES ($1,'LOGISTICS_KPI_SNAPSHOT','organization',$1,$2,'SYSTEM',$3::jsonb)`,
      [organizationId, profile?.id || null, json({ snapshotId: overall.id, metrics: kpis.summary })]);
    await client.query("COMMIT");
    return { snapshot: overall, kpis };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listScheduledLogisticsJobs(pool, organizationId) {
  return (await pool.query(`SELECT id,organization_id,job_code,enabled,timezone_name,
      local_hour,period_days,next_run_at,last_started_at,last_completed_at,last_status,
      last_error,last_result,updated_at
    FROM logistics_scheduled_jobs
    WHERE organization_id=$1 ORDER BY job_code`, [organizationId])).rows;
}

export async function updateScheduledLogisticsJob(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const jobCode = text(input.jobCode || "KPI_DAILY_SNAPSHOT").toUpperCase();
  const timezoneName = text(input.timezoneName || "America/Santiago");
  const localHour = Math.trunc(number(input.localHour, 7));
  const periodDays = Math.trunc(number(input.periodDays, 90));
  if (!organizationId || jobCode !== "KPI_DAILY_SNAPSHOT") {
    throw new Error("La automatizaciÃ³n indicada no es vÃ¡lida.");
  }
  if (localHour < 0 || localHour > 23 || periodDays < 1 || periodDays > 730) {
    throw new Error("Revisa la hora y el perÃ­odo configurados.");
  }
  const timezone = await pool.query("SELECT 1 FROM pg_timezone_names WHERE name=$1 LIMIT 1",
    [timezoneName]);
  if (!timezone.rowCount) throw new Error("La zona horaria no es vÃ¡lida.");
  const result = await pool.query(`INSERT INTO logistics_scheduled_jobs
    (organization_id,job_code,enabled,timezone_name,local_hour,period_days,next_run_at,
     created_by,updated_by,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,
      CASE WHEN (((NOW() AT TIME ZONE $4)::date+make_interval(hours=>$5)) AT TIME ZONE $4)>NOW()
        THEN (((NOW() AT TIME ZONE $4)::date+make_interval(hours=>$5)) AT TIME ZONE $4)
        ELSE ((((NOW() AT TIME ZONE $4)::date+1)+make_interval(hours=>$5)) AT TIME ZONE $4)
      END,$7,$7,NOW())
    ON CONFLICT (organization_id,job_code) DO UPDATE SET
      enabled=EXCLUDED.enabled,timezone_name=EXCLUDED.timezone_name,
      local_hour=EXCLUDED.local_hour,period_days=EXCLUDED.period_days,
      next_run_at=EXCLUDED.next_run_at,updated_by=EXCLUDED.updated_by,updated_at=NOW()
    RETURNING *`, [organizationId, jobCode, input.enabled !== false, timezoneName,
      localHour, periodDays, actorProfileId]);
  await pool.query(`INSERT INTO logistics_audit_events
    (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,after_data)
    VALUES ($1,'LOGISTICS_SCHEDULE_UPDATED','scheduled_job',$2,$3,'WEB',$4::jsonb)`,
  [organizationId, result.rows[0].id, actorProfileId, json(result.rows[0])]);
  return result.rows[0];
}

export async function runDueLogisticsJobs(pool) {
  const lockClient = await pool.connect();
  let locked = false;
  try {
    locked = Boolean((await lockClient.query(
      "SELECT pg_try_advisory_lock(hashtext('icc:scheduled-logistics-jobs')) AS acquired"
    )).rows[0]?.acquired);
    if (!locked) return { skipped: true, reason: "scheduler_locked", processed: 0, results: [] };
    const jobs = (await pool.query(`SELECT * FROM logistics_scheduled_jobs
      WHERE enabled=TRUE AND next_run_at<=NOW()
      ORDER BY next_run_at,id LIMIT 25`)).rows;
    const results = [];
    for (const job of jobs) {
      await pool.query(`UPDATE logistics_scheduled_jobs SET last_status='RUNNING',
        last_started_at=NOW(),last_error=NULL,
        next_run_at=((((NOW() AT TIME ZONE timezone_name)::date+1)
          +make_interval(hours=>local_hour)) AT TIME ZONE timezone_name),
        updated_at=NOW() WHERE id=$1`, [job.id]);
      try {
        const outcome = job.job_code === "KPI_DAILY_SNAPSHOT"
          ? await snapshotLogisticsKpis(pool, { id: null, admin: true, cost_center: null },
            job.organization_id, job.period_days)
          : null;
        const summary = {
          snapshotId: outcome?.snapshot?.id || null,
          breaches: outcome?.kpis?.breaches?.length || 0,
          periodDays: job.period_days
        };
        await pool.query(`UPDATE logistics_scheduled_jobs SET last_status='SUCCESS',
          last_completed_at=NOW(),last_error=NULL,last_result=$2::jsonb,updated_at=NOW()
          WHERE id=$1`, [job.id, json(summary)]);
        results.push({ id: job.id, jobCode: job.job_code, ok: true, ...summary });
      } catch (error) {
        const message = String(error?.message || error).slice(0, 2000);
        await pool.query(`UPDATE logistics_scheduled_jobs SET last_status='FAILED',
          last_completed_at=NOW(),last_error=$2,last_result='{}'::jsonb,updated_at=NOW()
          WHERE id=$1`, [job.id, message]);
        results.push({ id: job.id, jobCode: job.job_code, ok: false, error: message });
      }
    }
    return { skipped: false, processed: jobs.length, results };
  } finally {
    if (locked) {
      await lockClient.query(
        "SELECT pg_advisory_unlock(hashtext('icc:scheduled-logistics-jobs'))"
      ).catch(() => {});
    }
    lockClient.release();
  }
}

export async function createInventoryPeriod(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const year = Math.trunc(number(input.year));
  const month = Math.trunc(number(input.month));
  if (!organizationId || year < 2020 || year > 2200 || month < 1 || month > 12) {
    throw new Error("Indica un año y mes válidos.");
  }
  const periodCode = `${year}-${String(month).padStart(2, "0")}`;
  const startsOn = `${periodCode}-01`;
  const endsOn = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const result = await pool.query(`INSERT INTO logistics_inventory_periods
    (organization_id,period_code,starts_on,ends_on,status,opened_by,notes)
    VALUES ($1,$2,$3,$4,'OPEN',$5,$6)
    ON CONFLICT (organization_id,period_code) DO UPDATE SET
      notes=CASE WHEN EXCLUDED.notes IS NULL THEN logistics_inventory_periods.notes ELSE EXCLUDED.notes END,
      updated_at=NOW()
    RETURNING *`, [organizationId, periodCode, startsOn, endsOn, actorProfileId, text(input.notes) || null]);
  return result.rows[0];
}

export async function closeInventoryPeriod(pool, periodId, input, actorProfileId = null) {
  if (!text(input.declaration)) throw new Error("Confirma la declaración de cierre.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const period = (await client.query(`SELECT * FROM logistics_inventory_periods
      WHERE id=$1 FOR UPDATE`, [periodId])).rows[0];
    if (!period) throw new Error("Período de inventario inexistente.");
    if (period.status === "CLOSED") {
      await client.query("COMMIT");
      return { period, replayed: true };
    }
    const pending = await client.query(`SELECT COUNT(*)::int AS total
      FROM logistics_inventory_adjustments
      WHERE organization_id=$1 AND status IN ('SUBMITTED','APPROVED')
        AND requested_at::date<= $2::date`, [period.organization_id, period.ends_on]);
    if (number(pending.rows[0]?.total) > 0) {
      throw new Error(`Existen ${pending.rows[0].total} ajuste(s) pendientes de resolver.`);
    }
    const openCounts = await client.query(`SELECT COUNT(*)::int AS total FROM logistics_cycle_counts
      WHERE organization_id=$1 AND status NOT IN ('POSTED','CANCELLED')
        AND created_at::date<= $2::date`, [period.organization_id, period.ends_on]);
    if (number(openCounts.rows[0]?.total) > 0) {
      throw new Error(`Existen ${openCounts.rows[0].total} conteo(s) cíclico(s) sin cerrar.`);
    }
    const values = await client.query(`SELECT item.currency,
        ROUND(COALESCE(SUM(balance.quantity * item.standard_cost),0),4) AS stock_value,
        COALESCE(SUM(balance.quantity),0)::numeric AS stock_quantity
      FROM logistics_stock_balances balance
      JOIN logistics_items item ON item.id=balance.item_id
      JOIN logistics_locations location ON location.id=balance.location_id
      WHERE balance.organization_id=$1 AND location.location_type='STORAGE'
      GROUP BY item.currency ORDER BY item.currency`, [period.organization_id]);
    const movements = await client.query(`SELECT COUNT(*)::int AS total,
        COALESCE(SUM(total_value),0)::numeric AS gross_value
      FROM logistics_stock_movements WHERE organization_id=$1 AND status='POSTED'
        AND occurred_at::date BETWEEN $2::date AND $3::date`,
    [period.organization_id, period.starts_on, period.ends_on]);
    const summary = {
      values: values.rows,
      movements: number(movements.rows[0]?.total),
      grossMovementValue: number(movements.rows[0]?.gross_value),
      closedAt: new Date().toISOString(),
      declaration: text(input.declaration)
    };
    const closed = (await client.query(`UPDATE logistics_inventory_periods
      SET status='CLOSED',closed_by=$1,closed_at=NOW(),closing_summary=$2::jsonb,
        notes=CONCAT_WS(E'\\n',notes,$3),updated_at=NOW()
      WHERE id=$4 RETURNING *`,
    [actorProfileId, json(summary), text(input.notes) || null, period.id])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,
       before_data,after_data,metadata)
      VALUES ($1,'INVENTORY_PERIOD_CLOSED','inventory_period',$2,$3,$4,'MANUAL',
        $5::jsonb,$6::jsonb,$7::jsonb)`,
    [period.organization_id, period.id, actorProfileId, `period-close:${period.id}`,
      json(period), json(closed), json(summary)]);
    await client.query("COMMIT");
    return { period: closed, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createInventoryAdjustment(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const itemId = text(input.itemId);
  const locationId = text(input.locationId);
  const assetUnitId = text(input.assetUnitId) || null;
  const lotId = text(input.lotId) || null;
  const quantityDelta = number(input.quantityDelta);
  const reasonCode = text(input.reasonCode || "OTHER").toUpperCase();
  const notes = text(input.notes);
  const allowedReasons = new Set(["COUNT_VARIANCE", "DAMAGE", "LOSS", "FOUND", "EXPIRY", "DATA_CORRECTION", "OTHER"]);
  if (!organizationId || !itemId || !locationId || quantityDelta === 0) {
    throw new Error("Completa artículo, ubicación y diferencia de cantidad.");
  }
  if (!allowedReasons.has(reasonCode)) throw new Error("Motivo de ajuste no permitido.");
  if (!notes) throw new Error("El ajuste requiere un fundamento.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const item = (await client.query(`SELECT * FROM logistics_items
      WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR SHARE`, [itemId, organizationId])).rows[0];
    if (!item) throw new Error("Artículo inexistente o inactivo.");
    if (item.tracking_type === "SERIAL" && (!assetUnitId || Math.abs(quantityDelta) !== 1)) {
      throw new Error("Un activo serializado requiere la unidad física y diferencia 1 o -1.");
    }
    if (item.tracking_type === "LOT" && !lotId) throw new Error("El artículo requiere identificar el lote.");
    const location = (await client.query(`SELECT location.*,warehouse.id AS warehouse_id
      FROM logistics_locations location
      JOIN logistics_warehouses warehouse ON warehouse.id=location.warehouse_id
      WHERE location.id=$1 AND location.organization_id=$2 AND location.active=TRUE
        AND location.location_type='STORAGE' FOR SHARE`,
    [locationId, organizationId])).rows[0];
    if (!location) throw new Error("Ubicación inexistente o inactiva.");
    const systemQuantity = await currentQuantity(client, {
      organizationId, itemId, assetUnitId, lotId, locationId
    });
    if (item.tracking_type === "SERIAL"
      && ((quantityDelta > 0 && systemQuantity >= 1) || (quantityDelta < 0 && systemQuantity < 1))) {
      throw new Error("La unidad serializada ya tiene una existencia incompatible con el ajuste.");
    }
    if (systemQuantity + quantityDelta < 0) throw new Error("El ajuste produciría stock negativo.");
    const sequence = await client.query(`SELECT COALESCE(MAX(NULLIF(
      regexp_replace(adjustment_number,'\\D','','g'),'')::bigint),0)+1 AS next
      FROM logistics_inventory_adjustments WHERE organization_id=$1`, [organizationId]);
    const adjustmentNumber = `AJU-${String(sequence.rows[0].next).padStart(7, "0")}`;
    const unitCost = number(item.standard_cost);
    const adjustment = (await client.query(`INSERT INTO logistics_inventory_adjustments
      (organization_id,adjustment_number,warehouse_id,location_id,item_id,asset_unit_id,lot_id,
       reason_code,quantity_delta,system_quantity,unit_cost,total_value_delta,currency,status,
       requested_by,notes,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'SUBMITTED',$14,$15,$16::jsonb)
      RETURNING *`,
    [organizationId, adjustmentNumber, location.warehouse_id, locationId, itemId, assetUnitId,
      lotId, reasonCode, quantityDelta, systemQuantity, unitCost,
      Number((quantityDelta * unitCost).toFixed(4)), item.currency, actorProfileId, notes,
      json({ source: text(input.source || "MANUAL"), observedQuantity: systemQuantity + quantityDelta })])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data)
      VALUES ($1,'INVENTORY_ADJUSTMENT_REQUESTED','inventory_adjustment',$2,$3,$4,'MANUAL',$5::jsonb)`,
    [organizationId, adjustment.id, actorProfileId, adjustmentNumber, json(adjustment)]);
    await client.query("COMMIT");
    return adjustment;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateInventoryAdjustment(pool, adjustmentId, action, input, actorProfileId = null) {
  const normalizedAction = text(action).toUpperCase();
  if (!["APPROVE", "REJECT", "POST", "CANCEL"].includes(normalizedAction)) {
    throw new Error("Acción de ajuste no permitida.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query(`SELECT * FROM logistics_inventory_adjustments
      WHERE id=$1 FOR UPDATE`, [adjustmentId])).rows[0];
    if (!current) throw new Error("Solicitud de ajuste inexistente.");
    const auditState = async (eventType, updated) => client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,
       before_data,after_data,metadata)
      VALUES ($1,$2,'inventory_adjustment',$3,$4,$5,'MANUAL',$6::jsonb,$7::jsonb,$8::jsonb)`,
    [current.organization_id, eventType, current.id, actorProfileId,
      `adjustment:${current.id}:${eventType}`, json(current), json(updated),
      json({ notes: text(input.notes) })]);
    if (normalizedAction === "APPROVE") {
      if (current.status !== "SUBMITTED") throw new Error("El ajuste no está pendiente de aprobación.");
      if (current.requested_by === actorProfileId) {
        throw new Error("Quien solicita un ajuste no puede aprobarlo.");
      }
      const updated = (await client.query(`UPDATE logistics_inventory_adjustments
        SET status='APPROVED',approved_by=$1,approved_at=NOW(),approval_notes=$2,updated_at=NOW()
        WHERE id=$3 RETURNING *`, [actorProfileId, text(input.notes) || null, current.id])).rows[0];
      await auditState("INVENTORY_ADJUSTMENT_APPROVED", updated);
      await client.query("COMMIT");
      return { adjustment: updated };
    }
    if (normalizedAction === "REJECT") {
      if (!["SUBMITTED", "APPROVED"].includes(current.status)) throw new Error("El ajuste ya no puede rechazarse.");
      if (!text(input.notes)) throw new Error("Indica el motivo del rechazo.");
      const updated = (await client.query(`UPDATE logistics_inventory_adjustments
        SET status='REJECTED',approved_by=$1,approved_at=NOW(),approval_notes=$2,updated_at=NOW()
        WHERE id=$3 RETURNING *`, [actorProfileId, text(input.notes), current.id])).rows[0];
      await auditState("INVENTORY_ADJUSTMENT_REJECTED", updated);
      await client.query("COMMIT");
      return { adjustment: updated };
    }
    if (normalizedAction === "CANCEL") {
      if (current.status !== "SUBMITTED" || current.requested_by !== actorProfileId) {
        throw new Error("Sólo quien solicitó puede cancelar un ajuste pendiente.");
      }
      const updated = (await client.query(`UPDATE logistics_inventory_adjustments
        SET status='CANCELLED',updated_at=NOW() WHERE id=$1 RETURNING *`, [current.id])).rows[0];
      await auditState("INVENTORY_ADJUSTMENT_CANCELLED", updated);
      await client.query("COMMIT");
      return { adjustment: updated };
    }
    if (current.status === "POSTED") {
      await client.query("COMMIT");
      return { adjustment: current, replayed: true };
    }
    if (current.status !== "APPROVED") throw new Error("El ajuste debe estar aprobado antes de contabilizarse.");
    if (current.requested_by === actorProfileId) {
      throw new Error("Quien solicitó el ajuste no puede contabilizarlo.");
    }
    const latestQuantity = await currentQuantity(client, {
      organizationId: current.organization_id, itemId: current.item_id,
      assetUnitId: current.asset_unit_id, lotId: current.lot_id, locationId: current.location_id
    });
    if (latestQuantity + number(current.quantity_delta) < 0) {
      throw new Error("El saldo cambió y el ajuste produciría stock negativo.");
    }
    const positive = number(current.quantity_delta) > 0;
    const posted = await postMovementWithClient(client, {
      organizationId: current.organization_id, itemId: current.item_id,
      assetUnitId: current.asset_unit_id, lotId: current.lot_id,
      quantity: Math.abs(number(current.quantity_delta)),
      fromLocationId: positive ? null : current.location_id,
      toLocationId: positive ? current.location_id : null,
      movementType: "ADJUSTMENT", referenceType: "inventory_adjustment", referenceId: current.id,
      idempotencyKey: `inventory-adjustment:${current.id}`, source: "MANUAL",
      notes: `${current.adjustment_number} · ${current.reason_code} · ${current.notes}`,
      unitCost: current.unit_cost, currency: current.currency
    }, actorProfileId);
    const updated = (await client.query(`UPDATE logistics_inventory_adjustments
      SET status='POSTED',posted_by=$1,posted_at=NOW(),movement_id=$2,updated_at=NOW()
      WHERE id=$3 RETURNING *`, [actorProfileId, posted.movement.id, current.id])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,
       before_data,after_data,metadata)
      VALUES ($1,'INVENTORY_ADJUSTMENT_POSTED','inventory_adjustment',$2,$3,$4,'MANUAL',
        $5::jsonb,$6::jsonb,$7::jsonb)`,
    [current.organization_id, current.id, actorProfileId, `adjustment-post:${current.id}`,
      json(current), json(updated), json({ movementId: posted.movement.id })]);
    await client.query("COMMIT");
    return { adjustment: updated, movement: posted.movement, replayed: posted.replayed };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
      const supplierReturn = normalizedAction === "REJECT"
        ? (await client.query("SELECT * FROM logistics_supplier_returns WHERE receipt_id=$1", [receipt.id])).rows[0] || null
        : null;
      await client.query("COMMIT");
      return { receipt, supplierReturn, replayed: true };
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
    let supplierReturn = null;
    if (normalizedAction === "REJECT") {
      const reasonCode = text(input.reasonCode).toUpperCase();
      const allowedReasons = ["QUALITY", "DAMAGED", "WRONG_ITEM", "WRONG_QUANTITY", "EXPIRED", "DOCUMENT", "OTHER"];
      if (!allowedReasons.includes(reasonCode)) throw new Error("Selecciona un motivo válido para la devolución.");
      if (text(input.notes).length < 10) throw new Error("Describe la no conformidad con al menos 10 caracteres.");
      const sequence = await client.query(`SELECT COALESCE(MAX(NULLIF(
        regexp_replace(return_number,'\\D','','g'),'')::bigint),0)+1 AS next
        FROM logistics_supplier_returns WHERE organization_id=$1`, [receipt.organization_id]);
      const returnNumber = `DEV-${String(sequence.rows[0].next).padStart(7, "0")}`;
      supplierReturn = (await client.query(`INSERT INTO logistics_supplier_returns
        (organization_id,return_number,receipt_id,supplier_id,warehouse_id,status,reason_code,
         document_number,carrier,tracking_number,notes,created_by,currency,metadata)
        VALUES ($1,$2,$3,$4,$5,'SHIPPED',$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
        RETURNING *`, [receipt.organization_id, returnNumber, receipt.id, receipt.supplier_id,
        receipt.warehouse_id, reasonCode, text(input.returnDocumentNumber) || null,
        text(input.carrier) || null, text(input.trackingNumber) || null, text(input.notes),
        actorProfileId, text(input.currency || lines[0]?.currency || "CLP").toUpperCase(),
        json({ inboundReceiptNumber: receipt.receipt_number })])).rows[0];
    }
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
      if (supplierReturn) {
        await client.query(`INSERT INTO logistics_supplier_return_lines
          (supplier_return_id,receipt_line_id,item_id,asset_unit_id,lot_id,quantity,
           return_movement_id,unit_cost,currency,notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (supplier_return_id,receipt_line_id) DO NOTHING`,
        [supplierReturn.id, line.id, line.item_id, line.asset_unit_id, line.lot_id, line.quantity,
          posted.movement.id, number(line.unit_cost), text(line.currency || supplierReturn.currency),
          text(input.notes) || null]);
        if (line.purchase_order_line_id) {
          await client.query(`UPDATE logistics_purchase_order_lines SET
            quantity_received=GREATEST(0,quantity_received-$1),updated_at=NOW() WHERE id=$2`,
          [line.quantity, line.purchase_order_line_id]);
        }
      }
    }
    if (supplierReturn && receipt.purchase_order_id) {
      const orderProgress = await client.query(`SELECT
          COUNT(*) FILTER (WHERE quantity_received>0)::int AS received_lines,
          COUNT(*) FILTER (WHERE quantity_received<quantity_ordered)::int AS pending_lines
        FROM logistics_purchase_order_lines WHERE purchase_order_id=$1`, [receipt.purchase_order_id]);
      const progress = orderProgress.rows[0];
      const orderStatus = progress.pending_lines === 0 ? "RECEIVED"
        : progress.received_lines > 0 ? "PARTIALLY_RECEIVED" : "SENT";
      await client.query("UPDATE logistics_purchase_orders SET status=$1,updated_at=NOW() WHERE id=$2",
        [orderStatus, receipt.purchase_order_id]);
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
    return { receipt: updated, lines, supplierReturn, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSupplierReturn(pool, returnId, action, input, actorProfileId = null) {
  const normalizedAction = text(action).toUpperCase();
  const transitions = {
    CONFIRM_DELIVERY: { from: ["SHIPPED"], to: "CREDIT_PENDING" },
    REGISTER_CREDIT: { from: ["DELIVERED", "CREDIT_PENDING"], to: "CREDITED" },
    CLOSE: { from: ["CREDITED"], to: "CLOSED" }
  };
  const transition = transitions[normalizedAction];
  if (!transition) throw new Error("Acción de devolución no permitida.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query("SELECT * FROM logistics_supplier_returns WHERE id=$1 FOR UPDATE",
      [returnId])).rows[0];
    if (!current) throw new Error("Devolución no encontrada.");
    if (current.status === transition.to) {
      await client.query("COMMIT");
      return { supplierReturn: current, replayed: true };
    }
    if (!transition.from.includes(current.status)) throw new Error("La devolución no está en la etapa requerida.");
    if (normalizedAction === "REGISTER_CREDIT") {
      if (!text(input.creditNoteNumber)) throw new Error("Ingresa el número de la nota de crédito.");
      if (number(input.creditAmount, -1) < 0) throw new Error("El monto de la nota de crédito no es válido.");
    }
    const updated = (await client.query(`UPDATE logistics_supplier_returns SET status=$1,
        delivered_by=CASE WHEN $2='CONFIRM_DELIVERY' THEN $3 ELSE delivered_by END,
        delivered_at=CASE WHEN $2='CONFIRM_DELIVERY' THEN NOW() ELSE delivered_at END,
        credited_by=CASE WHEN $2='REGISTER_CREDIT' THEN $3 ELSE credited_by END,
        credited_at=CASE WHEN $2='REGISTER_CREDIT' THEN NOW() ELSE credited_at END,
        credit_note_number=CASE WHEN $2='REGISTER_CREDIT' THEN $4 ELSE credit_note_number END,
        credit_amount=CASE WHEN $2='REGISTER_CREDIT' THEN $5 ELSE credit_amount END,
        closed_by=CASE WHEN $2='CLOSE' THEN $3 ELSE closed_by END,
        closed_at=CASE WHEN $2='CLOSE' THEN NOW() ELSE closed_at END,
        notes=CASE WHEN $6='' THEN notes ELSE CONCAT_WS(E'\n',notes,$6) END,updated_at=NOW()
      WHERE id=$7 RETURNING *`, [transition.to, normalizedAction, actorProfileId,
      text(input.creditNoteNumber) || null, normalizedAction === "REGISTER_CREDIT" ? number(input.creditAmount) : null,
      text(input.notes), current.id])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,
       before_data,after_data,metadata)
      VALUES ($1,$2,'supplier_return',$3,$4,$5,'MANUAL',$6::jsonb,$7::jsonb,$8::jsonb)`,
    [current.organization_id, `SUPPLIER_RETURN_${normalizedAction}`, current.id, actorProfileId,
      `${current.return_number}:${normalizedAction}`, json(current), json(updated),
      json({ notes: text(input.notes), creditNoteNumber: text(input.creditNoteNumber) })]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,$2,'supplier_return',$3,$4::jsonb)`,
    [current.organization_id, `supplier_return.${normalizedAction.toLowerCase()}`, current.id,
      json({ supplierReturn: updated })]);
    await client.query("COMMIT");
    return { supplierReturn: updated, replayed: false };
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

export async function createPurchaseOrder(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const requisitionId = text(input.requisitionId) || null;
  const supplierId = text(input.supplierId);
  const warehouseId = text(input.warehouseId);
  const currency = text(input.currency || "CLP").toUpperCase();
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!organizationId || !supplierId || !warehouseId || !lines.length) {
    throw new Error("Completa proveedor, bodega y productos de la orden.");
  }
  if (!["CLP", "USD", "EUR", "UF"].includes(currency)) throw new Error("Moneda no permitida.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const supplier = (await client.query(`SELECT * FROM logistics_suppliers
      WHERE id=$1 AND organization_id=$2 AND status='ACTIVE' FOR SHARE`,
    [supplierId, organizationId])).rows[0];
    if (!supplier) throw new Error("Proveedor inexistente o inactivo.");
    const warehouse = (await client.query(`SELECT * FROM logistics_warehouses
      WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR SHARE`,
    [warehouseId, organizationId])).rows[0];
    if (!warehouse) throw new Error("Bodega inexistente o inactiva.");
    let requisition = null;
    if (requisitionId) {
      requisition = (await client.query(`SELECT * FROM logistics_purchase_requisitions
        WHERE id=$1 AND organization_id=$2 AND warehouse_id=$3 AND status='APPROVED' FOR UPDATE`,
      [requisitionId, organizationId, warehouseId])).rows[0];
      if (!requisition) throw new Error("La solicitud debe estar aprobada y corresponder a la bodega.");
    }
    const sequence = await client.query(`SELECT COALESCE(MAX(NULLIF(
      regexp_replace(purchase_order_number,'\\D','','g'),'')::bigint),0)+1 AS next
      FROM logistics_purchase_orders WHERE organization_id=$1`, [organizationId]);
    const orderNumber = text(input.purchaseOrderNumber)
      || `OC-${String(sequence.rows[0].next).padStart(7, "0")}`;
    const order = (await client.query(`INSERT INTO logistics_purchase_orders
      (organization_id,purchase_order_number,requisition_id,supplier_id,warehouse_id,status,
       currency,order_date,expected_date,payment_terms,requested_by,notes)
      VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,COALESCE($7::date,CURRENT_DATE),$8,$9,$10,$11)
      RETURNING *`, [organizationId, orderNumber, requisitionId, supplierId, warehouseId, currency,
      text(input.orderDate) || null, text(input.expectedDate) || null, text(input.paymentTerms) || null,
      actorProfileId, text(input.notes) || null])).rows[0];
    const savedLines = [];
    let subtotal = 0;
    let taxAmount = 0;
    for (const lineInput of lines) {
      const quantity = assertPositiveQuantity(lineInput.quantity);
      const unitCost = Math.max(0, number(lineInput.unitCost));
      const taxRate = Math.max(0, number(lineInput.taxRate, 19));
      const item = (await client.query(`SELECT * FROM logistics_items
        WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR SHARE`,
      [lineInput.itemId, organizationId])).rows[0];
      if (!item) throw new Error("Uno de los productos de la orden no existe.");
      let requisitionLineId = text(lineInput.requisitionLineId) || null;
      if (requisition) {
        const reqLine = (await client.query(`SELECT * FROM logistics_purchase_requisition_lines
          WHERE requisition_id=$1 AND item_id=$2 FOR SHARE`, [requisition.id, item.id])).rows[0];
        if (!reqLine) throw new Error(`${item.sku} no pertenece a la solicitud aprobada.`);
        if (quantity > number(reqLine.quantity_requested)) {
          throw new Error(`${item.sku} supera la cantidad solicitada.`);
        }
        requisitionLineId = reqLine.id;
      }
      const lineSubtotal = Number((quantity * unitCost).toFixed(4));
      const lineTax = Number((lineSubtotal * taxRate / 100).toFixed(4));
      const lineTotal = Number((lineSubtotal + lineTax).toFixed(4));
      const line = (await client.query(`INSERT INTO logistics_purchase_order_lines
        (purchase_order_id,requisition_line_id,item_id,quantity_ordered,unit_cost,tax_rate,
         line_subtotal,line_total,notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [order.id, requisitionLineId, item.id, quantity, unitCost, taxRate, lineSubtotal, lineTotal,
        text(lineInput.notes) || null])).rows[0];
      savedLines.push(line);
      subtotal += lineSubtotal;
      taxAmount += lineTax;
    }
    const totalAmount = Number((subtotal + taxAmount).toFixed(4));
    const updatedOrder = (await client.query(`UPDATE logistics_purchase_orders
      SET subtotal=$1,tax_amount=$2,total_amount=$3,updated_at=NOW() WHERE id=$4 RETURNING *`,
    [subtotal, taxAmount, totalAmount, order.id])).rows[0];
    if (requisition) {
      await client.query(`UPDATE logistics_purchase_requisitions
        SET status='ORDERED',ordered_at=NOW(),updated_at=NOW() WHERE id=$1`, [requisition.id]);
    }
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data,metadata)
      VALUES ($1,'PURCHASE_ORDER_CREATED','purchase_order',$2,$3,$4,'MANUAL',$5::jsonb,$6::jsonb)`,
    [organizationId, order.id, actorProfileId, orderNumber, json(updatedOrder),
      json({ supplier: supplier.name, lineCount: savedLines.length })]);
    await client.query("COMMIT");
    return { purchaseOrder: updatedOrder, lines: savedLines };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listProcurement(pool, profile, organizationId) {
  await pool.query(`INSERT INTO logistics_procurement_settings (organization_id)
    VALUES ($1) ON CONFLICT (organization_id) DO NOTHING`, [organizationId]);
  const params = [organizationId];
  const scope = profile?.admin ? "" : `AND center.name=$${params.push(profile?.cost_center || "")}`;
  const performanceParams = [organizationId];
  const performanceScope = profile?.admin ? "" : `AND performance_center.name=$${performanceParams.push(profile?.cost_center || "")}`;
  const [settings, orders, invoices, supplierPerformance] = await Promise.all([
    pool.query(`SELECT * FROM logistics_procurement_settings WHERE organization_id=$1`, [organizationId]),
    pool.query(`SELECT purchase_order.*,supplier.name AS supplier_name,supplier.tax_id AS supplier_tax_id,
        warehouse.name AS warehouse_name,center.name AS cost_center,requisition.requisition_number,
        requester.name AS requested_by_name,approver.name AS approved_by_name,
        COALESCE(jsonb_agg(jsonb_build_object(
          'id',line.id,'itemId',line.item_id,'sku',item.sku,'itemName',item.name,
          'quantityOrdered',line.quantity_ordered,'quantityReceived',line.quantity_received,
          'unitCost',line.unit_cost,'taxRate',line.tax_rate,'lineSubtotal',line.line_subtotal,
          'lineTotal',line.line_total,'requisitionLineId',line.requisition_line_id
        ) ORDER BY line.created_at) FILTER (WHERE line.id IS NOT NULL),'[]'::jsonb) AS lines
      FROM logistics_purchase_orders purchase_order
      JOIN logistics_suppliers supplier ON supplier.id=purchase_order.supplier_id
      JOIN logistics_warehouses warehouse ON warehouse.id=purchase_order.warehouse_id
      LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
      LEFT JOIN logistics_purchase_requisitions requisition ON requisition.id=purchase_order.requisition_id
      LEFT JOIN inventory_user_profiles requester ON requester.id=purchase_order.requested_by
      LEFT JOIN inventory_user_profiles approver ON approver.id=purchase_order.approved_by
      LEFT JOIN logistics_purchase_order_lines line ON line.purchase_order_id=purchase_order.id
      LEFT JOIN logistics_items item ON item.id=line.item_id
      WHERE purchase_order.organization_id=$1 ${scope}
      GROUP BY purchase_order.id,supplier.name,supplier.tax_id,warehouse.name,center.name,
        requisition.requisition_number,requester.name,approver.name
      ORDER BY purchase_order.created_at DESC LIMIT 250`, params),
    pool.query(`SELECT invoice.*,supplier.name AS supplier_name,purchase_order.purchase_order_number,
        warehouse.name AS warehouse_name,center.name AS cost_center,
        registrar.name AS registered_by_name,approver.name AS approved_by_name,
        COALESCE(jsonb_agg(jsonb_build_object(
          'id',line.id,'purchaseOrderLineId',line.purchase_order_line_id,'itemId',line.item_id,
          'sku',item.sku,'itemName',item.name,'quantityInvoiced',line.quantity_invoiced,
          'unitCost',line.unit_cost,'taxRate',line.tax_rate,'lineTotal',line.line_total,
          'matchStatus',line.match_status,'exceptions',line.exception_details
        ) ORDER BY line.created_at) FILTER (WHERE line.id IS NOT NULL),'[]'::jsonb) AS lines
      FROM logistics_supplier_invoices invoice
      JOIN logistics_suppliers supplier ON supplier.id=invoice.supplier_id
      JOIN logistics_purchase_orders purchase_order ON purchase_order.id=invoice.purchase_order_id
      JOIN logistics_warehouses warehouse ON warehouse.id=purchase_order.warehouse_id
      LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
      LEFT JOIN inventory_user_profiles registrar ON registrar.id=invoice.registered_by
      LEFT JOIN inventory_user_profiles approver ON approver.id=invoice.approved_by
      LEFT JOIN logistics_supplier_invoice_lines line ON line.invoice_id=invoice.id
      LEFT JOIN logistics_items item ON item.id=line.item_id
      WHERE invoice.organization_id=$1 ${scope}
      GROUP BY invoice.id,supplier.name,purchase_order.purchase_order_number,warehouse.name,
        center.name,registrar.name,approver.name
      ORDER BY invoice.invoice_date DESC,invoice.created_at DESC LIMIT 250`, params),
    pool.query(`SELECT supplier.id,supplier.code,supplier.name,
        COUNT(DISTINCT purchase_order.id)::int AS purchase_orders,
        COUNT(DISTINCT receipt.id)::int AS receipts,
        COUNT(DISTINCT invoice.id) FILTER (WHERE invoice.status='EXCEPTION')::int AS invoice_exceptions,
        ROUND(100.0 * COUNT(DISTINCT receipt.id) FILTER (
          WHERE purchase_order.expected_date IS NULL OR receipt.received_at::date<=purchase_order.expected_date)
          / NULLIF(COUNT(DISTINCT receipt.id),0),1) AS on_time_percent
      FROM logistics_suppliers supplier
      LEFT JOIN logistics_purchase_orders purchase_order ON purchase_order.supplier_id=supplier.id
      LEFT JOIN logistics_warehouses performance_warehouse ON performance_warehouse.id=purchase_order.warehouse_id
      LEFT JOIN logistics_cost_centers performance_center ON performance_center.id=performance_warehouse.cost_center_id
      LEFT JOIN logistics_inbound_receipts receipt ON receipt.purchase_order_id=purchase_order.id
      LEFT JOIN logistics_supplier_invoices invoice ON invoice.purchase_order_id=purchase_order.id
      WHERE supplier.organization_id=$1 ${performanceScope}
      GROUP BY supplier.id,supplier.code,supplier.name ORDER BY supplier.name`, performanceParams)
  ]);
  return {
    settings: settings.rows[0],
    purchaseOrders: orders.rows,
    supplierInvoices: invoices.rows,
    supplierPerformance: supplierPerformance.rows
  };
}

export async function updateProcurementSettings(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const result = await pool.query(`INSERT INTO logistics_procurement_settings
    (organization_id,price_tolerance_percent,quantity_tolerance_percent,amount_tolerance,
     require_purchase_order,require_receipt,updated_by,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
    ON CONFLICT (organization_id) DO UPDATE SET
      price_tolerance_percent=EXCLUDED.price_tolerance_percent,
      quantity_tolerance_percent=EXCLUDED.quantity_tolerance_percent,
      amount_tolerance=EXCLUDED.amount_tolerance,require_purchase_order=EXCLUDED.require_purchase_order,
      require_receipt=EXCLUDED.require_receipt,updated_by=EXCLUDED.updated_by,updated_at=NOW()
    RETURNING *`, [organizationId, Math.max(0, number(input.priceTolerancePercent, 2)),
    Math.max(0, number(input.quantityTolerancePercent, 0)), Math.max(0, number(input.amountTolerance, 1)),
    input.requirePurchaseOrder !== false, input.requireReceipt !== false, actorProfileId]);
  return result.rows[0];
}

export async function updatePurchaseOrder(pool, orderId, action, input, actorProfileId = null) {
  const normalizedAction = text(action).toUpperCase();
  const transitions = {
    APPROVE: { from: ["DRAFT"], to: "APPROVED" },
    SEND: { from: ["APPROVED"], to: "SENT" },
    CLOSE: { from: ["RECEIVED"], to: "CLOSED" },
    CANCEL: { from: ["DRAFT", "APPROVED"], to: "CANCELLED" }
  };
  const transition = transitions[normalizedAction];
  if (!transition) throw new Error("Acción de orden de compra no permitida.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query(`SELECT * FROM logistics_purchase_orders
      WHERE id=$1 FOR UPDATE`, [orderId])).rows[0];
    if (!current) throw new Error("Orden de compra inexistente.");
    if (current.status === transition.to) {
      await client.query("COMMIT");
      return { purchaseOrder: current, replayed: true };
    }
    if (!transition.from.includes(current.status)) throw new Error(`La orden está en estado ${current.status}.`);
    if (normalizedAction === "APPROVE" && current.requested_by === actorProfileId) {
      throw new Error("Quien crea la orden no puede aprobarla.");
    }
    const updated = (await client.query(`UPDATE logistics_purchase_orders SET status=$1,
      approved_by=CASE WHEN $1='APPROVED' THEN $2 ELSE approved_by END,
      approved_at=CASE WHEN $1='APPROVED' THEN NOW() ELSE approved_at END,
      sent_by=CASE WHEN $1='SENT' THEN $2 ELSE sent_by END,
      sent_at=CASE WHEN $1='SENT' THEN NOW() ELSE sent_at END,
      closed_at=CASE WHEN $1='CLOSED' THEN NOW() ELSE closed_at END,
      notes=CASE WHEN $3='' THEN notes ELSE CONCAT_WS(E'\\n',notes,$3) END,updated_at=NOW()
      WHERE id=$4 RETURNING *`,
    [transition.to, actorProfileId, text(input.notes), current.id])).rows[0];
    if (current.requisition_id && normalizedAction === "CANCEL") {
      await client.query(`UPDATE logistics_purchase_requisitions
        SET status='APPROVED',ordered_at=NULL,updated_at=NOW() WHERE id=$1`, [current.requisition_id]);
    }
    if (current.requisition_id && normalizedAction === "SEND") {
      await client.query(`UPDATE logistics_purchase_requisitions
        SET status='ORDERED',ordered_at=NOW(),updated_at=NOW() WHERE id=$1`, [current.requisition_id]);
    }
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,
       before_data,after_data)
      VALUES ($1,$2,'purchase_order',$3,$4,$5,'MANUAL',$6::jsonb,$7::jsonb)`,
    [current.organization_id, `PURCHASE_ORDER_${transition.to}`, current.id, actorProfileId,
      `${current.purchase_order_number}:${transition.to}`, json(current), json(updated)]);
    await client.query("COMMIT");
    return { purchaseOrder: updated, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createSupplierInvoice(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const purchaseOrderId = text(input.purchaseOrderId);
  const invoiceNumber = text(input.invoiceNumber);
  const invoiceDate = text(input.invoiceDate);
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!organizationId || !purchaseOrderId || !invoiceNumber || !invoiceDate || !lines.length) {
    throw new Error("Completa orden, número, fecha y líneas de la factura.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const order = (await client.query(`SELECT * FROM logistics_purchase_orders
      WHERE id=$1 AND organization_id=$2 AND status IN ('SENT','PARTIALLY_RECEIVED','RECEIVED','CLOSED')
      FOR SHARE`, [purchaseOrderId, organizationId])).rows[0];
    if (!order) throw new Error("La orden no está emitida o no existe.");
    const settings = (await client.query(`SELECT * FROM logistics_procurement_settings
      WHERE organization_id=$1`, [organizationId])).rows[0]
      || { price_tolerance_percent: 2, quantity_tolerance_percent: 0, amount_tolerance: 1, require_receipt: true };
    let subtotal = 0;
    let taxAmount = 0;
    const prepared = [];
    const allExceptions = [];
    for (const [index, lineInput] of lines.entries()) {
      const orderLine = (await client.query(`SELECT line.*,item.sku,item.name FROM logistics_purchase_order_lines line
        JOIN logistics_items item ON item.id=line.item_id
        WHERE line.id=$1 AND line.purchase_order_id=$2 FOR SHARE`,
      [lineInput.purchaseOrderLineId, order.id])).rows[0];
      if (!orderLine) throw new Error(`Línea ${index + 1}: no pertenece a la orden.`);
      const quantity = assertPositiveQuantity(lineInput.quantity);
      const unitCost = Math.max(0, number(lineInput.unitCost));
      const taxRate = Math.max(0, number(lineInput.taxRate, orderLine.tax_rate));
      const previous = await client.query(`SELECT COALESCE(SUM(invoice_line.quantity_invoiced),0)::numeric AS quantity
        FROM logistics_supplier_invoice_lines invoice_line
        JOIN logistics_supplier_invoices invoice ON invoice.id=invoice_line.invoice_id
        WHERE invoice_line.purchase_order_line_id=$1 AND invoice.status<>'REJECTED'`,
      [orderLine.id]);
      const exceptions = [];
      const priceVariancePercent = number(orderLine.unit_cost) > 0
        ? Math.abs(unitCost - number(orderLine.unit_cost)) / number(orderLine.unit_cost) * 100
        : unitCost === 0 ? 0 : 100;
      if (priceVariancePercent > number(settings.price_tolerance_percent)) {
        exceptions.push({ type: "PRICE", expected: number(orderLine.unit_cost), actual: unitCost,
          variancePercent: Number(priceVariancePercent.toFixed(4)) });
      }
      const allowedQuantity = number(orderLine.quantity_received)
        * (1 + number(settings.quantity_tolerance_percent) / 100);
      const cumulative = number(previous.rows[0]?.quantity) + quantity;
      if (settings.require_receipt && cumulative > allowedQuantity) {
        exceptions.push({ type: "QUANTITY", received: number(orderLine.quantity_received),
          previouslyInvoiced: number(previous.rows[0]?.quantity), actual: quantity });
      }
      const lineSubtotal = Number((quantity * unitCost).toFixed(4));
      const lineTax = Number((lineSubtotal * taxRate / 100).toFixed(4));
      const lineTotal = Number((lineSubtotal + lineTax).toFixed(4));
      subtotal += lineSubtotal;
      taxAmount += lineTax;
      prepared.push({ orderLine, quantity, unitCost, taxRate, lineSubtotal, lineTotal, exceptions });
      allExceptions.push(...exceptions.map(exception => ({ line: orderLine.sku, ...exception })));
    }
    const totalAmount = Number((subtotal + taxAmount).toFixed(4));
    const expectedTotal = prepared.reduce((sum, line) =>
      sum + line.quantity * number(line.orderLine.unit_cost) * (1 + line.taxRate / 100), 0);
    const varianceAmount = Number((totalAmount - expectedTotal).toFixed(4));
    if (Math.abs(varianceAmount) > number(settings.amount_tolerance, 1)) {
      allExceptions.push({ type: "AMOUNT", expected: Number(expectedTotal.toFixed(4)),
        actual: totalAmount, variance: varianceAmount });
    }
    const status = allExceptions.length ? "EXCEPTION" : "MATCHED";
    const invoice = (await client.query(`INSERT INTO logistics_supplier_invoices
      (organization_id,supplier_id,purchase_order_id,invoice_number,invoice_date,currency,
       subtotal,tax_amount,total_amount,status,variance_amount,exception_details,registered_by,
       matched_at,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,NOW(),$14) RETURNING *`,
    [organizationId, order.supplier_id, order.id, invoiceNumber, invoiceDate, order.currency,
      subtotal, taxAmount, totalAmount, status, varianceAmount, json(allExceptions), actorProfileId,
      text(input.notes) || null])).rows[0];
    const savedLines = [];
    for (const line of prepared) {
      savedLines.push((await client.query(`INSERT INTO logistics_supplier_invoice_lines
        (invoice_id,purchase_order_line_id,item_id,quantity_invoiced,unit_cost,tax_rate,
         line_subtotal,line_total,match_status,exception_details)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
      [invoice.id, line.orderLine.id, line.orderLine.item_id, line.quantity, line.unitCost,
        line.taxRate, line.lineSubtotal, line.lineTotal, line.exceptions.length ? "EXCEPTION" : "MATCHED",
        json(line.exceptions)])).rows[0]);
    }
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,
       after_data,metadata)
      VALUES ($1,'SUPPLIER_INVOICE_MATCHED','supplier_invoice',$2,$3,$4,'MANUAL',$5::jsonb,$6::jsonb)`,
    [organizationId, invoice.id, actorProfileId, invoiceNumber, json(invoice),
      json({ status, exceptions: allExceptions })]);
    await client.query("COMMIT");
    return { invoice, lines: savedLines, matched: status === "MATCHED" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSupplierInvoice(pool, invoiceId, action, input, actorProfileId = null) {
  const normalizedAction = text(action).toUpperCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query(`SELECT * FROM logistics_supplier_invoices
      WHERE id=$1 FOR UPDATE`, [invoiceId])).rows[0];
    if (!current) throw new Error("Factura de proveedor inexistente.");
    let target;
    if (normalizedAction === "APPROVE") {
      if (!["MATCHED", "EXCEPTION"].includes(current.status)) throw new Error("La factura no puede aprobarse.");
      if (current.registered_by === actorProfileId) throw new Error("Quien registra la factura no puede aprobarla.");
      if (current.status === "EXCEPTION" && (!input.allowException || !text(input.notes))) {
        throw new Error("La excepción requiere autorización administrativa y fundamento.");
      }
      target = "APPROVED";
    } else if (normalizedAction === "REJECT") {
      if (!["MATCHED", "EXCEPTION"].includes(current.status)) throw new Error("La factura no puede rechazarse.");
      if (!text(input.notes)) throw new Error("Indica el motivo del rechazo.");
      target = "REJECTED";
    } else if (normalizedAction === "PAY") {
      if (current.status !== "APPROVED") throw new Error("La factura debe estar aprobada antes de pagar.");
      target = "PAID";
    } else {
      throw new Error("Acción de factura no permitida.");
    }
    const updated = (await client.query(`UPDATE logistics_supplier_invoices SET status=$1,
      approved_by=CASE WHEN $1 IN ('APPROVED','REJECTED') THEN $2 ELSE approved_by END,
      approved_at=CASE WHEN $1 IN ('APPROVED','REJECTED') THEN NOW() ELSE approved_at END,
      notes=CASE WHEN $3='' THEN notes ELSE CONCAT_WS(E'\\n',notes,$3) END,updated_at=NOW()
      WHERE id=$4 RETURNING *`, [target, actorProfileId, text(input.notes), current.id])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,
       before_data,after_data,metadata)
      VALUES ($1,$2,'supplier_invoice',$3,$4,$5,'MANUAL',$6::jsonb,$7::jsonb,$8::jsonb)`,
    [current.organization_id, `SUPPLIER_INVOICE_${target}`, current.id, actorProfileId,
      `${current.invoice_number}:${target}`, json(current), json(updated),
      json({ exceptionOverride: Boolean(input.allowException), notes: text(input.notes) })]);
    await client.query("COMMIT");
    return { invoice: updated };
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
      transfer.transfer_number,transfer.status AS transfer_status,
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
      WHERE reservation.request_id=request.id),'[]'::jsonb) AS reservations,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',task.id,'reservationId',task.reservation_id,'itemId',task.item_id,
        'sku',item.sku,'itemName',item.name,'unitCode',asset_unit.unit_code,
        'lotNumber',lot.lot_number,'locationId',task.location_id,
        'locationCode',location.code,'locationName',location.name,
        'quantityRequired',task.quantity_required,'quantityPicked',task.quantity_picked,
        'status',task.status,'pickingSequence',task.picking_sequence,
        'assignedTo',task.assigned_to,'scannedLocation',task.scanned_location,
        'scannedItem',task.scanned_item,'discrepancyReason',task.discrepancy_reason
      ) ORDER BY task.picking_sequence,task.created_at)
      FROM logistics_pick_tasks task
      JOIN logistics_items item ON item.id=task.item_id
      JOIN logistics_locations location ON location.id=task.location_id
      LEFT JOIN logistics_asset_units asset_unit ON asset_unit.id=task.asset_unit_id
      LEFT JOIN logistics_lots lot ON lot.id=task.lot_id
      WHERE task.request_id=request.id),'[]'::jsonb) AS "pickTasks"
    FROM logistics_material_requests request
    JOIN logistics_warehouses requesting ON requesting.id=request.requesting_warehouse_id
    JOIN logistics_warehouses fulfillment ON fulfillment.id=request.fulfillment_warehouse_id
    LEFT JOIN logistics_transfer_orders transfer ON transfer.id=request.transfer_id
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
    ISSUE: { from: ["PICKING"], to: "ISSUED" },
    RECEIVE: { from: ["IN_TRANSIT"], to: "RECEIVED" },
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
    const targetStatus = normalizedAction === "ISSUE"
      && current.requesting_warehouse_id !== current.fulfillment_warehouse_id
      ? "IN_TRANSIT" : transition.to;
    if (current.status === targetStatus) {
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

    if (normalizedAction === "START_PICK") {
      await client.query(`INSERT INTO logistics_pick_tasks
        (organization_id,request_id,reservation_id,warehouse_id,location_id,item_id,
         asset_unit_id,lot_id,picking_sequence,quantity_required,status,assigned_to,started_at)
        SELECT reservation.organization_id,reservation.request_id,reservation.id,
          location.warehouse_id,reservation.location_id,reservation.item_id,
          reservation.asset_unit_id,reservation.lot_id,location.picking_sequence,
          reservation.quantity,'OPEN',$2,NOW()
        FROM logistics_stock_reservations reservation
        JOIN logistics_locations location ON location.id=reservation.location_id
        WHERE reservation.request_id=$1 AND reservation.status='ACTIVE'
        ON CONFLICT (reservation_id) DO UPDATE SET
          assigned_to=COALESCE(logistics_pick_tasks.assigned_to,EXCLUDED.assigned_to),
          started_at=COALESCE(logistics_pick_tasks.started_at,EXCLUDED.started_at),
          status=CASE WHEN logistics_pick_tasks.status='CANCELLED' THEN 'OPEN'
            ELSE logistics_pick_tasks.status END,
          updated_at=NOW()`, [requestId, actorProfileId]);
      const taskCount = number((await client.query(`SELECT COUNT(*)::int AS count
        FROM logistics_pick_tasks WHERE request_id=$1 AND status<>'CANCELLED'`,
        [requestId])).rows[0]?.count);
      if (!taskCount) throw new Error("No fue posible crear tareas para el stock reservado.");
    }

    let createdTransferId = current.transfer_id || null;
    if (normalizedAction === "ISSUE") {
      const taskSummary = (await client.query(`SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status='PICKED'
            AND quantity_picked=quantity_required)::int AS completed
        FROM logistics_pick_tasks WHERE request_id=$1 AND status<>'CANCELLED'`,
        [requestId])).rows[0];
      if (!number(taskSummary?.total)) {
        throw new Error("Inicia y completa la preparación antes de confirmar la entrega.");
      }
      if (number(taskSummary.completed) !== number(taskSummary.total)) {
        throw new Error(`Preparación incompleta: ${taskSummary.completed} de ${taskSummary.total} tareas verificadas.`);
      }
      const reservations = (await client.query(`SELECT reservation.*,item.item_type,item.sku
        FROM logistics_stock_reservations reservation
        JOIN logistics_items item ON item.id=reservation.item_id
        WHERE reservation.request_id=$1 AND reservation.status='ACTIVE'
        ORDER BY reservation.reserved_at FOR UPDATE OF reservation`, [requestId])).rows;
      if (!reservations.length) throw new Error("La solicitud no tiene stock reservado para entregar.");
      if (targetStatus === "IN_TRANSIT") {
        const transit = (await client.query(`SELECT * FROM logistics_locations
          WHERE organization_id=$1 AND location_type='TRANSIT' AND active=TRUE
          ORDER BY created_at LIMIT 1`, [current.organization_id])).rows[0];
        if (!transit) throw new Error("No existe una ubicación de tránsito configurada.");
        const sequence = await client.query(`SELECT COALESCE(MAX(NULLIF(
          regexp_replace(transfer_number,'\\D','','g'),'')::bigint),0)+1 AS next
          FROM logistics_transfer_orders WHERE organization_id=$1`, [current.organization_id]);
        const transferNumber = `TR-${String(sequence.rows[0].next).padStart(6, "0")}`;
        const transfer = (await client.query(`INSERT INTO logistics_transfer_orders
          (organization_id,transfer_number,source_warehouse_id,destination_warehouse_id,
           transit_location_id,status,requested_by,dispatched_by,requested_at,dispatched_at,notes)
          VALUES ($1,$2,$3,$4,$5,'IN_TRANSIT',$6,$6,NOW(),NOW(),$7)
          RETURNING *`, [current.organization_id, transferNumber, current.fulfillment_warehouse_id,
            current.requesting_warehouse_id, transit.id, actorProfileId,
            text(input.notes) || `Despacho de ${current.request_number}`])).rows[0];
        createdTransferId = transfer.id;
        for (const reservation of reservations) {
          const transferLine = (await client.query(`INSERT INTO logistics_transfer_lines
            (transfer_id,item_id,asset_unit_id,lot_id,source_location_id,request_reservation_id,
             quantity_requested,quantity_dispatched)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
            [transfer.id, reservation.item_id, reservation.asset_unit_id, reservation.lot_id,
              reservation.location_id, reservation.id, reservation.quantity])).rows[0];
          await postMovementWithClient(client, {
            organizationId: current.organization_id,
            itemId: reservation.item_id,
            assetUnitId: reservation.asset_unit_id,
            lotId: reservation.lot_id,
            quantity: reservation.quantity,
            fromLocationId: reservation.location_id,
            toLocationId: transit.id,
            movementType: "TRANSFER_DISPATCH",
            referenceType: "transfer",
            referenceId: transfer.id,
            idempotencyKey: `material-request:${current.id}:transfer:${transfer.id}:line:${transferLine.id}:dispatch`,
            source: "MANUAL",
            notes: text(input.notes) || `Despacho solicitud ${current.request_number}`
          }, actorProfileId);
          await client.query(`UPDATE logistics_stock_reservations SET status='ISSUED',
            issued_at=NOW() WHERE id=$1`, [reservation.id]);
        }
        await client.query(`INSERT INTO logistics_outbox_events
          (organization_id,event_type,aggregate_type,aggregate_id,payload)
          VALUES ($1,'transfer.dispatched','transfer',$2,$3::jsonb)`,
          [current.organization_id, transfer.id, json({ transfer, materialRequestId: current.id })]);
      } else {
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
      }
      await client.query(`UPDATE logistics_material_request_lines line SET
        quantity_issued=quantity_reserved,updated_at=NOW() WHERE request_id=$1`, [requestId]);
    }

    if (normalizedAction === "RECEIVE") {
      if (!current.transfer_id) throw new Error("La solicitud no tiene un traslado asociado.");
      const receiverName = text(input.receiverName)
        || text((await client.query("SELECT name FROM inventory_user_profiles WHERE id=$1",
          [actorProfileId])).rows[0]?.name);
      if (receiverName.length < 3) throw new Error("Indica quién recibe los materiales.");
      const transfer = (await client.query(`SELECT * FROM logistics_transfer_orders
        WHERE id=$1 FOR UPDATE`, [current.transfer_id])).rows[0];
      if (!transfer || !["IN_TRANSIT", "PARTIALLY_RECEIVED"].includes(transfer.status)) {
        throw new Error("El traslado no está disponible para recepción.");
      }
      const destination = await warehouseLocation(client, current.requesting_warehouse_id, "STORAGE");
      const transit = (await client.query("SELECT * FROM logistics_locations WHERE id=$1",
        [transfer.transit_location_id])).rows[0];
      if (!transit) throw new Error("El traslado no tiene ubicación de tránsito.");
      const lines = (await client.query(`SELECT * FROM logistics_transfer_lines
        WHERE transfer_id=$1 ORDER BY created_at FOR UPDATE`, [transfer.id])).rows;
      for (const line of lines) {
        const quantity = number(line.quantity_dispatched) - number(line.quantity_received);
        if (!(quantity > 0)) continue;
        await postMovementWithClient(client, {
          organizationId: current.organization_id,
          itemId: line.item_id,
          assetUnitId: line.asset_unit_id,
          lotId: line.lot_id,
          quantity,
          fromLocationId: transit.id,
          toLocationId: destination.id,
          movementType: "TRANSFER_RECEIPT",
          referenceType: "transfer",
          referenceId: transfer.id,
          idempotencyKey: `material-request:${current.id}:transfer:${transfer.id}:line:${line.id}:receive`,
          source: "MANUAL",
          notes: text(input.notes) || `Recepción solicitud ${current.request_number} por ${receiverName}`
        }, actorProfileId);
        await client.query(`UPDATE logistics_transfer_lines SET quantity_received=quantity_dispatched,
          updated_at=NOW() WHERE id=$1`, [line.id]);
      }
      await client.query(`UPDATE logistics_transfer_orders SET status='RECEIVED',received_by=$1,
        received_at=NOW(),updated_at=NOW() WHERE id=$2`, [actorProfileId, transfer.id]);
      await client.query(`INSERT INTO logistics_outbox_events
        (organization_id,event_type,aggregate_type,aggregate_id,payload)
        VALUES ($1,'transfer.received','transfer',$2,$3::jsonb)`,
        [current.organization_id, transfer.id, json({ transferId: transfer.id,
          materialRequestId: current.id, receiverName })]);
      input.receiverName = receiverName;
    }

    if (normalizedAction === "CANCEL") {
      await client.query(`UPDATE logistics_stock_reservations SET status='RELEASED',
        released_at=NOW(),release_reason=$2 WHERE request_id=$1 AND status='ACTIVE'`,
        [requestId, text(input.notes) || "Solicitud cancelada"]);
      await client.query(`UPDATE logistics_material_request_lines SET
        quantity_reserved=0,updated_at=NOW() WHERE request_id=$1`, [requestId]);
      await client.query(`UPDATE logistics_pick_tasks SET status='CANCELLED',
        updated_at=NOW() WHERE request_id=$1 AND status<>'CANCELLED'`, [requestId]);
    }

    const updated = (await client.query(`UPDATE logistics_material_requests SET status=$1,
      submitted_at=CASE WHEN $1='SUBMITTED' THEN NOW() ELSE submitted_at END,
      approved_at=CASE WHEN $1='APPROVED' THEN NOW() ELSE approved_at END,
      approved_by=CASE WHEN $1='APPROVED' THEN $2 ELSE approved_by END,
      allocated_at=CASE WHEN $1='ALLOCATED' THEN NOW() ELSE allocated_at END,
      picking_at=CASE WHEN $1='PICKING' THEN NOW() ELSE picking_at END,
      prepared_by=CASE WHEN $1='PICKING' THEN $2 ELSE prepared_by END,
       issued_at=CASE WHEN $1 IN ('ISSUED','IN_TRANSIT') THEN NOW() ELSE issued_at END,
       issued_by=CASE WHEN $1 IN ('ISSUED','IN_TRANSIT') THEN $2 ELSE issued_by END,
       transfer_id=COALESCE($5,transfer_id),
       received_at=CASE WHEN $1='RECEIVED' THEN NOW() ELSE received_at END,
       received_by=CASE WHEN $1='RECEIVED' THEN $2 ELSE received_by END,
       receiver_name=CASE WHEN $1='RECEIVED' THEN $6 ELSE receiver_name END,
       delivery_notes=CASE WHEN $1 IN ('IN_TRANSIT','RECEIVED') AND $3<>'' THEN $3 ELSE delivery_notes END,
       cancelled_at=CASE WHEN $1='CANCELLED' THEN NOW() ELSE cancelled_at END,
       notes=CASE WHEN $3='' THEN notes ELSE CONCAT_WS(E'\\n',notes,$3) END,updated_at=NOW()
       WHERE id=$4 RETURNING *`, [targetStatus, actorProfileId, text(input.notes), requestId,
        createdTransferId, text(input.receiverName)])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,
       source,before_data,after_data,metadata)
      VALUES ($1,$2,'material_request',$3,$4,$5,'MANUAL',$6::jsonb,$7::jsonb,$8::jsonb)`,
      [current.organization_id, `MATERIAL_REQUEST_${targetStatus}`, current.id, actorProfileId,
        current.request_number, json(current), json(updated), json({ action: normalizedAction })]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,$2,'material_request',$3,$4::jsonb)`,
      [current.organization_id, `material_request.${targetStatus.toLowerCase()}`,
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

function comparableScan(value) {
  let raw = text(value);
  try {
    const parsed = new URL(raw);
    raw = parsed.searchParams.get("asset") || parsed.searchParams.get("code")
      || decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) || raw);
  } catch {}
  const normalized = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized.replace(/^([A-Z]+)0+(?=\d)/, "$1");
}

export async function updatePickTask(pool, taskId, action, input, actorProfileId = null) {
  const normalizedAction = text(action).toUpperCase();
  if (!["START", "PICK"].includes(normalizedAction)) throw new Error("Acción de picking no permitida.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const task = (await client.query(`SELECT task.*,request.request_number,request.status AS request_status,
        location.code AS location_code,location.barcode AS location_barcode,location.name AS location_name,
        item.sku,item.gtin,item.name AS item_name,asset_unit.unit_code,asset_unit.manufacturer_serial,
        lot.lot_number
      FROM logistics_pick_tasks task
      JOIN logistics_material_requests request ON request.id=task.request_id
      JOIN logistics_locations location ON location.id=task.location_id
      JOIN logistics_items item ON item.id=task.item_id
      LEFT JOIN logistics_asset_units asset_unit ON asset_unit.id=task.asset_unit_id
      LEFT JOIN logistics_lots lot ON lot.id=task.lot_id
      WHERE task.id=$1 FOR UPDATE OF task`, [taskId])).rows[0];
    if (!task) throw new Error("Tarea de preparación no encontrada.");
    if (task.request_status !== "PICKING") throw new Error("La solicitud no está en preparación.");
    if (task.status === "CANCELLED") throw new Error("La tarea fue cancelada.");

    if (normalizedAction === "START") {
      const updated = (await client.query(`UPDATE logistics_pick_tasks SET
        status=CASE WHEN status='OPEN' THEN 'IN_PROGRESS' ELSE status END,
        assigned_to=COALESCE(assigned_to,$2),started_at=COALESCE(started_at,NOW()),updated_at=NOW()
        WHERE id=$1 RETURNING *`, [taskId, actorProfileId])).rows[0];
      await client.query("COMMIT");
      return { task: updated };
    }

    const scannedLocation = text(input.locationScan);
    const scannedItem = text(input.itemScan);
    if (!scannedLocation || !scannedItem) throw new Error("Escanea la ubicación y el producto.");
    const expectedLocations = [task.location_code, task.location_barcode, task.location_name]
      .map(comparableScan).filter(Boolean);
    if (!expectedLocations.includes(comparableScan(scannedLocation))) {
      throw new Error(`Ubicación incorrecta. Debes preparar desde ${task.location_code || task.location_name}.`);
    }
    const identifiers = (await client.query(`SELECT identifier_value FROM (
        SELECT presentation.barcode AS identifier_value
        FROM logistics_item_uoms presentation WHERE presentation.item_id=$1
        UNION ALL
        SELECT presentation.supplier_code
        FROM logistics_item_uoms presentation WHERE presentation.item_id=$1
        UNION ALL
        SELECT supplier_item.supplier_item_code
        FROM logistics_supplier_items supplier_item WHERE supplier_item.item_id=$1
      ) identifiers WHERE identifier_value IS NOT NULL`, [task.item_id])).rows.map(row => row.identifier_value);
    const expectedItems = [
      task.sku, task.gtin, task.unit_code, task.manufacturer_serial, task.lot_number, ...identifiers
    ].map(comparableScan).filter(Boolean);
    if (!expectedItems.includes(comparableScan(scannedItem))) {
      throw new Error(`El código escaneado no corresponde a ${task.sku} · ${task.item_name}.`);
    }
    const quantityPicked = assertPositiveQuantity(input.quantityPicked);
    if (quantityPicked > number(task.quantity_required)) {
      throw new Error("La cantidad preparada no puede superar la cantidad requerida.");
    }
    const exact = Math.abs(quantityPicked - number(task.quantity_required)) < 0.000001;
    const discrepancyReason = text(input.discrepancyReason);
    if (!exact && discrepancyReason.length < 5) {
      throw new Error("Indica el motivo de la diferencia de cantidad.");
    }
    const nextStatus = exact ? "PICKED" : "EXCEPTION";
    const updated = (await client.query(`UPDATE logistics_pick_tasks SET
      quantity_picked=$2,status=$3,assigned_to=COALESCE(assigned_to,$4),picked_by=$4,
      started_at=COALESCE(started_at,NOW()),picked_at=CASE WHEN $3='PICKED' THEN NOW() ELSE NULL END,
      scanned_location=$5,scanned_item=$6,discrepancy_reason=NULLIF($7,''),updated_at=NOW()
      WHERE id=$1 RETURNING *`,
      [taskId, quantityPicked, nextStatus, actorProfileId, scannedLocation, scannedItem, discrepancyReason])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,
       source,before_data,after_data,metadata)
      VALUES ($1,$2,'pick_task',$3,$4,$5,'SCAN',$6::jsonb,$7::jsonb,$8::jsonb)`,
      [task.organization_id, `PICK_TASK_${nextStatus}`, task.id, actorProfileId,
        task.request_number, json(task), json(updated),
        json({ scannedLocation, scannedItem, quantityPicked, discrepancyReason })]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,$2,'pick_task',$3,$4::jsonb)`,
      [task.organization_id, `pick_task.${nextStatus.toLowerCase()}`, task.id, json({ task: updated })]);
    await client.query("COMMIT");
    return { task: updated };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createMaintenancePlan(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const assetUnitId = text(input.assetUnitId);
  const name = text(input.name);
  const intervalDays = Math.round(number(input.intervalDays));
  if (!organizationId || !assetUnitId || !name || !(intervalDays > 0)) {
    throw new Error("Completa equipo, nombre e intervalo del plan.");
  }
  const unit = (await pool.query(`SELECT unit.id FROM logistics_asset_units unit
    WHERE unit.id=$1 AND unit.organization_id=$2 AND unit.status<>'RETIRED'`,
    [assetUnitId, organizationId])).rows[0];
  if (!unit) throw new Error("El equipo no existe o está retirado.");
  const result = await pool.query(`INSERT INTO logistics_maintenance_plans
    (organization_id,asset_unit_id,name,maintenance_type,interval_days,next_due_at,
     estimated_duration_hours,checklist,active,created_by,updated_at)
    VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz,NOW()+($5::text||' days')::interval),
      $7,$8::jsonb,TRUE,$9,NOW())
    ON CONFLICT (organization_id,asset_unit_id,name) DO UPDATE SET
      maintenance_type=EXCLUDED.maintenance_type,interval_days=EXCLUDED.interval_days,
      next_due_at=EXCLUDED.next_due_at,estimated_duration_hours=EXCLUDED.estimated_duration_hours,
      checklist=EXCLUDED.checklist,active=TRUE,updated_at=NOW()
    RETURNING *`, [organizationId, assetUnitId, name,
    ["PREVENTIVE", "PREDICTIVE", "LEGAL"].includes(text(input.maintenanceType).toUpperCase())
      ? text(input.maintenanceType).toUpperCase() : "PREVENTIVE",
    intervalDays, text(input.nextDueAt) || null,
    number(input.estimatedDurationHours) > 0 ? number(input.estimatedDurationHours) : null,
    json(Array.isArray(input.checklist) ? input.checklist : []), actorProfileId]);
  const plan = result.rows[0];
  await pool.query(`INSERT INTO logistics_audit_events
    (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,after_data)
    VALUES ($1,'MAINTENANCE_PLAN_SAVED','maintenance_plan',$2,$3,'MANUAL',$4::jsonb)`,
    [organizationId, plan.id, actorProfileId, json(plan)]);
  return plan;
}

export async function createWorkOrder(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const assetUnitId = text(input.assetUnitId);
  const title = text(input.title);
  const parts = Array.isArray(input.parts) ? input.parts : [];
  if (!organizationId || !assetUnitId || !title) throw new Error("Completa equipo y descripción de la orden.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const unit = (await client.query(`SELECT unit.*,item.sku,item.name AS item_name
      FROM logistics_asset_units unit JOIN logistics_items item ON item.id=unit.item_id
      WHERE unit.id=$1 AND unit.organization_id=$2 AND unit.status<>'RETIRED' FOR UPDATE OF unit`,
      [assetUnitId, organizationId])).rows[0];
    if (!unit) throw new Error("El equipo no existe o está retirado.");
    if (unit.status === "IN_CUSTODY") throw new Error("Registra la devolución del equipo antes de enviarlo a mantenimiento.");
    const warehouseId = text(input.warehouseId) || null;
    if (warehouseId) {
      const warehouse = await client.query(`SELECT 1 FROM logistics_warehouses
        WHERE id=$1 AND organization_id=$2 AND active=TRUE`, [warehouseId, organizationId]);
      if (!warehouse.rowCount) throw new Error("La bodega de mantenimiento no es válida.");
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`work-order-sequence:${organizationId}`]);
    const sequence = await client.query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(work_order_number,'\\D','','g'),'')::bigint),0)+1 AS next
      FROM logistics_work_orders WHERE organization_id=$1`, [organizationId]);
    const workOrderNumber = text(input.workOrderNumber)
      || `OT-${String(sequence.rows[0].next).padStart(7, "0")}`;
    const priority = ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(text(input.priority).toUpperCase())
      ? text(input.priority).toUpperCase() : "MEDIUM";
    const workType = ["PREVENTIVE", "PREDICTIVE", "CORRECTIVE", "INSPECTION"].includes(text(input.workType).toUpperCase())
      ? text(input.workType).toUpperCase() : "CORRECTIVE";
    const workOrder = (await client.query(`INSERT INTO logistics_work_orders
      (organization_id,work_order_number,asset_unit_id,warehouse_id,maintenance_plan_id,
       inspection_id,finding_id,work_type,priority,status,title,description,blocks_operation,
       requested_by,assigned_to,planned_start_at,due_at,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'OPEN',$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *`, [organizationId, workOrderNumber, assetUnitId, warehouseId,
      text(input.maintenancePlanId) || null, text(input.inspectionId) || null,
      text(input.findingId) || null, workType, priority, title, text(input.description) || null,
      input.blocksOperation !== false, actorProfileId, text(input.assignedTo) || null,
      text(input.plannedStartAt) || null, text(input.dueAt) || null, text(input.notes) || null])).rows[0];
    const savedParts = [];
    for (const partInput of parts) {
      const quantity = assertPositiveQuantity(partInput.quantity);
      const item = (await client.query(`SELECT * FROM logistics_items
        WHERE id=$1 AND organization_id=$2 AND active=TRUE FOR SHARE`,
        [partInput.itemId, organizationId])).rows[0];
      if (!item) throw new Error("Uno de los repuestos no existe.");
      if (item.tracking_type === "SERIAL") throw new Error(`${item.sku} es serializado y no puede consumirse como repuesto.`);
      const part = (await client.query(`INSERT INTO logistics_work_order_parts
        (work_order_id,item_id,quantity_planned,unit_cost,notes)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [workOrder.id, item.id, quantity, Math.max(0, number(partInput.unitCost)),
          text(partInput.notes) || null])).rows[0];
      savedParts.push(part);
    }
    if (workOrder.blocks_operation) {
      await client.query("UPDATE logistics_asset_units SET status='BLOCKED',updated_at=NOW() WHERE id=$1", [assetUnitId]);
    }
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,source,after_data,metadata)
      VALUES ($1,'WORK_ORDER_CREATED','work_order',$2,$3,'MANUAL',$4::jsonb,$5::jsonb)`,
      [organizationId, workOrder.id, actorProfileId, json(workOrder), json({ parts: savedParts })]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,'maintenance.work_order.created','work_order',$2,$3::jsonb)`,
      [organizationId, workOrder.id, json({ workOrder, parts: savedParts })]);
    await client.query("COMMIT");
    return { workOrder, parts: savedParts };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listMaintenance(pool, profile) {
  const params = [];
  const scope = profile?.admin ? "" : `AND center.name=$${params.push(profile?.cost_center || "")}`;
  const planParams = [];
  const planScope = profile?.admin ? "" : `AND EXISTS (
    SELECT 1 FROM logistics_stock_balances balance
    JOIN logistics_locations location ON location.id=balance.location_id
    JOIN logistics_warehouses warehouse ON warehouse.id=location.warehouse_id
    LEFT JOIN logistics_cost_centers plan_center ON plan_center.id=warehouse.cost_center_id
    WHERE balance.asset_unit_id=plan.asset_unit_id AND balance.quantity>0
      AND plan_center.name=$${planParams.push(profile?.cost_center || "")})`;
  const plans = await pool.query(`SELECT plan.*,unit.unit_code,item.sku,item.name AS item_name
    FROM logistics_maintenance_plans plan
    JOIN logistics_asset_units unit ON unit.id=plan.asset_unit_id
    JOIN logistics_items item ON item.id=unit.item_id
    WHERE plan.active=TRUE ${planScope}
    ORDER BY plan.next_due_at,item.name,unit.unit_code`, planParams);
  const orders = await pool.query(`SELECT work_order.*,unit.unit_code,unit.status AS asset_status,
      item.sku,item.name AS item_name,warehouse.name AS warehouse_name,center.name AS cost_center,
      plan.name AS plan_name,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',part.id,'itemId',part.item_id,'sku',part_item.sku,'itemName',part_item.name,
        'quantityPlanned',part.quantity_planned,'quantityUsed',part.quantity_used,
        'unitCost',part.unit_cost,'movementIds',part.stock_movement_ids
      ) ORDER BY part.created_at)
      FROM logistics_work_order_parts part
      JOIN logistics_items part_item ON part_item.id=part.item_id
      WHERE part.work_order_id=work_order.id),'[]'::jsonb) AS parts
    FROM logistics_work_orders work_order
    JOIN logistics_asset_units unit ON unit.id=work_order.asset_unit_id
    JOIN logistics_items item ON item.id=unit.item_id
    LEFT JOIN logistics_warehouses warehouse ON warehouse.id=work_order.warehouse_id
    LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
    LEFT JOIN logistics_maintenance_plans plan ON plan.id=work_order.maintenance_plan_id
    WHERE 1=1 ${scope}
    ORDER BY CASE work_order.priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
      work_order.created_at DESC LIMIT 300`, params);
  return { plans: plans.rows, workOrders: orders.rows };
}

export async function updateWorkOrder(pool, workOrderId, action, input, actorProfileId = null) {
  const normalizedAction = text(action).toUpperCase();
  const transitions = {
    APPROVE: { from: ["OPEN"], to: "APPROVED" },
    START: { from: ["APPROVED"], to: "IN_PROGRESS" },
    WAIT_PARTS: { from: ["IN_PROGRESS"], to: "WAITING_PARTS" },
    RESUME: { from: ["WAITING_PARTS"], to: "IN_PROGRESS" },
    COMPLETE: { from: ["IN_PROGRESS", "WAITING_PARTS"], to: "COMPLETED" },
    CANCEL: { from: ["OPEN", "APPROVED"], to: "CANCELLED" }
  };
  const transition = transitions[normalizedAction];
  if (!transition) throw new Error("Acción de mantenimiento no permitida.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`work-order:${workOrderId}`]);
    const current = (await client.query("SELECT * FROM logistics_work_orders WHERE id=$1 FOR UPDATE", [workOrderId])).rows[0];
    if (!current) throw new Error("Orden de trabajo no encontrada.");
    if (current.status === transition.to) {
      await client.query("COMMIT");
      return { workOrder: current, replayed: true };
    }
    if (!transition.from.includes(current.status)) throw new Error(`La orden está en estado ${current.status}.`);
    if (normalizedAction === "APPROVE" && current.requested_by === actorProfileId && !input.allowSelfApproval) {
      throw new Error("Quien creó la orden no puede aprobarla.");
    }
    if (normalizedAction === "COMPLETE" && !text(input.resolution)) {
      throw new Error("Describe el trabajo realizado antes de cerrar.");
    }

    if (normalizedAction === "START") {
      await client.query("UPDATE logistics_asset_units SET status='REPAIR',updated_at=NOW() WHERE id=$1", [current.asset_unit_id]);
    }
    let partsCost = number(current.parts_cost);
    if (normalizedAction === "COMPLETE") {
      if (!current.warehouse_id) throw new Error("La orden necesita una bodega para consumir repuestos.");
      const parts = (await client.query(`SELECT part.*,item.sku,item.tracking_type
        FROM logistics_work_order_parts part JOIN logistics_items item ON item.id=part.item_id
        WHERE part.work_order_id=$1 FOR UPDATE OF part`, [workOrderId])).rows;
      partsCost = 0;
      for (const part of parts) {
        let remaining = number(part.quantity_planned) - number(part.quantity_used);
        const movementIds = Array.isArray(part.stock_movement_ids) ? [...part.stock_movement_ids] : [];
        const candidates = (await client.query(`SELECT balance.*,location.picking_sequence,
            lot.expires_at,lot.status AS lot_status,
            GREATEST(0,balance.quantity-COALESCE((
              SELECT SUM(reservation.quantity) FROM logistics_stock_reservations reservation
              WHERE reservation.organization_id=balance.organization_id
                AND reservation.item_id=balance.item_id
                AND reservation.location_id=balance.location_id
                AND reservation.asset_unit_id IS NOT DISTINCT FROM balance.asset_unit_id
                AND reservation.lot_id IS NOT DISTINCT FROM balance.lot_id
                AND reservation.status='ACTIVE'),0))::numeric AS available_quantity
          FROM logistics_stock_balances balance
          JOIN logistics_locations location ON location.id=balance.location_id
          LEFT JOIN logistics_lots lot ON lot.id=balance.lot_id
          WHERE balance.organization_id=$1 AND balance.item_id=$2
            AND location.warehouse_id=$3 AND location.location_type='STORAGE'
            AND location.active=TRUE AND location.operational_status='AVAILABLE'
            AND balance.quantity>0
            AND (lot.id IS NULL OR (lot.status='ACTIVE' AND (lot.expires_at IS NULL OR lot.expires_at>=CURRENT_DATE)))
          ORDER BY location.picking_sequence,lot.expires_at NULLS LAST,balance.updated_at
          FOR UPDATE OF balance`, [current.organization_id, part.item_id, current.warehouse_id])).rows;
        for (const candidate of candidates) {
          if (!(remaining > 0)) break;
          const quantity = Math.min(remaining, number(candidate.available_quantity));
          if (!(quantity > 0)) continue;
          const posted = await postMovementWithClient(client, {
            organizationId: current.organization_id, itemId: part.item_id,
            lotId: candidate.lot_id, quantity, fromLocationId: candidate.location_id,
            movementType: "CONSUMPTION", referenceType: "work_order", referenceId: current.id,
            idempotencyKey: `work-order:${current.id}:part:${part.id}:location:${candidate.location_id}:lot:${candidate.lot_id || "none"}`,
            source: "MANUAL", notes: `Repuesto utilizado en ${current.work_order_number}`
          }, actorProfileId);
          movementIds.push(posted.movement.id);
          remaining -= quantity;
        }
        if (remaining > 0.000001) throw new Error(`Stock insuficiente del repuesto ${part.sku}. Faltan ${remaining.toFixed(4)}.`);
        await client.query(`UPDATE logistics_work_order_parts SET quantity_used=quantity_planned,
          stock_movement_ids=$1::jsonb,updated_at=NOW() WHERE id=$2`, [json(movementIds), part.id]);
        partsCost += number(part.quantity_planned) * number(part.unit_cost);
      }
      if (current.finding_id) {
        await client.query(`UPDATE logistics_inspection_findings SET status='CORRECTED',
          corrected_at=NOW(),corrective_action=$1,updated_at=NOW() WHERE id=$2`,
          [text(input.resolution), current.finding_id]);
      } else if (current.inspection_id) {
        await client.query(`UPDATE logistics_inspection_findings SET status='CORRECTED',
          corrected_at=NOW(),corrective_action=$1,updated_at=NOW()
          WHERE inspection_id=$2 AND status IN ('OPEN','IN_PROGRESS')`,
          [text(input.resolution), current.inspection_id]);
      }
      if (current.maintenance_plan_id) {
        await client.query(`UPDATE logistics_maintenance_plans SET last_completed_at=NOW(),
          next_due_at=NOW()+(interval_days::text||' days')::interval,updated_at=NOW() WHERE id=$1`,
          [current.maintenance_plan_id]);
      }
      const nextStatus = current.inspection_id ? "BLOCKED" : "AVAILABLE";
      await client.query("UPDATE logistics_asset_units SET status=$1,updated_at=NOW() WHERE id=$2",
        [nextStatus, current.asset_unit_id]);
    }
    if (normalizedAction === "CANCEL") {
      const other = await client.query(`SELECT 1 FROM logistics_work_orders
        WHERE asset_unit_id=$1 AND id<>$2 AND status NOT IN ('COMPLETED','CANCELLED') LIMIT 1`,
        [current.asset_unit_id, current.id]);
      if (!other.rowCount) {
        await client.query("UPDATE logistics_asset_units SET status='AVAILABLE',updated_at=NOW() WHERE id=$1", [current.asset_unit_id]);
      }
    }
    const updated = (await client.query(`UPDATE logistics_work_orders SET status=$1,
      approved_by=CASE WHEN $1='APPROVED' THEN $2 ELSE approved_by END,
      started_at=CASE WHEN $1='IN_PROGRESS' THEN COALESCE(started_at,NOW()) ELSE started_at END,
      completed_at=CASE WHEN $1='COMPLETED' THEN NOW() ELSE completed_at END,
      completed_by=CASE WHEN $1='COMPLETED' THEN $2 ELSE completed_by END,
      resolution=CASE WHEN $3='' THEN resolution ELSE $3 END,
      downtime_hours=CASE WHEN $4::numeric<0 THEN downtime_hours ELSE $4::numeric END,
      labor_cost=CASE WHEN $5::numeric<0 THEN labor_cost ELSE $5::numeric END,
      parts_cost=$6,notes=CASE WHEN $7='' THEN notes ELSE CONCAT_WS(E'\\n',notes,$7) END,
      updated_at=NOW() WHERE id=$8 RETURNING *`,
      [transition.to, actorProfileId, text(input.resolution),
        input.downtimeHours === undefined ? -1 : Math.max(0, number(input.downtimeHours)),
        input.laborCost === undefined ? -1 : Math.max(0, number(input.laborCost)),
        partsCost, text(input.notes), current.id])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,
       source,before_data,after_data,metadata)
      VALUES ($1,$2,'work_order',$3,$4,$5,'MANUAL',$6::jsonb,$7::jsonb,$8::jsonb)`,
      [current.organization_id, `WORK_ORDER_${transition.to}`, current.id, actorProfileId,
        current.work_order_number, json(current), json(updated), json({ action: normalizedAction })]);
    await client.query(`INSERT INTO logistics_outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
      VALUES ($1,$2,'work_order',$3,$4::jsonb)`,
      [current.organization_id, `maintenance.work_order.${transition.to.toLowerCase()}`,
        current.id, json({ workOrder: updated })]);
    await client.query("COMMIT");
    return { workOrder: updated, replayed: false };
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
    if (failed) {
      const firstFinding = (await client.query(`SELECT id FROM logistics_inspection_findings
        WHERE inspection_id=$1 ORDER BY created_at LIMIT 1`, [inspection.id])).rows[0];
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`work-order-sequence:${organizationId}`]);
      const sequence = await client.query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(work_order_number,'\\D','','g'),'')::bigint),0)+1 AS next
        FROM logistics_work_orders WHERE organization_id=$1`, [organizationId]);
      const workOrderNumber = `OT-${String(sequence.rows[0].next).padStart(7, "0")}`;
      await client.query(`INSERT INTO logistics_work_orders
        (organization_id,work_order_number,asset_unit_id,warehouse_id,inspection_id,finding_id,
         work_type,priority,status,title,description,blocks_operation,requested_by,due_at,notes)
        VALUES ($1,$2,$3,$4,$5,$6,'INSPECTION','HIGH','OPEN',$7,$8,TRUE,$9,$10,$11)
        ON CONFLICT DO NOTHING`,
        [organizationId, workOrderNumber, assetUnitId, warehouseId, inspection.id,
          firstFinding?.id || null, `Corregir hallazgos de inspección · ${unit.unit_code}`,
          `Orden automática por inspección no conforme de ${unit.item_name}.`,
          actorProfileId, input.dueAt || null, text(input.notes) || null]);
      await client.query("UPDATE logistics_asset_units SET status='BLOCKED',updated_at=NOW() WHERE id=$1", [assetUnitId]);
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
        const activeMaintenance = await client.query(`SELECT 1 FROM logistics_work_orders
          WHERE asset_unit_id=$1 AND inspection_id IS DISTINCT FROM $2::uuid
            AND status NOT IN ('COMPLETED','CANCELLED') LIMIT 1`,
          [current.asset_unit_id, inspectionId]);
        if (!activeMaintenance.rowCount) {
          await client.query("UPDATE logistics_asset_units SET status='AVAILABLE',updated_at=NOW() WHERE id=$1",
            [current.asset_unit_id]);
        }
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
        notes: input.notes || transfer.notes,
        allowComplianceOverride: input.allowComplianceOverride === true,
        complianceOverrideReason: input.complianceOverrideReason
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
    if (complete) {
      await client.query(`UPDATE logistics_material_requests request SET status='RECEIVED',
        received_by=$1,received_at=NOW(),
        receiver_name=COALESCE(request.receiver_name,
          (SELECT profile.name FROM inventory_user_profiles profile WHERE profile.id=$1)),
        updated_at=NOW()
        WHERE request.transfer_id=$2 AND request.status='IN_TRANSIT'`, [actorProfileId, transfer.id]);
    }
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

    if (assetUnitId) {
      const complianceOverride = await assertAssetComplianceOperational(client, assetUnitId, input);
      if (complianceOverride) {
        await client.query(`INSERT INTO logistics_audit_events
          (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,
           source,after_data,metadata)
          VALUES ($1,'ASSET_COMPLIANCE_OVERRIDE','asset_unit',$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
        [organizationId, assetUnitId, actorProfileId, externalReference,
          text(input.source).toUpperCase() || "QR",
          json({ reason: text(input.complianceOverrideReason) }),
          json({ complianceRecordId: complianceOverride.id, operation: "CUSTODY" })]);
      }
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
    ORDER BY cycle.created_at DESC LIMIT 100`, params);
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

export async function listAssetFinancials(pool, profile, organizationId, asOfDate = null) {
  const params = [organizationId, text(asOfDate) || new Date().toISOString().slice(0, 10)];
  const scope = profile?.admin ? "" : `AND center.name=$${params.push(profile?.cost_center || "")}`;
  const result = await pool.query(`WITH calculated AS (
      SELECT financial.*,unit.unit_code,unit.manufacturer_serial,unit.status AS unit_status,
        item.sku,item.name AS item_name,center.name AS cost_center,
        LEAST(financial.useful_life_months,GREATEST(0,
          (EXTRACT(YEAR FROM AGE($2::date,financial.acquisition_date))*12
           +EXTRACT(MONTH FROM AGE($2::date,financial.acquisition_date)))::int)) AS months_depreciated
      FROM logistics_asset_financials financial
      JOIN logistics_asset_units unit ON unit.id=financial.asset_unit_id
      JOIN logistics_items item ON item.id=unit.item_id
      LEFT JOIN logistics_cost_centers center ON center.id=financial.cost_center_id
      WHERE financial.organization_id=$1 ${scope}
    )
    SELECT calculated.*,
      ROUND((acquisition_cost-residual_value)/useful_life_months,4) AS monthly_depreciation,
      ROUND(LEAST(acquisition_cost-residual_value,
        months_depreciated*((acquisition_cost-residual_value)/useful_life_months)),4) AS accumulated_depreciation,
      ROUND(GREATEST(residual_value,acquisition_cost-
        LEAST(acquisition_cost-residual_value,
          months_depreciated*((acquisition_cost-residual_value)/useful_life_months))),4) AS book_value,
      $2::date AS as_of_date
    FROM calculated ORDER BY item_name,unit_code`, params);
  const totals = result.rows.reduce((summary, row) => {
    const currency = row.currency || "CLP";
    summary[currency] ||= { acquisitionCost: 0, accumulatedDepreciation: 0, bookValue: 0 };
    summary[currency].acquisitionCost += number(row.acquisition_cost);
    summary[currency].accumulatedDepreciation += number(row.accumulated_depreciation);
    summary[currency].bookValue += number(row.book_value);
    return summary;
  }, {});
  return { rows: result.rows, totals, asOfDate: params[1] };
}

export async function upsertAssetFinancial(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const assetUnitId = text(input.assetUnitId);
  const acquisitionCost = Math.max(0, number(input.acquisitionCost));
  const residualValue = Math.max(0, number(input.residualValue));
  const usefulLifeMonths = Math.trunc(number(input.usefulLifeMonths));
  if (!organizationId || !assetUnitId || !text(input.acquisitionDate)) {
    throw new Error("Completa activo, fecha y costo de adquisición.");
  }
  if (usefulLifeMonths < 1) throw new Error("La vida útil debe ser de al menos un mes.");
  if (residualValue > acquisitionCost) throw new Error("El valor residual no puede superar el costo de adquisición.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const unit = (await client.query(`SELECT unit.*,location.warehouse_id,warehouse.cost_center_id
      FROM logistics_asset_units unit
      LEFT JOIN logistics_stock_balances balance ON balance.asset_unit_id=unit.id AND balance.quantity>0
      LEFT JOIN logistics_locations location ON location.id=balance.location_id
      LEFT JOIN logistics_warehouses warehouse ON warehouse.id=location.warehouse_id
      WHERE unit.id=$1 AND unit.organization_id=$2 LIMIT 1 FOR UPDATE OF unit`,
    [assetUnitId, organizationId])).rows[0];
    if (!unit) throw new Error("Activo serializado inexistente.");
    const before = (await client.query("SELECT * FROM logistics_asset_financials WHERE asset_unit_id=$1",
      [assetUnitId])).rows[0] || null;
    const financial = (await client.query(`INSERT INTO logistics_asset_financials
      (organization_id,asset_unit_id,acquisition_date,acquisition_cost,residual_value,
       useful_life_months,depreciation_method,currency,cost_center_id,document_number,
       notes,active,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,'STRAIGHT_LINE',$7,$8,$9,$10,TRUE,$11,$11)
      ON CONFLICT (asset_unit_id) DO UPDATE SET acquisition_date=EXCLUDED.acquisition_date,
        acquisition_cost=EXCLUDED.acquisition_cost,residual_value=EXCLUDED.residual_value,
        useful_life_months=EXCLUDED.useful_life_months,currency=EXCLUDED.currency,
        cost_center_id=COALESCE(EXCLUDED.cost_center_id,logistics_asset_financials.cost_center_id),
        document_number=EXCLUDED.document_number,notes=EXCLUDED.notes,active=TRUE,
        updated_by=EXCLUDED.updated_by,updated_at=NOW()
      RETURNING *`, [organizationId, assetUnitId, text(input.acquisitionDate), acquisitionCost,
      residualValue, usefulLifeMonths, text(input.currency || "CLP").toUpperCase(),
      text(input.costCenterId) || unit.cost_center_id || null, text(input.documentNumber) || null,
      text(input.notes) || null, actorProfileId])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,
       before_data,after_data,metadata)
      VALUES ($1,$2,'asset_financial',$3,$4,$5,'MANUAL',$6::jsonb,$7::jsonb,$8::jsonb)`,
    [organizationId, before ? "ASSET_FINANCIAL_UPDATED" : "ASSET_FINANCIAL_REGISTERED",
      financial.id, actorProfileId, `asset-financial:${assetUnitId}`, json(before), json(financial),
      json({ unitCode: unit.unit_code })]);
    await client.query("COMMIT");
    return { financial, created: !before };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function runAssetDepreciation(pool, organizationId, asOfDate, actorProfileId = null) {
  const date = text(asOfDate);
  if (!date) throw new Error("Selecciona el cierre mensual.");
  const endOfMonth = (await pool.query(`SELECT
    (date_trunc('month',$1::date)+INTERVAL '1 month - 1 day')::date=$1::date AS valid`, [date])).rows[0]?.valid;
  if (!endOfMonth) throw new Error("La depreciación debe calcularse al último día del mes.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",
      [`asset-depreciation:${organizationId}:${date}`]);
    const financials = await client.query(`SELECT financial.*,
        LEAST(financial.useful_life_months,GREATEST(0,
          (EXTRACT(YEAR FROM AGE($2::date,financial.acquisition_date))*12
           +EXTRACT(MONTH FROM AGE($2::date,financial.acquisition_date)))::int)) AS months_depreciated
      FROM logistics_asset_financials financial
      WHERE financial.organization_id=$1 AND financial.active=TRUE FOR SHARE`,
    [organizationId, date]);
    let inserted = 0;
    for (const financial of financials.rows) {
      const monthly = Number(((number(financial.acquisition_cost)-number(financial.residual_value))
        / number(financial.useful_life_months, 1)).toFixed(4));
      const accumulated = Number(Math.min(
        number(financial.acquisition_cost)-number(financial.residual_value),
        number(financial.months_depreciated)*monthly).toFixed(4));
      const bookValue = Number(Math.max(number(financial.residual_value),
        number(financial.acquisition_cost)-accumulated).toFixed(4));
      const previous = (await client.query(`SELECT accumulated_depreciation FROM
        logistics_asset_depreciation_snapshots WHERE financial_id=$1 AND as_of_date<$2
        ORDER BY as_of_date DESC LIMIT 1`, [financial.id, date])).rows[0];
      const period = Number(Math.max(0, accumulated-number(previous?.accumulated_depreciation)).toFixed(4));
      const saved = await client.query(`INSERT INTO logistics_asset_depreciation_snapshots
        (organization_id,financial_id,asset_unit_id,as_of_date,months_depreciated,
         monthly_depreciation,period_depreciation,accumulated_depreciation,book_value,
         currency,run_by,metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
        ON CONFLICT (financial_id,as_of_date) DO NOTHING RETURNING id`,
      [organizationId, financial.id, financial.asset_unit_id, date, financial.months_depreciated,
        monthly, period, accumulated, bookValue, financial.currency, actorProfileId,
        json({ method: financial.depreciation_method })]);
      inserted += saved.rowCount;
    }
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,
       after_data,metadata)
      VALUES ($1,'ASSET_DEPRECIATION_RUN','organization',$1,$2,$3,'SYSTEM',$4::jsonb,$5::jsonb)`,
    [organizationId, actorProfileId, `depreciation:${date}`, json({ asOfDate: date, inserted }),
      json({ financials: financials.rowCount })]);
    await client.query("COMMIT");
    return { asOfDate: date, processed: financials.rowCount, inserted, replayed: inserted === 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listAssetDisposals(pool, profile, organizationId) {
  const params = [organizationId];
  const scope = profile?.admin ? "" : `AND center.name=$${params.push(profile?.cost_center || "")}`;
  const result = await pool.query(`SELECT disposal.*,unit.unit_code,unit.manufacturer_serial,
      item.sku,item.name AS item_name,item.standard_cost,item.currency AS item_currency,
      warehouse.name AS warehouse_name,location.name AS location_name,center.name AS cost_center,
      requester.name AS requested_by_name,approver.name AS approved_by_name,poster.name AS posted_by_name
    FROM logistics_asset_disposals disposal
    JOIN logistics_asset_units unit ON unit.id=disposal.asset_unit_id
    JOIN logistics_items item ON item.id=disposal.item_id
    JOIN logistics_warehouses warehouse ON warehouse.id=disposal.warehouse_id
    JOIN logistics_locations location ON location.id=disposal.location_id
    LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
    LEFT JOIN inventory_user_profiles requester ON requester.id=disposal.requested_by
    LEFT JOIN inventory_user_profiles approver ON approver.id=disposal.approved_by
    LEFT JOIN inventory_user_profiles poster ON poster.id=disposal.posted_by
    WHERE disposal.organization_id=$1 ${scope}
    ORDER BY disposal.requested_at DESC LIMIT 250`, params);
  return result.rows;
}

export async function createAssetDisposal(pool, input, actorProfileId = null) {
  const organizationId = text(input.organizationId);
  const assetUnitId = text(input.assetUnitId);
  const reasonCode = text(input.reasonCode).toUpperCase();
  const allowedReasons = ["SCRAPPED", "SOLD", "LOST", "STOLEN", "DONATED", "OBSOLETE", "DAMAGED", "OTHER"];
  if (!organizationId || !assetUnitId || !allowedReasons.includes(reasonCode)) {
    throw new Error("Completa el activo y un motivo de baja válido.");
  }
  if (text(input.notes).length < 10) throw new Error("La solicitud de baja requiere un fundamento de al menos 10 caracteres.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const unit = (await client.query(`SELECT unit.*,item.standard_cost,item.currency,
        balance.location_id,location.warehouse_id
      FROM logistics_asset_units unit
      JOIN logistics_items item ON item.id=unit.item_id
      JOIN logistics_stock_balances balance ON balance.asset_unit_id=unit.id AND balance.quantity=1
      JOIN logistics_locations location ON location.id=balance.location_id
      WHERE unit.id=$1 AND unit.organization_id=$2 FOR UPDATE OF unit`,
    [assetUnitId, organizationId])).rows[0];
    if (!unit) throw new Error("El activo no tiene una ubicación física disponible para solicitar su baja.");
    if (["RETIRED", "LOST", "IN_TRANSIT", "IN_CUSTODY", "RESERVED"].includes(unit.status)) {
      throw new Error(`El activo no puede darse de baja mientras está ${unit.status}.`);
    }
    const open = await client.query(`SELECT disposal_number FROM logistics_asset_disposals
      WHERE asset_unit_id=$1 AND status IN ('SUBMITTED','APPROVED')`, [unit.id]);
    if (open.rows[0]) throw new Error(`El activo ya tiene la solicitud ${open.rows[0].disposal_number}.`);
    const sequence = await client.query(`SELECT COALESCE(MAX(NULLIF(
      regexp_replace(disposal_number,'\\D','','g'),'')::bigint),0)+1 AS next
      FROM logistics_asset_disposals WHERE organization_id=$1`, [organizationId]);
    const disposalNumber = `BAJ-${String(sequence.rows[0].next).padStart(7, "0")}`;
    const disposal = (await client.query(`INSERT INTO logistics_asset_disposals
      (organization_id,disposal_number,asset_unit_id,item_id,warehouse_id,location_id,status,
       reason_code,requested_by,effective_date,proceeds_amount,currency,notes,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,'SUBMITTED',$7,$8,COALESCE($9::date,CURRENT_DATE),
        $10,$11,$12,$13::jsonb) RETURNING *`,
    [organizationId, disposalNumber, unit.id, unit.item_id, unit.warehouse_id, unit.location_id,
      reasonCode, actorProfileId, text(input.effectiveDate) || null,
      Math.max(0, number(input.proceedsAmount)), text(input.currency || unit.currency || "CLP").toUpperCase(),
      text(input.notes), json({ standardCost: number(unit.standard_cost), unitStatus: unit.status })])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,after_data,metadata)
      VALUES ($1,'ASSET_DISPOSAL_SUBMITTED','asset_disposal',$2,$3,$4,'MANUAL',$5::jsonb,$6::jsonb)`,
    [organizationId, disposal.id, actorProfileId, disposalNumber, json(disposal),
      json({ unitCode: unit.unit_code, reasonCode })]);
    await client.query("COMMIT");
    return { disposal };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateAssetDisposal(pool, disposalId, action, input, actorProfileId = null) {
  const normalizedAction = text(action).toUpperCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query("SELECT * FROM logistics_asset_disposals WHERE id=$1 FOR UPDATE",
      [disposalId])).rows[0];
    if (!current) throw new Error("Solicitud de baja no encontrada.");
    if (normalizedAction === "APPROVE") {
      if (current.status !== "SUBMITTED") throw new Error("La solicitud no está pendiente de aprobación.");
      if (current.requested_by === actorProfileId && !input.allowSelfApproval) {
        throw new Error("Quien solicita la baja no puede aprobarla.");
      }
      const updated = (await client.query(`UPDATE logistics_asset_disposals SET status='APPROVED',
        approved_by=$1,approved_at=NOW(),approval_notes=$2,updated_at=NOW() WHERE id=$3 RETURNING *`,
      [actorProfileId, text(input.notes) || null, current.id])).rows[0];
      await client.query(`INSERT INTO logistics_audit_events
        (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,before_data,after_data)
        VALUES ($1,'ASSET_DISPOSAL_APPROVED','asset_disposal',$2,$3,$4,'MANUAL',$5::jsonb,$6::jsonb)`,
      [current.organization_id, current.id, actorProfileId, `${current.disposal_number}:APPROVE`,
        json(current), json(updated)]);
      await client.query("COMMIT");
      return { disposal: updated };
    }
    if (normalizedAction === "REJECT") {
      if (current.status !== "SUBMITTED") throw new Error("Sólo se puede rechazar una solicitud pendiente.");
      if (text(input.notes).length < 5) throw new Error("Indica el motivo del rechazo.");
      const updated = (await client.query(`UPDATE logistics_asset_disposals SET status='REJECTED',
        rejected_by=$1,rejected_at=NOW(),approval_notes=$2,updated_at=NOW() WHERE id=$3 RETURNING *`,
      [actorProfileId, text(input.notes), current.id])).rows[0];
      await client.query("COMMIT");
      return { disposal: updated };
    }
    if (normalizedAction === "CANCEL") {
      if (current.status !== "SUBMITTED") throw new Error("Sólo se puede cancelar una solicitud pendiente.");
      if (current.requested_by !== actorProfileId && !input.admin) throw new Error("Sólo quien solicitó o el administrador puede cancelar.");
      const updated = (await client.query(`UPDATE logistics_asset_disposals SET status='CANCELLED',
        approval_notes=$1,updated_at=NOW() WHERE id=$2 RETURNING *`,
      [text(input.notes) || null, current.id])).rows[0];
      await client.query("COMMIT");
      return { disposal: updated };
    }
    if (normalizedAction !== "POST") throw new Error("Acción de baja no permitida.");
    if (current.status === "POSTED") {
      await client.query("COMMIT");
      return { disposal: current, replayed: true };
    }
    if (current.status !== "APPROVED") throw new Error("La baja debe estar aprobada antes de contabilizar.");
    const unit = (await client.query("SELECT * FROM logistics_asset_units WHERE id=$1 FOR UPDATE",
      [current.asset_unit_id])).rows[0];
    if (!unit || ["RETIRED", "LOST"].includes(unit.status)) throw new Error("El activo ya fue retirado.");
    const posted = await postMovementWithClient(client, {
      organizationId: current.organization_id, itemId: current.item_id, assetUnitId: current.asset_unit_id,
      quantity: 1, fromLocationId: current.location_id, movementType: "ISSUE",
      referenceType: "asset_disposal", referenceId: current.id,
      idempotencyKey: `asset-disposal:${current.id}`, source: "MANUAL",
      notes: `${current.disposal_number} · ${current.reason_code} · ${current.notes}`,
      occurredAt: current.effective_date
    }, actorProfileId);
    const finalStatus = ["LOST", "STOLEN"].includes(current.reason_code) ? "LOST" : "RETIRED";
    await client.query(`UPDATE logistics_asset_units SET status=$1,retired_at=$2,updated_at=NOW()
      WHERE id=$3`, [finalStatus, current.effective_date, current.asset_unit_id]);
    const updated = (await client.query(`UPDATE logistics_asset_disposals SET status='POSTED',
      posted_by=$1,posted_at=NOW(),movement_id=$2,updated_at=NOW() WHERE id=$3 RETURNING *`,
    [actorProfileId, posted.movement.id, current.id])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,source,
       before_data,after_data,metadata)
      VALUES ($1,'ASSET_DISPOSAL_POSTED','asset_disposal',$2,$3,$4,'MANUAL',
        $5::jsonb,$6::jsonb,$7::jsonb)`,
    [current.organization_id, current.id, actorProfileId, `asset-disposal:${current.id}`,
      json(current), json(updated), json({ movementId: posted.movement.id, finalStatus })]);
    await client.query("COMMIT");
    return { disposal: updated, movement: posted.movement, replayed: posted.replayed };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listAssetCompliance(pool, profile, organizationId) {
  const params = [organizationId];
  const centerFilter = profile?.admin ? "" : `AND center.name=$2`;
  if (!profile?.admin) params.push(profile?.cost_center || "");
  const result = await pool.query(`SELECT compliance.*,unit.unit_code,unit.status AS asset_status,
      item.name AS item_name,item.sku,warehouse.name AS warehouse_name,center.name AS cost_center,
      document.title AS document_title,document.file_object_id,
      CASE
        WHEN compliance.status<>'ACTIVE' THEN compliance.status
        WHEN compliance.expires_at<CURRENT_DATE THEN 'EXPIRED'
        WHEN compliance.expires_at<=CURRENT_DATE+compliance.reminder_days THEN 'EXPIRING'
        ELSE 'ACTIVE'
      END AS effective_status,
      CASE WHEN compliance.expires_at IS NULL THEN NULL
        ELSE compliance.expires_at-CURRENT_DATE END AS days_remaining
    FROM logistics_asset_compliance_records compliance
    JOIN logistics_asset_units unit ON unit.id=compliance.asset_unit_id
    JOIN logistics_items item ON item.id=unit.item_id
    LEFT JOIN LATERAL (
      SELECT balance.location_id FROM logistics_stock_balances balance
      WHERE balance.asset_unit_id=unit.id AND balance.quantity>0
      ORDER BY balance.updated_at DESC LIMIT 1
    ) current_stock ON TRUE
    LEFT JOIN logistics_locations location ON location.id=current_stock.location_id
    LEFT JOIN logistics_warehouses warehouse ON warehouse.id=location.warehouse_id
    LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
    LEFT JOIN logistics_documents document ON document.id=compliance.canonical_document_id
    WHERE compliance.organization_id=$1 ${centerFilter}
    ORDER BY
      CASE WHEN compliance.status='ACTIVE' AND compliance.expires_at<CURRENT_DATE THEN 0
           WHEN compliance.status='ACTIVE' AND compliance.expires_at<=CURRENT_DATE+compliance.reminder_days THEN 1
           ELSE 2 END,
      compliance.expires_at NULLS LAST,compliance.created_at DESC`, params);
  const rows = result.rows;
  return {
    rows,
    summary: {
      expired: rows.filter(row => row.effective_status === "EXPIRED").length,
      expiring: rows.filter(row => row.effective_status === "EXPIRING").length,
      active: rows.filter(row => row.effective_status === "ACTIVE").length,
      critical: rows.filter(row => row.critical &&
        ["EXPIRED", "EXPIRING"].includes(row.effective_status)).length
    }
  };
}

export async function createAssetCompliance(pool, input, actorProfileId = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const unit = (await client.query(`SELECT unit.*,item.organization_id,item.name AS item_name,
        warehouse.id AS warehouse_id,center.name AS cost_center
      FROM logistics_asset_units unit
      JOIN logistics_items item ON item.id=unit.item_id
      LEFT JOIN LATERAL (
        SELECT balance.location_id FROM logistics_stock_balances balance
        WHERE balance.asset_unit_id=unit.id AND balance.quantity>0
        ORDER BY balance.updated_at DESC LIMIT 1
      ) current_stock ON TRUE
      LEFT JOIN logistics_locations location ON location.id=current_stock.location_id
      LEFT JOIN logistics_warehouses warehouse ON warehouse.id=location.warehouse_id
      LEFT JOIN logistics_cost_centers center ON center.id=warehouse.cost_center_id
      WHERE unit.id=$1 FOR UPDATE`, [input.assetUnitId])).rows[0];
    if (!unit) throw new Error("Activo serializado no encontrado.");
    const allowedTypes = new Set(["CERTIFICATION", "CALIBRATION", "WARRANTY", "INSURANCE",
      "PERMIT", "INSPECTION_CERTIFICATE", "OTHER"]);
    const complianceType = text(input.complianceType).toUpperCase();
    if (!allowedTypes.has(complianceType)) throw new Error("Tipo de cumplimiento no válido.");
    if (text(input.requirementName).length < 3) throw new Error("Indica el requisito o certificado.");
    const reminderDays = Number(input.reminderDays ?? 30);
    if (!Number.isInteger(reminderDays) || reminderDays < 0 || reminderDays > 365) {
      throw new Error("La anticipación debe estar entre 0 y 365 días.");
    }
    if (input.issuedAt && input.expiresAt && new Date(input.expiresAt) < new Date(input.issuedAt)) {
      throw new Error("El vencimiento no puede ser anterior a la emisión.");
    }
    let supersedes = null;
    if (input.supersedesId) {
      supersedes = (await client.query(`SELECT * FROM logistics_asset_compliance_records
        WHERE id=$1 AND asset_unit_id=$2 FOR UPDATE`, [input.supersedesId, unit.id])).rows[0];
      if (!supersedes) throw new Error("El antecedente que deseas renovar no existe.");
      if (supersedes.status !== "ACTIVE") throw new Error("Este antecedente ya fue renovado o cerrado.");
    }
    const compliance = (await client.query(`INSERT INTO logistics_asset_compliance_records
      (organization_id,asset_unit_id,compliance_type,requirement_name,issuer,document_number,
       issued_at,expires_at,reminder_days,critical,supersedes_id,notes,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
    [unit.organization_id, unit.id, complianceType, text(input.requirementName),
      text(input.issuer) || null, text(input.documentNumber) || null,
      input.issuedAt || null, input.expiresAt || null, reminderDays,
      input.critical !== false, supersedes?.id || null, text(input.notes) || null,
      actorProfileId])).rows[0];
    if (supersedes) {
      await client.query(`UPDATE logistics_asset_compliance_records
        SET status='RENEWED',updated_by=$1,updated_at=NOW() WHERE id=$2`,
      [actorProfileId, supersedes.id]);
    }
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,
       source,before_data,after_data,metadata)
      VALUES ($1,$2,'asset_compliance',$3,$4,$5,'MANUAL',$6::jsonb,$7::jsonb,$8::jsonb)`,
    [unit.organization_id, supersedes ? "ASSET_COMPLIANCE_RENEWED" : "ASSET_COMPLIANCE_CREATED",
      compliance.id, actorProfileId, `asset-compliance:${compliance.id}`,
      json(supersedes), json(compliance), json({ unitCode: unit.unit_code, itemName: unit.item_name })]);
    await client.query("COMMIT");
    return { compliance: { ...compliance, unit_code: unit.unit_code, item_name: unit.item_name,
      warehouse_id: unit.warehouse_id, cost_center: unit.cost_center } };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateAssetCompliance(pool, complianceId, action, input, actorProfileId = null) {
  const normalizedAction = text(action).toUpperCase();
  if (!["REVOKE", "CANCEL"].includes(normalizedAction)) throw new Error("Acción no permitida.");
  const status = normalizedAction === "REVOKE" ? "REVOKED" : "CANCELLED";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = (await client.query(`SELECT * FROM logistics_asset_compliance_records
      WHERE id=$1 FOR UPDATE`, [complianceId])).rows[0];
    if (!before) throw new Error("Antecedente técnico no encontrado.");
    if (before.status !== "ACTIVE") throw new Error("El antecedente ya no está activo.");
    if (text(input.notes).length < 5) throw new Error("Indica el motivo del cambio.");
    const updated = (await client.query(`UPDATE logistics_asset_compliance_records
      SET status=$1,notes=CONCAT_WS(E'\\n',notes,$2),updated_by=$3,updated_at=NOW()
      WHERE id=$4 RETURNING *`, [status, text(input.notes), actorProfileId, complianceId])).rows[0];
    await client.query(`INSERT INTO logistics_audit_events
      (organization_id,event_type,entity_type,entity_id,actor_profile_id,correlation_id,
       source,before_data,after_data)
      VALUES ($1,$2,'asset_compliance',$3,$4,$5,'MANUAL',$6::jsonb,$7::jsonb)`,
    [before.organization_id, `ASSET_COMPLIANCE_${status}`, before.id, actorProfileId,
      `asset-compliance:${before.id}:${status}`, json(before), json(updated)]);
    await client.query("COMMIT");
    return { compliance: updated };
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
    (SELECT COUNT(*) FROM logistics_maintenance_plans WHERE active=TRUE) AS maintenance_plans,
    (SELECT COUNT(*) FROM logistics_maintenance_plans
      WHERE active=TRUE AND next_due_at<=NOW()) AS overdue_maintenance_plans,
    (SELECT COUNT(*) FROM logistics_work_orders) AS work_orders,
    (SELECT COUNT(*) FROM logistics_work_orders
      WHERE status NOT IN ('COMPLETED','CANCELLED')) AS open_work_orders,
    (SELECT COUNT(*) FROM logistics_item_cost_history) AS cost_updates,
    (SELECT COUNT(*) FROM logistics_inventory_periods WHERE status='CLOSED') AS closed_inventory_periods,
    (SELECT COUNT(*) FROM logistics_inventory_adjustments
      WHERE status IN ('SUBMITTED','APPROVED')) AS pending_inventory_adjustments,
    (SELECT COUNT(*) FROM logistics_purchase_orders
      WHERE status NOT IN ('CLOSED','CANCELLED')) AS open_purchase_orders,
    (SELECT COUNT(*) FROM logistics_supplier_invoices
      WHERE status='EXCEPTION') AS supplier_invoice_exceptions,
    (SELECT COUNT(*) FROM logistics_supplier_returns
      WHERE status NOT IN ('CLOSED','CANCELLED')) AS open_supplier_returns,
    (SELECT COUNT(*) FROM logistics_asset_disposals
      WHERE status IN ('SUBMITTED','APPROVED')) AS pending_asset_disposals,
    (SELECT COUNT(*) FROM logistics_asset_financials WHERE active=TRUE) AS valued_asset_units,
    (SELECT MAX(as_of_date) FROM logistics_asset_depreciation_snapshots) AS last_depreciation_date,
    (SELECT COUNT(*) FROM logistics_asset_compliance_records
      WHERE status='ACTIVE' AND expires_at<CURRENT_DATE) AS expired_asset_compliance,
    (SELECT COUNT(*) FROM logistics_asset_compliance_records
      WHERE status='ACTIVE' AND expires_at>=CURRENT_DATE
        AND expires_at<=CURRENT_DATE+reminder_days) AS expiring_asset_compliance,
    (SELECT COALESCE(SUM(balance.quantity * item.standard_cost),0)
      FROM logistics_stock_balances balance
      JOIN logistics_items item ON item.id=balance.item_id
      JOIN logistics_locations location ON location.id=balance.location_id
      WHERE location.location_type='STORAGE') AS inventory_value,
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
