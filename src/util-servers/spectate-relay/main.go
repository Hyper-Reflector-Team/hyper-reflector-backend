package main

// Spectate relay: a dumb forwarder for the spectating feature. It never
// interprets game data — it only moves opaque bytes from a match's publisher
// (always the playerSlot-0 client, see websocket-server's spectate-request
// handler) to that match's subscribers.
//
// The live per-frame confirmed-input feed rides TCP, not UDP -- unlike GGPO's
// own P2P input packets (which tolerate loss because every packet carries
// several recent frames and rollback can correct a late/wrong prediction), a
// spectator feed carries only already-confirmed data with nothing analogous
// to rollback on the receiving end. A single dropped UDP "frame" packet used
// to strand a spectator forever waiting on a frame number that would never
// be resent. TCP's own reliable, ordered delivery makes that whole class of
// bug impossible by construction (see Project Slippi's spectator protocol
// for prior art: it makes the same choice, over ENet's reliable channel,
// specifically to avoid needing any catch-up/gap-recovery machinery).
//
// Two transports:
//
//   - UDP (SPECTATE_UDP_PORT): presence and chat, both fine to lose
//     occasionally since they're self-correcting (heartbeats resend
//     periodically; a missed spectator-count update is overwritten by the
//     next change). Every packet is a single JSON object with a "type":
//
//     {"type":"publish","matchId":"...","uid":"..."}
//     Registers/refreshes the sender as matchId's publisher. Must be
//     resent periodically (see publisherTimeout) to stay registered.
//
//     {"type":"unpublish","matchId":"..."}
//     Explicit stop; relay drops the publisher and its watchers.
//
//     {"type":"watch","matchId":"...","uid":"..."}
//     Registers/refreshes the sender as a subscriber of matchId. Must be
//     resent periodically (see watcherTimeout) to stay registered. Purely
//     for presence/spectator-count purposes now -- the live frame feed
//     itself flows over each spectator's TCP connection instead (below).
//
//     {"type":"unwatch","matchId":"...","uid":"..."}
//     Explicit stop.
//
//     {"type":"chat","matchId":"...","uid":"...","userName":"...","text":"..."}
//     Spectator-only chat; fanned out to this match's other watchers.
//
//   - TCP (SPECTATE_TCP_PORT): the state-snapshot handoff for mid-match
//     join, AND (unlike the old design) the ongoing live frame feed itself.
//     A publisher holds ONE persistent connection per match; a spectator
//     also keeps its connection open for the match's duration once
//     connected, rather than closing it after the initial snapshot. Every
//     message on either side of this protocol is:
//
//     [4-byte big-endian header length][header JSON bytes][optional payload]
//
//     Publisher, on connect, sends:
//       {"role":"publisher","matchId":"..."}
//     and then keeps the connection open, both reading further headers
//     (snapshot-request, below) and proactively pushing:
//       {"cmd":"frame","frame":12345,"data":"<base64>"}
//     for every confirmed frame once it's old enough to be safe to reveal
//     (see fbn_spectate.cpp's SpectatePublishTick) -- no payload, the "data"
//     field carries the tiny (14-byte) confirmed-input blob inline.
//
//     The relay pushes, whenever a spectator asks:
//       {"cmd":"snapshot-request","requestId":"..."}
//     (no payload)
//
//     The publisher responds on the same connection with:
//       {"cmd":"snapshot-response","requestId":"...","frame":12345,"payloadSize":N}
//     immediately followed by N raw bytes (the state blob — NOT
//     base64'd, this is why TCP framing carries a raw payload instead of
//     JSON-embedding it).
//
//     Spectator, on connect, sends:
//       {"role":"spectator","matchId":"..."}
//     and then reads exactly one of:
//       {"cmd":"snapshot-response","frame":12345,"payloadSize":N} + N bytes
//     or
//       {"cmd":"error","reason":"..."}
//     On success, the connection is NOT closed afterward -- the relay keeps
//     it open and streams every subsequent {"cmd":"frame",...} push from the
//     publisher down it, in the exact order the publisher sent them (TCP
//     guarantees this), until either side disconnects.

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	SPECTATE_UDP_PORT = 33335
	SPECTATE_TCP_PORT = 33336

	publisherTimeout = 15 * time.Second
	watcherTimeout   = 15 * time.Second
	pruneInterval    = 5 * time.Second

	snapshotRequestTimeout = 5 * time.Second
	maxHeaderSize          = 4096
	maxSnapshotPayload     = 64 * 1024 * 1024 // sanity cap; real state blobs are far smaller
)

// ---------------------------------------------------------------------------
// UDP: presence (publish/watch keepalive, spectator-count) and chat
// ---------------------------------------------------------------------------

type udpRegistration struct {
	addr     *net.UDPAddr
	uid      string
	lastSeen time.Time
}

var (
	udpMu       sync.Mutex
	publishers  = make(map[string]udpRegistration)            // matchId -> publisher
	subscribers = make(map[string]map[string]udpRegistration) // matchId -> uid -> subscriber
)

type udpEnvelope struct {
	Type     string `json:"type"`
	MatchID  string `json:"matchId"`
	UID      string `json:"uid,omitempty"`
	UserName string `json:"userName,omitempty"`
	Text     string `json:"text,omitempty"`
	// Count deliberately has no omitempty: 0 is meaningful (the last spectator leaving), and
	// omitempty on a numeric field drops the key entirely at its zero value, which a reader like
	// fbn_spectate.cpp's JsonExtractLong can't tell apart from "no packet was even parseable".
	Count int `json:"count"`
}

// Sent to a match's publisher and all of its watchers whenever the watcher set changes size
// (join, leave, or timeout-prune) -- see the "watch"/"unwatch" cases and pruneStaleUDP below.
func broadcastSpectatorCount(conn *net.UDPConn, matchId string) {
	udpMu.Lock()
	count := len(subscribers[matchId])
	var targets []udpRegistration
	if pub, ok := publishers[matchId]; ok {
		targets = append(targets, pub)
	}
	for _, w := range subscribers[matchId] {
		targets = append(targets, w)
	}
	udpMu.Unlock()

	if len(targets) == 0 {
		return
	}
	out, err := json.Marshal(udpEnvelope{Type: "spectator-count", MatchID: matchId, Count: count})
	if err != nil {
		return
	}
	for _, t := range targets {
		_, _ = conn.WriteToUDP(out, t.addr)
	}
}

func runUDPRelay() {
	addr := net.UDPAddr{Port: SPECTATE_UDP_PORT, IP: net.ParseIP("0.0.0.0")}
	conn, err := net.ListenUDP("udp", &addr)
	if err != nil {
		log.Fatal("spectate-relay UDP listen error:", err)
	}
	defer conn.Close()

	log.Println("spectate-relay UDP listening on", addr.String())

	go func() {
		ticker := time.NewTicker(pruneInterval)
		defer ticker.Stop()
		for range ticker.C {
			pruneStaleUDP(conn)
		}
	}()

	buf := make([]byte, 2048)
	for {
		n, remote, err := conn.ReadFromUDP(buf)
		if err != nil {
			log.Println("spectate-relay UDP read error:", err)
			continue
		}
		dataCopy := make([]byte, n)
		copy(dataCopy, buf[:n])
		go handleUDPPacket(conn, dataCopy, remote)
	}
}

func handleUDPPacket(conn *net.UDPConn, data []byte, remote *net.UDPAddr) {
	var msg udpEnvelope
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Println("spectate-relay: invalid UDP JSON:", err)
		return
	}
	if msg.MatchID == "" {
		return
	}

	switch msg.Type {
	case "publish":
		if msg.UID == "" {
			return
		}
		udpMu.Lock()
		_, alreadyPublishing := publishers[msg.MatchID]
		publishers[msg.MatchID] = udpRegistration{addr: remote, uid: msg.UID, lastSeen: time.Now()}
		udpMu.Unlock()
		if !alreadyPublishing {
			log.Printf("spectate-relay: UDP publisher registered for match %s from %s\n", msg.MatchID, remote.String())
		}

	case "unpublish":
		udpMu.Lock()
		delete(publishers, msg.MatchID)
		delete(subscribers, msg.MatchID)
		udpMu.Unlock()

	case "watch":
		if msg.UID == "" {
			return
		}
		udpMu.Lock()
		if subscribers[msg.MatchID] == nil {
			subscribers[msg.MatchID] = make(map[string]udpRegistration)
		}
		_, alreadyWatching := subscribers[msg.MatchID][msg.UID]
		subscribers[msg.MatchID][msg.UID] = udpRegistration{addr: remote, uid: msg.UID, lastSeen: time.Now()}
		udpMu.Unlock()

		// Only broadcast on an actual join, not the periodic keepalive re-registration
		// (see SPECTATE_REGISTER_INTERVAL_MS in fbn_spectate.cpp) that keeps this from expiring.
		if !alreadyWatching {
			log.Printf("spectate-relay: UDP watcher %s registered for match %s from %s\n", msg.UID, msg.MatchID, remote.String())
			broadcastSpectatorCount(conn, msg.MatchID)
		}

	case "unwatch":
		if msg.UID == "" {
			return
		}
		udpMu.Lock()
		watchers, ok := subscribers[msg.MatchID]
		_, wasWatching := watchers[msg.UID]
		if ok {
			delete(watchers, msg.UID)
		}
		udpMu.Unlock()

		if wasWatching {
			broadcastSpectatorCount(conn, msg.MatchID)
		}

	case "chat":
		// Spectator-only chat: fans out to this match's other watchers and nothing else --
		// never touches the publishers map, so it can never reach the players. Sender must be
		// a currently-registered watcher of this match so a stranger can't inject chat into a
		// match they never joined as a spectator.
		udpMu.Lock()
		watchers, ok := subscribers[msg.MatchID]
		if !ok {
			udpMu.Unlock()
			return
		}
		sender, isWatcher := watchers[msg.UID]
		if !isWatcher || sender.addr.String() != remote.String() {
			udpMu.Unlock()
			return
		}

		var targets []udpRegistration
		for uid, w := range watchers {
			if uid == msg.UID {
				continue // sender already echoes their own message locally, don't send it back
			}
			targets = append(targets, w)
		}
		udpMu.Unlock()

		if len(targets) == 0 {
			return
		}
		out, err := json.Marshal(msg)
		if err != nil {
			return
		}
		for _, t := range targets {
			_, _ = conn.WriteToUDP(out, t.addr)
		}

	default:
		// Unknown type — ignore. Keeps this relay forward-compatible with
		// clients that add new envelope types the relay doesn't need to react to.
	}
}

func pruneStaleUDP(conn *net.UDPConn) {
	now := time.Now()
	var changedMatches []string

	udpMu.Lock()
	for matchId, pub := range publishers {
		if now.Sub(pub.lastSeen) > publisherTimeout {
			delete(publishers, matchId)
			delete(subscribers, matchId)
			log.Printf("spectate-relay: publisher for match %s timed out\n", matchId)
		}
	}
	for matchId, watchers := range subscribers {
		before := len(watchers)
		for uid, w := range watchers {
			if now.Sub(w.lastSeen) > watcherTimeout {
				delete(watchers, uid)
			}
		}
		if len(watchers) != before {
			changedMatches = append(changedMatches, matchId)
		}
		if len(watchers) == 0 {
			delete(subscribers, matchId)
		}
	}
	udpMu.Unlock()

	// Broadcast outside the lock -- these are network sends, not map access.
	for _, matchId := range changedMatches {
		broadcastSpectatorCount(conn, matchId)
	}
}

// ---------------------------------------------------------------------------
// TCP: snapshot handoff for mid-match join, and the live frame feed
// ---------------------------------------------------------------------------

type tcpHeader struct {
	Role      string `json:"role,omitempty"`
	MatchID   string `json:"matchId,omitempty"`
	Cmd       string `json:"cmd,omitempty"`
	RequestID string `json:"requestId,omitempty"`
	// No omitempty on Frame/PayloadSize: both can legitimately be 0 (the very first frame of a
	// match), and omitempty would silently drop the key in that case instead of sending an
	// explicit 0, which a reader like fbn_spectate.cpp's JsonExtractLong can't tell apart from
	// "no packet was even parseable".
	Frame       int64  `json:"frame"`
	PayloadSize int    `json:"payloadSize"`
	Reason      string `json:"reason,omitempty"`
	// Data carries a "frame" push's tiny (14-byte) confirmed-input blob inline as base64 -- no
	// separate raw payload needed for something this small (contrast the snapshot's payload,
	// which can be sizeable and rides the raw-bytes-after-header form instead).
	Data string `json:"data,omitempty"`
}

// A persistent TCP connection this relay writes to, possibly from multiple goroutines: a
// publisher's snapshot responses come from its own read loop, but the live frame feed (pushed by
// the publisher, fanned out to every watcher) and new-watcher registration can all be happening
// concurrently. send() serializes writes to a given connection and can be called from any
// goroutine.
type tcpWriter struct {
	conn net.Conn
	w    *bufio.Writer
	mu   sync.Mutex
}

func (t *tcpWriter) send(header tcpHeader, payload []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if err := writeFramed(t.w, header, payload); err != nil {
		return err
	}
	return t.w.Flush()
}

type pendingSnapshot struct {
	spec *tcpWriter
	done chan struct{}
}

var (
	tcpMu             sync.Mutex
	matchPublisherTCP = make(map[string]*tcpWriter)          // matchId -> its publisher's persistent conn
	matchWatchersTCP  = make(map[string]map[*tcpWriter]bool) // matchId -> set of connected spectators' persistent conns
	pendingByRequest  = make(map[string]*pendingSnapshot)

	// Debug aid: logs only the first successfully-relayed frame per match, so "frames are
	// flowing at all" is visible in the log without spamming it at frame rate. Guarded by tcpMu
	// since the live feed now flows entirely over TCP.
	loggedFirstFrameRelayed = make(map[string]bool)
)

func writeFramed(w io.Writer, header tcpHeader, payload []byte) error {
	headerBytes, err := json.Marshal(header)
	if err != nil {
		return err
	}
	lenBuf := make([]byte, 4)
	binary.BigEndian.PutUint32(lenBuf, uint32(len(headerBytes)))
	if _, err := w.Write(lenBuf); err != nil {
		return err
	}
	if _, err := w.Write(headerBytes); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := w.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

func readFramedHeader(r *bufio.Reader) (tcpHeader, error) {
	var header tcpHeader
	lenBuf := make([]byte, 4)
	if _, err := io.ReadFull(r, lenBuf); err != nil {
		return header, err
	}
	size := binary.BigEndian.Uint32(lenBuf)
	if size == 0 || size > maxHeaderSize {
		return header, fmt.Errorf("invalid header size %d", size)
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(r, buf); err != nil {
		return header, err
	}
	if err := json.Unmarshal(buf, &header); err != nil {
		return header, err
	}
	return header, nil
}

func runTCPRelay() {
	addr := net.TCPAddr{Port: SPECTATE_TCP_PORT, IP: net.ParseIP("0.0.0.0")}
	listener, err := net.ListenTCP("tcp", &addr)
	if err != nil {
		log.Fatal("spectate-relay TCP listen error:", err)
	}
	defer listener.Close()

	log.Println("spectate-relay TCP listening on", addr.String())

	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Println("spectate-relay TCP accept error:", err)
			continue
		}
		go handleTCPConn(conn)
	}
}

func handleTCPConn(conn net.Conn) {
	reader := bufio.NewReader(conn)

	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	header, err := readFramedHeader(reader)
	if err != nil {
		log.Println("spectate-relay: bad TCP hello:", err)
		conn.Close()
		return
	}
	_ = conn.SetReadDeadline(time.Time{})

	switch header.Role {
	case "publisher":
		handlePublisherConn(conn, reader, header.MatchID)
	case "spectator":
		handleSpectatorConn(conn, reader, header.MatchID)
	default:
		conn.Close()
	}
}

func handlePublisherConn(conn net.Conn, reader *bufio.Reader, matchId string) {
	if matchId == "" {
		conn.Close()
		return
	}

	pc := &tcpWriter{conn: conn, w: bufio.NewWriter(conn)}

	tcpMu.Lock()
	matchPublisherTCP[matchId] = pc
	tcpMu.Unlock()

	defer func() {
		tcpMu.Lock()
		if matchPublisherTCP[matchId] == pc {
			delete(matchPublisherTCP, matchId)
		}
		// The live feed ends with the publisher -- tell this match's watchers and drop them
		// rather than leaving their connections open with nothing left to stream.
		watchers := matchWatchersTCP[matchId]
		delete(matchWatchersTCP, matchId)
		delete(loggedFirstFrameRelayed, matchId)
		tcpMu.Unlock()
		for w := range watchers {
			_ = w.send(tcpHeader{Cmd: "publisher-disconnected"}, nil)
			w.conn.Close()
		}
		conn.Close()
	}()

	log.Printf("spectate-relay: publisher connected for match %s\n", matchId)

	for {
		header, err := readFramedHeader(reader)
		if err != nil {
			log.Printf("spectate-relay: publisher for match %s disconnected: %v\n", matchId, err)
			return
		}

		switch header.Cmd {
		case "snapshot-response":
			if header.PayloadSize < 0 || header.PayloadSize > maxSnapshotPayload {
				log.Printf("spectate-relay: publisher for match %s sent bad payloadSize %d\n", matchId, header.PayloadSize)
				return
			}
			payload := make([]byte, header.PayloadSize)
			if _, err := io.ReadFull(reader, payload); err != nil {
				log.Printf("spectate-relay: failed reading snapshot payload for match %s: %v\n", matchId, err)
				return
			}

			tcpMu.Lock()
			pending, ok := pendingByRequest[header.RequestID]
			if ok {
				delete(pendingByRequest, header.RequestID)
			}
			tcpMu.Unlock()

			if !ok {
				// Late/duplicate response for a request that already timed out. Drop it.
				continue
			}

			_ = pending.spec.send(tcpHeader{
				Cmd:         "snapshot-response",
				Frame:       header.Frame,
				PayloadSize: header.PayloadSize,
			}, payload)
			close(pending.done)
			// pending.spec's connection is deliberately NOT closed here -- it stays open and
			// registers as a live watcher right after this (see handleSpectatorConn), unlike the
			// old one-shot-then-close design.

		case "frame":
			// The confirmed-input live feed, pushed unprompted by the publisher for every frame
			// once it's old enough to be safe to reveal (see fbn_spectate.cpp's
			// SpectatePublishTick). Fan out to every currently-connected watcher's persistent TCP
			// connection -- delivery here is exactly as reliable as this connection itself, so
			// unlike the old UDP feed, no redundancy or gap-recovery is needed on either end.
			tcpMu.Lock()
			var targets []*tcpWriter
			for w := range matchWatchersTCP[matchId] {
				targets = append(targets, w)
			}
			alreadyLogged := loggedFirstFrameRelayed[matchId]
			loggedFirstFrameRelayed[matchId] = true
			tcpMu.Unlock()

			if !alreadyLogged {
				log.Printf("spectate-relay: relaying frame %d for match %s to %d watcher(s) over TCP\n", header.Frame, matchId, len(targets))
			}

			out := tcpHeader{Cmd: "frame", Frame: header.Frame, Data: header.Data}
			for _, w := range targets {
				if err := w.send(out, nil); err != nil {
					// A slow/dead watcher shouldn't block or drop frames for everyone else --
					// just deregister it; its own read loop in handleSpectatorConn notices the
					// connection is dead and closes it there.
					tcpMu.Lock()
					delete(matchWatchersTCP[matchId], w)
					tcpMu.Unlock()
				}
			}

		default:
			// Unknown/unused cmd on this connection -- ignore for forward-compatibility.
		}
	}
}

func handleSpectatorConn(conn net.Conn, reader *bufio.Reader, matchId string) {
	sw := &tcpWriter{conn: conn, w: bufio.NewWriter(conn)}

	if matchId == "" {
		_ = sw.send(tcpHeader{Cmd: "error", Reason: "missing matchId"}, nil)
		conn.Close()
		return
	}

	tcpMu.Lock()
	pc, ok := matchPublisherTCP[matchId]
	tcpMu.Unlock()

	if !ok {
		_ = sw.send(tcpHeader{Cmd: "error", Reason: "no publisher for match"}, nil)
		conn.Close()
		return
	}

	requestId := uuid.New().String()
	pending := &pendingSnapshot{spec: sw, done: make(chan struct{})}

	tcpMu.Lock()
	pendingByRequest[requestId] = pending
	tcpMu.Unlock()

	if err := pc.send(tcpHeader{Cmd: "snapshot-request", RequestID: requestId}, nil); err != nil {
		tcpMu.Lock()
		delete(pendingByRequest, requestId)
		tcpMu.Unlock()
		_ = sw.send(tcpHeader{Cmd: "error", Reason: "publisher unreachable"}, nil)
		conn.Close()
		return
	}

	select {
	case <-pending.done:
		// handlePublisherConn already sent the snapshot-response above.
	case <-time.After(snapshotRequestTimeout):
		tcpMu.Lock()
		delete(pendingByRequest, requestId)
		tcpMu.Unlock()
		_ = sw.send(tcpHeader{Cmd: "error", Reason: "snapshot request timed out"}, nil)
		conn.Close()
		return
	}

	// Snapshot delivered -- register as a live watcher and keep this connection open for the
	// match's duration instead of closing it (see the "frame" case in handlePublisherConn, which
	// only starts fanning frames out to this connection from this point forward; registering any
	// earlier would risk a frame push racing ahead of the snapshot-response on the wire).
	tcpMu.Lock()
	if matchWatchersTCP[matchId] == nil {
		matchWatchersTCP[matchId] = make(map[*tcpWriter]bool)
	}
	matchWatchersTCP[matchId][sw] = true
	tcpMu.Unlock()
	log.Printf("spectate-relay: spectator connected for match %s, watching live feed over TCP\n", matchId)

	defer func() {
		tcpMu.Lock()
		delete(matchWatchersTCP[matchId], sw)
		tcpMu.Unlock()
		conn.Close()
	}()

	// Nothing meaningful is expected FROM the spectator on this connection -- it's a one-way live
	// feed. Keep reading (and discarding) so a closed/dead connection is noticed promptly instead
	// of leaking a registration until the match ends.
	discard := make([]byte, 256)
	for {
		if _, err := reader.Read(discard); err != nil {
			return
		}
	}
}

// ---------------------------------------------------------------------------

func main() {
	go runUDPRelay()
	runTCPRelay()
}
