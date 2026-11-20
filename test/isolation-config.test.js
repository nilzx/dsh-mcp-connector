import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../src/config.js'
const server=()=>({command:'node',delegation:'deny',runtimeMetadata:{namespace:'io.example/session',historyTools:['start','probe'],captureTools:['start','probe']},turnContext:{tool:'refresh',arguments:{},state:{cursor:'/cursor'},pins:['/identity'],delivery:{reloadArguments:{reload:true}}},lifecycle:{group:'g',startTools:['start'],probe:'probe',ready:{start:'/ready',probe:'/ready'},allowedTools:[],blockedTools:['copy_history']}})
test('validates generic blocked tool names and rejects malformed lists',()=>{
 const input=server();assert.deepEqual(normalizeConfig({servers:{x:input}}).servers[0].lifecycle.blockedTools,['copy_history'])
 for(const invalid of [['x','x'],['bad name'],Array(33).fill('x'),[1]]){const x=server();x.lifecycle.blockedTools=invalid;assert.throws(()=>normalizeConfig({servers:{x}}))}
})
