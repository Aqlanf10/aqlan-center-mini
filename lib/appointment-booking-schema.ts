import type { MigrationFile } from './migration-files';
export const APPOINTMENT_BOOKING_MIGRATION: MigrationFile = {
  version:'0096', name:'appointment_booking_commands', filename:'0096_appointment_booking_commands.sql',
  checksum:'7f6a635217952fffddd4682d853eb70ddb908b03a98c84fe803dd898feee4e4c',
  sql:`-- Clinical category is explicit booking metadata, never a treatment-status inference.
ALTER TABLE appointments ADD COLUMN clinical_category TEXT
  CHECK (clinical_category IN ('orthodontics','new_orthodontic_patient','endodontics',
    'filling','prosthetics','awaiting_prosthetics','other'));
ALTER TABLE appointments ADD COLUMN staff_confirmed_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN staff_confirmed_by TEXT;
ALTER TABLE appointments ADD CONSTRAINT appointments_staff_confirmation_shape CHECK
  ((staff_confirmed_at IS NULL) = (staff_confirmed_by IS NULL));

-- Generic quick booking commands reuse the 0095 UUID fence and recovery endpoint.
-- They do not invent a treatment intent or an association with a plan.
CREATE TABLE appointment_booking_commands (
  command_id UUID PRIMARY KEY,
  appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE RESTRICT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recorded_by TEXT NOT NULL,
  command_hash TEXT NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (appointment_id,patient_id) REFERENCES appointments(id,patient_id) ON DELETE RESTRICT
);
CREATE TRIGGER appointment_booking_commands_immutable
  BEFORE UPDATE OR DELETE ON appointment_booking_commands
  FOR EACH ROW EXECUTE FUNCTION aqlan_appointment_purpose_immutable();
CREATE TRIGGER appointment_booking_commands_no_nonempty_truncate
  BEFORE TRUNCATE ON appointment_booking_commands
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_appointment_purpose_immutable();
`,
};
