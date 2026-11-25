-- Clinic sign-up records (prm_28626d25 v247). This is the public clinic
-- intake: 5 first-step fields plus an optional specialty/billing-setup step.
-- No patient data columns by design; the phone is a clinic contact number.
CREATE TABLE IF NOT EXISTS nimbir.clinic_signup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_name text NOT NULL CHECK (length(clinic_name) BETWEEN 2 AND 120),
  work_email text NOT NULL CHECK (work_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text NOT NULL CHECK (phone ~ '^\+?[0-9][0-9 ()-]{5,19}$'),
  emirate_country text NOT NULL CHECK (length(emirate_country) BETWEEN 2 AND 80),
  monthly_volume_band text NOT NULL CHECK (monthly_volume_band IN ('lt500', '500-2000', '2000-10000', 'gt10000')),
  specialty text CHECK (specialty IS NULL OR length(specialty) <= 120),
  current_billing_setup text CHECK (current_billing_setup IS NULL OR current_billing_setup IN ('in_house', 'bpo', 'mixed')),
  notified boolean NOT NULL DEFAULT false,
  delivery_error text,
  source text NOT NULL DEFAULT 'nimbir_web_signup',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clinic_signup_created_idx ON nimbir.clinic_signup (created_at DESC);
