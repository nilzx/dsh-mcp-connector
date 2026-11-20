import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installTurnContext } from '../src/turn-context.js'
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
test('merges pages and does not advance an undelivered cursor',async()=>{
 const f=await mount(); await initial(f); f.setResponse(args=>args.cursor==='c2'?page('c3',true,'two'):page('c2',false,'one'))
 const d=await f.pre(2,1); assert.match(d.messages.at(-1).content[0].text,/one\n\ntwo/)
 const wires=f.calls.filter(x=>x.wire); assert.equal(wires.at(-2).wire.reload,true); assert.equal(wires.at(-1).wire.cursor,'c2')
 const state=[...f.shared.values()][0].servers.s; assert.deepEqual(state.arguments,{}); assert.equal(state.delivery.pending.arguments.cursor,'c3')
})
test('rejects stalled pages, page limit and cross-page identity changes',async()=>{
 for(const mode of ['stalled','limit','pin']) {const f=await mount();await initial(f);let n=0;f.setResponse(()=>page(mode==='stalled'?'same':`c${++n}`,false,'x',mode==='pin'&&n>1?'other':'id'));await assert.rejects(()=>f.pre(2,1),{name:'McpTurnContextError'})}
})
test('confirms manual result by call id and hash, and reloads after compaction',async()=>{
 const f=await mount();await initial(f);f.messages.push({role:'tool',toolCallId:'manual',isError:false,content:[{type:'text',text:'initial'}]});f.setResponse(()=>page('c2',true,'next'))
 const d=await f.pre(2,1);const wire=f.calls.filter(x=>x.wire).at(-1).wire;assert.equal(wire.cursor,'c1');assert.equal(wire.reload,undefined)
 f.messages.push(d.messages.at(-1));await f.pre(2,2);const n=f.calls.length;await f.pre(2,3);assert.equal(f.calls.length,n)
 f.a.session.surface.contentGeneration++;await f.pre(3,1);assert.equal(f.calls.filter(x=>x.wire).at(-1).wire.reload,true)
})
test('retries undelivered automatic message after restart or intermediate step',async()=>{
 const shared=new Map(), f=await mount(shared);await initial(f);f.setResponse(()=>page('c2',true,'fresh'));await f.pre(2,1)
 const before=f.calls.length;await f.pre(2,2);assert.ok(f.calls.length>before)
 const restored=await mount(shared);restored.setResponse(()=>page('c2',true,'fresh'));await restored.pre(3,1);assert.equal(restored.calls.filter(x=>x.wire).at(-1).wire.reload,true)
})
test('rejects a failed later page without committing its cursor',async()=>{
 const f=await mount();await initial(f);let n=0;f.setResponse(()=>++n===1?page('c2',false,'one'):{isError:true,content:[{type:'text',text:'failed'}]});await assert.rejects(()=>f.pre(2,1),{name:'McpTurnContextError'});assert.equal([...f.shared.values()][0].servers.s.delivery.pending.arguments.cursor,'c1')
})
test('does not confirm mismatched manual result content or call id',async()=>{
 const f=await mount();await initial(f);f.messages.push({role:'tool',toolCallId:'manual',isError:false,content:[{type:'text',text:'altered'}]});f.setResponse(()=>page('c2',true));await f.pre(2,1);assert.equal(f.calls.filter(x=>x.wire).at(-1).wire.reload,true)
})
test('real dsh Session confirms delivery and detects surface replacement',async t=>{
 const path=process.env.DSH_SESSION_MODULE; if(!path){t.skip('DSH_SESSION_MODULE not set');return}
 const {Session}=await import(path); const f=await mount(); const session=Session.create('a',[],{type:'session',version:4,id:'a',createdAt:1,isSeeded:false}); f.a.session=session
 await initial(f)
 const tool={id:'tool-message',role:'tool',source:{kind:'tool',callId:'manual'},toolCallId:'manual',content:[{type:'text',text:'initial'}],isError:false}
 const e=session.append('tool/result',{turn:1,step:1,message:tool},{surfaceOp:'append'})
 f.setResponse(()=>page('c2',true,'next'));const d=await f.pre(2,1);assert.equal(f.calls.filter(x=>x.wire).at(-1).wire.cursor,'c1')
 const msg=d.messages.at(-1);const injected=session.append('user/message',msg,{surfaceOp:'append'})
 await f.pre(2,2); const before=f.calls.length; await f.pre(2,3); assert.equal(f.calls.length,before)
 session.append('user/message',{id:'replacement',role:'user',source:{kind:'user'},content:[{type:'text',text:'summary'}]},{surfaceOp:{op:'replace',startSeq:injected.seq,endSeq:injected.seq},sourceEventSeqs:[injected.seq]})
 await f.pre(3,1);assert.equal(f.calls.filter(x=>x.wire).at(-1).wire.reload,true);assert.ok(e.seq>=0)
})

test('an intermediate acknowledgment cannot overwrite a concurrently completed context call',async()=>{
 const f=await mount(); await initial(f);
 f.messages.push({role:'tool',toolCallId:'manual',isError:false,content:[{type:'text',text:'initial'}]});
 let release, entered;
 const reached=new Promise(resolve=>{entered=resolve}), waiting=new Promise(resolve=>{release=resolve});
 f.setResponse(async()=>{entered();await waiting;return page('c2',true,'concurrent')});
 const manual=f.c.contextCall('load',{}, {agent:f.a,signal:f.signal,callId:'parallel'},f.invoke);
 await reached; const step=f.pre(2,2); await Promise.resolve(); release();
 await Promise.all([manual,step]);
 const state=[...f.shared.values()][0].servers.s;
 assert.equal(state.arguments.cursor,'c1'); assert.equal(state.delivery.pending.arguments.cursor,'c2');
});
test('full result confirms across generation only when exact content remains',async()=>{
 const f=await mount();await initial(f);f.messages.push({role:'tool',toolCallId:'manual',isError:false,content:[{type:'text',text:'initial'}]});f.a.session.surface.contentGeneration++;f.setResponse(()=>page('c2',true,'next'));await f.pre(2,1);assert.equal(f.calls.filter(x=>x.wire).at(-1).wire.cursor,'c1');assert.equal(f.calls.filter(x=>x.wire).at(-1).wire.reload,undefined)
 for(const mode of ['missing','changed']){const x=await mount();await initial(x);if(mode==='changed')x.messages.push({role:'tool',toolCallId:'manual',isError:false,content:[{type:'text',text:'different'}]});x.a.session.surface.contentGeneration++;x.setResponse(()=>page('c2',true));await x.pre(2,1);assert.equal(x.calls.filter(v=>v.wire).at(-1).wire.reload,true)}
})
test('incremental result across generation requires reload despite exact marker',async()=>{
 const f=await mount();await initial(f);f.messages.push({role:'tool',toolCallId:'manual',isError:false,content:[{type:'text',text:'initial'}]});f.setResponse(()=>page('c2',true,'delta'));const d=await f.pre(2,1);f.messages.push(d.messages.at(-1));f.a.session.surface.contentGeneration++;await f.pre(3,1);assert.equal(f.calls.filter(x=>x.wire).at(-1).wire.reload,true)
})
