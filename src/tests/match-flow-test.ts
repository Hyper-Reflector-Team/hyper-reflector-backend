/**
 * End-to-end match flow test
 *
 * Tests the full path: WebSocket signaling → hole punch server → emulator launch
 * Both "players" are local bots. The test is read-only against a running server.
 *
 * Prerequisites:
 *   - WebSocket signal server running  (npm start / ts-node src/index.ts)
 *   - Hole punch Go server running     (go run gopunchv1.go)
 *
 * Usage:
 *   npx ts-node src/tests/match-flow-test.ts [emulator-path] [options]
 *
 * Options:
 *   --game <rom>         ROM name           (default: sfiii3nr1)
 *   --lua  <path>        Lua script path    (optional)
 *   --delay <n>          GGPO delay frames  (default: 0)
 *   --skip-emu           Only test signaling + hole punch, don't launch emulators
 *   --skip-punch         Only test WebSocket signaling (no hole punch server needed)
 *
 * Examples:
 *   npx ts-node src/tests/match-flow-test.ts --skip-emu
 *   npx ts-node src/tests/match-flow-test.ts "C:/path/to/fs-fbneo.exe" --game sfiii3nr1
 */

import WebSocket from 'ws'
import dgram from 'dgram'
import { spawn, ChildProcess } from 'child_process'

// ── Config ────────────────────────────────────────────────────────────────────

const serverInfo = require('../../keys/server')

const DEFAULTS = {
  signalUrl:  `ws://${serverInfo.COTURN_IP}:${serverInfo.SIGNAL_PORT ?? 3004}`,
  punchHost:  serverInfo.COTURN_IP ?? '127.0.0.1',
  punchPort:  Number(serverInfo.PUNCH_PORT ?? 33334),
  gameName:   'sfiii3nr1',
  delay:      0,
}

function parseArgs() {
  const argv = process.argv.slice(2)
  const cfg = { ...DEFAULTS, emulatorPath: '', luaPath: '', skipEmulator: false, skipPunch: false }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--game':       cfg.gameName     = argv[++i]; break
      case '--lua':        cfg.luaPath      = argv[++i]; break
      case '--delay':      cfg.delay        = Number(argv[++i]); break
      case '--skip-emu':   cfg.skipEmulator = true; break
      case '--skip-punch': cfg.skipPunch    = true; break
      default:
        if (!argv[i].startsWith('--')) cfg.emulatorPath = argv[i]
    }
  }
  return cfg
}

// ── Pretty logging ────────────────────────────────────────────────────────────

const ts  = () => new Date().toISOString().slice(11, 23)
const log = (tag: string, msg: string) => console.log(`  [${ts()}] [${tag}] ${msg}`)
const ok  = (msg: string)              => console.log(`\x1b[32m  ✓\x1b[0m ${msg}`)
const err = (msg: string)              => console.log(`\x1b[31m  ✗\x1b[0m ${msg}`)
const inf = (msg: string)              => console.log(`    ${msg}`)

function header(title: string) {
  console.log(`\n\x1b[36m── ${title} ${'─'.repeat(Math.max(0, 55 - title.length))}\x1b[0m`)
}

// ── WebSocket helpers ─────────────────────────────────────────────────────────

function wsConnect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open',  () => resolve(ws))
    ws.once('error', (e) => reject(new Error(`WS connect error: ${e.message}`)))
    setTimeout(() => reject(new Error(`WS connect timeout to ${url}`)), 6000)
  })
}

function waitFor(ws: WebSocket, predicate: (p: any) => boolean, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error('waitFor timeout'))
    }, timeoutMs)

    const handler = (raw: WebSocket.RawData) => {
      try {
        const p = JSON.parse(raw.toString())
        if (predicate(p)) {
          clearTimeout(timer)
          ws.off('message', handler)
          resolve(p)
        }
      } catch {}
    }

    ws.on('message', handler)
  })
}

function wsSend(ws: WebSocket, payload: object) {
  ws.send(JSON.stringify(payload))
}

// ── Hole punch helper ─────────────────────────────────────────────────────────

type PeerInfo = { address: string; port: number; matchId: string }

function holePunch(uid: string, peerUid: string, host: string, port: number): Promise<PeerInfo> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4')

    const timer = setTimeout(() => {
      try { sock.close() } catch {}
      reject(new Error(`Hole punch timeout for ${uid} — is the Go server running on ${host}:${port}?`))
    }, 10_000)

    sock.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString())
        // Go server sends: { peer: { uid, address, port }, matchId }
        if (parsed.peer?.address && parsed.peer?.port) {
          clearTimeout(timer)
          try { sock.close() } catch {}
          resolve({
            address: parsed.peer.address,
            port:    parsed.peer.port,
            matchId: parsed.matchId ?? '',
          })
        }
      } catch {}
    })

    sock.on('error', (e) => {
      clearTimeout(timer)
      try { sock.close() } catch {}
      reject(new Error(`UDP socket error for ${uid}: ${e.message}`))
    })

    sock.bind(0, () => {
      const buf = Buffer.from(JSON.stringify({ uid, peerUid, kill: false }))
      sock.send(buf, port, host, (sendErr) => {
        if (sendErr) {
          clearTimeout(timer)
          try { sock.close() } catch {}
          reject(new Error(`UDP send error for ${uid}: ${sendErr.message}`))
        }
      })
    })
  })
}

// ── Emulator arg builder (mirrors src/match/index.ts) ─────────────────────────

function buildEmulatorArgs(opts: {
  emulatorPath: string
  playerIndex:  1 | 2
  localPort:    number
  remotePort:   number
  playerName:   string
  delay:        number
  luaPath:      string
  rom:          string
}): string[] {
  const { emulatorPath, playerIndex, localPort, remotePort, playerName, delay, luaPath, rom } = opts
  const normalized = emulatorPath.toLowerCase()
  const args: string[] = []

  if (normalized.endsWith('fs-fbneo.exe') || normalized.endsWith('fs-fbneo')) {
    args.push('--rom', rom)
    if (luaPath.trim()) args.push('--lua', luaPath)
    args.push('direct', '--player', String(playerIndex),
      '-n', playerName,
      '-l', `127.0.0.1:${localPort}`,
      '-r', `127.0.0.1:${remotePort}`,
      '-d', String(delay))
    return args
  }

  if (normalized.endsWith('fcadefbneo.exe') || normalized.endsWith('fcadefbneo')) {
    args.push(`quark:direct,${rom},${localPort},127.0.0.1,${remotePort},${playerIndex},${delay},0`)
    if (luaPath.trim()) args.push('--lua', luaPath)
    return args
  }

  // Generic fallback
  args.push('--rom', rom, '--player', String(playerIndex),
    '-n', playerName,
    '-l', `127.0.0.1:${localPort}`,
    '-r', `127.0.0.1:${remotePort}`,
    '-d', String(delay))
  return args
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

function disconnectBot(ws: WebSocket, uid: string) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      wsSend(ws, { type: 'userDisconnect', userUID: uid })
      ws.close()
    }
  } catch {}
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = parseArgs()
  const runId = Date.now()

  const BOT_A = {
    uid:       `test-bot-a-${runId}`,
    userName:  'TestBotA',
    accountElo: 1200,
    lobbyId:   'Hyper Reflector',
    userEmail: 'bota@test.local',
    countryCode: 'US',
    lastKnownPings: [] as any[],
  }
  const BOT_B = {
    uid:       `test-bot-b-${runId}`,
    userName:  'TestBotB',
    accountElo: 1200,
    lobbyId:   'Hyper Reflector',
    userEmail: 'botb@test.local',
    countryCode: 'US',
    lastKnownPings: [] as any[],
  }

  console.log('\n\x1b[1m=== Hyper Reflector Match Flow Test ===\x1b[0m')
  inf(`Signal server : ${cfg.signalUrl}`)
  inf(`Hole punch    : ${cfg.punchHost}:${cfg.punchPort}${cfg.skipPunch ? ' (skipped)' : ''}`)
  inf(`Emulator      : ${cfg.emulatorPath || '(not provided)'}${cfg.skipEmulator ? ' (skipped)' : ''}`)
  inf(`Game          : ${cfg.gameName}`)

  let wsA!: WebSocket
  let wsB!: WebSocket

  // ── Step 1: Connect ──────────────────────────────────────────────────────────
  header('Step 1: WebSocket Connect')
  try {
    ;[wsA, wsB] = await Promise.all([wsConnect(cfg.signalUrl), wsConnect(cfg.signalUrl)])
    ok('Both bots connected to signal server')
  } catch (e: any) {
    err(`Connection failed: ${e.message}`)
    process.exit(1)
  }

  // ── Step 2: Join lobby ───────────────────────────────────────────────────────
  header('Step 2: Join Lobby')
  wsSend(wsA, { type: 'join', user: BOT_A, lobbyId: BOT_A.lobbyId })
  wsSend(wsB, { type: 'join', user: BOT_B, lobbyId: BOT_B.lobbyId })

  try {
    await Promise.all([
      waitFor(wsA, p => p.type === 'connected-users'),
      waitFor(wsB, p => p.type === 'connected-users'),
    ])
    ok(`Both bots joined lobby "${BOT_A.lobbyId}"`)
  } catch (e: any) {
    err(`Lobby join failed: ${e.message}`)
    disconnectBot(wsA, BOT_A.uid)
    disconnectBot(wsB, BOT_B.uid)
    process.exit(1)
  }

  // Small pause so both are visible in connectedUsers before challenge
  await new Promise(r => setTimeout(r, 200))

  // ── Step 3: Simulate WebRTC challenge (bypass actual SDP negotiation) ────────
  header('Step 3: Challenge Signaling (WebRTC offer/answer bypass)')
  log('info', 'Bot B sends offer to Bot A...')

  const dummyOffer  = { type: 'offer',  sdp: 'v=0\r\n' }
  const dummyAnswer = { type: 'answer', sdp: 'v=0\r\n' }

  wsSend(wsB, { type: 'webrtc-ping-offer', from: BOT_B.uid, to: BOT_A.uid, offer: dummyOffer })

  try {
    await waitFor(wsA, p => p.type === 'webrtc-ping-offer' && p.from === BOT_B.uid)
    ok('Bot A received challenge offer from Bot B')
  } catch (e: any) {
    err(`Bot A never got the offer: ${e.message}`)
    disconnectBot(wsA, BOT_A.uid)
    disconnectBot(wsB, BOT_B.uid)
    process.exit(1)
  }

  log('info', 'Bot A sends answer to Bot B...')
  wsSend(wsA, { type: 'webrtc-ping-answer', from: BOT_A.uid, to: BOT_B.uid, answer: dummyAnswer })

  try {
    await waitFor(wsB, p => p.type === 'webrtc-ping-answer' && p.from === BOT_A.uid)
    ok('Bot B received answer from Bot A')
  } catch (e: any) {
    err(`Bot B never got the answer: ${e.message}`)
    disconnectBot(wsA, BOT_A.uid)
    disconnectBot(wsB, BOT_B.uid)
    process.exit(1)
  }

  // ── Step 4: Request match ─────────────────────────────────────────────────────
  header('Step 4: Request Match')
  log('info', 'Bot A sends request-match to signal server...')

  wsSend(wsA, {
    type:        'request-match',
    challengerId: BOT_A.uid,
    opponentId:   BOT_B.uid,
    requestedBy:  BOT_A.uid,
    lobbyId:      BOT_A.lobbyId,
    gameName:     cfg.gameName,
  })

  let matchStartA: any
  let matchStartB: any

  try {
    ;[matchStartA, matchStartB] = await Promise.all([
      waitFor(wsA, p => p.type === 'match-start'),
      waitFor(wsB, p => p.type === 'match-start'),
    ])
    ok(`Match created successfully`)
    inf(`Match ID   : ${matchStartA.matchId}`)
    inf(`Bot A slot : ${matchStartA.playerSlot}`)
    inf(`Bot B slot : ${matchStartB.playerSlot}`)
    inf(`Server     : ${matchStartA.serverHost}:${matchStartA.serverPort}`)
  } catch (e: any) {
    err(`match-start not received: ${e.message}`)
    disconnectBot(wsA, BOT_A.uid)
    disconnectBot(wsB, BOT_B.uid)
    process.exit(1)
  }

  // ── Step 5: Hole punch ───────────────────────────────────────────────────────
  if (!cfg.skipPunch) {
    header('Step 5: Hole Punch')
    log('info', `Both bots registering with ${cfg.punchHost}:${cfg.punchPort}...`)

    let peerA: PeerInfo
    let peerB: PeerInfo

    try {
      // Both must connect concurrently — the server only responds once it has both
      ;[peerA, peerB] = await Promise.all([
        holePunch(BOT_A.uid, BOT_B.uid, cfg.punchHost, cfg.punchPort),
        holePunch(BOT_B.uid, BOT_A.uid, cfg.punchHost, cfg.punchPort),
      ])
      ok('Hole punch exchange complete')
      inf(`Bot A sees peer at ${peerA.address}:${peerA.port}  (matchId: ${peerA.matchId || 'n/a'})`)
      inf(`Bot B sees peer at ${peerB.address}:${peerB.port}  (matchId: ${peerB.matchId || 'n/a'})`)
    } catch (e: any) {
      err(`Hole punch failed: ${e.message}`)
      disconnectBot(wsA, BOT_A.uid)
      disconnectBot(wsB, BOT_B.uid)
      process.exit(1)
    }
  } else {
    header('Step 5: Hole Punch')
    inf('Skipped (--skip-punch)')
  }

  // ── Step 6: Launch emulators ─────────────────────────────────────────────────
  header('Step 6: Emulator Launch')

  if (cfg.skipEmulator || !cfg.emulatorPath.trim()) {
    inf('Skipped — pass an emulator path as the first argument to launch')
    console.log('\n\x1b[32m✓ All requested steps passed.\x1b[0m\n')
    disconnectBot(wsA, BOT_A.uid)
    disconnectBot(wsB, BOT_B.uid)
    return
  }

  // Since both bots are on the same machine the emulators can connect directly
  // on localhost without a proxy.  Port assignment mirrors startMockMatch logic:
  //   Bot A (slot 0) → local:7000, remote:7001
  //   Bot B (slot 1) → local:7001, remote:7000
  const slotA: 0 | 1 = matchStartA.playerSlot === 0 ? 0 : 1
  const slotB: 0 | 1 = slotA === 0 ? 1 : 0

  const argsA = buildEmulatorArgs({
    emulatorPath: cfg.emulatorPath,
    playerIndex:  (slotA + 1) as 1 | 2,
    localPort:    slotA === 0 ? 7000 : 7001,
    remotePort:   slotA === 0 ? 7001 : 7000,
    playerName:   BOT_A.userName,
    delay:        cfg.delay,
    luaPath:      cfg.luaPath,
    rom:          cfg.gameName,
  })

  const argsB = buildEmulatorArgs({
    emulatorPath: cfg.emulatorPath,
    playerIndex:  (slotB + 1) as 1 | 2,
    localPort:    slotB === 0 ? 7000 : 7001,
    remotePort:   slotB === 0 ? 7001 : 7000,
    playerName:   BOT_B.userName,
    delay:        cfg.delay,
    luaPath:      cfg.luaPath,
    rom:          cfg.gameName,
  })

  log('info', `Emulator A args: ${argsA.join(' ')}`)
  log('info', `Emulator B args: ${argsB.join(' ')}`)

  let emuA: ChildProcess
  let emuB: ChildProcess

  try {
    emuA = spawn(cfg.emulatorPath, argsA, { detached: false, stdio: 'ignore' })
    emuB = spawn(cfg.emulatorPath, argsB, { detached: false, stdio: 'ignore' })

    emuA.on('error', (e) => log('emuA', `spawn error: ${e.message}`))
    emuB.on('error', (e) => log('emuB', `spawn error: ${e.message}`))

    ok(`Emulator A launched  (PID ${emuA.pid},  Player ${slotA + 1})`)
    ok(`Emulator B launched  (PID ${emuB.pid},  Player ${slotB + 1})`)
  } catch (e: any) {
    err(`Failed to spawn emulator: ${e.message}`)
    disconnectBot(wsA, BOT_A.uid)
    disconnectBot(wsB, BOT_B.uid)
    process.exit(1)
  }

  console.log('\n\x1b[32m✓ All steps passed.\x1b[0m')
  inf('Both emulators are running and connecting to each other on localhost.')
  inf('Close the emulator windows to finish the test.\n')

  // Keep the process alive until both emulators exit, then clean up
  let closed = 0
  const onClose = (label: string) => {
    closed++
    log(label, 'exited')
    if (closed >= 2) {
      // Send match-end to both bots so the server cleans up the activeMatch entry
      try { wsSend(wsA, { type: 'matchEnd', userUID: BOT_A.uid }) } catch {}
      try { wsSend(wsB, { type: 'matchEnd', userUID: BOT_B.uid }) } catch {}
      setTimeout(() => {
        disconnectBot(wsA, BOT_A.uid)
        disconnectBot(wsB, BOT_B.uid)
        process.exit(0)
      }, 300)
    }
  }

  emuA!.on('close', () => onClose('emuA'))
  emuB!.on('close', () => onClose('emuB'))

  process.on('SIGINT', () => {
    log('cleanup', 'Interrupted — killing emulators and disconnecting bots')
    try { emuA?.kill() } catch {}
    try { emuB?.kill() } catch {}
    disconnectBot(wsA, BOT_A.uid)
    disconnectBot(wsB, BOT_B.uid)
    process.exit(0)
  })
}

main().catch((e) => {
  console.error('\n\x1b[31mUnhandled error:\x1b[0m', e)
  process.exit(1)
})
