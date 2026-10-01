# Murmur

Serverless, decentralized group chat. There is no backend to deploy: every device runs a node that is both the server and the database.

## Run it

```bash
npm install
npm start                      # open http://localhost:4000
```

Try it on one machine with three people:

```bash
npm run alice   # http://localhost:4001
npm run bob     # http://localhost:4002
npm run carol   # http://localhost:4003
```

Create a group in one window, copy its id (`grp_…`), and paste it into *Join group* in the others. Use `--name`, `--port` and `--data <dir>` to customise.

## How it works

- **Group = unique id.** Even a 1:1 chat is a group of two. The id is 128 random bits and doubles as the secret: whoever has it can join.
- **Finding peers with no server.** From the id we derive a *topic* (`sha256("topic:"+id)`). Nodes announce and look up that topic on the Hyperswarm DHT and connect directly to each other (with NAT holepunching). The DHT only ever sees the hash.
- **Every member keeps a full copy.** Messages are appended to `messages/<topic>.jsonl` on your disk.
- **Sync = gossip.** When two nodes connect, they swap the ids of the messages they hold and send each other whatever the other lacks. New messages are also forwarded to the other peers. So if 4 people are in a group and only 1 is online when the 4th returns, the 4th still gets everything. Only one holder needs to be online.
- **Messages** are AES-256-GCM encrypted with a key derived from the group id, signed with the author's ed25519 key, and identified by the hash of their content, so duplicates are free and forged messages are dropped.

```
src/node.js     identity, groups, encrypted message log, peer sync protocol
src/server.js   local-only HTTP UI (127.0.0.1)
public/         single-page chat UI
test/           4-person offline/online scenario on a local DHT
```

## Test

```bash
npm test
```

## Limits (it's a fun project, not Signal)

- Anyone who learns a group id can read and join it; there is no member removal or key rotation.
- Message ordering uses the sender's clock.
- History sync sends the full id list on each connection, which is fine for thousands of messages, not millions.
- Two nodes that start at the very same instant may miss each other until the next DHT refresh; restarting one fixes it.
- Needs internet for the DHT bootstrap nodes to find peers (peers on the same LAN included).
