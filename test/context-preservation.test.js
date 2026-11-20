import {createHash} from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextMessage, installTurnContext, reconcileDelivery } from '../src/turn-context.js'
function fixture(shared=new Map()) {
 const handlers=new Map(), calls=[], messages=[]; let response
 const table={get:k=>shared.get(k),put:async(k,v)=>shared.set(k,structuredClone(v))}
 const ctx={get:()=>({open:async()=>({table:()=>table,close:async()=>{}})}),effect:f=>f(),on:(n,f)=>{handlers.set(n,f);return()=>{}}}
 const config={tool:'load',arguments:{},state:{cursor:'/cursor'},pins:['/identity'],maxBytes:10000,pagination:{complete:'/complete',maxPages:3},delivery:{reloadArguments:{reload:true}}}
 const c={entry:{name:'s',enabled:true,transport:'stdio',command:'x',turnContext:config},policies:new Map([['mcp__s__load','allow']])}
 const a={session:{header:{id:'a',createdAt:1,isSeeded:false},surface:{contentGeneration:0},deriveMessages:()=>messages},ctx:{tools:{execute:async input=>{calls.push(input);const r=await c.contextCall('load',{}, {agent:a,signal:input.signal,callId:input.calls[0].id}, invoke);return {results:[{result:{isError:false,value:r}}],additionalContexts:[],concluded:false}}}}}
 const invoke=async args=>{ calls.push({wire:structuredClone(args)}); return response(args) }
 const signal=new AbortController().signal, pre=(turn,step,ms=[])=>handlers.get('agent/pre-step')({agent:a,turn,step,signal},async()=>({kind:'enter',messages:ms}))
 return {ctx,c,a,shared,calls,messages,signal,pre,invoke,setResponse:f=>{response=f}}
}
const page=(cursor,complete,text='page',identity='id')=>({content:[{type:'text',text}],structuredContent:{cursor,complete,identity}})
async function mount(shared) {const f=fixture(shared);await installTurnContext(f.ctx,[f.c],()=>true,{warn(){}});if (!shared || shared.size === 0) await f.pre(1,1);return f}
async function initial(f) {f.setResponse(()=>page('c1',true,'initial'));return f.c.contextCall('load',{}, {agent:f.a,signal:f.signal,callId:'manual'},f.invoke)}
const sessionModule = process.env.DSH_SESSION_MODULE
const {Session}=sessionModule ? await import(sessionModule) : {}
async function actual(){const f=await mount(),s=Session.create('a',[],{type:'session',version:4,id:'a',createdAt:1,isSeeded:false});f.a.session=s;const sys=s.append('system/message',{turn:1,step:1,message:{id:'sys',role:'system',source:{kind:'system-prompt'},content:[{type:'text',text:'old'}]}},{surfaceOp:'append'});await initial(f);const anchor=s.append('tool/result',{turn:1,step:1,message:{id:'tool',role:'tool',source:{kind:'tool',callId:'manual'},toolCallId:'manual',content:[{type:'text',text:'initial'}],isError:false}},{surfaceOp:'append'});f.setResponse(()=>page('c2',true,'delta'));const d=await f.pre(2,1);return {f,s,sys,anchor,msg:d.messages.at(-1)}}
function system(f){f.s.append('system/message',{turn:2,step:1,message:{id:'sys2',role:'system',source:{kind:'system-prompt'},content:[{type:'text',text:'new'}]}},{surfaceOp:{op:'replace',startSeq:f.sys.seq,endSeq:f.sys.seq},sourceEventSeqs:[f.sys.seq]})}
test('automatic proof accepts system replacement with genuine Session messages',{skip:!sessionModule},async()=>{const x=await actual();system(x);x.s.append('user/message',x.msg,{surfaceOp:'append'});assert.equal(x.f.c.contextReady(x.f.a),true);await x.f.pre(2,2);assert.equal([...x.f.shared.values()][0].servers.s.arguments.cursor,'c2')})
test('automatic proof refuses replaced prior non-system context',{skip:!sessionModule},async()=>{const x=await actual();x.s.append('user/message',{id:'summary',role:'user',source:{kind:'user'},content:[{type:'text',text:'summary'}]},{surfaceOp:{op:'replace',startSeq:x.anchor.seq,endSeq:x.anchor.seq},sourceEventSeqs:[x.anchor.seq]});x.s.append('user/message',x.msg,{surfaceOp:'append'});assert.equal(x.f.c.contextReady(x.f.a),false);await x.f.pre(2,2);assert.equal(x.f.calls.filter(c=>c.wire).at(-1).wire.reload,true)})
test('restart cannot reuse old in-memory proof',{skip:!sessionModule},async()=>{const x=await actual();system(x);x.s.append('user/message',x.msg,{surfaceOp:'append'});const y=await mount(x.f.shared);y.a.session=x.s;assert.equal(y.c.contextReady(y.a),false);y.setResponse(()=>page('c3',true,'full'));await y.pre(3,1);assert.equal(y.calls.filter(c=>c.wire).at(-1).wire.reload,true)})
test('different session object cannot reuse proof',{skip:!sessionModule},async()=>{const x=await actual();system(x);x.s.append('user/message',x.msg,{surfaceOp:'append'});x.f.a.session={header:x.s.header,surface:x.s.surface,deriveMessages:()=>x.s.deriveMessages()};assert.equal(x.f.c.contextReady(x.f.a),false)})

test('ordered frozen proof rejects reorder and mutable basis',()=>{const a=Object.freeze({id:'a',role:'user',source:{kind:'user'},content:[]}),b=Object.freeze({id:'b',role:'user',source:{kind:'user'},content:[]}),m=contextMessage('s','delta','fresh',true);const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');const state={arguments:{},delivery:{generation:0,pending:{marker:{id:'fresh',digest:hash('delta')},arguments:{cursor:'new'},full:false}}};const session={surface:{contentGeneration:1},deriveMessages:()=>[b,a,m]},agent={session};assert.equal(reconcileDelivery(state,agent,'s',{session,markerId:'fresh',messages:[a,b]}).undelivered,true);session.deriveMessages=()=>[a,b,m];const mutable={...a};session.deriveMessages=()=>[mutable,b,m];assert.equal(reconcileDelivery(state,agent,'s',{session,markerId:'fresh',messages:[mutable,b]}).undelivered,true)})
