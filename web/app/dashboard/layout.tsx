import { ReactNode } from 'react';
import Link from 'next/link';
import { Building2 } from 'lucide-react';

/**
 * Authority-context banner for /dashboard.
 *
 * This is nested INSIDE the root layout, which already supplies <header>, <main>, the max-width
 * wrapper and the footer. It must therefore not render its own header/main or set a page
 * background: an earlier revision wrapped the route in `min-h-screen bg-gray-50` with a second
 * white header bar, which put the dashboard's dark slate cards on a light background and showed
 * two stacked navigation bars.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Building2 className="w-4 h-4 text-amber-400 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-amber-200">Authority view</p>
            <p className="text-[11px] text-slate-400">
              Operator tooling for policies and the cohort root — not the beneficiary flow.
            </p>
          </div>
        </div>
        <Link
          href="/"
          className="text-xs font-semibold text-slate-300 hover:text-white underline decoration-slate-600 hover:decoration-white shrink-0"
        >
          Back to beneficiary app
        </Link>
      </div>

      {children}
    </div>
  );
}
