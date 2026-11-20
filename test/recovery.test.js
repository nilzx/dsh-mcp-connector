import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { installRecovery } from '../src/recovery.js'
import { normalizeRecoveries } from '../src/recovery-config.js'
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex')
function fixture(shared = { journal: new Map(), rows: new Map() }, operations = []) {
 const handlers = new Map(), guards = [], warnings = [], wire = [], effects = []; let fault, remoteFailure = false
 const fields = ['context','lifecycle','runtime'], header = { id:'chat',createdAt:10,isSeeded:false,cwd:'/work' }
 if (!shared.rows.size) for(const n of fields) shared.rows.set(n,{sessionId:'chat',createdAt:10,fingerprint:'old',kept:'history',...(n==='context'?{pins:['subject','old-instance'],cursor:'old-cursor',delivery:'old-delivery'}:{phase:'ready',loaded:'old-persona'})})
 const table={get:k=>shared.journal.get(k),entries:()=>shared.journal.entries(),put:async(k,v)=>{if(fault?.when==='before'&&fault.kind===v.phase)throw Error('disk');shared.journal.set(k,structuredClone(v));if(fault?.when==='after'&&fault.kind===v.phase)throw Error('lost durable response')}}
 const ctx={get:n=>n==='storageDomain'?{open:async()=>({table:()=>table,close:async()=>{}})}:n==='sessionQuery'?{readSession:async()=>({session:header,events:[]})}:undefined,
  tools:{guard:f=>(guards.push(f),()=>{})},on:(n,f)=>(handlers.set(n,f),()=>{}),effect:f=>effects.push(f())}
 const c={entry:{name:'service',enabled:true,lifecycle:{group:'g'},runtimeMetadata:{namespace:'test/conversation'}},recoveryCall:async(tool,args,metadata)=>{
  wire.push({tool,args,metadata});if(remoteFailure)throw Error('response lost');return {structuredContent:{operationId:args.requestId,before:['subject','old-instance'],after:['subject','new-instance']}}
 }}
 for(const n of fields)c['recovery'+n[0].toUpperCase()+n.slice(1)]={fingerprint:()=>hash(['new',n]),read:()=>shared.rows.get(n),
  pins:r=>r.pins,owns:()=>true,transform:(r,pins)=>({...r,fingerprint:'new',...(n==='context'?{pins,cursor:null,delivery:null}:{phase:'pending',loaded:null})}),
  put:async(_id,r)=>{if(fault?.when==='before'&&fault.kind===n)throw Error('disk');shared.rows.set(n,structuredClone(r));if(fault?.when==='after'&&fault.kind===n)throw Error('lost durable response')}}
 const mount=()=>installRecovery(ctx,[c],operations,()=>true,{warn:s=>warnings.push(s)})
 const agent={session:{header}},blocked=()=>guards.some(g=>g({agent})!==undefined)
 return {shared,operations,ctx,c,header,mount,wire,warnings,blocked,handlers,agent,table,setFault:f=>{fault=f},setRemoteFailure:v=>{remoteFailure=v},dispose:async()=>{for(const f of effects.reverse())if(typeof f==='function')await f()}}
}
async function prepared(shared) {
 const f=fixture(shared),control=await f.mount(),r=await control.inspect('service','chat')
 const op=normalizeRecoveries([{operationId:'restore-1',server:'service',sessionId:'chat',createdAt:10,configuration:r.configuration,expected:r.expected,
  fromPins:['subject','old-instance'],toPins:['subject','new-instance'],stablePins:[0],tool:'recover',arguments:{requestId:'restore-1'},metadata:{'test/recovery':{requestId:'restore-1'}},
  proof:{operationId:'/operationId',before:['/before/0','/before/1'],after:['/after/0','/after/1']}}])[0]
 await f.dispose();return {shared:f.shared,op}
}
test('explicit recovery preserves history, resets context and gates all paths until durable completion',async()=>{
 const {shared,op}=await prepared(),f=fixture(shared,[op]),r=await f.mount();assert.equal(f.blocked(),true)
 assert.throws(()=>f.handlers.get('agent/pre-step')({agent:f.agent},()=>({kind:'enter'})),/pending/)
 assert.throws(()=>f.handlers.get('llm/stream')({sessionId:'chat'},()=>{}),/pending/)
 await r.run();assert.equal(f.blocked(),false);assert.equal(f.wire.length,1)
 assert.equal(f.wire[0].metadata['test/conversation'].id,'chat');assert.equal(f.wire[0].metadata['test/recovery'].requestId,'restore-1')
 for(const row of shared.rows.values()){assert.equal(row.kept,'history');assert.equal(row.fingerprint,'new')}
 assert.equal(shared.rows.get('context').cursor,null);assert.equal(shared.rows.get('lifecycle').loaded,null)
 await r.run();assert.equal(f.wire.length,1)
})
test('resumes every durable write boundary without losing the gate or replaying a completed transition',async()=>{
 for(const point of ['prepared','remote','context','lifecycle','runtime','complete'])for(const when of ['before','after']) {
  const {shared,op}=await prepared(),f=fixture(shared,[op]),r=await f.mount();f.setFault({kind:point,when});await r.run();await f.dispose()
  const resumed=fixture(shared,[op]),rr=await resumed.mount();await rr.run();assert.equal(resumed.blocked(),false,point+' '+when)
  assert.deepEqual(shared.rows.get('context').pins,['subject','new-instance']);assert.equal(shared.rows.get('runtime').kept,'history')
  if(['remote','context','lifecycle','runtime','complete'].includes(point)&&!(point==='remote'&&when==='before'))assert.equal(resumed.wire.length,0,point+' '+when)
 }
})
test('lost remote response retries the same operation and metadata while local state stays old',async()=>{
 const {shared,op}=await prepared(),f=fixture(shared,[op]),r=await f.mount();f.setRemoteFailure(true);await r.run()
 assert.equal(f.blocked(),true);assert.equal(shared.rows.get('context').fingerprint,'old');f.setRemoteFailure(false);await r.run()
 assert.equal(f.blocked(),false);assert.deepEqual(f.wire[0],f.wire[1])
})
test('a lost completion acknowledgment repairs the gate on private retry without another remote call',async()=>{
 const {shared,op}=await prepared(),f=fixture(shared,[op]),r=await f.mount();f.setFault({kind:'complete',when:'after'});await r.run();assert.equal(f.blocked(),true)
 f.setFault(undefined);await r.run();assert.equal(f.blocked(),false);assert.equal(f.wire.length,1)
})
test('removed pending configuration stays blocked, and changed operation IDs cannot replace a journal',async()=>{
 const {shared,op}=await prepared(),f=fixture(shared,[op]),r=await f.mount();f.setRemoteFailure(true);await r.run();await f.dispose()
 const missing=fixture(shared,[]);await missing.mount();assert.equal(missing.blocked(),true);await missing.dispose()
 const changed=fixture(shared,[{...op,toPins:['subject','other']}]),rr=await changed.mount();await rr.run();assert.equal(changed.blocked(),true);assert.equal(changed.wire.length,0)
})
test('stale local review, altered proof, and metadata override never advance local ownership',async()=>{
 for(const mode of ['review','proof','metadata']) {
  const {shared,op}=await prepared();if(mode==='review')shared.rows.get('context').cursor='concurrent'
  if(mode==='metadata')op.metadata['test/conversation']={id:'forged'}
  const f=fixture(shared,[op]);if(mode==='proof')f.c.recoveryCall=async()=>({structuredContent:{operationId:'restore-1',before:['subject','old-instance'],after:['other-subject','new-instance']}})
  const r=await f.mount();await r.run();assert.equal(f.blocked(),true);assert.equal(shared.rows.get('context').fingerprint,'old');assert.equal(f.wire.length,0)
 }
})
test('completed receipt cannot rewind newer local state when retained in configuration',async()=>{
 const {shared,op}=await prepared(),f=fixture(shared,[op]),r=await f.mount();await r.run();await f.dispose()
 for(const row of shared.rows.values())row.fingerprint='newer'
 const next=fixture(shared,[op]),rr=await next.mount();await rr.run();assert.equal(next.blocked(),false);assert.equal(next.wire.length,0)
 for(const row of shared.rows.values())assert.equal(row.fingerprint,'newer')
})
test('operator schema rejects changed stable identity, reserved metadata and mismatched pin maps',async()=>{
 const {op}=await prepared()
 assert.throws(()=>normalizeRecoveries([{...op,toPins:['other','new-instance']}]))
 assert.throws(()=>normalizeRecoveries([{...op,metadata:{'io.modelcontextprotocol/x':{id:'x'}}}]))
 assert.throws(()=>normalizeRecoveries([{...op,proof:{...op.proof,after:['/after/0']}}]))
 assert.throws(()=>normalizeRecoveries([op,op]))
})
