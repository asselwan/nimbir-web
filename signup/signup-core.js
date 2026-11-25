// Clinic sign-up core: validation, honeypot and rate limiting for the public
// /api/clinic-signup route. Pure logic, no IO, so it is unit-testable.
// The founder-facing lead pattern mirrors nomoi-web's contact route
// (honeypot `company_url`, Resend first, durable row as the fallback).

export const volumeBands = new Set(['lt500', '500-2000', '2000-10000', 'gt10000']);
export const billingSetups = new Set(['in_house', 'bpo', 'mixed']);

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// E.164-ish international phone, tolerant of spaces/dashes/parens.
const phoneRe = /^\+?[0-9][0-9 ()-]{5,19}$/;
// Free-text fields: single line, no control chars.
const clean = (v) => typeof v === 'string' && !/[\r\n\x00-\x1f]/.test(v) ? v.trim() : null;

export function validateClinicSignup(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, errors: { _: 'JSON object required' } };
  }
  // Honeypot: any value in the hidden company_url field means a bot filled
  // every visible box. The route treats this as success without storing.
  if ('company_url' in payload && payload.company_url) return { honeypot: true, ok: true };
  const errors = {};
  const out = {};
  const clinicName = clean(payload.clinic_name);
  if (!clinicName || clinicName.length < 2 || clinicName.length > 120) errors.clinic_name = 'Clinic name required (2-120 characters)';
  const email = clean(payload.work_email);
  if (!email || email.length > 320 || !emailRe.test(email)) errors.work_email = 'A valid work email is required';
  const phone = clean(payload.phone);
  if (!phone || !phoneRe.test(phone)) errors.phone = 'A valid phone number is required';
  const place = clean(payload.emirate_country);
  if (!place || place.length < 2 || place.length > 80) errors.emirate_country = 'Emirate or country required';
  if (!volumeBands.has(payload.monthly_volume_band)) errors.monthly_volume_band = 'Choose a monthly claim volume band';
  // Optional second step.
  if (payload.specialty !== undefined && payload.specialty !== null && payload.specialty !== '') {
    const specialty = clean(payload.specialty);
    if (!specialty || specialty.length > 120) errors.specialty = 'Specialty too long';
    else out.specialty = specialty;
  }
  if (payload.current_billing_setup !== undefined && payload.current_billing_setup !== null && payload.current_billing_setup !== '') {
    if (!billingSetups.has(payload.current_billing_setup)) errors.current_billing_setup = 'Unknown billing setup';
    else out.current_billing_setup = payload.current_billing_setup;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  out.clinic_name = clinicName;
  out.work_email = email.toLowerCase();
  out.phone = phone;
  out.emirate_country = place;
  out.monthly_volume_band = payload.monthly_volume_band;
  return { ok: true, signup: out };
}

// Per-client rate limiter, same windowed-counter shape the workspace sign-in
// throttle uses. Caps tracked keys so the map itself cannot be grown without
// limit by address spoofing.
export function createRateLimiter({ windowMs = 60 * 60 * 1000, max = 5, maxTracked = 5000 } = {}) {
  const hits = new Map();
  return {
    allow(key, at) {
      for (const [other, record] of hits) if (at - record.first >= windowMs) hits.delete(other);
      while (hits.size >= maxTracked) {
        let oldest = null; let oldestAt = Infinity;
        for (const [other, record] of hits) if (record.first < oldestAt) { oldestAt = record.first; oldest = other; }
        if (oldest === null) break;
        hits.delete(oldest);
      }
      const record = hits.get(key);
      if (record && at - record.first < windowMs) {
        if (record.count >= max) return false;
        record.count += 1;
        return true;
      }
      hits.set(key, { count: 1, first: at });
      return true;
    },
  };
}

export function signupEmailBody(signup) {
  const band = { lt500: 'under 500', '500-2000': '500-2,000', '2000-10000': '2,000-10,000', gt10000: 'over 10,000' }[signup.monthly_volume_band] || signup.monthly_volume_band;
  const setup = { in_house: 'in-house', bpo: 'BPO (outsourced)', mixed: 'mixed' }[signup.current_billing_setup] || 'not stated';
  return [
    `Clinic: ${signup.clinic_name}`,
    `Email: ${signup.work_email}`,
    `Phone: on file in the nimbir.clinic_signup row`,
    `Emirate/country: ${signup.emirate_country}`,
    `Monthly claims: ${band}`,
    `Specialty: ${signup.specialty || 'not stated'}`,
    `Current billing: ${setup}`,
  ].join('\n');
}
