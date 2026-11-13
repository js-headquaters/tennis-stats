import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export default function IconLabel({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return <span className="icon-label"><Icon aria-hidden="true" focusable="false" /><span className="icon-label-text">{children}</span></span>;
}
