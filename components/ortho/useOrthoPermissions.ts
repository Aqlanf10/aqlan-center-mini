"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  OrthoFieldKey,
  OrthoPermissionKey,
  OrthoSectionKey,
} from "@/lib/ortho-privacy";

export interface EffectiveOrthoPermissions {
  loading: boolean;
  moduleVisible: boolean;
  isOwner: boolean;
  permissions: Partial<Record<OrthoPermissionKey, boolean>>;
  sections: Partial<Record<OrthoSectionKey, boolean>>;
  fields: Partial<Record<OrthoFieldKey, boolean>>;
  can: (perm: OrthoPermissionKey) => boolean;
  canSection: (sec: OrthoSectionKey) => boolean;
  canField: (field: OrthoFieldKey) => boolean;
  reload: () => Promise<void>;
}

interface RawPermissionsResponse {
  moduleVisible?: boolean;
  isOwner?: boolean;
  permissions?: Partial<Record<OrthoPermissionKey, boolean>>;
  sections?: Partial<Record<OrthoSectionKey, boolean>>;
  fields?: Partial<Record<OrthoFieldKey, boolean>>;
}

export function useOrthoPermissions(options: {
  enabled?: boolean;
  patientId?: number | null;
  orthoCaseId?: number | null;
} = {}): EffectiveOrthoPermissions {
  const { enabled = true, patientId = null, orthoCaseId = null } = options;
  const [state, setState] = useState<{
    loading: boolean;
    moduleVisible: boolean;
    isOwner: boolean;
    permissions: Partial<Record<OrthoPermissionKey, boolean>>;
    sections: Partial<Record<OrthoSectionKey, boolean>>;
    fields: Partial<Record<OrthoFieldKey, boolean>>;
  }>({
    loading: enabled,
    moduleVisible: true,
    isOwner: false,
    permissions: {},
    sections: {},
    fields: {},
  });

  const load = useCallback(async () => {
    if (!enabled) return;
    const params = new URLSearchParams();
    if (patientId && patientId > 0) params.set("patientId", String(patientId));
    if (orthoCaseId && orthoCaseId > 0) params.set("orthoCaseId", String(orthoCaseId));
    const qs = params.toString();
    try {
      const res = await fetch(`/api/ortho/my-permissions${qs ? `?${qs}` : ""}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setState((prev) => ({ ...prev, loading: false, moduleVisible: false, permissions: {}, sections: {}, fields: {} }));
        return;
      }
      const data = (await res.json()) as RawPermissionsResponse;
      setState({
        loading: false,
        moduleVisible: data.moduleVisible === true,
        isOwner: data.isOwner === true,
        permissions: data.permissions ?? {},
        sections: data.sections ?? {},
        fields: data.fields ?? {},
      });
    } catch {
      // Fail-closed if permission endpoint cannot be reached
      setState((prev) => ({ ...prev, loading: false, moduleVisible: false, permissions: {}, sections: {}, fields: {} }));
    }
  }, [enabled, patientId, orthoCaseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const can = useCallback(
    (perm: OrthoPermissionKey) => state.moduleVisible && state.permissions[perm] === true,
    [state.moduleVisible, state.permissions],
  );

  const canSection = useCallback(
    (sec: OrthoSectionKey) => state.moduleVisible && state.sections[sec] === true,
    [state.moduleVisible, state.sections],
  );

  const canField = useCallback(
    (field: OrthoFieldKey) => state.moduleVisible && state.fields[field] === true,
    [state.moduleVisible, state.fields],
  );

  return {
    ...state,
    can,
    canSection,
    canField,
    reload: load,
  };
}
