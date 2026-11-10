import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { readStudyExportCommand } from '../lib/ortho-study-export-archive-contract';
import { ORTHO_STUDY_EXPORT_ARCHIVE_SQL } from '../lib/ortho-study-export-archive-schema';
const command={schemaVersion:1,clientRequestId:'synthetic_request_123',revisionId:1,revisionHash:'a'.repeat(64),format:'text-pptx'};
it('admits only exact browser intent, never storage, authority or renderer parameters',()=>{
 expect(readStudyExportCommand(command)).toEqual(command);
 for(const extra of ['storageKey','patientId','renderer','canExportStudies','manifest']) expect(()=>readStudyExportCommand({...command,[extra]:'arbitrary'})).toThrow();
 for(const value of [null,[],{...command,revisionId:0},{...command,revisionHash:'A'.repeat(64)},{...command,format:'pdf'},{...command,clientRequestId:'short'}])expect(()=>readStudyExportCommand(value)).toThrow();
});
it('runtime mirror is byte-identical to the numbered migration',async()=>{
 expect(ORTHO_STUDY_EXPORT_ARCHIVE_SQL).toBe(await readFile('migrations/0123_ortho_study_export_archive.sql','utf8'));
});
