/**
 * End-to-end match flow test
 *
 * Two modes:
 *
 *   CHALLENGE MODE  (--target <uid>)
 *     A single bot challenges YOUR real logged-in account.
 *     The app receives match-start normally and launches the emulator via Tauri.
 *     The bot registers with the hole punch server so the proxy can complete the handshake.
 *     Best for testing the full real-world path.
 *
 *   BOT-VS-BOT MODE  (default, no --target)
 *     Two bots simulate the full signaling + hole punch exchange between themselves.
 *     Useful for testing the server in isolation without the app running.
 *
 * Prerequisites:
 *   - WebSocket signal server running   (npm run sockets)
 *   - Hole punch Go server running      (npm run holepuncher)
 *   - For challenge mode: app open and logged in
 *
 * Usage:
 *   npx ts-node src/tests/match-flow-test.ts [options]
 *
 * Options:
 *   --target <uid>       Challenge mode: your real Firebase UID
 *   --bot-name <name>    Display name for the challenger bot  (default: TestBot)
 *   --game <rom>         ROM name                             (default: sfiii3nr1)
 *   --skip-punch         Skip hole punch step
 *   --skip-emu           Bot-vs-bot only: skip emulator launch
 *
 * Examples:
 *   npm run test:challenge -- --target abc123uid
 *   npm run test:signal
 *   npm run test:punch
 */

import WebSocket from 'ws'
import dgram from 'dgram'
import { spawn, ChildProcess } from 'child_process'

// ── Config ────────────────────────────────────────────────────────────────────

const serverInfo = require('../../keys/server')

const DEFAULTS = {
  signalUrl: `ws://${serverInfo.COTURN_IP}:${serverInfo.SIGNAL_PORT ?? 3004}`,
  punchHost: serverInfo.COTURN_IP ?? '127.0.0.1',
  punchPort: Number(serverInfo.PUNCH_PORT ?? 33334),
  gameName:  'sfiii3nr1',
  delay:     0,
}

function parseArgs() {
  const argv = process.argv.slice(2)
  const cfg = {
    ...DEFAULTS,
    targetUid:    '',
    botName:      'TestBot',
    emulatorPath: '',
    luaPath:      '',
    skipEmulator: false,
    skipPunch:    false,
  }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--target':     cfg.targetUid    = argv[++i]; break
      case '--bot-name':   cfg.botName      = argv[++i]; break
      case '--game':       cfg.gameName     = argv[++i]; break
      case '--skip-emu':   cfg.skipEmulator = true;      break
      case '--skip-punch': cfg.skipPunch    = true;      break
      default:
        if (!argv[i].startsWith('--')) cfg.emulatorPath = argv[i]
    }
  }
  return cfg
}

// ── Logging ───────────────────────────────────────────────────────────────────

const ts  = () => new Date().toISOString().slice(11, 23)
const log = (tag: string, msg: string) => console.log(`  [${ts()}] [${tag}] ${msg}`)
const ok  = (msg: string)              => console.log(`\x1b[32m  ✓\x1b[0m ${msg}`)
const err = (msg: string)              => console.log(`\x1b[31m  ✗\x1b[0m ${msg}`)
const inf = (msg: string)              => console.log(`    ${msg}`)
const warn = (msg: string)             => console.log(`\x1b[33m  !\x1b[0m ${msg}`)

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

function waitFor(ws: WebSocket, predicate: (p: any) => boolean, timeoutMs = 15_000): Promise<any> {
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

function disconnectBot(ws: WebSocket, uid: string) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      wsSend(ws, { type: 'userDisconnect', userUID: uid })
      ws.close()
    }
  } catch {}
}

// ── Hole punch ────────────────────────────────────────────────────────────────

type PeerInfo = { address: string; port: number; matchId: string }

function holePunch(uid: string, peerUid: string, host: string, port: number): Promise<PeerInfo> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4')

    const timer = setTimeout(() => {
      try { sock.close() } catch {}
      reject(new Error(`Hole punch timeout for ${uid} — is the Go server running on ${host}:${port}?`))
    }, 15_000)

    sock.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString())
        if (parsed.peer?.address && parsed.peer?.port) {
          clearTimeout(timer)
          try { sock.close() } catch {}
          resolve({ address: parsed.peer.address, port: parsed.peer.port, matchId: parsed.matchId ?? '' })
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

// ── Emulator args (mirrors src/match/index.ts buildEmulatorArgs) ──────────────

function buildEmulatorArgs(opts: {
  emulatorPath: string; playerIndex: 1 | 2; localPort: number; remotePort: number
  playerName: string; delay: number; luaPath: string; rom: string
}): string[] {
  const { emulatorPath, playerIndex, localPort, remotePort, playerName, delay, luaPath, rom } = opts
  const normalized = emulatorPath.toLowerCase()
  const args: string[] = []

  if (normalized.endsWith('fs-fbneo.exe') || normalized.endsWith('fs-fbneo')) {
    args.push('--rom', rom)
    if (luaPath.trim()) args.push('--lua', luaPath)
    args.push('direct', '--player', String(playerIndex), '-n', playerName,
      '-l', `127.0.0.1:${localPort}`, '-r', `127.0.0.1:${remotePort}`, '-d', String(delay))
    return args
  }
  if (normalized.endsWith('fcadefbneo.exe') || normalized.endsWith('fcadefbneo')) {
    args.push(`quark:direct,${rom},${localPort},127.0.0.1,${remotePort},${playerIndex},${delay},0`)
    if (luaPath.trim()) args.push('--lua', luaPath)
    return args
  }
  args.push('--rom', rom, '--player', String(playerIndex), '-n', playerName,
    '-l', `127.0.0.1:${localPort}`, '-r', `127.0.0.1:${remotePort}`, '-d', String(delay))
  return args
}

// ── Challenge mode ────────────────────────────────────────────────────────────
// One bot challenges your real account. The app handles the emulator launch.

async function runChallengeMode(cfg: ReturnType<typeof parseArgs>) {
  const runId = Date.now()
  const BOT = {
    uid:            `test-bot-${runId}`,
    userName:       cfg.botName,
    accountElo:     1200,
    lobbyId:        'Hyper Reflector',
    userEmail:      'bot@test.local',
    countryCode:    'US',
    lastKnownPings: [] as any[],
  }

  console.log(`\n\x1b[1m=== Challenge Mode ===\x1b[0m`)
  inf(`Signal server : ${cfg.signalUrl}`)
  inf(`Hole punch    : ${cfg.punchHost}:${cfg.punchPort}${cfg.skipPunch ? ' (skipped)' : ''}`)
  inf(`Bot UID       : ${BOT.uid}`)
  inf(`Target UID    : ${cfg.targetUid}`)
  inf(`Game          : ${cfg.gameName}`)

  // Step 1 — connect
  header('Step 1: Connect')
  let ws!: WebSocket
  try {
    ws = await wsConnect(cfg.signalUrl)
    ok('Bot connected to signal server')
  } catch (e: any) {
    err(`Connection failed: ${e.message}`)
    process.exit(1)
  }

  // Step 2 — join lobby
  header('Step 2: Join Lobby')
  wsSend(ws, { type: 'join', user: BOT, lobbyId: BOT.lobbyId })
  try {
    await waitFor(ws, p => p.type === 'connected-users')
    ok(`Bot joined "${BOT.lobbyId}"`)
  } catch (e: any) {
    err(`Join failed: ${e.message}`)
    disconnectBot(ws, BOT.uid)
    process.exit(1)
  }

  // Confirm target is online
  const allUsers: any[] = []
  ws.on('message', (raw) => {
    try {
      const p = JSON.parse(raw.toString())
      if (p.type === 'connected-users' && Array.isArray(p.users)) allUsers.push(...p.users)
    } catch {}
  })
  await new Promise(r => setTimeout(r, 300))
  const targetOnline = allUsers.some((u: any) => u.uid === cfg.targetUid)
  if (targetOnline) {
    ok(`Target ${cfg.targetUid} is online`)
  } else {
    warn(`Target ${cfg.targetUid} not seen in connected-users — they may be in a different lobby or not logged in yet. Proceeding anyway.`)
  }

  // Step 3 — request match directly
  // The app handles match-start without needing a prior WebRTC exchange.
  header('Step 3: Send match request')
  log('info', `Requesting match: bot vs ${cfg.targetUid}`)

  wsSend(ws, {
    type:         'request-match',
    challengerId:  BOT.uid,
    opponentId:    cfg.targetUid,
    requestedBy:   BOT.uid,
    lobbyId:       BOT.lobbyId,
    gameName:      cfg.gameName,
  })

  let matchStart: any
  try {
    matchStart = await waitFor(ws, p => p.type === 'match-start' && p.opponentUid === cfg.targetUid)
    ok(`match-start received`)
    inf(`Match ID  : ${matchStart.matchId}`)
    inf(`Bot slot  : ${matchStart.playerSlot}`)
    inf(`Server    : ${matchStart.serverHost}:${matchStart.serverPort}`)
  } catch (e: any) {
    err(`match-start not received: ${e.message}`)
    inf('Make sure the target user is connected and not already in a match.')
    disconnectBot(ws, BOT.uid)
    process.exit(1)
  }

  // Step 4 — hole punch (bot's side)
  // The app's Rust proxy registers the real user's side automatically.
  // The bot must register too so the hole punch server can complete the pair.
  if (!cfg.skipPunch) {
    header('Step 4: Hole Punch (bot side)')
    inf(`Registering bot with ${cfg.punchHost}:${cfg.punchPort}...`)
    inf('The app proxy is registering the other side — waiting for the pair to complete...')
    try {
      const peer = await holePunch(BOT.uid, cfg.targetUid, cfg.punchHost, cfg.punchPort)
      ok(`Hole punch complete`)
      inf(`Bot sees real player at ${peer.address}:${peer.port}`)
      inf(`matchId from punch server: ${peer.matchId || 'n/a'}`)
    } catch (e: any) {
      err(`Hole punch failed: ${e.message}`)
      inf('The emulator may still have launched if the app proxy completed its side independently.')
    }
  } else {
    header('Step 4: Hole Punch')
    inf('Skipped (--skip-punch)')
  }

  console.log('\n\x1b[32m✓ Challenge sent and match started.\x1b[0m')
  inf('The emulator should now be launching on your machine via the app.')
  inf('Watching for match-force-close (opponent disconnect / match end)...')
  inf('Press Ctrl+C to exit early.\n')

  // Stay alive and watch for the match ending
  const cleanup = () => {
    try { wsSend(ws, { type: 'matchEnd', userUID: BOT.uid }) } catch {}
    setTimeout(() => { disconnectBot(ws, BOT.uid); process.exit(0) }, 300)
  }

  ws.on('message', (raw) => {
    try {
      const p = JSON.parse(raw.toString())
      if (p.type === 'match-force-close') {
        log('server', `match-force-close received (reason: ${p.reason ?? 'unknown'})`)
        ok('Match ended cleanly — server cleanup confirmed.')
        cleanup()
      }
    } catch {}
  })

  ws.on('close', () => {
    log('ws', 'Connection closed')
    process.exit(0)
  })

  process.on('SIGINT', () => {
    log('cleanup', 'Interrupted')
    cleanup()
  })
}

// ── Bot-vs-bot mode ───────────────────────────────────────────────────────────

async function runBotVsBotMode(cfg: ReturnType<typeof parseArgs>) {
  const runId = Date.now()
  const BOT_A = { uid: `test-bot-a-${runId}`, userName: 'TestBotA', accountElo: 1200, lobbyId: 'Hyper Reflector', userEmail: 'bota@test.local', countryCode: 'US', lastKnownPings: [] as any[] }
  const BOT_B = { uid: `test-bot-b-${runId}`, userName: 'TestBotB', accountElo: 1200, lobbyId: 'Hyper Reflector', userEmail: 'botb@test.local', countryCode: 'US', lastKnownPings: [] as any[] }

  console.log(`\n\x1b[1m=== Bot-vs-Bot Mode ===\x1b[0m`)
  inf(`Signal server : ${cfg.signalUrl}`)
  inf(`Hole punch    : ${cfg.punchHost}:${cfg.punchPort}${cfg.skipPunch ? ' (skipped)' : ''}`)
  inf(`Emulator      : ${cfg.emulatorPath || '(not provided)'}${cfg.skipEmulator ? ' (skipped)' : ''}`)
  inf(`Game          : ${cfg.gameName}`)

  let wsA!: WebSocket, wsB!: WebSocket

  // Step 1 — connect
  header('Step 1: Connect')
  try {
    ;[wsA, wsB] = await Promise.all([wsConnect(cfg.signalUrl), wsConnect(cfg.signalUrl)])
    ok('Both bots connected')
  } catch (e: any) {
    err(`Connection failed: ${e.message}`)
    process.exit(1)
  }

  // Step 2 — join
  header('Step 2: Join Lobby')
  wsSend(wsA, { type: 'join', user: BOT_A, lobbyId: BOT_A.lobbyId })
  wsSend(wsB, { type: 'join', user: BOT_B, lobbyId: BOT_B.lobbyId })
  try {
    await Promise.all([
      waitFor(wsA, p => p.type === 'connected-users'),
      waitFor(wsB, p => p.type === 'connected-users'),
    ])
    ok(`Both bots joined "${BOT_A.lobbyId}"`)
  } catch (e: any) {
    err(`Join failed: ${e.message}`)
    disconnectBot(wsA, BOT_A.uid); disconnectBot(wsB, BOT_B.uid)
    process.exit(1)
  }

  await new Promise(r => setTimeout(r, 200))

  // Step 3 — offer/answer forwarding
  header('Step 3: Challenge Signaling (WebRTC forwarding)')
  wsSend(wsB, { type: 'webrtc-ping-offer', from: BOT_B.uid, to: BOT_A.uid, offer: { type: 'offer', sdp: 'v=0\r\n' } })
  try {
    await waitFor(wsA, p => p.type === 'webrtc-ping-offer' && p.from === BOT_B.uid)
    ok('Bot A received offer from Bot B')
  } catch (e: any) {
    err(`Offer not forwarded: ${e.message}`)
    disconnectBot(wsA, BOT_A.uid); disconnectBot(wsB, BOT_B.uid)
    process.exit(1)
  }

  wsSend(wsA, { type: 'webrtc-ping-answer', from: BOT_A.uid, to: BOT_B.uid, answer: { type: 'answer', sdp: 'v=0\r\n' } })
  try {
    await waitFor(wsB, p => p.type === 'webrtc-ping-answer' && p.from === BOT_A.uid)
    ok('Bot B received answer from Bot A')
  } catch (e: any) {
    err(`Answer not forwarded: ${e.message}`)
    disconnectBot(wsA, BOT_A.uid); disconnectBot(wsB, BOT_B.uid)
    process.exit(1)
  }

  // Step 4 — request match
  header('Step 4: Request Match')
  wsSend(wsA, { type: 'request-match', challengerId: BOT_A.uid, opponentId: BOT_B.uid, requestedBy: BOT_A.uid, lobbyId: BOT_A.lobbyId, gameName: cfg.gameName })

  let matchStartA: any, matchStartB: any
  try {
    ;[matchStartA, matchStartB] = await Promise.all([
      waitFor(wsA, p => p.type === 'match-start'),
      waitFor(wsB, p => p.type === 'match-start'),
    ])
    ok('Match created')
    inf(`Match ID : ${matchStartA.matchId}`)
    inf(`Bot A slot ${matchStartA.playerSlot}  |  Bot B slot ${matchStartB.playerSlot}`)
    inf(`Server   : ${matchStartA.serverHost}:${matchStartA.serverPort}`)
  } catch (e: any) {
    err(`match-start not received: ${e.message}`)
    disconnectBot(wsA, BOT_A.uid); disconnectBot(wsB, BOT_B.uid)
    process.exit(1)
  }

  // Step 5 — hole punch
  if (!cfg.skipPunch) {
    header('Step 5: Hole Punch')
    log('info', `Both bots registering with ${cfg.punchHost}:${cfg.punchPort}...`)
    try {
      const [peerA, peerB] = await Promise.all([
        holePunch(BOT_A.uid, BOT_B.uid, cfg.punchHost, cfg.punchPort),
        holePunch(BOT_B.uid, BOT_A.uid, cfg.punchHost, cfg.punchPort),
      ])
      ok('Hole punch exchange complete')
      inf(`Bot A sees peer at ${peerA.address}:${peerA.port}`)
      inf(`Bot B sees peer at ${peerB.address}:${peerB.port}`)
    } catch (e: any) {
      err(`Hole punch failed: ${e.message}`)
      disconnectBot(wsA, BOT_A.uid); disconnectBot(wsB, BOT_B.uid)
      process.exit(1)
    }
  } else {
    header('Step 5: Hole Punch')
    inf('Skipped (--skip-punch)')
  }

  // Step 6 — emulator
  header('Step 6: Emulator Launch')
  if (cfg.skipEmulator || !cfg.emulatorPath.trim()) {
    inf('Skipped')
    console.log('\n\x1b[32m✓ All requested steps passed.\x1b[0m\n')
    disconnectBot(wsA, BOT_A.uid)
    disconnectBot(wsB, BOT_B.uid)
    return
  }

  const slotA: 0 | 1 = matchStartA.playerSlot === 0 ? 0 : 1
  const slotB: 0 | 1 = slotA === 0 ? 1 : 0
  const argsA = buildEmulatorArgs({ emulatorPath: cfg.emulatorPath, playerIndex: (slotA + 1) as 1 | 2, localPort: slotA === 0 ? 7000 : 7001, remotePort: slotA === 0 ? 7001 : 7000, playerName: BOT_A.userName, delay: cfg.delay, luaPath: cfg.luaPath, rom: cfg.gameName })
  const argsB = buildEmulatorArgs({ emulatorPath: cfg.emulatorPath, playerIndex: (slotB + 1) as 1 | 2, localPort: slotB === 0 ? 7000 : 7001, remotePort: slotB === 0 ? 7001 : 7000, playerName: BOT_B.userName, delay: cfg.delay, luaPath: cfg.luaPath, rom: cfg.gameName })

  let emuA!: ChildProcess, emuB!: ChildProcess
  try {
    emuA = spawn(cfg.emulatorPath, argsA, { detached: false, stdio: 'ignore' })
    emuB = spawn(cfg.emulatorPath, argsB, { detached: false, stdio: 'ignore' })
    emuA.on('error', (e) => log('emuA', `error: ${e.message}`))
    emuB.on('error', (e) => log('emuB', `error: ${e.message}`))
    ok(`Emulator A (PID ${emuA.pid}, Player ${slotA + 1})`)
    ok(`Emulator B (PID ${emuB.pid}, Player ${slotB + 1})`)
  } catch (e: any) {
    err(`Failed to spawn emulator: ${e.message}`)
    disconnectBot(wsA, BOT_A.uid); disconnectBot(wsB, BOT_B.uid)
    process.exit(1)
  }

  console.log('\n\x1b[32m✓ All steps passed.\x1b[0m')
  inf('Close the emulator windows when done.\n')

  let closed = 0
  const onClose = (label: string) => {
    closed++
    log(label, 'exited')
    if (closed >= 2) {
      try { wsSend(wsA, { type: 'matchEnd', userUID: BOT_A.uid }) } catch {}
      try { wsSend(wsB, { type: 'matchEnd', userUID: BOT_B.uid }) } catch {}
      setTimeout(() => { disconnectBot(wsA, BOT_A.uid); disconnectBot(wsB, BOT_B.uid); process.exit(0) }, 300)
    }
  }
  emuA.on('close', () => onClose('emuA'))
  emuB.on('close', () => onClose('emuB'))
  process.on('SIGINT', () => {
    log('cleanup', 'Interrupted')
    try { emuA?.kill() } catch {}
    try { emuB?.kill() } catch {}
    disconnectBot(wsA, BOT_A.uid); disconnectBot(wsB, BOT_B.uid)
    process.exit(0)
  })
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const cfg = parseArgs()
  if (cfg.targetUid) {
    await runChallengeMode(cfg)
  } else {
    await runBotVsBotMode(cfg)
  }
}

main().catch((e) => {
  console.error('\n\x1b[31mUnhandled error:\x1b[0m', e)
  process.exit(1)
})
