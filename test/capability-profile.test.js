import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { normalizeConfig } from '../src/config.js'
import { ServerConnection } from '../src/connection.js'
import { createFakeContext } from './helpers/fake-ctx.js'
const turnContext={tool:'inventory',state:{cursor:'/cursor'},pins:['/warehouse'],pagination:{complete:'/complete'},delivery:{reloadArguments:{reload:true}}}
const server={command:'node',turnContext,capabilityProfile:{version:1,tier:'turn-sync'}}
test('requested profile fails at startup without durable host storage',async()=>{const {ctx}=createFakeContext();await assert.rejects(()=>apply(ctx,{servers:{inventory:server}}),/storageDomain/)})
test('status reports requested and configured profile without certification',()=>{const entry=normalizeConfig({servers:{inventory:server}}).servers[0];const c=new ServerConnection({ctx:{},entry});assert.deepEqual(c.snapshot().capabilityProfile,{requested:{version:1,tier:'turn-sync'},configured:['turn-sync']});assert.doesNotMatch(JSON.stringify(c.snapshot()),/certified|verified/i)})
test('trusted profile rejects a host without admission version 1 at startup',async()=>{
 const {ctx}=createFakeContext({services:{sessions:{preparationAdmissionVersion:0}}});ctx.tools.guard=()=>()=>{}
 const trusted={...server,delegation:'deny',capabilityProfile:{version:1,tier:'trusted-lifecycle'},runtimeMetadata:{namespace:'io.example/session',captureTools:['start','probe'],historyTools:['history']},lifecycle:{group:'g',startTools:['start'],probe:'probe',allowedTools:['history'],ready:{start:'/ready',probe:'/ready'},requireCreationAdmission:true}}
 await assert.rejects(()=>apply(ctx,{servers:{inventory:trusted}}),/requires host session preparation admission version 1/)
})
