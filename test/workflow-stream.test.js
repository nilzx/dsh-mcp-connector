import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initializationStream } from '../src/workflow-stream.js'
const text=[{type:'block-start',index:5,blockType:'text'},{type:'text-delta',index:5,text:'hidden'},{type:'block-end',index:5,block:{type:'text',text:'hidden'}}]
const tool=(index=9,id='c1',name='allowed')=>[{type:'block-start',index,blockType:'tool-call'},{type:'tool-call-delta',index,id,name,argumentsDelta:'{}'},{type:'block-end',index,block:{type:'tool-call',id,name,arguments:'{}'}}]
const finish={type:'finish',reason:{kind:'tool-calls'},replayState:{response:{secret:'hidden'},blocks:['x','y']}}
const source=async function* (chunks){for(const c of chunks)yield c}
async function collect(chunks, opts={}) {const out=[];let error;try{for await(const c of initializationStream(source(chunks),{allows:n=>n==='allowed',...opts}))out.push(c)}catch(e){error=e}return {out,error}}
test('buffers mixed content and emits only reindexed tool calls without replay state',async()=>{
 const input=[...text,...tool(),finish], copy=structuredClone(input), r=await collect(input);assert.ifError(r.error);assert.deepEqual(input,copy);assert.deepEqual(r.out.map(c=>c.type),['block-start','tool-call-delta','block-end','finish']);assert.equal(r.out[0].index,0);assert.equal(r.out.at(-1).replayState,undefined);assert.doesNotMatch(JSON.stringify(r.out),/hidden/)
})
test('rejects plain text, forbidden tools, truncation, failed finish, malformed indexes and IDs without yielding',async()=>{
 const cases=[[...text,{type:'finish',reason:{kind:'stop'}}],[...tool(0,'x','forbidden'),finish],[...tool().slice(0,2),finish],[...tool(),{type:'finish',reason:{kind:'error'}}],[...tool(),{type:'finish',reason:{kind:'max-tokens'}}],[...tool(),...tool(9,'x'),finish],[...tool(1,'x'),...tool(2,'x'),finish],[...tool()]]
 for(const x of cases){const r=await collect(x);assert.ok(r.error);assert.deepEqual(r.out,[])}
})
test('rejects cancellation, size limit and validation without leaking chunks',async()=>{
 const c=new AbortController();c.abort();for(const opts of [{signal:c.signal},{maxBytes:20},{validate:()=>{throw new Error('changed')}}]){const r=await collect([...text,...tool(),finish],opts);assert.ok(r.error);assert.deepEqual(r.out,[])}
})
test('real dsh BlockAssembler accepts filtered output',async t=>{
 const path=process.env.DSH_LLM_MODULE;if(!path){t.skip('DSH_LLM_MODULE not set');return}const {BlockAssembler}=await import(path);const r=await collect([...text,...tool(),finish]);assert.ifError(r.error);const a=new BlockAssembler();for(const c of r.out)a.push(c);assert.deepEqual(a.blocks(),[{type:'tool-call',id:'c1',name:'allowed',arguments:'{}'}]);assert.equal(a.replayState,undefined);assert.doesNotMatch(JSON.stringify(a.message({provider:'test',model:'test'})),/hidden/)
})
test('authorization changing during emission cannot leak partial output',async()=>{
 let checks=0;const r=await collect([...tool(1,'x'),...tool(2,'y'),finish],{allows:()=>++checks<4});assert.ok(r.error);assert.deepEqual(r.out,[])
})
