import { Activity, type LucideIcon } from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Only routes that are actually implemented appear here.
 * Each phase adds its module's entries (and, from Phase 2, permission filtering).
 */
export const navGroups: NavGroup[] = [
  {
    label: 'System',
    items: [{ label: 'System status', to: '/', icon: Activity }],
  },
];
