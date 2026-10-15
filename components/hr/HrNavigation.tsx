'use client';
import { createContext, useContext, useState } from 'react';
import type { HrProfileTab } from '@/lib/hr-navigation';
export const HrNavigationContext = createContext<{
  staffId: string;
  profileTab: HrProfileTab;
  contractId: string;
  href: (patch: Record<string, string | null>) => string;
  selectStaff: (id: string) => void;
  closeProfile: () => void;
} | null>(null);
export const useHrNavigation = () => useContext(HrNavigationContext);
export function useHrStaffSelection(): [string, (id: string) => void] {
  const nav = useHrNavigation();
  const [local, setLocal] = useState('');
  return nav ? [nav.staffId, nav.selectStaff] : [local, setLocal];
}
