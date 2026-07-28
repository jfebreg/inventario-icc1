-- Resultado canónico de conteos para exactitud, tendencias y causas.
CREATE OR REPLACE VIEW logistics_cycle_count_results_v AS
SELECT
  cycle.organization_id,
  cycle.id AS count_id,
  cycle.count_number,
  cycle.warehouse_id,
  cycle.posted_at,
  line.id AS line_id,
  line.item_id,
  line.lot_id,
  line.location_id,
  line.expected_quantity,
  line.counted_quantity AS initial_counted_quantity,
  line.recount_quantity,
  COALESCE(line.recount_quantity,line.counted_quantity) AS final_counted_quantity,
  COALESCE(line.recount_quantity,line.counted_quantity)-line.expected_quantity
    AS variance_quantity,
  ABS(COALESCE(line.recount_quantity,line.counted_quantity)-line.expected_quantity)
    AS absolute_variance_quantity,
  line.tolerance_percent,
  CASE
    WHEN ABS(line.expected_quantity)<0.00001
      THEN ABS(COALESCE(line.recount_quantity,line.counted_quantity)
        -line.expected_quantity)<0.00001
    ELSE ABS(COALESCE(line.recount_quantity,line.counted_quantity)
      -line.expected_quantity)
      <=ABS(line.expected_quantity)*line.tolerance_percent/100
  END AS within_tolerance,
  line.recount_required,
  line.variance_reason_code,
  line.variance_notes,
  item.sku,
  item.name AS item_name,
  item.standard_cost,
  item.currency,
  ABS(COALESCE(line.recount_quantity,line.counted_quantity)-line.expected_quantity)
    *item.standard_cost AS absolute_variance_value
FROM logistics_cycle_count_lines line
JOIN logistics_cycle_counts cycle ON cycle.id=line.count_id
JOIN logistics_items item ON item.id=line.item_id
WHERE cycle.status='POSTED';

REVOKE ALL ON logistics_cycle_count_results_v FROM anon, authenticated;
