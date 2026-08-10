CREATE OR REPLACE FUNCTION inventory_file_object_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(current_setting('icc.allow_file_disposal', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Los archivos son inmutables; use el proceso autorizado de disposición documental.';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.filename IS DISTINCT FROM OLD.filename
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.data_base64 IS DISTINCT FROM OLD.data_base64
     OR (NEW.payload ->> 'sha256') IS DISTINCT FROM (OLD.payload ->> 'sha256') THEN
    RAISE EXCEPTION 'El contenido y la identidad del archivo son inmutables.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_file_object_immutable_trigger ON inventory_file_objects;
CREATE TRIGGER inventory_file_object_immutable_trigger
BEFORE UPDATE OR DELETE ON inventory_file_objects
FOR EACH ROW EXECUTE FUNCTION inventory_file_object_immutable();
