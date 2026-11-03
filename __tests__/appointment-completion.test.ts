import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {APPOINTMENT_BOOKING_MIGRATION} from '../lib/appointment-booking-schema';
import {APPOINTMENT_CATEGORY_LABEL} from '../lib/appointment-category';
import {isLateAppointment} from '../lib/appointment-lateness';
import {parsePendingAppointmentBooking} from '../lib/appointment-booking-recovery';
import {withDefaults} from '../lib/settings';
import {friendlyTime,bookingConfirmationText} from '../lib/reminders';
import {reminderTemplateParams} from '../lib/auto-reminders';
import type {Appointment} from '../lib/schedule';
const appointment:Appointment={id:1,patientId:1,patientName:'Synthetic',patientPhone:null,
  scheduledDate:'2030-01-15',scheduledTime:'16:30',durationMinutes:30,note:null,status:'booked'};
describe('appointment completion boundaries',()=>{
  it('keeps seven categories separate and migration/runtime bytes identical',()=>{
    expect(Object.keys(APPOINTMENT_CATEGORY_LABEL)).toHaveLength(7);
    const sql=readFileSync(new URL('../migrations/0096_appointment_booking_commands.sql',import.meta.url),'utf8');
    expect(APPOINTMENT_BOOKING_MIGRATION.sql).toBe(sql);
    expect(APPOINTMENT_BOOKING_MIGRATION.checksum).toBe(createHash('sha256').update(sql).digest('hex'));
  });
  it('uses two-session defaults only for an unconfigured clinic, preserving saved continuous hours',()=>{
    expect(withDefaults({})).toMatchObject({'clinic.day_start':'09:00','clinic.day_end':'13:00','clinic.shift2_start':'15:00','clinic.shift2_end':'19:00'});
    expect(withDefaults({'clinic.day_start':'09:00','clinic.day_end':'21:00'})).toMatchObject({'clinic.day_end':'21:00','clinic.shift2_start':'','clinic.shift2_end':''});
    expect(withDefaults({'clinic.shift2_start':'','clinic.shift2_end':''})['clinic.shift2_start']).toBe('');
  });
  it('late display uses clinic time and tolerance, never rewrites booked/no-show status',()=>{
    expect(isLateAppointment(appointment,new Date('2030-01-15T13:44:00Z'),'Asia/Aden',15)).toBe(false);
    expect(isLateAppointment(appointment,new Date('2030-01-15T13:45:00Z'),'Asia/Aden',15)).toBe(true);
    expect(isLateAppointment({...appointment,status:'arrived'},new Date('2030-01-15T14:00:00Z'),'Asia/Aden',15)).toBe(false);
    expect(appointment.status).toBe('booked');
  });
  it('manual and automated reminders retain the scheduled clinic clock without an added hour',()=>{
    const clinic={name:'Synthetic clinic',phone:'700000000',address:'Synthetic'};
    expect(friendlyTime('16:30')).toContain('4:30');
    expect(reminderTemplateParams(appointment,clinic)[2]).toBe(friendlyTime('16:30'));
    expect(bookingConfirmationText(appointment,clinic)).toContain(friendlyTime('16:30'));
  });
  it('rejects corrupt or actor-unbound browser recovery records',()=>{
    const commandId='40c9c100-740f-4219-818b-6ea4f219b167';
    expect(parsePendingAppointmentBooking('{')).toBeNull();
    expect(parsePendingAppointmentBooking(JSON.stringify({commandId,body:JSON.stringify({commandId,patientId:1})}))).toBeNull();
    const pending={commandId,body:JSON.stringify({commandId,patientId:1,expectedActor:{userId:1,username:'synthetic'}})};
    expect(parsePendingAppointmentBooking(JSON.stringify(pending))).toEqual(pending);
  });
});
