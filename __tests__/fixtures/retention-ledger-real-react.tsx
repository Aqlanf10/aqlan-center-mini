import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {OrthoRetentionPanel} from '../../components/PatientOrtho';
function Fixture(){const [open,setOpen]=useState(true);return <><button onClick={()=>setOpen(v=>!v)}>Toggle synthetic panel</button>{open&&<OrthoRetentionPanel patientId={1} row={{id:2} as never}/>}</>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
