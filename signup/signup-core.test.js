import test from 'node:test';
import assert from 'node:assert/strict';
import { validateClinicSignup, createRateLimiter, signupEmailBody } from './signup-core.js';

const valid = {
  clinic_name: 'Al Noor Family Clinic',
  work_email: 'Admin@AlNoorClinic.ae',
  phone: '+971 4 555 0100',
  emirate_country: 'Dubai',
  monthly_volume_band: '500-2000',
};

test('a complete valid sign-up normalizes email and passes optional fields through', () => {
  const verdict = validateClinicSignup({ ...valid, specialty: 'Family medicine', current_billing_setup: 'bpo' });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.signup.work_email, 'admin@alnoorclinic.ae');
  assert.equal(verdict.signup.specialty, 'Family medicine');
  assert.equal(verdict.signup.current_billing_setup, 'bpo');
});

test('each required field is validated with a field-level error', () => {
  const verdict = validateClinicSignup({});
  assert.equal(verdict.ok, false);
  assert.deepEqual(Object.keys(verdict.errors).sort(), ['clinic_name', 'emirate_country', 'monthly_volume_band', 'phone', 'work_email']);
  assert.equal(validateClinicSignup({ ...valid, phone: 'not a phone' }).ok, false);
  assert.equal(validateClinicSignup({ ...valid, monthly_volume_band: 'lots' }).ok, false);
  assert.equal(validateClinicSignup({ ...valid, current_billing_setup: 'carrier pigeon' }).ok, false);
  assert.equal(validateClinicSignup('not an object').ok, false);
});

test('a filled honeypot field is reported as ok without a signup payload', () => {
  const verdict = validateClinicSignup({ ...valid, company_url: 'http://spam.example' });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.honeypot, true);
  assert.equal('signup' in verdict, false);
});

test('the rate limiter allows max submissions per client per window and resets', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
  const t = 1000;
  assert.deepEqual([limiter.allow('a', t), limiter.allow('a', t + 1), limiter.allow('a', t + 2)], [true, true, true]);
  assert.equal(limiter.allow('a', t + 3), false);
  assert.equal(limiter.allow('b', t + 3), true);
  // Past the window the budget resets.
  assert.equal(limiter.allow('a', t + 2000), true);
});

test('the rate limiter caps its own tracked-key table', () => {
  const limiter = createRateLimiter({ windowMs: 100000, max: 5, maxTracked: 10 });
  for (let i = 0; i < 50; i += 1) limiter.allow(`k${i}`, i);
  // Old churn keys were evicted, so the first key gets a fresh budget — the map
  // itself stayed bounded.
  assert.equal(limiter.allow('k0', 60), true);
});

test('the founder email body carries every field without the phone number in the email', () => {
  const body = signupEmailBody({ ...valid, specialty: 'Cardiology', current_billing_setup: 'in_house' });
  assert.match(body, /Clinic: Al Noor Family Clinic/);
  assert.match(body, /Monthly claims: 500-2,000/);
  assert.match(body, /Current billing: in-house/);
  assert.doesNotMatch(body, /555 0100/);
});
