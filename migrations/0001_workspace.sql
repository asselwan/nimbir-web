CREATE SCHEMA IF NOT EXISTS nimbir;

CREATE TABLE nimbir.hospital (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nimbir.hospital_member (
  hospital_id uuid NOT NULL REFERENCES nimbir.hospital(id),
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'agent')),
  PRIMARY KEY (hospital_id, user_id)
);

CREATE TABLE nimbir.work_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id uuid NOT NULL REFERENCES nimbir.hospital(id),
  kind text NOT NULL CHECK (kind IN ('denial', 'unpaid_claim', 'remittance_line')),
  source_ref text NOT NULL CHECK (source_ref ~ '^SYN-[A-Za-z0-9_-]{1,80}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 11 AND 200 AND title LIKE 'Synthetic %'),
  owner_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'blocked', 'done')),
  sla_due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hospital_id, kind, source_ref),
  UNIQUE (hospital_id, id),
  FOREIGN KEY (hospital_id, owner_id) REFERENCES nimbir.hospital_member(hospital_id, user_id)
);
CREATE INDEX work_item_queue_idx ON nimbir.work_item (hospital_id, status, sla_due_at);

CREATE TABLE nimbir.work_item_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hospital_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  before_state jsonb,
  after_state jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_item_audit_item_idx ON nimbir.work_item_audit (hospital_id, work_item_id, id);

CREATE FUNCTION nimbir.audit_work_item() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = nimbir, pg_temp AS $$
DECLARE actor uuid;
BEGIN
  actor := NULLIF(current_setting('nimbir.actor_id', true), '')::uuid;
  IF actor IS NULL THEN RAISE EXCEPTION 'nimbir.actor_id required'; END IF;
  IF TG_OP = 'UPDATE' AND NEW.hospital_id <> OLD.hospital_id THEN
    RAISE EXCEPTION 'hospital_id is immutable';
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  INSERT INTO nimbir.work_item_audit (hospital_id, work_item_id, actor_id, action, before_state, after_state)
  VALUES (COALESCE(NEW.hospital_id, OLD.hospital_id), COALESCE(NEW.id, OLD.id), actor,
    CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END);
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER work_item_audit_trigger BEFORE INSERT OR UPDATE OR DELETE ON nimbir.work_item
FOR EACH ROW EXECUTE FUNCTION nimbir.audit_work_item();

CREATE FUNCTION nimbir.reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit entries are append only'; END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON nimbir.work_item_audit
FOR EACH ROW EXECUTE FUNCTION nimbir.reject_audit_mutation();

-- The API connects as a dedicated login role granted this no-login role.
-- Do not use the migration owner or a Supabase service role as DATABASE_URL.
CREATE ROLE nimbir_workspace_app NOLOGIN;
REVOKE ALL ON SCHEMA nimbir FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA nimbir FROM PUBLIC;
REVOKE ALL ON FUNCTION nimbir.audit_work_item() FROM PUBLIC;
REVOKE ALL ON FUNCTION nimbir.reject_audit_mutation() FROM PUBLIC;
GRANT USAGE ON SCHEMA nimbir TO nimbir_workspace_app;
GRANT SELECT ON nimbir.hospital, nimbir.hospital_member TO nimbir_workspace_app;
GRANT SELECT, INSERT, UPDATE ON nimbir.work_item TO nimbir_workspace_app;
GRANT SELECT ON nimbir.work_item_audit TO nimbir_workspace_app;

ALTER TABLE nimbir.hospital ENABLE ROW LEVEL SECURITY;
ALTER TABLE nimbir.hospital_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE nimbir.work_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE nimbir.work_item_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY hospital_read ON nimbir.hospital FOR SELECT TO nimbir_workspace_app
  USING (EXISTS (SELECT 1 FROM nimbir.hospital_member m WHERE m.hospital_id = hospital.id AND m.user_id = NULLIF(current_setting('nimbir.actor_id', true), '')::uuid));
CREATE POLICY member_read ON nimbir.hospital_member FOR SELECT TO nimbir_workspace_app
  USING (user_id = NULLIF(current_setting('nimbir.actor_id', true), '')::uuid);
CREATE POLICY item_read ON nimbir.work_item FOR SELECT TO nimbir_workspace_app
  USING (EXISTS (SELECT 1 FROM nimbir.hospital_member m WHERE m.hospital_id = work_item.hospital_id AND m.user_id = NULLIF(current_setting('nimbir.actor_id', true), '')::uuid));
CREATE POLICY item_insert ON nimbir.work_item FOR INSERT TO nimbir_workspace_app
  WITH CHECK (EXISTS (SELECT 1 FROM nimbir.hospital_member m WHERE m.hospital_id = work_item.hospital_id AND m.user_id = NULLIF(current_setting('nimbir.actor_id', true), '')::uuid));
CREATE POLICY item_update ON nimbir.work_item FOR UPDATE TO nimbir_workspace_app
  USING (EXISTS (SELECT 1 FROM nimbir.hospital_member m WHERE m.hospital_id = work_item.hospital_id AND m.user_id = NULLIF(current_setting('nimbir.actor_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM nimbir.hospital_member m WHERE m.hospital_id = work_item.hospital_id AND m.user_id = NULLIF(current_setting('nimbir.actor_id', true), '')::uuid));
CREATE POLICY audit_read ON nimbir.work_item_audit FOR SELECT TO nimbir_workspace_app
  USING (EXISTS (SELECT 1 FROM nimbir.hospital_member m WHERE m.hospital_id = work_item_audit.hospital_id AND m.user_id = NULLIF(current_setting('nimbir.actor_id', true), '')::uuid));
