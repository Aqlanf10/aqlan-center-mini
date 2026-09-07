#!/usr/bin/env node
/**
 * Aqlan Center Model Context Protocol (MCP) Server
 *
 * خادم بروتوكول سياق النموذج القياسي (MCP - Model Context Protocol)
 * يتيح ربط أدوات مركز د. عقلان الذكية مباشرة مع:
 * - Claude Desktop
 * - OpenAI ChatGPT / Agents
 * - Cursor / IDEs
 * - Any MCP Client
 *
 * يعمل عبر خط أنابيب JSON-RPC 2.0 القياسي على stdio
 * خاضع لطبقة الخصوصية وإلغاء تحديد الهوية وحوكمة الصلاحيات.
 */

import readline from "node:readline";
import { executeAiTool, AI_TOOL_DEFINITIONS } from "../lib/ai-tools/registry";
import type { AiToolContext } from "../lib/ai-tools/types";
import { deIdentifyClinicalContext } from "../lib/ai-tools/privacy";

// إنشاء سياق افتراضي آمن أو مستمد من البيئة
const defaultContext: AiToolContext = {
  userId: Number(process.env.AQLAN_MCP_USER_ID || 1),
  username: process.env.AQLAN_MCP_USERNAME || "admin",
  role: (process.env.AQLAN_MCP_ROLE || "admin") as any,
  doctorPartyId: process.env.AQLAN_MCP_DOCTOR_ID ? Number(process.env.AQLAN_MCP_DOCTOR_ID) : null,
  canViewAllPatients: true,
  canViewClinicFinance: true,
  canViewOwnCommissions: true,
  canManageInventory: true,
  todayISO: new Date().toISOString().slice(0, 10),
  isDbConnected: Boolean(process.env.DATABASE_URL || process.env.USE_LOCAL_DB === "true"),
};

// تعريف الأدوات بصيغة JSON Schema متوافقة مع مواصفات MCP
const MCP_TOOLS = Object.values(AI_TOOL_DEFINITIONS).map((tool) => {
  let properties: Record<string, any> = {};
  let required: string[] = [];

  switch (tool.name) {
    case "search_patient":
      properties = {
        term: { type: "string", description: "اسم المريض أو رقم هاتفه أو رقم ملفه السكني (مثال: P-001)" },
      };
      required = ["term"];
      break;
    case "get_patient_summary":
      properties = {
        patientId: { type: "number", description: "الرقم التعريفي الفريد للمريض (ID)" },
      };
      required = ["patientId"];
      break;
    case "get_today_collections":
      properties = {
        currency: { type: "string", enum: ["YER", "SAR", "USD"], description: "العملة المستهدفة للتحصيل" },
      };
      break;
    case "get_revenue_report":
      properties = {
        preset: { type: "string", enum: ["today", "this_week", "this_month", "prev_month", "this_year"], description: "الفترة الزمنية للتقرير" },
        currency: { type: "string", enum: ["YER", "SAR", "USD"], description: "العملة" },
      };
      break;
    case "get_patient_receivables":
      properties = {
        specialty: { type: "string", enum: ["ortho", "general", "implants"], description: "التخصص (تقويم، عام، زراعة)" },
        limit: { type: "number", description: "أقصى عدد للمرضى في القائمة (افتراضي 10)" },
      };
      break;
    case "generate_internal_report":
      properties = {
        reportType: { type: "string", enum: ["daily", "monthly", "annual", "debt", "aging", "specialty", "doctor", "collections"] },
        preset: { type: "string", description: "الفترة الزمنية مثل today, this_month, prev_month" },
        currency: { type: "string", enum: ["YER", "SAR", "USD"] },
        specialty: { type: "string" },
        compare: { type: "string", enum: ["none", "prev_period", "prev_year"] },
      };
      required = ["reportType"];
      break;
    case "get_today_appointments":
      properties = {
        date: { type: "string", description: "التاريخ بصيغة YYYY-MM-DD (افتراضي اليوم)" },
      };
      break;
    case "get_inventory_summary":
      properties = {
        onlyLowStock: { type: "boolean", description: "إظهار المواد الناقصة وتحت حد الطلب فقط" },
      };
      break;
    case "get_service_prices":
      properties = {
        keyword: { type: "string", description: "كلمة بحث عن الخدمة (مثال: تقويم، عصب، حشوة)" },
      };
      break;
    case "get_system_guide":
      properties = {
        query: { type: "string", description: "السؤال عن كيفية استخدام شاشات أو ميزات النظام" },
      };
      required = ["query"];
      break;
  }

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties,
      required,
    },
  };
});

function sendResponse(id: string | number | null, result: any) {
  const payload = {
    jsonrpc: "2.0",
    id,
    result,
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function sendError(id: string | number | null, code: number, message: string) {
  const payload = {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function handleMessage(msg: any) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;

  switch (method) {
    case "initialize": {
      sendResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: "aqlan-center-ai-mcp",
          version: "1.0.0",
        },
      });
      break;
    }

    case "notifications/initialized": {
      // إشعار اكتمال المصافحة
      break;
    }

    case "ping": {
      sendResponse(id, {});
      break;
    }

    case "tools/list": {
      sendResponse(id, {
        tools: MCP_TOOLS,
      });
      break;
    }

    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments || {};

      try {
        const result = await executeAiTool(toolName, args, defaultContext);

        // تعقيم الرد بحارس الخصوصية الصارم
        const sanitizedSummary = deIdentifyClinicalContext(result.textSummary);

        sendResponse(id, {
          content: [
            {
              type: "text",
              text: sanitizedSummary,
            },
          ],
          isError: !result.success,
          _aqlanMetadata: {
            cards: result.cards,
            table: result.table,
            actions: result.actions,
            warnings: result.warnings,
          },
        });
      } catch (err) {
        sendError(id, -32603, `فشل تنفيذ أداة المركز: ${(err as Error).message}`);
      }
      break;
    }

    default: {
      if (id !== undefined && id !== null) {
        sendError(id, -32601, `الطريقة المطلوبة غير معروفة: ${method}`);
      }
      break;
    }
  }
}

export function startMcpServer() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const json = JSON.parse(trimmed);
      void handleMessage(json);
    } catch {
      sendError(null, -32700, "Parse error: invalid JSON");
    }
  });

  process.stderr.write("Aqlan Center MCP Server started successfully over stdio.\n");
}

if (process.env.NODE_ENV !== "test") {
  startMcpServer();
}
