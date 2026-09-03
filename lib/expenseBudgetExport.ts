import { formatMoney, MINOR_UNITS, type Currency } from "@/lib/money";
import type { ExpenseCategoryDTO, ExpenseBudgetSummary } from "@/lib/db";

export interface ExpenseBudgetExportParams {
  clinicName: string;
  clinicPhone?: string;
  clinicAddress?: string;
  baseCurrency: Currency;
  categories: ExpenseCategoryDTO[];
  summary: ExpenseBudgetSummary;
  month: string;
  generatedDate?: string;
}

function escapeXml(unsafe: string): string {
  return (unsafe || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * تصدير تقرير بنود المصروفات التشغيلية والميزانيات التقديرية بصيغة Excel XML Spreadsheet 2003.
 * يفتح مباشرة في Microsoft Excel باللغة العربية ومن اليمين لليسار (RTL) مع التنسيقات والألوان وحساب الانحراف.
 */
export function exportExpenseBudgetToExcel(params: ExpenseBudgetExportParams) {
  const dateStr = params.generatedDate || new Date().toISOString().slice(0, 10);
  const timeStr = new Intl.DateTimeFormat("ar-YE", {
    timeZone: "Asia/Aden",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());

  const { categories, summary, clinicName, month, baseCurrency } = params;

  let rowsXml = "";
  categories.forEach((cat, idx) => {
    const isDeficit = cat.isOverBudget;
    const rowBg = idx % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
    const statusBg = isDeficit ? "#FEE2E2" : "#DCFCE7";
    const statusColor = isDeficit ? "#991B1B" : "#166534";
    const statusText = isDeficit ? "تجاوز للميزانية" : "ضمن الميزانية";
    const varianceColor = cat.varianceMinor < 0 ? "#DC2626" : "#16A34A";
    const catVariancePercent = cat.variancePercent !== undefined
      ? cat.variancePercent
      : (cat.monthlyBudgetMinor > 0
          ? Math.round(((cat.actualSpentMinor - cat.monthlyBudgetMinor) / cat.monthlyBudgetMinor) * 100)
          : cat.actualSpentMinor > 0 ? 100 : 0);

    rowsXml += `
      <Row ss:Height="24">
        <Cell ss:StyleID="CellCenter" ss:Index="1"><Data ss:Type="Number">${idx + 1}</Data></Cell>
        <Cell ss:StyleID="CellCode"><Data ss:Type="String">${escapeXml(cat.key)}</Data></Cell>
        <Cell ss:StyleID="CellBold"><Data ss:Type="String">${escapeXml(cat.name)}</Data></Cell>
        <Cell ss:StyleID="CellCenter"><Data ss:Type="String">${escapeXml(cat.categoryGroup)}</Data></Cell>
        <Cell ss:StyleID="CellCode"><Data ss:Type="String">${escapeXml(cat.accountCode)}</Data></Cell>
        <Cell ss:StyleID="CellRegular"><Data ss:Type="String">${escapeXml(cat.accountName)}</Data></Cell>
        <Cell ss:StyleID="CellMoney"><Data ss:Type="Number">${(cat.monthlyBudgetMinor / MINOR_UNITS[baseCurrency]).toFixed(2)}</Data></Cell>
        <Cell ss:StyleID="CellMoney"><Data ss:Type="Number">${(cat.actualSpentMinor / MINOR_UNITS[baseCurrency]).toFixed(2)}</Data></Cell>
        <Cell ss:StyleID="${cat.varianceMinor < 0 ? 'CellMoneyNeg' : 'CellMoneyPos'}"><Data ss:Type="Number">${(cat.varianceMinor / MINOR_UNITS[baseCurrency]).toFixed(2)}</Data></Cell>
        <Cell ss:StyleID="${catVariancePercent > 0 ? 'CellPercentHigh' : 'CellPercent'}"><Data ss:Type="Number">${(catVariancePercent / 100).toFixed(4)}</Data></Cell>
        <Cell ss:StyleID="${cat.consumptionPercent > 100 ? 'CellPercentHigh' : 'CellPercent'}"><Data ss:Type="Number">${(cat.consumptionPercent / 100).toFixed(4)}</Data></Cell>
        <Cell ss:StyleID="CellCenter"><Data ss:Type="Number">${cat.expensesCount}</Data></Cell>
        <Cell ss:StyleID="CellMoney"><Data ss:Type="Number">${(cat.annualBudgetMinor / MINOR_UNITS[baseCurrency]).toFixed(2)}</Data></Cell>
        <Cell ss:StyleID="${isDeficit ? 'CellStatusDeficit' : 'CellStatusSurplus'}"><Data ss:Type="String">${statusText}</Data></Cell>
        <Cell ss:StyleID="${cat.isActive ? 'CellActive' : 'CellInactive'}"><Data ss:Type="String">${cat.isActive ? "نشط" : "معطّل"}</Data></Cell>
        <Cell ss:StyleID="CellRegular"><Data ss:Type="String">${escapeXml(cat.description || "-")}</Data></Cell>
      </Row>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
  <Title>تقرير بنود المصروفات التشغيلية والميزانيات التقديرية</Title>
  <Subject>مراقبة المصروفات والربط بدليل الحسابات</Subject>
  <Author>${escapeXml(clinicName)}</Author>
  <Created>${dateStr}T${timeStr}</Created>
 </DocumentProperties>
 <OfficeDocumentSettings xmlns="urn:schemas-microsoft-com:office:office">
  <AllowPNG/>
 </OfficeDocumentSettings>
 <ExcelWorkbook xmlns="urn:schemas-microsoft-com:office:excel">
  <WindowHeight>11000</WindowHeight>
  <WindowWidth>20000</WindowWidth>
  <WindowTopX>0</WindowTopX>
  <WindowTopY>0</WindowTopY>
  <ProtectStructure>False</ProtectStructure>
  <ProtectWindows>False</ProtectWindows>
  <DisplayRightToLeft/>
 </ExcelWorkbook>
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Alignment ss:Vertical="Center" ss:ReadingOrder="RightToLeft"/>
   <Borders/>
   <Font ss:FontName="Segoe UI" x:CharSet="178" ss:Size="10" ss:Color="#1E293B"/>
   <Interior/>
   <NumberFormat/>
   <Protection/>
  </Style>
  <Style ss:ID="TitleClinic">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="16" ss:Bold="1" ss:Color="#0F172A"/>
   <Interior ss:Color="#F1F5F9" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="TitleReport">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="13" ss:Bold="1" ss:Color="#1E40AF"/>
   <Interior ss:Color="#DBEAFE" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="MetaLabel">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="9" ss:Bold="1" ss:Color="#475569"/>
   <Interior ss:Color="#F8FAFC" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="MetaVal">
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#0F172A"/>
   <Interior ss:Color="#F8FAFC" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="KpiHeader">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="9" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1E293B" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#0F172A"/>
   </Borders>
  </Style>
  <Style ss:ID="KpiVal">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="12" ss:Bold="1" ss:Color="#0F172A"/>
   <Interior ss:Color="#F1F5F9" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
   </Borders>
  </Style>
  <Style ss:ID="ColHeader">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
   <Font ss:FontName="Segoe UI" ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#0F766E" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#115E59"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#14B8A6"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#14B8A6"/>
   </Borders>
  </Style>
  <Style ss:ID="CellRegular">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#1E293B"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="CellBold">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="9.5" ss:Bold="1" ss:Color="#0F172A"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="CellCenter">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#1E293B"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="CellCode">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Consolas" ss:Size="9.5" ss:Bold="1" ss:Color="#097277"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="CellMoney">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#0F172A"/>
   <NumberFormat ss:Format="#,##0.00"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="CellMoneyPos">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="9.5" ss:Bold="1" ss:Color="#166534"/>
   <NumberFormat ss:Format="#,##0.00"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="CellMoneyNeg">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="9.5" ss:Bold="1" ss:Color="#991B1B"/>
   <Interior ss:Color="#FEE2E2" ss:Pattern="Solid"/>
   <NumberFormat ss:Format="#,##0.00"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FECACA"/>
   </Borders>
  </Style>
  <Style ss:ID="CellPercent">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#0F172A"/>
   <NumberFormat ss:Format="0.0%"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="CellPercentHigh">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="9.5" ss:Bold="1" ss:Color="#991B1B"/>
   <Interior ss:Color="#FEE2E2" ss:Pattern="Solid"/>
   <NumberFormat ss:Format="0.0%"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FECACA"/>
   </Borders>
  </Style>
  <Style ss:ID="CellStatusSurplus">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="9" ss:Bold="1" ss:Color="#166534"/>
   <Interior ss:Color="#DCFCE7" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#BBF7D0"/>
   </Borders>
  </Style>
  <Style ss:ID="CellStatusDeficit">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="9" ss:Bold="1" ss:Color="#991B1B"/>
   <Interior ss:Color="#FEE2E2" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FECACA"/>
   </Borders>
  </Style>
  <Style ss:ID="CellActive">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#0369A1"/>
   <Interior ss:Color="#E0F2FE" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#BAE6FD"/>
   </Borders>
  </Style>
  <Style ss:ID="CellInactive">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#64748B"/>
   <Interior ss:Color="#F1F5F9" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
   </Borders>
  </Style>
  <Style ss:ID="TotalHeader">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="11" ss:Bold="1" ss:Color="#0F172A"/>
   <Interior ss:Color="#E2E8F0" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#64748B"/>
    <Border ss:Position="Bottom" ss:LineStyle="Double" ss:Weight="3" ss:Color="#0F172A"/>
   </Borders>
  </Style>
  <Style ss:ID="TotalMoney">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <Font ss:FontName="Segoe UI" ss:Size="11" ss:Bold="1" ss:Color="#0F172A"/>
   <Interior ss:Color="#E2E8F0" ss:Pattern="Solid"/>
   <NumberFormat ss:Format="#,##0.00"/>
   <Borders>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#64748B"/>
    <Border ss:Position="Bottom" ss:LineStyle="Double" ss:Weight="3" ss:Color="#0F172A"/>
   </Borders>
  </Style>
 </Styles>
 <Worksheet ss:Name="ميزانية المصروفات">
  <Table ss:DefaultRowHeight="20">
   <Column ss:Width="40"/>  <!-- م -->
   <Column ss:Width="90"/>  <!-- كود البند -->
   <Column ss:Width="170"/> <!-- مسمى البند التشغيلي -->
   <Column ss:Width="110"/> <!-- التصنيف -->
   <Column ss:Width="70"/>  <!-- كود الدليل -->
   <Column ss:Width="180"/> <!-- مسمى الحساب في الدليل -->
   <Column ss:Width="110"/> <!-- الميزانية الشهرية -->
   <Column ss:Width="110"/> <!-- المنصرف الفعلي -->
   <Column ss:Width="110"/> <!-- الفارق والوفر -->
   <Column ss:Width="85"/>  <!-- نسبة الانحراف -->
   <Column ss:Width="75"/>  <!-- نسبة الاستهلاك -->
   <Column ss:Width="65"/>  <!-- عدد العمليات -->
   <Column ss:Width="110"/> <!-- الميزانية السنوية -->
   <Column ss:Width="95"/>  <!-- حالة الميزانية -->
   <Column ss:Width="65"/>  <!-- الحالة -->
   <Column ss:Width="200"/> <!-- بيان وملاحظات -->

   <!-- عنوان المركز -->
   <Row ss:Height="32">
    <Cell ss:MergeAcross="15" ss:StyleID="TitleClinic">
     <Data ss:Type="String">${escapeXml(clinicName)}</Data>
    </Cell>
   </Row>

   <!-- عنوان التقرير -->
   <Row ss:Height="24">
    <Cell ss:MergeAcross="15" ss:StyleID="TitleReport">
     <Data ss:Type="String">تقرير رقابة بنود المصروفات التشغيلية والميزانيات التقديرية — شهر (${month})</Data>
    </Cell>
   </Row>

   <!-- بيانات توثيق التقرير -->
   <Row ss:Height="20">
    <Cell ss:MergeAcross="3" ss:StyleID="MetaLabel"><Data ss:Type="String">تاريخ وساعة الاستخراج:</Data></Cell>
    <Cell ss:MergeAcross="3" ss:StyleID="MetaVal"><Data ss:Type="String">${dateStr} ${timeStr}</Data></Cell>
    <Cell ss:MergeAcross="3" ss:StyleID="MetaLabel"><Data ss:Type="String">العملة المحاسبية الأساسية:</Data></Cell>
    <Cell ss:MergeAcross="3" ss:StyleID="MetaVal"><Data ss:Type="String">${baseCurrency}</Data></Cell>
   </Row>

   <Row ss:Height="8"/>

   <!-- بطاقات الملخص المحاسبي KPIs -->
   <Row ss:Height="20">
    <Cell ss:MergeAcross="2" ss:StyleID="KpiHeader"><Data ss:Type="String">إجمالي الميزانية التقديرية للشهر</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiHeader"><Data ss:Type="String">إجمالي المنصرف الفعلي</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiHeader"><Data ss:Type="String">صافي الوفر / العجز</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiHeader"><Data ss:Type="String">نسبة الاستنزاف الإجمالية</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiHeader"><Data ss:Type="String">بنود متجاوزة للميزانية</Data></Cell>
   </Row>
   <Row ss:Height="26">
    <Cell ss:MergeAcross="2" ss:StyleID="KpiVal"><Data ss:Type="String">${formatMoney(summary.totalMonthlyBudgetMinor, baseCurrency)}</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiVal"><Data ss:Type="String">${formatMoney(summary.totalActualSpentMinor, baseCurrency)}</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiVal"><Data ss:Type="String">${formatMoney(summary.totalVarianceMinor, baseCurrency)}</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiVal"><Data ss:Type="String">${summary.overallConsumptionPercent}%</Data></Cell>
    <Cell ss:MergeAcross="2" ss:StyleID="KpiVal"><Data ss:Type="String">${summary.overBudgetCount} من أصل ${summary.activeCategories}</Data></Cell>
   </Row>

   <Row ss:Height="12"/>

   <!-- ترويسة الجدول الرئيسي -->
   <Row ss:Height="28">
    <Cell ss:StyleID="ColHeader"><Data ss:Type="String">م</Data></Cell>
    <Cell ss:StyleID="ColHeader"><Data ss:Type="String">كود البند</Data></Cell>
    <Cell ss:StyleID="ColHeader"><Data ss:Type="String">مسمى البند التشغيلي</Data></Cell>
    <Cell ss:StyleID="ColHeader"><Data ss:Type="String">المجموعة والتبويب</Data></Cell>
    <Cell ss:StyleID="ColHeader"><Data ss:Type="String">كود الدليل</Data></Cell>
    <Cell ss:StyleID="ColHeader"><Data ss:Type="String">مسمى الحساب المحاسبي</Data></Cell>
    <Cell ss:StyleID="ColHeader"><Data ss:Type="String">الميزانية التقديرية (${baseCurrency})</Data></Cell>
    <Cell ss:StyleID="ColHeader"><Data ss:Type="String">المنصرف الفعلي (${baseCurrency})</Data></Cell>
    <Cell ss:StyleID="ColHeader"><Data ss:Type="String">الفارق / الوفر (${baseCurrency})</Data></Cell>
    <Cell ss:StyleID="ColHeader"><Data ss:Type="String">نسبة الانحراف</Data></Cell>
    <Cell ss:StyleID="ColHeader"><Data ss:Type="String">نسبة الاستهلاك</Data></Cell>
    <Cell ss:StyleID="ColHeader"><Data ss:Type="String">العمليات</Data></Cell>
    <Cell ss:StyleID="ColHeader"><Data ss:Type="String">الميزانية السنوية (${baseCurrency})</Data></Cell>
    <Cell ss:StyleID="ColHeader"><Data ss:Type="String">حالة الميزانية</Data></Cell>
    <Cell ss:StyleID="ColHeader"><Data ss:Type="String">الحالة</Data></Cell>
    <Cell ss:StyleID="ColHeader"><Data ss:Type="String">بيان ونطاق المصروف</Data></Cell>
   </Row>

   <!-- أسطر البيانات -->
   ${rowsXml}

   <!-- سطر الإجماليات -->
   <Row ss:Height="26">
    <Cell ss:MergeAcross="5" ss:StyleID="TotalHeader"><Data ss:Type="String">الإجمالي العام لجميع البنود (${categories.length} بنداً)</Data></Cell>
    <Cell ss:StyleID="TotalMoney"><Data ss:Type="Number">${(summary.totalMonthlyBudgetMinor / MINOR_UNITS[baseCurrency]).toFixed(2)}</Data></Cell>
    <Cell ss:StyleID="TotalMoney"><Data ss:Type="Number">${(summary.totalActualSpentMinor / MINOR_UNITS[baseCurrency]).toFixed(2)}</Data></Cell>
    <Cell ss:StyleID="TotalMoney"><Data ss:Type="Number">${(summary.totalVarianceMinor / MINOR_UNITS[baseCurrency]).toFixed(2)}</Data></Cell>
    <Cell ss:StyleID="TotalHeader"><Data ss:Type="String">${(summary.overallVariancePercent || 0) > 0 ? `+${summary.overallVariancePercent}%` : `${summary.overallVariancePercent || 0}%`}</Data></Cell>
    <Cell ss:StyleID="TotalHeader"><Data ss:Type="String">${summary.overallConsumptionPercent}%</Data></Cell>
    <Cell ss:StyleID="TotalHeader"><Data ss:Type="Number">${summary.totalExpensesCount}</Data></Cell>
    <Cell ss:MergeAcross="3" ss:StyleID="TotalHeader"><Data ss:Type="String">-</Data></Cell>
   </Row>

  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <PageSetup>
    <Layout x:Orientation="Landscape"/>
    <Header x:Margin="0.3"/>
    <Footer x:Margin="0.3"/>
    <PageMargins x:Bottom="0.5" x:Left="0.5" x:Right="0.5" x:Top="0.5"/>
   </PageSetup>
   <FitToPage/>
   <Print>
    <FitWidth>1</FitWidth>
    <FitHeight>0</FitHeight>
    <ValidPrinterInfo/>
    <PaperSizeIndex>9</PaperSizeIndex>
   </Print>
   <Selected/>
   <DoNotDisplayGridlines/>
  </WorksheetOptions>
 </Worksheet>
</Workbook>`;

  const blob = new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `تقرير_ميزانيات_المصروفات_التشغيلية_${month}_${dateStr}.xls`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
