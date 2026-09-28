import type { ReactNode } from 'react';
import { Icon, type IconName } from '../icons.tsx';

/** The one header every full-page view shares: what this place is for, and its main actions. */
export function PageHeader({ icon, title, sub, children }: { icon: IconName; title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <span className="ph-icon" aria-hidden><Icon name={icon} size={18} /></span>
      <div className="ph-text">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      <div className="spacer" />
      {children && <div className="ph-actions">{children}</div>}
    </header>
  );
}
