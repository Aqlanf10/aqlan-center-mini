'use client';
import { useEffect, useState } from 'react';
/** Refresh visible operational views at least once a minute and when returning to them. */
export function useHrReadEpoch() {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setEpoch(value => value + 1); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('hr-employment-changed', refresh);
    return () => {
      window.clearInterval(timer); window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh); window.removeEventListener('hr-employment-changed', refresh);
    };
  }, []);
  return epoch;
}
