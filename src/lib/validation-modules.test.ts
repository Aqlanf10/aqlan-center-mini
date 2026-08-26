import { describe, expect, it } from "vitest";

import {
  appointmentFormSchema,
  chargeFormSchema,
  patientFormSchema,
  paymentFormSchema,
  staffCreateSchema,
  visitFormSchema,
  validateWith,
} from "@/lib/validation";

const validPatient = {
  fullName: "أحمد محمد",
  gender: "MALE",
  dateOfBirth: "1995-04-12",
  mobile: "712345678",
  alternateMobile: "",
  address: "صنعاء",
  treatingDoctorId: "6f9d2b2e-1f4b-4c1e-8f0a-2b7d9c3e4a5b",
  treatmentType: "تقويم",
  treatmentStatus: "NEW",
  recallIntervalDays: "21",
  notes: "",
};

describe("patient validation", () => {
  it("accepts a complete valid patient", () => {
    const result = validateWith(patientFormSchema, validPatient);
    expect(result.ok).toBe(true);
  });

  it("accepts minimal input (only required fields)", () => {
    const result = validateWith(patientFormSchema, {
      ...validPatient,
      dateOfBirth: "",
      address: "",
      treatingDoctorId: "",
      treatmentType: "",
      notes: "",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a too-short name", () => {
    const result = validateWith(patientFormSchema, {
      ...validPatient,
      fullName: "أ",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.errors.fullName : undefined).toBe(
      "fullNameRequired"
    );
  });

  it("rejects invalid mobile formats", () => {
    for (const mobile of ["", "12345", "abc-defg", "call me"]) {
      const result = validateWith(patientFormSchema, {
        ...validPatient,
        mobile,
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.errors.mobile : undefined).toBe(
        "mobileInvalid"
      );
    }
  });

  it("rejects a date of birth in the future", () => {
    const result = validateWith(patientFormSchema, {
      ...validPatient,
      dateOfBirth: "2999-01-01",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.errors.dateOfBirth : undefined).toBe(
      "dateInFuture"
    );
  });

  it("bounds the recall interval to 1..365 days", () => {
    expect(
      validateWith(patientFormSchema, {
        ...validPatient,
        recallIntervalDays: "0",
      }).ok
    ).toBe(false);
    expect(
      validateWith(patientFormSchema, {
        ...validPatient,
        recallIntervalDays: "366",
      }).ok
    ).toBe(false);
    expect(
      validateWith(patientFormSchema, {
        ...validPatient,
        recallIntervalDays: "7",
      }).ok
    ).toBe(true);
    expect(
      validateWith(patientFormSchema, {
        ...validPatient,
        recallIntervalDays: "30",
      }).ok
    ).toBe(true);
  });

  it("rejects non-integer recall values", () => {
    expect(
      validateWith(patientFormSchema, {
        ...validPatient,
        recallIntervalDays: "2.5",
      }).ok
    ).toBe(false);
  });

  it("rejects an unknown treatment status", () => {
    expect(
      validateWith(patientFormSchema, {
        ...validPatient,
        treatmentStatus: "ON_HOLD",
      }).ok
    ).toBe(false);
  });
});

const validAppointment = {
  patientId: "6f9d2b2e-1f4b-4c1e-8f0a-2b7d9c3e4a5b",
  doctorId: "8a1c3d4e-5f60-4a1b-9c2d-3e4f5a6b7c8d",
  appointmentDate: "2026-08-27T09:30",
  reason: "متابعة تقويم",
  notes: "",
};

describe("appointment validation", () => {
  it("accepts a valid appointment", () => {
    expect(validateWith(appointmentFormSchema, validAppointment).ok).toBe(true);
  });

  it("requires a real datetime-local value", () => {
    for (const appointmentDate of ["", "2026-08-27", "09:30", "tomorrow"]) {
      const result = validateWith(appointmentFormSchema, {
        ...validAppointment,
        appointmentDate,
      });
      expect(result.ok).toBe(false);
      expect(
        result.ok === false ? result.errors.appointmentDate : undefined
      ).toBe("datetimeInvalid");
    }
  });

  it("requires uuid patient and doctor ids", () => {
    expect(
      validateWith(appointmentFormSchema, {
        ...validAppointment,
        patientId: "not-a-uuid",
      }).ok
    ).toBe(false);
    expect(
      validateWith(appointmentFormSchema, {
        ...validAppointment,
        doctorId: "",
      }).ok
    ).toBe(false);
  });
});

const validVisit = {
  patientId: "6f9d2b2e-1f4b-4c1e-8f0a-2b7d9c3e4a5b",
  doctorId: "8a1c3d4e-5f60-4a1b-9c2d-3e4f5a6b7c8d",
  appointmentId: "",
  visitDate: "2026-08-27T10:00",
  chiefComplaint: "ألم",
  treatmentPerformed: "تغيير سلك",
  clinicalNotes: "",
  nextVisitPlan: "",
  nextAppointmentDate: "",
};

describe("visit validation", () => {
  it("accepts a valid visit", () => {
    expect(validateWith(visitFormSchema, validVisit).ok).toBe(true);
  });

  it("allows empty treatment performed (drafts) — completion enforces it", () => {
    const result = validateWith(visitFormSchema, {
      ...validVisit,
      treatmentPerformed: "",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts an optional next appointment datetime", () => {
    const result = validateWith(visitFormSchema, {
      ...validVisit,
      nextAppointmentDate: "2026-09-17T09:00",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a malformed next appointment datetime", () => {
    const result = validateWith(visitFormSchema, {
      ...validVisit,
      nextAppointmentDate: "next tuesday",
    });
    expect(result.ok).toBe(false);
    expect(
      result.ok === false ? result.errors.nextAppointmentDate : undefined
    ).toBe("datetimeInvalid");
  });
});

const validStaff = {
  name: "Dr. Aqlan",
  username: "aqlan",
  email: "",
  password: "strong-password-123",
  role: "DOCTOR",
};

describe("staff validation", () => {
  it("accepts a valid staff payload", () => {
    expect(validateWith(staffCreateSchema, validStaff).ok).toBe(true);
  });

  it("rejects usernames with spaces or arabic characters", () => {
    for (const username of ["has space", "عقلان", "user@name", "x"]) {
      expect(
        validateWith(staffCreateSchema, { ...validStaff, username }).ok
      ).toBe(false);
    }
  });

  it("enforces the 8-character password minimum", () => {
    expect(
      validateWith(staffCreateSchema, { ...validStaff, password: "short" }).ok
    ).toBe(false);
  });

  it("rejects unknown roles", () => {
    expect(
      validateWith(staffCreateSchema, { ...validStaff, role: "SUPERADMIN" }).ok
    ).toBe(false);
  });

  it("validates email shape when provided", () => {
    expect(
      validateWith(staffCreateSchema, {
        ...validStaff,
        email: "not-an-email",
      }).ok
    ).toBe(false);
  });
});

describe("finance validation", () => {
  const base = {
    patientId: "6f9d2b2e-1f4b-4c1e-8f0a-2b7d9c3e4a5b",
    amount: "15000.00",
    currency: "YER",
    description: "تقويم كامل",
  };

  it("accepts a valid charge", () => {
    expect(validateWith(chargeFormSchema, base).ok).toBe(true);
  });

  it("rejects negative, zero and malformed amounts", () => {
    for (const amount of ["0", "-5", "1.234", "12,000", "abc"]) {
      expect(validateWith(chargeFormSchema, { ...base, amount }).ok).toBe(
        false
      );
    }
  });

  it("requires a description for charges but not payments", () => {
    expect(
      validateWith(chargeFormSchema, { ...base, description: "" }).ok
    ).toBe(false);
    expect(
      validateWith(paymentFormSchema, {
        patientId: base.patientId,
        amount: "500.50",
        currency: "SAR",
        description: "",
      }).ok
    ).toBe(true);
  });

  it("rejects unknown currencies", () => {
    expect(
      validateWith(chargeFormSchema, { ...base, currency: "EUR" }).ok
    ).toBe(false);
  });
});
