/** Synthetic-only local visual fixture. No application DB, network or real data.
 * Keep this generator with its test fixture, outside the Docker production context. */
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spaceStudyFixture,spaceStudyScope} from '../fixtures/ortho-study-space';
import {studyTextPresentation} from '../../lib/ortho-study-text-export';
import {illustrateSavedStudy} from '../../lib/ortho-study-illustrated';
import {renderStudyTextPptx} from '../../lib/ortho-study-pptx';
import {renderIllustratedStudyPptx} from '../../lib/ortho-study-illustrated-pptx';
async function main(){
 const output=resolve(process.argv[2]??'evidence/space-study-20261106/visual');mkdirSync(output,{recursive:true});
 const {revision}=spaceStudyFixture();
 const text=studyTextPresentation(revision,spaceStudyScope);
 const illustrated=await illustrateSavedStudy(revision,spaceStudyScope,async()=>{throw Error('synthetic_fixture_has_no_images');});
 writeFileSync(join(output,'synthetic-space-text.pptx'),await renderStudyTextPptx(text));
 writeFileSync(join(output,'synthetic-space-illustrated.pptx'),await renderIllustratedStudyPptx(illustrated));
 writeFileSync(join(output,'synthetic-space-presentation.json'),JSON.stringify(text,null,2));
 console.log(JSON.stringify({output,pages:text.pages.length,scope:spaceStudyScope,revisionHash:revision.contentHash}));
}
void main();
