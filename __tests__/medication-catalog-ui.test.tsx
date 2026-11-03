import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import MedicationsSettings from '../app/settings/medications/page';
import { PrescriptionClinicCatalog } from '../components/PrescriptionClinicCatalog';
it('renders management without unsafe default edit availability or clinical approval claims',()=>{const html=renderToStaticMarkup(<MedicationsSettings/>);expect(html).toContain('دليل أدوية الوصفات');expect(html).toContain('لا حساب تلقائي');expect(html).toContain('disabled');expect(html).toContain('سجل التغييرات');});
it('does not insert a medication on render and explains unconfirmed copying',()=>{const select=vi.fn();const html=renderToStaticMarkup(<PrescriptionClinicCatalog onSelect={select}/>);expect(select).not.toHaveBeenCalled();expect(html).toContain('مسودة غير مؤكدة');expect(html).toContain('لا توجد إضافات مفعلة');});
