import { formatMoney, type Currency } from "@/lib/money";

export interface LabAccountingExportRow {
  id: number;
  name: string;
  currency: Currency;
  isActive: boolean;
  deliveryDays: number;
  expenseAccountCode: string;
  expenseAccountName: string;
  payableAccountCode: string;
  payableAccountName: string;
  autoPostJournal: boolean;
  customAccountName: string | null;
  activeOrdersCount: number;
  totalOrdersCount: number;
  totalOwedMinor: number;
  totalPaidMinor: number;
  dueMinor: number;
  lastOrderDate: string | null;
}

export interface LabAccountingExportParams {
  clinicName: string;
  clinicPhone?: string;
  clinicAddress?: string;
  baseCurrency: Currency;
  rows: LabAccountingExportRow[];
  summary?: {
    totalLabs: number;
    activeLabs: number;
    totalOwedMinor: number;
    totalPaidMinor: number;
    totalDueMinor: number;
    activeOrdersTotal: number;
    customMappedCount: number;
  } | null;
  filterLabel?: string;
  generatedDate?: string;
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * تصدير تقرير ربط حسابات المختبرات والترحيل الآلي بصيغة Excel XML Spreadsheet 2003.
 * يفتح مباشرة في Microsoft Excel وLibreOffice باللغة العربية ومن اليمين لليسار (RTL)
 * مع الألوان والتنسيقات والخلايا النقدية وملخص التدقيق المحاسبي.
 */
export function exportLabAccountingToExcel(params: LabAccountingExportParams) {
  const dateStr = params.generatedDate || new Date().toISOString().slice(0, 10);
  const timeStr = new Intl.DateTimeFormat("ar-YE", {
    timeZone: "Asia/Aden",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());

  const autoPostActiveCount = params.rows.filter((r) => r.autoPostJournal).length;
  const totalOwed = params.rows.reduce((sum, r) => sum + r.totalOwedMinor, 0);
  const totalPaid = params.rows.reduce((sum, r) => sum + r.totalPaidMinor, 0);
  const totalDue = params.rows.reduce((sum, r) => sum + r.dueMinor, 0);
  const totalActiveOrders = params.rows.reduce((sum, r) => sum + r.activeOrdersCount, 0);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
  <Title>تقرير تدقيق ربط حسابات المختبرات والترحيل الآلي</Title>
  <Subject>التدقيق المحاسبي للمختبرات</Subject>
  <Author>${escapeXml(params.clinicName)}</Author>
  <Created>${new Date().toISOString()}</Created>
 </DocumentProperties>
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Alignment ss:Vertical="Center" ss:ReadingOrder="RightToLeft"/>
   <Borders/>
   <Font ss:FontName="Segoe UI" x:CharSet="1" ss:Size="11" ss:Color="#1E293B"/>
   <Interior/>
   <NumberFormat/>
   <Protection/>
  </Style>
  <Style ss:ID="TitleStyle">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:ReadingOrder="RightToLeft"/>
   <Font ss:FontName="Segoe UI" ss:Size="16" ss:Bold="1" ss:Color="#0F172A"/>
   <Interior ss:Color="#F1F5F9" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="SubTitleStyle">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:ReadingOrder="RightToLeft"/>
   <Font ss:FontName="Segoe UI" ss:Size="10" ss:Color="#475569" ss:Italic="1"/>
  </Style>
  <Style ss:ID="KpiLabel">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center" ss:ReadingOrder="RightToLeft"/>
   <Font ss:FontName="Segoe UI" ss:Size="9" ss:Bold="1" ss:Color="#475569"/>
   <Interior ss:Color="#F8FAFC" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="KpiValue">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:ReadingOrder="RightToLeft"/>
   <Font ss:FontName="Segoe UI" ss:Size="11" ss:Bold="1" ss:Color="#0F172A"/>
   <Interior ss:Color="#FFFFFF" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="TableHeader">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1" ss:ReadingOrder="RightToLeft"/>
   <Font ss:FontName="Segoe UI" ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1E293B" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#0F172A"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#334155"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#334155"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#334155"/>
   </Borders>
  </Style>
  <Style ss:ID="DataRowEven">
   <Alignment ss:Vertical="Center" ss:ReadingOrder="RightToLeft"/>
   <Font ss:FontName="Segoe UI" ss:Size="9.5" ss:Color="#0F172A"/>
   <Interior ss:Color="#FFFFFF" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="DataRowOdd">
   <Alignment ss:Vertical="Center" ss:ReadingOrder="RightToLeft"/>
   <Font ss:FontName="Segoe UI" ss:Size="9.5" ss:Color="#0F172A"/>
   <Interior ss:Color="#F8FAFC" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="MoneyCell">
   <Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:ReadingOrder="RightToLeft"/>
   <Font ss:FontName="Segoe UI" ss:Size="9.5" ss:Bold="1" ss:Color="#0F172A"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="MoneyDueCell">
   <Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:ReadingOrder="RightToLeft"/>
   <Font ss:FontName="Segoe UI" ss:Size="9.5" ss:Bold="1" ss:Color="#E11D48"/>
   <Interior ss:Color="#FFF1F2" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FECDD3"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FECDD3"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FECDD3"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FECDD3"/>
   </Borders>
  </Style>
  <Style ss:ID="AutoPostActive">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:ReadingOrder="RightToLeft"/>
   <Font ss:FontName="Segoe UI" ss:Size="9.5" ss:Bold="1" ss:Color="#047857"/>
   <Interior ss:Color="#ECFDF5" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A7F3D0"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A7F3D0"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A7F3D0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#A7F3D0"/>
   </Borders>
  </Style>
  <Style ss:ID="AutoPostInactive">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:ReadingOrder="RightToLeft"/>
   <Font ss:FontName="Segoe UI" ss:Size="9.5" ss:Color="#64748B"/>
   <Interior ss:Color="#F1F5F9" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
   </Borders>
  </Style>
  <Style ss:ID="TotalFooter">
   <Alignment ss:Vertical="Center" ss:ReadingOrder="RightToLeft"/>
   <Font ss:FontName="Segoe UI" ss:Size="10" ss:Bold="1" ss:Color="#0F172A"/>
   <Interior ss:Color="#E2E8F0" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#0F172A"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#64748B"/>
   </Borders>
  </Style>
 </Styles>
 <Worksheet ss:Name="ربط حسابات المختبرات" ss:RightToLeft="1">
  <Table ss:DefaultRowHeight="22">
   <Column ss:Width="35"/>
   <Column ss:Width="160"/>
   <Column ss:Width="70"/>
   <Column ss:Width="60"/>
   <Column ss:Width="175"/>
   <Column ss:Width="175"/>
   <Column ss:Width="140"/>
   <Column ss:Width="95"/>
   <Column ss:Width="160"/>
   <Column ss:Width="80"/>
   <Column ss:Width="110"/>
   <Column ss:Width="110"/>
   <Column ss:Width="120"/>
   <Column ss:Width="90"/>

   <!-- ترويسة التقرير الرئيسية -->
   <Row ss:Height="30">
    <Cell ss:MergeAcross="13" ss:StyleID="TitleStyle">
     <Data ss:Type="String">${escapeXml(params.clinicName)} — تقرير تدقيق ربط حسابات المختبرات والترحيل التلقائي</Data>
    </Cell>
   </Row>
   <Row ss:Height="20">
    <Cell ss:MergeAcross="13" ss:StyleID="SubTitleStyle">
     <Data ss:Type="String">تاريخ وساعة الإعداد: ${dateStr} ${timeStr} | العملة الأساسية: ${params.baseCurrency} | الفلتر: ${escapeXml(params.filterLabel || "كافة المختبرات")}</Data>
    </Cell>
   </Row>

   <!-- مسافة فارغة -->
   <Row ss:Height="10"/>

   <!-- بطاقات الملخص المحاسبي للتدقيق -->
   <Row ss:Height="22">
    <Cell ss:MergeAcross="1" ss:StyleID="KpiLabel"><Data ss:Type="String">إجمالي المختبرات المسجلة:</Data></Cell>
    <Cell ss:MergeAcross="1" ss:StyleID="KpiValue"><Data ss:Type="Number">${params.rows.length}</Data></Cell>
    <Cell ss:MergeAcross="1" ss:StyleID="KpiLabel"><Data ss:Type="String">المختبرات النشطة:</Data></Cell>
    <Cell ss:MergeAcross="1" ss:StyleID="KpiValue"><Data ss:Type="Number">${params.rows.filter((r) => r.isActive).length}</Data></Cell>
    <Cell ss:MergeAcross="1" ss:StyleID="KpiLabel"><Data ss:Type="String">الترحيل الآلي مفعّل (Auto-Post):</Data></Cell>
    <Cell ss:MergeAcross="3" ss:StyleID="KpiValue"><Data ss:Type="String">${autoPostActiveCount} من ${params.rows.length} (${Math.round((autoPostActiveCount / (params.rows.length || 1)) * 100)}%)</Data></Cell>
   </Row>
   <Row ss:Height="22">
    <Cell ss:MergeAcross="1" ss:StyleID="KpiLabel"><Data ss:Type="String">إجمالي الالتزامات (المصروفات):</Data></Cell>
    <Cell ss:MergeAcross="1" ss:StyleID="KpiValue"><Data ss:Type="String">${escapeXml(formatMoney(totalOwed, params.baseCurrency))}</Data></Cell>
    <Cell ss:MergeAcross="1" ss:StyleID="KpiLabel"><Data ss:Type="String">إجمالي المسدد (سندات الصرف):</Data></Cell>
    <Cell ss:MergeAcross="1" ss:StyleID="KpiValue"><Data ss:Type="String">${escapeXml(formatMoney(totalPaid, params.baseCurrency))}</Data></Cell>
    <Cell ss:MergeAcross="1" ss:StyleID="KpiLabel"><Data ss:Type="String">صافي الرصيد المستحق (ذمم دائنة):</Data></Cell>
    <Cell ss:MergeAcross="3" ss:StyleID="KpiValue"><Data ss:Type="String">${escapeXml(formatMoney(totalDue, params.baseCurrency))}</Data></Cell>
   </Row>

   <!-- مسافة فارغة قبل الجدول -->
   <Row ss:Height="14"/>

   <!-- رؤوس أعمدة جدول التدقيق -->
   <Row ss:Height="26">
    <Cell ss:StyleID="TableHeader"><Data ss:Type="String">م</Data></Cell>
    <Cell ss:StyleID="TableHeader"><Data ss:Type="String">المختبر / المعمل</Data></Cell>
    <Cell ss:StyleID="TableHeader"><Data ss:Type="String">الحالة</Data></Cell>
    <Cell ss:StyleID="TableHeader"><Data ss:Type="String">العملة</Data></Cell>
    <Cell ss:StyleID="TableHeader"><Data ss:Type="String">بند المصروف (قائمة الدخل Debit)</Data></Cell>
    <Cell ss:StyleID="TableHeader"><Data ss:Type="String">بند الذمم (الميزانية Credit)</Data></Cell>
    <Cell ss:StyleID="TableHeader"><Data ss:Type="String">مسمى الحساب بالدفاتر</Data></Cell>
    <Cell ss:StyleID="TableHeader"><Data ss:Type="String">الترحيل التلقائي</Data></Cell>
    <Cell ss:StyleID="TableHeader"><Data ss:Type="String">أثر القيد المحاسبي المزدوج</Data></Cell>
    <Cell ss:StyleID="TableHeader"><Data ss:Type="String">الطلبات النشطة</Data></Cell>
    <Cell ss:StyleID="TableHeader"><Data ss:Type="String">إجمالي الالتزامات</Data></Cell>
    <Cell ss:StyleID="TableHeader"><Data ss:Type="String">إجمالي المسدد</Data></Cell>
    <Cell ss:StyleID="TableHeader"><Data ss:Type="String">الرصيد المستحق (الذمة)</Data></Cell>
    <Cell ss:StyleID="TableHeader"><Data ss:Type="String">آخر طلب</Data></Cell>
   </Row>

   <!-- أسطر البيانات -->
   ${params.rows
     .map((row, idx) => {
       const style = idx % 2 === 0 ? "DataRowEven" : "DataRowOdd";
       const autoPostStyle = row.autoPostJournal ? "AutoPostActive" : "AutoPostInactive";
       const journalImpact = row.autoPostJournal
         ? `مدين: ${row.expenseAccountCode} / دائن: ${row.payableAccountCode}`
         : "يدوي — غير مرحل آلياً";

       return `
   <Row ss:Height="22">
    <Cell ss:StyleID="${style}"><Data ss:Type="Number">${idx + 1}</Data></Cell>
    <Cell ss:StyleID="${style}"><Data ss:Type="String">${escapeXml(row.name)}</Data></Cell>
    <Cell ss:StyleID="${style}"><Data ss:Type="String">${row.isActive ? "نشط" : "معطّل"}</Data></Cell>
    <Cell ss:StyleID="${style}"><Data ss:Type="String">${row.currency}</Data></Cell>
    <Cell ss:StyleID="${style}"><Data ss:Type="String">${row.expenseAccountCode} — ${escapeXml(row.expenseAccountName)}</Data></Cell>
    <Cell ss:StyleID="${style}"><Data ss:Type="String">${row.payableAccountCode} — ${escapeXml(row.payableAccountName)}</Data></Cell>
    <Cell ss:StyleID="${style}"><Data ss:Type="String">${escapeXml(row.customAccountName || "افتراضي (" + row.name + ")")}</Data></Cell>
    <Cell ss:StyleID="${autoPostStyle}"><Data ss:Type="String">${row.autoPostJournal ? "✓ مفعّل" : "✗ معطّل"}</Data></Cell>
    <Cell ss:StyleID="${style}"><Data ss:Type="String">${escapeXml(journalImpact)}</Data></Cell>
    <Cell ss:StyleID="${style}"><Data ss:Type="Number">${row.activeOrdersCount}</Data></Cell>
    <Cell ss:StyleID="MoneyCell"><Data ss:Type="String">${escapeXml(formatMoney(row.totalOwedMinor, params.baseCurrency))}</Data></Cell>
    <Cell ss:StyleID="MoneyCell"><Data ss:Type="String">${escapeXml(formatMoney(row.totalPaidMinor, params.baseCurrency))}</Data></Cell>
    <Cell ss:StyleID="${row.dueMinor > 0 ? "MoneyDueCell" : "MoneyCell"}"><Data ss:Type="String">${escapeXml(formatMoney(row.dueMinor, params.baseCurrency))}</Data></Cell>
    <Cell ss:StyleID="${style}"><Data ss:Type="String">${row.lastOrderDate || "—"}</Data></Cell>
   </Row>`;
     })
     .join("")}

   <!-- سطر الإجماليات -->
   <Row ss:Height="24">
    <Cell ss:StyleID="TotalFooter"><Data ss:Type="String">∑</Data></Cell>
    <Cell ss:MergeAcross="7" ss:StyleID="TotalFooter">
     <Data ss:Type="String">الإجمالي العام لـ (${params.rows.length}) مختبرات مسجلة</Data>
    </Cell>
    <Cell ss:StyleID="TotalFooter"><Data ss:Type="Number">${totalActiveOrders}</Data></Cell>
    <Cell ss:StyleID="TotalFooter"><Data ss:Type="String">${escapeXml(formatMoney(totalOwed, params.baseCurrency))}</Data></Cell>
    <Cell ss:StyleID="TotalFooter"><Data ss:Type="String">${escapeXml(formatMoney(totalPaid, params.baseCurrency))}</Data></Cell>
    <Cell ss:StyleID="TotalFooter"><Data ss:Type="String">${escapeXml(formatMoney(totalDue, params.baseCurrency))}</Data></Cell>
    <Cell ss:StyleID="TotalFooter"><Data ss:Type="String">—</Data></Cell>
   </Row>

   <!-- مسافة فارغة -->
   <Row ss:Height="15"/>

   <!-- ملاحظات وتواقيع التدقيق المحاسبي -->
   <Row ss:Height="20">
    <Cell ss:MergeAcross="13" ss:StyleID="SubTitleStyle">
     <Data ss:Type="String">ملاحظة التدقيق المحاسبي: عند تفعيل الترحيل التلقائي (Auto-Post)، يتم قيد الالتزام المالي فور اعتماد طلب المعمل (مدين: بند المصروف 51xx في قائمة الدخل / دائن: بند الذمم 21xx في الميزانية العمومية). ويتم تخفيض الذمة بسندات الصرف.</Data>
    </Cell>
   </Row>
   <Row ss:Height="22">
    <Cell ss:MergeAcross="3" ss:StyleID="KpiLabel"><Data ss:Type="String">إعداد المحاسب المالي: ............................</Data></Cell>
    <Cell ss:MergeAcross="4" ss:StyleID="KpiLabel"><Data ss:Type="String">تدقيق المراجع الداخلي: ............................</Data></Cell>
    <Cell ss:MergeAcross="4" ss:StyleID="KpiLabel"><Data ss:Type="String">اعتماد المدير المالي: ............................</Data></Cell>
   </Row>
  </Table>
 </Worksheet>
</Workbook>`;

  const blob = new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `تقرير_ربط_حسابات_المختبرات_${dateStr}.xls`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * تصدير تقرير ربط حسابات المختبرات والترحيل الآلي بصيغة CSV مع UTF-8 BOM
 */
export function exportLabAccountingToCsv(params: LabAccountingExportParams) {
  const dateStr = params.generatedDate || new Date().toISOString().slice(0, 10);

  const columns = [
    "م",
    "المختبر / المعمل",
    "الحالة",
    "العملة",
    "كود بند المصروف",
    "مسمى بند المصروف (قائمة الدخل)",
    "كود بند الذمم",
    "مسمى بند الذمم (الميزانية العمومية)",
    "مسمى الحساب بالدفاتر",
    "الترحيل التلقائي",
    "الطلبات النشطة",
    "إجمالي الطلبات",
    `إجمالي الالتزامات (${params.baseCurrency})`,
    `إجمالي المسدد (${params.baseCurrency})`,
    `الرصيد المستحق (${params.baseCurrency})`,
    "تاريخ آخر طلب",
  ];

  const escapeCsv = (val: string | number | null | undefined) => {
    const s = String(val ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const headerRow = columns.map(escapeCsv).join(",");
  const dataRows = params.rows.map((r, idx) => {
    return [
      idx + 1,
      r.name,
      r.isActive ? "نشط" : "معطل",
      r.currency,
      r.expenseAccountCode,
      r.expenseAccountName,
      r.payableAccountCode,
      r.payableAccountName,
      r.customAccountName || `افتراضي (${r.name})`,
      r.autoPostJournal ? "مفعل" : "معطل",
      r.activeOrdersCount,
      r.totalOrdersCount,
      formatMoney(r.totalOwedMinor, params.baseCurrency),
      formatMoney(r.totalPaidMinor, params.baseCurrency),
      formatMoney(r.dueMinor, params.baseCurrency),
      r.lastOrderDate || "—",
    ]
      .map(escapeCsv)
      .join(",");
  });

  const totalOwed = params.rows.reduce((sum, r) => sum + r.totalOwedMinor, 0);
  const totalPaid = params.rows.reduce((sum, r) => sum + r.totalPaidMinor, 0);
  const totalDue = params.rows.reduce((sum, r) => sum + r.dueMinor, 0);
  const totalActiveOrders = params.rows.reduce((sum, r) => sum + r.activeOrdersCount, 0);

  const totalRow = [
    "∑",
    `الإجمالي العام (${params.rows.length} مختبر)`,
    "—",
    "—",
    "—",
    "—",
    "—",
    "—",
    "—",
    "—",
    totalActiveOrders,
    "—",
    formatMoney(totalOwed, params.baseCurrency),
    formatMoney(totalPaid, params.baseCurrency),
    formatMoney(totalDue, params.baseCurrency),
    "—",
  ]
    .map(escapeCsv)
    .join(",");

  const csvContent = `\uFEFF${[headerRow, ...dataRows, totalRow].join("\n")}`;
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `تقرير_ربط_حسابات_المختبرات_${dateStr}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
