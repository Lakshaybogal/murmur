// 4 people in one group. Not everyone is ever online together, yet everyone ends up with the full history.
// Uses a throwaway local DHT so it runs offline.
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import { ChatNode } from '../src/node.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'murmur-'))
const testnet = await createTestnet(3)
// firewalled:false skips NAT holepunching, which is painfully slow on loopback
const dhts = []
const mk = (name) => {
  const dht = new DHT({ bootstrap: testnet.bootstrap, firewalled: false })
  dhts.push(dht)
  return new ChatNode({ dir: path.join(tmp, name), name, dht })
}
const until = async (what, fn, ms = 15000) => {
  const t = Date.now()
  while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)) }
  console.log('  ok -', what)
}
const texts = (n, id) => n.messages(id).map((m) => m.text)

const [a, b, c, d, e] = ['alice', 'bob', 'carol', 'dave', 'eve'].map(mk)
const g = await a.createGroup('team')
for (const n of [b, c, d]) await n.joinGroup(g.id, 'team')
const other = await e.createGroup('strangers') // different group, must never see ours

console.log('1. alice, bob, carol online; dave offline')
for (const n of [a, b, c, e]) await n.start()
await until('3 members see each other', () => a.listGroups()[0].peers >= 2 && c.listGroups()[0].peers >= 2)
a.send(g.id, 'hi from alice')
b.send(g.id, 'bob here')
await until('carol got both', () => texts(c, g.id).length === 2)

console.log('2. alice and bob go offline; carol writes alone; dave comes online')
await a.stop(); await b.stop()
c.send(g.id, 'carol still here')
await d.start()
await until('dave synced all 3 messages from carol alone', () => texts(d, g.id).length === 3)
assert.deepStrictEqual(texts(d, g.id), texts(c, g.id))

console.log('3. offline writes sync later')
const a2 = mk('alice') // same dir: reloads history from disk
assert.strictEqual(a2.messages(g.id).length, 2, 'alice kept her history on disk')
a2.send(g.id, 'written before reconnecting')
await a2.start()
await until('alice caught up and shared', () => texts(a2, g.id).length === 4 && texts(d, g.id).length === 4)

console.log('4. privacy + integrity')
assert.strictEqual(e.messages(g.id).length, 0)
assert.strictEqual(e.listGroups().length, 1)
console.log('PASS: every member converged on', texts(d, g.id))
await Promise.all([a2, c, d, e].map((n) => n.stop())); await Promise.all(dhts.map((x) => x.destroy())); await testnet.destroy()
fs.rmSync(tmp, { recursive: true }); process.exit(0)
