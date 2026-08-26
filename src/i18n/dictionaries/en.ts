import type { Dictionary } from "./ar";

/**
 * English dictionary. Typed as Dictionary so any missing or extra key
 * breaks `npm run typecheck`.
 */
export const en: Dictionary = {
  app: {
    name: "Aqlan Center Mini",
    centerName:
      "Dr. Aqlan Complete Center for Orthodontics, Implants and Cosmetic Dentistry",
    tagline: "Daily clinic operations system",
  },
  common: {
    loading: "Loading…",
    retry: "Retry",
    cancel: "Cancel",
    save: "Save",
    search: "Search",
    searchPlaceholder: "Search…",
    actions: "Actions",
    back: "Back",
    home: "Home",
    menu: "Menu",
    close: "Close",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    error: "Something went wrong",
    errorHint: "Please try again. If the problem persists, contact the administrator.",
    language: "Language",
    switchLanguage: "Switch language",
    notFoundTitle: "Page not found",
    notFoundHint: "The link you requested is not available.",
  },
  nav: {
    dashboard: "Dashboard",
    today: "Today",
    patients: "Patients",
    appointments: "Appointments",
    followUp: "Follow-up",
    mainNavigation: "Main navigation",
  },
  auth: {
    loginTitle: "Sign in",
    loginSubtitle: "Enter your account details to access the clinic system",
    username: "Username",
    usernamePlaceholder: "e.g. admin",
    password: "Password",
    passwordPlaceholder: "••••••••",
    showPassword: "Show password",
    hidePassword: "Hide password",
    submit: "Sign in",
    submitting: "Signing in…",
    usernameRequired: "Username is required",
    passwordRequired: "Password is required",
    passwordTooShort: "Password must be at least 8 characters",
    invalidCredentials: "Invalid username or password",
    loginFailed: "Could not sign in, please try again",
    signedInAs: "Signed in as",
    signOut: "Sign out",
    signingOut: "Signing out…",
    role: "Role",
  },
  roles: {
    ADMIN: "Administrator",
    DOCTOR: "Doctor",
    RECEPTION: "Reception",
  },
  dashboard: {
    title: "Dashboard",
    welcome: "Welcome, {name}",
    welcomeSubtitle: "This is your dashboard for the clinic's daily operations.",
    quickLinksTitle: "Quick access",
    foundationNoteTitle: "Foundation stage",
    foundationNote:
      "This is the system foundation release. Patient, appointment and visit management will be added in the next stage after this foundation is reviewed. No numbers or statistics will appear here until they are computed from the real database.",
    cards: {
      todayTitle: "Today",
      todayDescription: "Today's appointments and running operations",
      patientsTitle: "Patients",
      patientsDescription: "Patient files and records",
      appointmentsTitle: "Appointments",
      appointmentsDescription: "Appointment scheduling and management",
      followUpTitle: "Follow-up",
      followUpDescription: "Patients who need follow-up or contact",
    },
    open: "Open",
  },
  today: {
    title: "Today",
    subtitle: "An overview of today's appointments and operation status",
    emptyTitle: "No data yet",
    emptyHint:
      "Today's appointments, waiting lists and in-treatment statuses will appear here once the database is connected and the next stage is enabled.",
  },
  patients: {
    title: "Patients",
    subtitle: "Patient files and core information",
    emptyTitle: "No patients yet",
    emptyHint:
      "No patient files have been added yet. Adding and searching patient records will be enabled in the next stage of the system.",
  },
  appointments: {
    title: "Appointments",
    subtitle: "Appointment scheduling and status tracking",
    emptyTitle: "No appointments yet",
    emptyHint:
      "No appointments have been created yet. Creating and managing appointments will be enabled in the next stage of the system.",
  },
  followUp: {
    title: "Follow-up",
    subtitle: "Follow-up queues and patient contact",
    emptyTitle: "No follow-up lists yet",
    emptyHint:
      "Follow-up queues (due today, due soon, overdue, no next appointment) will appear here once patient and appointment data is enabled.",
    queues: {
      dueToday: "Due today",
      dueSoon: "Due soon",
      overdue: "Overdue",
      noNextAppointment: "No next appointment",
      missedAppointments: "Missed appointments",
    },
  },
  errors: {
    generic: "An unexpected error occurred",
    forbidden: "You do not have permission to access this page",
    unauthorizedTitle: "Session expired",
    unauthorizedHint: "Your session has expired or you are not signed in. Please sign in again.",
    dbNotReadyTitle: "Database not connected",
    dbNotReadyHint:
      "The database connection has not been configured yet. The system is currently running in foundation mode without data.",
  },
};
