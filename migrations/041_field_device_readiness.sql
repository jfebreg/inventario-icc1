-- Perfiles de dispositivos y comprobaciones operativas en terreno.
CREATE TABLE IF NOT EXISTS logistics_device_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  profile_type TEXT NOT NULL
    CHECK (profile_type IN ('MOBILE','USB_SCANNER','LABEL_PRINTER','WORKSTATION')),
  device_name TEXT NOT NULL,
  device_key TEXT NOT NULL,
  warehouse_id UUID REFERENCES logistics_warehouses(id),
  manufacturer TEXT,
  model TEXT,
  connection_type TEXT,
  label_width_mm NUMERIC(8,2),
  label_height_mm NUMERIC(8,2),
  dpi INTEGER,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_status TEXT CHECK (last_status IN ('PASS','WARN','FAIL')),
  last_verified_at TIMESTAMPTZ,
  created_by TEXT REFERENCES inventory_user_profiles(id),
  updated_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,device_key)
);

CREATE TABLE IF NOT EXISTS logistics_device_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  device_profile_id UUID NOT NULL REFERENCES logistics_device_profiles(id),
  check_type TEXT NOT NULL
    CHECK (check_type IN ('CAMERA_QR','KEYBOARD_SCANNER','PRINT_LABEL',
      'NETWORK','SECURE_CONTEXT','LOCAL_STORAGE')),
  status TEXT NOT NULL CHECK (status IN ('PASS','WARN','FAIL')),
  idempotency_key TEXT NOT NULL,
  measurements JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  performed_by TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,idempotency_key)
);

CREATE INDEX IF NOT EXISTS logistics_device_profiles_org_idx
  ON logistics_device_profiles (organization_id,profile_type,active);
CREATE INDEX IF NOT EXISTS logistics_device_checks_profile_idx
  ON logistics_device_checks (device_profile_id,performed_at DESC);

ALTER TABLE logistics_device_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_device_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_device_profiles,logistics_device_checks FROM anon,authenticated;
