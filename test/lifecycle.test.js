import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installLifecycle } from '../src/lifecycle.js'
const stream=async function*(xs){for(const x of xs)yield x}
const tool=(name='mcp__s__init')=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',id:'x',name,arguments:'{}'}},{type:'finish',reason:{kind:'tool-calls'}}]
async function fixture(shared=new Map()) {
 const listeners=new Map(),guards=[],effects=[],calls=[],messages=[], restrictions={installed:0,released:0,active:0};let contextReady=false, probeReady=false, probeError=false
 const table={get:k=>shared.get(k),put:async(k,v)=>shared.set(k,structuredClone(v))}
 const ctx={get:n=>n==='storageDomain'?{open:async()=>({table:()=>table,close:async()=>{}})}:n==='llm'?{}:undefined,effect:f=>effects.push(f()),on:(n,f)=>{listeners.set(n,f);return()=>{}},tools:{guard:f=>{guards.push(f);return()=>{}}}}
 const cfg={group:'personal',startTools:['start'],probe:'probe',ready:{start:'/ready',probe:'/ready',done:'/ready'},allowedTools:['init','done'],localTools:['history'],maxBytes:4096}
 const c={entry:{name:'s',enabled:true,transport:'stdio',command:'x',runtimeMetadata:{captureRollback:{pointer:'/activationEstablished',value:false}},turnContext:{tool:'refresh'},lifecycle:cfg},policies:new Map([['mcp__s__probe','allow']]),contextReady:()=>contextReady}
 const a={session:{header:{id:'session',createdAt:1},surface:{contentGeneration:0},deriveMessages:()=>[...messages]},ctx:{tools:{restrict:()=>{restrictions.installed++;restrictions.active++;return()=>{restrictions.released++;restrictions.active--}},execute:async input=>{calls.push(input);if(probeError)throw Error('offline');const r=await c.lifecycleCall('probe',{}, {agent:a,signal:input.signal,callId:'probe-id'},async()=>({content:[{type:'text',text:'persona'}],structuredContent:{ready:probeReady}}));return {results:[{result:{isError:false,value:r}}],additionalContexts:[],concluded:false}}}}}
 const other={entry:{...c.entry,name:'other'},policies:new Map([['mcp__other__probe','allow']]),contextReady:()=>false}
 await installLifecycle(ctx,[c,other],(_c,agent)=>agent===a,{warn(){}})
 const signal=new AbortController().signal,pre=(turn,step,ms=[])=>listeners.get('agent/pre-step')({agent:a,signal,turn,step},async()=>({kind:'enter',messages:ms}))
 const call=(name, result)=>c.lifecycleCall(name,{}, {agent:a,signal,callId:'call-'+name},async()=>result)
 return {ctx,c,other,a,signal,pre,call,restrictions,guards,listeners,messages,calls,shared,setContext:v=>{contextReady=v},setProbe:v=>{probeReady=v},setProbeError:v=>{probeError=v}}
}
async function collect(iter){const out=[];let error;try{for await(const x of iter)out.push(x)}catch(e){error=e}return {out,error}}
const started={content:[{type:'text',text:'persona'}],structuredContent:{ready:false}}
test('neutral remains unrestricted and ordinary stream passes unchanged',async()=>{const f=await fixture();assert.equal(f.guards[0]({agent:f.a,name:'ordinary'}),undefined);const chunks=[{type:'block-start',index:0,blockType:'text'}];const r=await collect(f.listeners.get('llm/stream')({sessionId:'session'},()=>stream(chunks)));assert.deepEqual(r.out,chunks)})
test('pending survives lost start; explicit rollback releases ownership',async()=>{const f=await fixture();await assert.rejects(()=>f.c.lifecycleCall('start',{}, {agent:f.a,signal:f.signal},async()=>{throw Error('lost')}));assert.ok(f.guards[0]({agent:f.a,name:'ordinary'}));const f2=await fixture();await f2.call('start',{isError:true,content:[],structuredContent:{activationEstablished:false}});assert.equal(f2.guards[0]({agent:f2.a,name:'ordinary'}),undefined)})
test('requires actual persona delivery before initialization tools and holds plain answers',async()=>{const f=await fixture();await f.call('start',started);assert.ok(f.guards[0]({agent:f.a,name:'mcp__s__init'}));f.messages.push({role:'tool',toolCallId:'call-start',isError:false,content:[{type:'text',text:'persona'}]});assert.equal(f.guards[0]({agent:f.a,name:'mcp__s__init'}),undefined);await f.pre(1,2);const opts={sessionId:'session',signal:f.signal,messages:f.a.session.deriveMessages()};const r=await collect(f.listeners.get('llm/stream')(opts,()=>stream([{type:'block-start',index:0,blockType:'text'},{type:'block-end',index:0,block:{type:'text',text:'secret'}},{type:'finish',reason:{kind:'stop'}}])));assert.ok(r.error);assert.deepEqual(r.out,[])})
test('ready remains gated until refresh admission; scope and endpoint changes fail closed',async()=>{const f=await fixture();await f.call('start',started);f.messages.push({role:'tool',toolCallId:'call-start',isError:false,content:[{type:'text',text:'persona'}]});await f.call('done',{content:[{type:'text',text:'done'}],structuredContent:{ready:true}});assert.ok(f.guards[0]({agent:f.a,name:'ordinary'}));f.setContext(true);assert.equal(f.guards[0]({agent:f.a,name:'ordinary'}),undefined);f.c.entry.command='changed';assert.ok(f.guards[0]({agent:f.a,name:'ordinary'}))})

test('same group rejects competing service and pending recovery errors block admission',async()=>{
 const f=await fixture();await assert.rejects(()=>f.c.lifecycleCall('start',{}, {agent:f.a,signal:f.signal},async()=>{throw Error('lost')}));
 assert.ok(f.guards[0]({agent:f.a,name:'mcp__other__start'}));
 await assert.rejects(()=>f.other.lifecycleCall('start',{}, {agent:f.a,signal:f.signal},async()=>started));
 f.setProbeError(true);await assert.rejects(()=>f.pre(2,1));f.setProbeError(false);const d=await f.pre(3,1);assert.ok(d.messages.some(m=>m.source?.kind==='mcp-connector-context'))
})
test('dispatch gate rechecks a previously admitted ordinary call after start',async()=>{
 const f=await fixture(), exec={agent:f.a,name:'ordinary'}
 assert.equal(f.guards[0](exec),undefined)
 await f.call('start',started)
 let ran=false;await assert.rejects(()=>f.listeners.get('tools/execute')(exec,async()=>{ran=true}));assert.equal(ran,false)
})
test('real Session fresh derived arrays match, changed surface rejects',async t=>{
 const path=process.env.DSH_SESSION_MODULE;if(!path){t.skip('DSH_SESSION_MODULE not set');return}const {Session}=await import(path);const f=await fixture();
 const session=Session.create('session',[],{type:'session',version:4,id:'session',createdAt:1,isSeeded:false});f.a.session=session
 const system=session.append('system/message',{turn:1,step:1,message:{id:'sys',role:'system',source:{kind:'system-prompt'},content:[{type:'text',text:'base'}]}},{surfaceOp:'append'})
 await f.call('start',started)
 session.append('tool/result',{turn:1,step:1,message:{id:'tool',role:'tool',source:{kind:'tool',callId:'call-start'},toolCallId:'call-start',content:[{type:'text',text:'persona'}],isError:false}},{surfaceOp:'append'})
 session.append('system/message',{turn:1,step:2,message:{id:'sys2',role:'system',source:{kind:'system-prompt'},content:[{type:'text',text:'updated'}]}},{surfaceOp:{op:'replace',startSeq:system.seq,endSeq:system.seq},sourceEventSeqs:[system.seq]});assert.equal(f.guards[0]({agent:f.a,name:'mcp__s__init'}),undefined)
 await f.pre(1,2);const first=session.deriveMessages(), second=session.deriveMessages();assert.notEqual(first,second);assert.ok(first.every((m,i)=>m===second[i]))
 const opts={sessionId:'session',signal:f.signal,messages:first}, accepted=await collect(f.listeners.get('llm/stream')(opts,()=>stream(tool('mcp__s__init'))));assert.ifError(accepted.error);assert.ok(accepted.out.length>0)
 const added=session.append('user/message',{id:'new',role:'user',source:{kind:'user'},content:[{type:'text',text:'new'}]},{surfaceOp:'append'})
 const rejected=await collect(f.listeners.get('llm/stream')(opts,()=>stream(tool('mcp__s__init'))));assert.ok(rejected.error);assert.deepEqual(rejected.out,[])
 const prior=session.deriveMessages();session.append('user/message',{id:'replaced',role:'user',source:{kind:'user'},content:[{type:'text',text:'changed'}]},{surfaceOp:{op:'replace',startSeq:added.seq,endSeq:added.seq},sourceEventSeqs:[added.seq]});const replaced=await collect(f.listeners.get('llm/stream')({...opts,messages:prior},()=>stream(tool('mcp__s__init'))));assert.ok(replaced.error);assert.deepEqual(replaced.out,[])
})
test('restriction is stable during initialization and released before complete returns',async()=>{
 const f=await fixture();await f.call('start',started);assert.equal(f.restrictions.active,1);const installed=f.restrictions.installed
 f.messages.push({role:'tool',toolCallId:'call-start',isError:false,content:[{type:'text',text:'persona'}]})
 await f.pre(1,2);await f.pre(1,3);assert.equal(f.restrictions.installed,installed);assert.equal(f.restrictions.released,0)
 await f.call('done',{content:[{type:'text',text:'done'}],structuredContent:{ready:true}});assert.equal(f.restrictions.active,0);assert.equal(f.restrictions.released,1)
})
