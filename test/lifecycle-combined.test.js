import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installLifecycle } from '../src/lifecycle.js'
import { installRuntimeContext } from '../src/runtime-context.js'
import { installTurnContext } from '../src/turn-context.js'
test('ready lifecycle forces first refresh on intermediate step before releasing ordinary work',async()=>{
 const handlers=new Map(),tables=new Map(), messages=[], calls=[]
 const ctx={get:n=>n==='storageDomain'?{open:async spec=>({table:()=>{if(!tables.has(spec.name))tables.set(spec.name,new Map());const m=tables.get(spec.name);return{get:k=>m.get(k),put:async(k,v)=>m.set(k,structuredClone(v)),delete:async k=>m.delete(k)}},close:async()=>{}})}:n==='sessionQuery'?{readSession:async()=>({session:{id:'s',createdAt:1},events:[]})}:n==='llm'?{}:undefined,effect:f=>f(),on:(n,f,opts)=>{const a=handlers.get(n)??[];opts?.prepend?a.unshift(f):a.push(f);handlers.set(n,a);return()=>{}},tools:{guard:()=>()=>{},register:()=>()=>{}}}
 const c={entry:{name:'x',enabled:true,transport:'stdio',command:'x',runtimeMetadata:{namespace:'io.example/session',historyTools:['start'],captureTools:['start'],captureRollback:{pointer:'/activationEstablished',value:false}},turnContext:{tool:'refresh',arguments:{},state:{cursor:'/cursor'},pins:['/identity'],maxBytes:4096,delivery:{reloadArguments:{reload:true}}},lifecycle:{group:'g',startTools:['start'],probe:'probe',ready:{start:'/ready',done:'/ready',probe:'/ready'},allowedTools:['done'],localTools:[],maxBytes:4096}},policies:new Map([['mcp__x__refresh','allow'],['mcp__x__probe','allow']])}
 const signal=new AbortController().signal
 const a={session:{header:{id:'s',createdAt:1,isSeeded:false},surface:{contentGeneration:0},deriveMessages:()=>messages},ctx:{tools:{restrict:()=>()=>{},execute:async input=>{calls.push(input.calls[0].name);const r=await c.contextCall('refresh',{}, {agent:a,signal,callId:input.calls[0].id},async()=>({content:[{type:'text',text:'fresh'}],structuredContent:{cursor:'c1',identity:'id'}}));return{results:[{result:{isError:false,value:r}}],additionalContexts:[],concluded:false}}}}}
 const allows=()=>true;await installLifecycle(ctx,[c],allows,{warn(){}});await installRuntimeContext(ctx,[c],allows);await installTurnContext(ctx,[c],allows,{warn(){}})
 async function pre(turn,step){const list=handlers.get('agent/pre-step'), payload={agent:a,signal,turn,step};let i=0;const next=()=>i===list.length?Promise.resolve({kind:'enter',messages:[]}):list[i++](payload,next);return next()}
 await pre(1,1)
 await c.runtimeCall('start',{}, {agent:a,signal},async()=>({content:[{type:'text',text:'persona'}],structuredContent:{ready:false}}))
 await c.lifecycleCall('start',{}, {agent:a,signal,callId:'start'},async()=>({content:[{type:'text',text:'persona'}],structuredContent:{ready:false}}))
 messages.push({role:'tool',toolCallId:'start',isError:false,content:[{type:'text',text:'persona'}]})
 await c.lifecycleCall('done',{}, {agent:a,signal},async()=>({content:[{type:'text',text:'done'}],structuredContent:{ready:true}}))
 const decision=await pre(1,2);assert.deepEqual(calls,['mcp__x__refresh']);assert.match(decision.messages.at(-1).content[0].text,/fresh/);assert.equal(c.contextReady(a),false)
 a.session.surface.contentGeneration++;messages.push(decision.messages.at(-1));assert.equal(c.contextReady(a),true)
 const child={...a,session:{...a.session,header:{id:'child',createdAt:2,origin:'subagent',delegationDepth:1}}};const list=handlers.get('agent/pre-step');let i=0;const next=()=>i===list.length?Promise.resolve({kind:'enter',messages:[]}):list[i++]({agent:child,signal,turn:1,step:1},next);assert.equal((await next()).kind,'enter')
})
