"use client";

import { formatToman } from "@/lib/money";

interface PnlLine {
  accountCode: string;
  accountName: string;
  amount: number;
}

export interface ProfitAndLoss {
  revenue: PnlLine[];
  expenses: PnlLine[];
  totalRevenue: number;
  totalExpenses: number;
  netIncome: number;
}

export interface BalanceSheet {
  assets: PnlLine[];
  liabilities: PnlLine[];
  equity: PnlLine[];
  retainedEarnings: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  balanced: boolean;
}

function Section({ heading, lines, total, totalLabel }: { heading: string; lines: PnlLine[]; total: number; totalLabel: string }) {
  return (
    <div className="mb-4">
      <h3 className="mb-2 font-semibold">{heading}</h3>
      <table className="w-full text-sm">
        <tbody>
          {lines.map((l) => (
            <tr key={l.accountCode} className="border-b border-border">
              <td className="py-1.5 pe-3 text-muted-foreground">{l.accountCode}</td>
              <td className="py-1.5 pe-3">{l.accountName}</td>
              <td className="py-1.5 text-end tabular-nums">{formatToman(l.amount)}</td>
            </tr>
          ))}
          {lines.length === 0 ? (
            <tr>
              <td colSpan={3} className="py-2 text-center text-muted-foreground">
                بدون سطر
              </td>
            </tr>
          ) : null}
          <tr className="border-t-2 border-input font-semibold">
            <td className="py-1.5 pe-3" colSpan={2}>
              {totalLabel}
            </td>
            <td className="py-1.5 text-end tabular-nums">{formatToman(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function ProfitAndLossView({ report }: { report: ProfitAndLoss }) {
  return (
    <div>
      <Section heading="درآمدها" lines={report.revenue} total={report.totalRevenue} totalLabel="جمع درآمدها" />
      <Section heading="هزینه‌ها" lines={report.expenses} total={report.totalExpenses} totalLabel="جمع هزینه‌ها" />
      <div className="mt-4 flex items-center justify-between rounded-xl bg-muted px-4 py-3 font-bold">
        <span>سود (زیان) خالص</span>
        <span className={report.netIncome < 0 ? "text-destructive" : ""}>{formatToman(report.netIncome)}</span>
      </div>
    </div>
  );
}

export function BalanceSheetView({ report }: { report: BalanceSheet }) {
  const equityLines = [...report.equity, { accountCode: "", accountName: "سود انباشته (جاری)", amount: report.retainedEarnings }];
  return (
    <div>
      <Section heading="دارایی‌ها" lines={report.assets} total={report.totalAssets} totalLabel="جمع دارایی‌ها" />
      <Section heading="بدهی‌ها" lines={report.liabilities} total={report.totalLiabilities} totalLabel="جمع بدهی‌ها" />
      <Section
        heading="حقوق صاحبان سرمایه"
        lines={equityLines}
        total={report.totalEquity}
        totalLabel="جمع حقوق صاحبان سرمایه"
      />
      <div className="mt-4 flex items-center justify-between rounded-xl bg-muted px-4 py-3 font-bold">
        <span>وضعیت تراز</span>
        <span className={report.balanced ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}>
          {report.balanced ? "متوازن" : "نامتوازن"}
        </span>
      </div>
    </div>
  );
}
