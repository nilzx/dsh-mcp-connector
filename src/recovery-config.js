/** Exact, operator-configured recovery operations; never model tool arguments. */
import { z } from 'zod'
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const scalar = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()])
const pointer = z.string().min(2).max(512).refine(s => s.startsWith('/') && !/~(?![01])/.test(s)
  && !s.split('/').some(p => ['__proto__', 'prototype', 'constructor'].includes(p)))
export const recoveryOperation = z.object({
  operationId: id, server: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), sessionId: id,
  createdAt: z.number().int().safe().nonnegative(), configuration: hash,
  expected: z.object({ context: hash, lifecycle: hash, runtime: hash }).strict(),
  fromPins: z.array(scalar).min(1).max(16), toPins: z.array(scalar).min(1).max(16),
  stablePins: z.array(z.number().int().min(0).max(15)).min(1).max(16),
  tool: id, arguments: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), scalar),
  metadata: z.record(z.string().max(200).regex(/^[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+$/), z.record(z.string().max(100), scalar)).default({}),
  proof: z.object({ operationId: pointer, before: z.array(pointer).min(1).max(16), after: z.array(pointer).min(1).max(16) }).strict(),
}).strict().superRefine((o, ctx) => {
  if (o.fromPins.length !== o.toPins.length || o.proof.before.length !== o.fromPins.length || o.proof.after.length !== o.toPins.length
    || new Set(o.stablePins).size !== o.stablePins.length || o.stablePins.some(i => i >= o.fromPins.length || o.fromPins[i] !== o.toPins[i])
    || Object.keys(o.arguments).some(k => ['constructor', 'prototype'].includes(k))
    || Object.keys(o.metadata).some(k => k.startsWith('io.modelcontextprotocol/'))
    || Object.keys(o.metadata).length > 16) ctx.addIssue({ code: 'custom', message: 'recovery must preserve the configured stable pins and map every old/new pin' })
})
export function normalizeRecoveries(raw = []) {
  const operations = z.array(recoveryOperation).max(128).parse(raw)
  if (new Set(operations.map(o => o.operationId)).size !== operations.length) throw new Error('recovery operation IDs must be unique')
  return operations
}
