"use client";
import React from 'react';
import { X } from 'lucide-react';
import { Language, PatientCase, RecordStage, UserRole } from '../types/ortho';
import { tr } from '../i18n/translations';
import { CbctStudio } from './CbctStudio';

interface DicomViewerModalProps {
  open: boolean;
  lang: Language;
  initialUrl?: string;
  title?: string;
  patient?: PatientCase;
  stage?: RecordStage;
  role?: UserRole;
  actorName?: string;
  onChange?: (next: PatientCase, timelineMsg?: { ar: string; en: string }) => void;
  onClose: () => void;
  onCalibrateFromDicom?: (pixelsPerMm: number, source: string) => void;
}

export const DicomViewerModal: React.FC<DicomViewerModalProps> = ({
  open,
  lang,
  initialUrl,
  title,
  patient,
  stage,
  role,
  actorName,
  onChange,
  onClose,
  onCalibrateFromDicom,
}) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-navy-950/85 flex items-center justify-center p-3 md:p-6 overflow-y-auto">
      <div className="bg-canvas border border-navy-200 rounded-2xl w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 bg-navy-900 text-white border-b border-navy-800">
          <h3 className="text-sm font-bold">
            {title || tr(lang, 'وحدة السي بي سي تي وعارض DICOM ثلاثي الأبعاد', 'CBCT 3D MPR & DICOM Suite')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 hover:bg-navy-800 rounded-lg text-navy-300 hover:text-white"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto">
          <CbctStudio
            patient={patient}
            stage={stage}
            lang={lang}
            role={role}
            actorName={actorName}
            initialUrl={initialUrl}
            onChange={onChange}
            onCalibrateFromDicom={onCalibrateFromDicom}
          />
        </div>
      </div>
    </div>
  );
};
