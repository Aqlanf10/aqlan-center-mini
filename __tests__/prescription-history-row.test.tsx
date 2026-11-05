import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SavedPrescriptionRow, type SavedRx } from '../components/SavedPrescriptionRow';
const rx: SavedRx = { id: 81, visitId: 9, createdAt: '2026-10-31T22:30:00Z', createdAtLabel: '01/11/2026 01:30', timeZone: 'Asia/Aden', prescribingDoctorName: null, status: 'active', items: [{ name: 'SyntheticRx', dose: '500mg', selection: { id: 'manual', amount: '1 tablet', confirmed: true }, form: 'tablet', frequency: 'reviewed frequency', duration: 'reviewed duration', instructions: 'تعليمات محفوظة', instructionsEn: 'Saved instructions' }] };
it('renders original medication/instruction snapshot, clinic date, visit and explicit issued state', () => {
 const html = renderToStaticMarkup(<SavedPrescriptionRow patientId={7} rx={rx} />);
 for (const value of ['SyntheticRx', '500mg', 'Dose: 1 tablet', 'تعليمات محفوظة', 'Saved instructions', '01/11/2026 01:30', 'Asia/Aden', 'زيارة #9', 'مصدرة', '/print/prescription/7?rx=81', 'اسم الطبيب غير موثق']) expect(html).toContain(value);
 expect(html).toContain('dir="rtl"'); expect(html).toContain('dir="ltr"');
});
it('shows void history but never offers a print action', () => {
 const html = renderToStaticMarkup(<SavedPrescriptionRow patientId={7} rx={{ ...rx, status: 'void', voidReason: 'Synthetic cancellation reason' }} />);
 expect(html).toContain('مبطلة'); expect(html).toContain('Synthetic cancellation reason'); expect(html).toContain('SyntheticRx'); expect(html).not.toContain('<a ');
});
it('preserves minimal reception picker without fabricated medication or status', () => {
 const html = renderToStaticMarkup(<SavedPrescriptionRow patientId={7} rx={{ id: 81, visitId: null, createdAt: rx.createdAt, prescribingDoctorName: null }} />);
 expect(html).toContain('/print/prescription/7?rx=81'); expect(html).not.toContain('SyntheticRx'); expect(html).not.toContain('مصدرة');
});
