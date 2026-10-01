// A ChatNode is one device: it owns an identity, a local copy of every group's
// messages, and a swarm connection to the other devices that hold the same group.
import Hyperswarm from 'hyperswarm'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const sha = (s) => crypto.createHash('sha256').update(s).digest()
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const MAX_LINE = 8 * 1024 * 1024
const MAX_TEXT = 4000
const BATCH = 200

export class ChatNode extends EventEmitter {
  constructor({ dir, name, dht }) {
    super()
    this.dir = dir
    this.dht = dht // optional: tests inject a local-DHT node
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true })
    this.#loadIdentity(name)
    this.groups = new Map() // groupId -> { id, label, key, topic, topicHex, msgs: Map }
    this.peers = new Set()
    this.#loadGroups()
  }

  // ---- identity: an ed25519 keypair; the public key is your user id ----
  #loadIdentity(name) {
    const file = path.join(this.dir, 'identity.json')
    let id
    if (fs.existsSync(file)) id = JSON.parse(fs.readFileSync(file, 'utf8'))
    else {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
      id = {
        priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
        pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
        name: name || 'anon',
      }
    }
    if (name) id.name = name
    fs.writeFileSync(file, JSON.stringify(id), { mode: 0o600 })
    this.name = id.name
    this.userId = id.pub
    this.privKey = crypto.createPrivateKey({ key: Buffer.from(id.priv, 'hex'), format: 'der', type: 'pkcs8' })
  }

  // ---- groups: the group id IS the secret. topic = what we find peers by, key = what we encrypt with ----
  #loadGroups() {
    const file = path.join(this.dir, 'groups.json')
    if (!fs.existsSync(file)) return
    for (const { id, label } of JSON.parse(fs.readFileSync(file, 'utf8'))) this.#addGroup(id, label)
  }

  #saveGroups() {
    const list = [...this.groups.values()].map(({ id, label }) => ({ id, label }))
    fs.writeFileSync(path.join(this.dir, 'groups.json'), JSON.stringify(list))
  }

  #addGroup(id, label) {
    const topic = sha('topic:' + id)
    const g = { id, label: label || id.slice(0, 12), key: sha('key:' + id), topic, topicHex: topic.toString('hex'), msgs: new Map() }
    this.groups.set(id, g)
    const file = this.#logFile(g)
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue
        try { const m = JSON.parse(line); if (this.#valid(g, m)) g.msgs.set(m.id, m) } catch {}
      }
    }
    return g
  }

  #logFile(g) { return path.join(this.dir, 'messages', g.topicHex + '.jsonl') }

  async createGroup(label) {
    return this.joinGroup('grp_' + crypto.randomBytes(16).toString('hex'), label)
  }

  async joinGroup(id, label) {
    id = id.trim()
    if (!/^grp_[0-9a-f]{32}$/.test(id)) throw new Error('invalid group id')
    let g = this.groups.get(id)
    if (!g) { g = this.#addGroup(id, label); this.#saveGroups() }
    if (this.swarm) { this.swarm.join(g.topic); this.#broadcastHello() }
    this.emit('change', id)
    return g
  }

  // ---- messages: encrypted with the group key, signed by the author, id = hash(content) ----
  #encrypt(g, obj) {
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', g.key, iv)
    const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final()])
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
  }

  #decrypt(g, e) {
    const b = Buffer.from(e, 'base64')
    const d = crypto.createDecipheriv('aes-256-gcm', g.key, b.subarray(0, 12))
    d.setAuthTag(b.subarray(12, 28))
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString())
  }

  #msgId(m) { return sha(`${m.a}|${m.ts}|${m.e}`).toString('hex') }

  #valid(g, m) {
    try {
      if (!m || typeof m.e !== 'string' || typeof m.a !== 'string' || typeof m.s !== 'string' || !Number.isFinite(m.ts)) return false
      if (m.id !== this.#msgId(m)) return false
      const pub = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(m.a, 'hex')]), format: 'der', type: 'spki' })
      if (!crypto.verify(null, Buffer.from(m.id, 'hex'), pub, Buffer.from(m.s, 'hex'))) return false
      const p = this.#decrypt(g, m.e)
      return typeof p.text === 'string' && p.text.length <= MAX_TEXT
    } catch { return false }
  }

  send(groupId, text) {
    const g = this.groups.get(groupId)
    if (!g) throw new Error('unknown group')
    text = String(text).trim().slice(0, MAX_TEXT)
    if (!text) return
    const m = { a: this.userId, ts: Date.now(), e: this.#encrypt(g, { name: this.name, text }) }
    m.id = this.#msgId(m)
    m.s = crypto.sign(null, Buffer.from(m.id, 'hex'), this.privKey).toString('hex')
    this.#ingest(g, m, null)
  }

  // Store a message if it is new + valid, then gossip it to every other peer in the group.
  #ingest(g, m, from) {
    if (g.msgs.has(m.id) || !this.#valid(g, m)) return false
    g.msgs.set(m.id, m)
    fs.appendFileSync(this.#logFile(g), JSON.stringify(m) + '\n')
    for (const p of this.peers) if (p !== from && p.topics.has(g.topicHex)) p.send({ t: 'msgs', g: g.topicHex, msgs: [m] })
    this.emit('change', g.id)
    return true
  }

  // ---- read side ----
  listGroups() {
    return [...this.groups.values()].map((g) => ({
      id: g.id, label: g.label, count: g.msgs.size,
      peers: [...this.peers].filter((p) => p.topics.has(g.topicHex)).length,
    }))
  }

  messages(groupId) {
    const g = this.groups.get(groupId)
    if (!g) return []
    return [...g.msgs.values()]
      .sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1))
      .map((m) => ({ id: m.id, ts: m.ts, author: m.a, mine: m.a === this.userId, ...this.#decrypt(g, m.e) }))
  }

  // ---- networking ----
  async start() {
    this.swarm = new Hyperswarm({ dht: this.dht })
    this.swarm.on('connection', (conn) => this.#onConnection(conn))
    for (const g of this.groups.values()) this.swarm.join(g.topic)
    await this.swarm.flush()
  }

  async stop() {
    for (const p of this.peers) p.conn.destroy()
    await this.swarm?.destroy()
  }

  #topics() { return [...this.groups.values()].map((g) => g.topicHex) }
  #broadcastHello() { for (const p of this.peers) p.send({ t: 'hello', topics: this.#topics() }) }

  #onConnection(conn) {
    const peer = { conn, topics: new Set(), send: (o) => { if (!conn.destroyed) conn.write(JSON.stringify(o) + '\n') } }
    this.peers.add(peer)
    let buf = ''
    conn.on('data', (d) => {
      buf += d.toString()
      if (buf.length > MAX_LINE) return conn.destroy()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        try { this.#onMessage(peer, JSON.parse(line)) } catch {}
      }
    })
    const done = () => { if (this.peers.delete(peer)) this.emit('change') }
    conn.on('close', done)
    conn.on('error', done)
    peer.send({ t: 'hello', topics: this.#topics() })
  }

  #byTopic(hex) { return [...this.groups.values()].find((g) => g.topicHex === hex) }

  // Sync protocol: hello (topics I hold) -> have (ids I hold) -> want (ids I lack) -> msgs.
  #onMessage(peer, m) {
    if (m.t === 'hello') {
      const mine = new Set(this.#topics())
      peer.topics = new Set((m.topics || []).filter((t) => mine.has(t)))
      for (const hex of peer.topics) peer.send({ t: 'have', g: hex, ids: [...this.#byTopic(hex).msgs.keys()] })
      this.emit('change')
    } else if (m.t === 'have' && peer.topics.has(m.g)) {
      const g = this.#byTopic(m.g)
      const missing = (m.ids || []).filter((id) => !g.msgs.has(id))
      if (missing.length) peer.send({ t: 'want', g: m.g, ids: missing })
    } else if (m.t === 'want' && peer.topics.has(m.g)) {
      const g = this.#byTopic(m.g)
      const have = (m.ids || []).map((id) => g.msgs.get(id)).filter(Boolean)
      for (let i = 0; i < have.length; i += BATCH) peer.send({ t: 'msgs', g: m.g, msgs: have.slice(i, i + BATCH) })
    } else if (m.t === 'msgs' && peer.topics.has(m.g)) {
      const g = this.#byTopic(m.g)
      for (const msg of m.msgs || []) this.#ingest(g, msg, peer)
    }
  }
}
