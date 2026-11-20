import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installLifecycle } from '../src/lifecycle.js'
import { normalizeConfig } from '../src/config.js'
const server=()=>({command:'node',delegation:'deny',runtimeMetadata:{namespace:'io.example/session',historyTools:['start','probe'],captureTools:['start','probe']},turnContext:{tool:'refresh',arguments:{},state:{cursor:'/cursor'},pins:['/identity'],delivery:{reloadArguments:{reload:true}}},lifecycle:{group:'g',startTools:['start'],probe:'probe',ready:{start:'/ready',probe:'/ready'},allowedTools:[],requireCreationAdmission:true}})
async function fixture({ version=1, required=true, records=new Map() }={}) {
 const listeners=new Map();let opened=0
 const ctx={get:n=>n==='sessions'?{preparationAdmissionVersion:version}:n==='llm'?{}:n==='storageDomain'?{open:async()=>{opened++;return {table:()=>({get:k=>records.get(k),put:async(k,v)=>records.set(k,structuredClone(v))}),close:async()=>{}}}}:undefined,effect:f=>f(),on:(n,f)=>{listeners.set(n,f);return()=>{}},tools:{guard:()=>()=>{}}}
 const c={entry:normalizeConfig({servers:{generic:server()}}).servers[0]};if(!required)delete c.entry.lifecycle.requireCreationAdmission
 const allows=(_c,a)=>a?.session?.header?.cwd==='/enabled'&&a.session.header.origin===undefined
 await installLifecycle(ctx,[c],allows,{warn(){}},(_c,a)=>a?.session?.header?.cwd==='/enabled')
 const a={session:{header:{id:'parent',createdAt:1,cwd:'/enabled'},surface:{contentGeneration:0},deriveMessages:()=>[]},ctx:{tools:{restrict:()=>()=>{}}}}
 const signal=new AbortController().signal
 const start=()=>c.lifecycleCall('start',{}, {agent:a,signal,callId:'start'},async()=>({content:[{type:'text',text:'synthetic context'}],structuredContent:{ready:false}}))
 const admit=(header={},extra={})=>listeners.get('session/preparing')({header:{id:'child',createdAt:2,cwd:'/enabled',isSeeded:false,...header},hasSeed:false,seedEventCount:0,inheritedEventCount:0,restoration:false,...extra})
 return {c,a,ctx,listeners,records,start,admit,get opened(){return opened}}
}
test('creation admission is opt in on older hosts and explicitly required without downgrade',async()=>{
 await assert.rejects(()=>fixture({version:0}),/requires host session preparation admission/)
 const old=await fixture({version:0,required:false});assert.equal(old.listeners.has('session/preparing'),false)
 for(const value of ['true',1,null]){const x=server();x.lifecycle.requireCreationAdmission=value;assert.throws(()=>normalizeConfig({servers:{x}}),/must be a boolean/)}
 const x=server();x.lifecycle.requireCreationAdmission=false;assert.equal(Object.hasOwn(normalizeConfig({servers:{x}}).servers[0].lifecycle,'requireCreationAdmission'),false)
})
test('fresh root and fresh helper need no workflow ownership or writes',async()=>{
 const f=await fixture();assert.doesNotThrow(()=>f.admit());assert.doesNotThrow(()=>f.admit({origin:'subagent',delegationDepth:1,parentSession:'parent'}));assert.equal(f.records.size,0)
})
test('unknown inherited destinations are refused before host construction',async()=>{
 const f=await fixture();assert.throws(()=>f.admit({isSeeded:true},{hasSeed:true,seedEventCount:1}),/no trusted workflow parent/)
 assert.throws(()=>f.admit({},{hasSeed:true,seedEventCount:1}),/no trusted workflow parent/)
 for(const marker of [{isSeeded:true},{}])assert.throws(()=>f.admit({origin:'subagent',...marker},{hasSeed:true,seedEventCount:1}),/before construction/)
 assert.doesNotThrow(()=>f.admit({cwd:'/outside',origin:'subagent',isSeeded:true},{hasSeed:true,seedEventCount:1}))
})
test('protected parent stays protected across scope changes and disabled configuration',async()=>{
 const f=await fixture();await f.start()
 assert.throws(()=>f.admit({parentSession:'parent',origin:'subagent',cwd:'/outside',isSeeded:true},{seedEventCount:1}),/before construction/)
 assert.doesNotThrow(()=>f.admit({parentSession:'parent',isSeeded:true},{seedEventCount:1,inheritedEventCount:1}))
 f.c.entry.enabled=false
 assert.throws(()=>f.admit({parentSession:'parent',origin:'subagent',cwd:'/outside',isSeeded:true}),/before construction/)
 assert.throws(()=>f.admit({parentSession:'parent',isSeeded:true}),/configuration changed/)
})
test('restoration checks exact identity and changed service but admission policy preserves ownership',async()=>{
 const f=await fixture();await f.start();const header={...f.a.session.header,isSeeded:true}
 assert.doesNotThrow(()=>f.admit(header,{restoration:true,seedEventCount:2,inheritedEventCount:1}))
 assert.throws(()=>f.admit({...header,origin:'subagent'},{restoration:true}),/persistent workflow cannot/)
 assert.throws(()=>f.admit({...header,createdAt:5},{restoration:true}),/identity changed/)
 delete f.c.entry.lifecycle.requireCreationAdmission;assert.doesNotThrow(()=>f.admit(header,{restoration:true}))
 f.c.entry.command='changed';assert.throws(()=>f.admit(header,{restoration:true}),/removed, changed or restricted/)
})
