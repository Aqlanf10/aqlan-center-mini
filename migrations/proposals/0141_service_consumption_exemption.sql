-- Proposal 0141: Per-service exemption from specialty material-consumption deduction in doctor commissions (Charter §18)
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS material_consumption_exempt BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN services.material_consumption_exempt IS
  'When TRUE, this service (e.g. clinical consultation/examination) is exempt from specialty percentage material-consumption deduction in doctor commission calculation.';
