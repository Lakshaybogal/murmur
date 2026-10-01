#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import { ChatNode } from './node.js'
import { startUi } from './server.js'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
const dir = path.resolve(args.data || path.join(os.homedir(), '.murmur'))

const node = new ChatNode({ dir, name: args.name })
const port = await startUi(node, Number(args.port) || 4000)
console.log(`\n  murmur  ·  ${node.name}\n  data   ${dir}\n  open   http://localhost:${port}\n`)
await node.start()
console.log('  joined the swarm. waiting for peers…')

const bye = async () => { await node.stop(); process.exit(0) }
process.on('SIGINT', bye)
process.on('SIGTERM', bye)
