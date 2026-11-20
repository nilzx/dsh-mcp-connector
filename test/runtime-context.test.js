import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installRuntimeContext, historyFromSnapshot } from '../src/runtime-context.js'
import { normalizeConfig } from '../src/config.js'
const agent = (header = {}) => ({ session: { header: { id:'session-a',createdAt:123,isSeeded:false,delegationDepth:0,...header } } })
const event = (seq,type,data,time=1000+seq) => ({seq,type,data,time})
const snapshot = () => ({session:{id:'session-a',createdAt:123},events:[event(0,'turn/start',{turn:1}),event(1,'user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text:'hello'}]}),event(2,'assistant/message',{message:{role:'assistant',content:[{type:'text',text:'world'}]}}),event(3,'turn/end',{turn:1,reason:{kind:'completed'}}),event(4,'turn/start',{turn:2})]})
async function fixture(shared=new Map()) {
 let snap=snapshot(); const listeners=new Map(), tools=new Map(), effects=[]
 const table={get:k=>shared.get(k),put:async(k,v)=>shared.set(k,structuredClone(v)),delete:async k=>shared.delete(k)}
 const ctx={get:n=>n==='storageDomain'?{open:async()=>({table:()=>table,close:async()=>{}})}:n==='sessionQuery'?{readSession:async()=>structuredClone(snap)}:undefined,effect:f=>effects.push(f()),on:(n,f)=>{listeners.set(n,f);return()=>{}},tools:{register:d=>{tools.set(d.name,d);return()=>tools.delete(d.name)}}}
 const c={entry:{name:'server',transport:'stdio',command:'fixture',runtimeMetadata:{namespace:'io.example/session',historyTools:['activate'],captureTools:['activate']}}}
 await installRuntimeContext(ctx,[c],(_c,a)=>a?.session?.header?.origin!=='subagent')
 const pre=async(a,turn,step,messages=[])=>listeners.get('agent/pre-step')({agent:a,turn,step},async()=>({kind:'enter',messages}))
 return {c,tools,pre,shared,setSnapshot:v=>{snap=v},signal:new AbortController().signal}
}
test('rejects reserved metadata namespace',()=>{
 assert.throws(()=>normalizeConfig({servers:{x:{command:'node',runtimeMetadata:{namespace:'io.modelcontextprotocol/test'}}}}))
})
test('derives header identity and preserves turn across tool steps but changes on steering',async()=>{
 const f=await fixture(),a=agent(); await f.pre(a,2,1,[{id:'u',source:{kind:'user'}}]); let x; await f.c.runtimeCall('activate',{}, {agent:a,signal:f.signal},async (_args,m)=>{x=m;return {content:[]}});
 assert.deepEqual({...x['io.example/session'],history:undefined},{id:'session-a',createdAt:123,parentId:null,temporary:false,seeded:false,turn:x['io.example/session'].turn,history:undefined})
 await f.pre(a,2,2,[]); const y=await f.c.runtimeMeta('other',{agent:a,signal:f.signal}); assert.equal(y['io.example/session'].turn,x['io.example/session'].turn); assert.equal(y['io.example/session'].history,undefined)
 await f.pre(a,2,3,[{id:'steer',source:{kind:'user'}}]); const z=await f.c.runtimeMeta('other',{agent:a,signal:f.signal}); assert.notEqual(z['io.example/session'].turn,y['io.example/session'].turn)
})
test('freezes completed history, flags summary gaps and rejects changed content',async()=>{
 const f=await fixture(),a=agent(); await f.pre(a,2,1); let x; await f.c.runtimeCall('activate',{}, {agent:a,signal:f.signal},async (_args,m)=>{x=m;return {content:[]}}); assert.equal(x['io.example/session'].history.items.length,1)
 let later=snapshot(); later.events.push(event(5,'user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text:'new'}]})); f.setSnapshot(later)
 const tool=f.tools.get('mcp_connector_history'); const result=await tool.execute({server:'server'},{agent:a,signal:f.signal}); assert.equal(result.total,1)
 later.events[1].data.content[0].text='altered'; f.setSnapshot(later); await assert.rejects(()=>tool.execute({server:'server'},{agent:a,signal:f.signal}),/changed/)
 const partial=snapshot(); partial.events[1].data.content.push({type:'image',data:'x'}); const h=historyFromSnapshot(partial); assert.equal(h.history.coverage,'partial'); assert.equal(h.history.items[0].material,'summary')
})
test('restores frozen state, refuses endpoint changes and temporary agents',async()=>{
 const shared=new Map(),f=await fixture(shared),a=agent(); await f.pre(a,2,1); await f.c.runtimeCall('activate',{}, {agent:a,signal:f.signal},async()=>({content:[]}))
 const restored=await fixture(shared); await restored.pre(a,3,1); assert.equal((await restored.c.runtimeMeta('activate',{agent:a,signal:restored.signal}))['io.example/session'].history.items.length,1)
 restored.c.entry.command='changed'; await assert.rejects(()=>restored.c.runtimeMeta('activate',{agent:a,signal:restored.signal}),/changed/)
 const child=agent({origin:'subagent',delegationDepth:1}); await restored.pre(child,1,1); await assert.rejects(()=>restored.c.runtimeMeta('activate',{agent:child,signal:restored.signal}))
})
test('real MCP wire receives host metadata and rejects argument override', async () => {
 const { mkdtemp, writeFile, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
 const { apply } = await import('../index.js'); const { createFakeContext } = await import('./helpers/fake-ctx.js')
 const dir=await mkdtemp(join(tmpdir(),'mcp-meta-test-')); const file=join(dir,'server.mjs')
 const server=import.meta.resolve('@modelcontextprotocol/server'), transport=import.meta.resolve('@modelcontextprotocol/server/stdio'), zod=import.meta.resolve('zod')
 await writeFile(file,`import {McpServer} from ${JSON.stringify(server)}; import {StdioServerTransport} from ${JSON.stringify(transport)}; import {z} from ${JSON.stringify(zod)}; const s=new McpServer({name:'wire',version:'1'}); s.registerTool('probe',{inputSchema:z.object({}).passthrough()},async (_a,extra)=>({content:[{type:'text',text:JSON.stringify(extra.mcpReq._meta)}]})); await s.connect(new StdioServerTransport());`)
 const records=new Map(),table={get:k=>records.get(k),put:async(k,v)=>records.set(k,v)}, a=agent()
 const h=createFakeContext({services:{storageDomain:{open:async()=>({table:()=>table,close:async()=>{}})},sessionQuery:{readSession:async()=>snapshot()},agents:{list:()=>[]}}})
 try {
  await apply(h.ctx,{servers:{wire:{command:process.execPath,args:[file],runtimeMetadata:{namespace:'io.example/session',historyTools:['probe'],captureTools:['probe']},reconnect:{enabled:false}}}})
  for(const listener of h.listeners.get('agent/pre-step')??[]) await listener({agent:a,turn:2,step:1},async()=>({kind:'enter',messages:[]}))
  const out=await h.callTool('mcp__wire__probe',{},a); const sent=JSON.parse(out.content[0].text); assert.equal(sent['io.example/session'].id,'session-a'); assert.equal(sent['io.example/session'].createdAt,123)
  await assert.rejects(()=>h.callTool('mcp__wire__probe',{_meta:{'io.example/session':{id:'forged'}}},a))
  await assert.rejects(()=>h.callTool('mcp__wire__probe',{}),/persistent session|unavailable|conversation/)
 } finally { await h.dispose(); await rm(dir,{recursive:true,force:true}) }
})
test('only explicit successful capture freezes history; clear failures retry and uncertainty preserves boundary', async () => {
 const f=await fixture(), a=agent(); f.c.entry.runtimeMetadata.captureTools=['activate']; f.c.entry.runtimeMetadata.captureRollback={pointer:'/activationEstablished',value:false}
 await f.pre(a,2,1); const exec={agent:a,signal:f.signal}
 await f.c.runtimeCall('ordinary',{},exec,async (_args,meta)=>({content:[{type:'text',text:'ok'}],meta}))
 assert.equal(f.shared.size,0)
 const history=f.tools.get('mcp_connector_history'); await assert.rejects(()=>history.execute({server:'server'},exec))
 let observed
 const clear=await f.c.runtimeCall('activate',{},exec,async (_args,meta)=>{observed=meta; return {isError:true,structuredContent:{activationEstablished:false},content:[]}})
 assert.equal(clear.isError,true); assert.equal(f.shared.size,0)
 const later=snapshot(); later.events.push(event(5,'user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text:'later'}]}),event(6,'assistant/message',{message:{role:'assistant',content:[{type:'text',text:'done'}]}}),event(7,'turn/end',{turn:2,reason:{kind:'completed'}})); f.setSnapshot(later)
 await f.c.runtimeCall('activate',{},exec,async (_args,meta)=>{observed=meta; return {isError:false,content:[{type:'text',text:'ok'}]}})
 assert.equal(observed['io.example/session'].history.items.length,2); assert.equal((await history.execute({server:'server'},exec)).total,2)
})
test('transport uncertainty retains the candidate activation boundary', async () => {
 const f=await fixture(),a=agent(); f.c.entry.runtimeMetadata.captureTools=['activate']; f.c.entry.runtimeMetadata.captureRollback={pointer:'/activationEstablished',value:false}; await f.pre(a,2,1); const exec={agent:a,signal:f.signal}
 await assert.rejects(()=>f.c.runtimeCall('activate',{},exec,async()=>{throw new Error('transport lost')}))
 const later=snapshot(); later.events.push(event(5,'user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text:'later'}]}),event(6,'turn/end',{turn:2,reason:{kind:'completed'}})); f.setSnapshot(later)
 let received; await f.c.runtimeCall('activate',{},exec,async (_args,meta)=>{received=meta;return {content:[{type:'text',text:'ok'}]}})
 assert.equal(received['io.example/session'].history.items.length,1)
})
test('replacement summaries are not originals and missing provenance is explicit',()=>{
 const s=snapshot(); s.events.splice(3,0,event(8,'user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text:'summary only'}]}));s.events[3].surfaceOp={op:'replace',startSeq:99,endSeq:99};s.events[3].sourceEventSeqs=[99]
 const h=historyFromSnapshot(s);assert.equal(h.history.coverage,'partial');assert.ok(h.history.gaps.some(g=>g.reason==='summary_only'));assert.equal(h.history.items[0].material,'original')
})
test('unknown inherited prefix and too many gaps fail honestly',()=>{
 const s=snapshot();s.inheritedEventCount=3; const h=historyFromSnapshot(s);assert.ok(h.history.gaps.some(g=>g.reason==='unavailable'))
 const many={session:{id:'session-a'},events:[]};for(let i=0;i<102;i++)many.events.push(event(i*2,'turn/start',{turn:i}),event(i*2+1,'turn/end',{turn:i,reason:{kind:i===101?'completed':'blocked'}}));assert.throws(()=>historyFromSnapshot(many),/exceeds/)
})
test('summary-only replacement without originals is never represented as original',()=>{
 const s={session:{id:'s'},events:[event(0,'turn/start',{turn:1}),{...event(1,'user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text:'summary'}]}),surfaceOp:{op:'replace',startSeq:99,endSeq:99},sourceEventSeqs:[99]},event(2,'turn/end',{turn:1,reason:{kind:'completed'}})]}
 const h=historyFromSnapshot(s);assert.ok(h.history.gaps.some(g=>g.reason==='summary_only'));assert.ok(h.history.items.every(i=>i.material!=='original'))
})
test('probe resolves pending rollback, but ready history cannot be rolled back',async()=>{
 const f=await fixture(),a=agent();f.c.entry.runtimeMetadata.captureTools=['activate','probe'];f.c.entry.runtimeMetadata.captureRollback={pointer:'/activationEstablished',value:false};await f.pre(a,1,1);const exec={agent:a,signal:f.signal}
 await assert.rejects(()=>f.c.runtimeCall('activate',{},exec,async()=>{throw Error('lost')}));assert.equal([...f.shared.values()][0].state,'pending')
 await f.c.runtimeCall('probe',{},exec,async()=>({structuredContent:{activationEstablished:false},content:[]}));assert.equal(f.shared.size,0)
 await f.c.runtimeCall('activate',{},exec,async()=>({content:[{type:'text',text:'ok'}]}));assert.equal([...f.shared.values()][0].state,'ready')
 await f.c.runtimeCall('probe',{},exec,async()=>({structuredContent:{activationEstablished:false},content:[]}));assert.equal([...f.shared.values()][0].state,'ready')
})
test('runtime inherit requires original parent time and matching endpoint',async()=>{
 const f=await fixture(),parent=agent();await f.pre(parent,1,1);await f.c.runtimeCall('activate',{}, {agent:parent,signal:f.signal},async()=>({content:[]}))
 const child=agent({id:'child',createdAt:456,parentSession:'session-a',isSeeded:true});await f.c.runtimeInherit(child,f.signal)
 const record=[...f.shared.values()].find(v=>v.sessionId==='child');assert.deepEqual(record.source,{sessionId:'session-a',createdAt:123});assert.equal(record.history.items.length,1)
 const bad=agent({id:'bad',createdAt:789,parentSession:'session-a',isSeeded:true});const s=snapshot();s.session.createdAt=999;f.setSnapshot(s);await assert.rejects(()=>f.c.runtimeInherit(bad,f.signal))
 f.setSnapshot(snapshot());f.c.entry.command='changed';await assert.rejects(()=>f.c.runtimeInherit(bad,f.signal))
})
