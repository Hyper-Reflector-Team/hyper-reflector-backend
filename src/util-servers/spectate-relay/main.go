package main

// Spectate relay: a dumb forwarder for the spectating feature. It never
// interprets game data — it only moves opaque bytes from a match's publisher
// (always the playerSlot-0 client, see websocket-server's spectate-request
// handler) to that match's subscribers.
//
// Two transports:
//
//   - UDP (SPECTATE_UDP_PORT): the live per-frame confirmed-input feed.
//     Every packet is a single JSON object with a "type" field:
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
//     resent periodically (see watcherTimeout) to stay registered.
//
//     {"type":"unwatch","matchId":"...","uid":"..."}
//     Explicit stop.
//
//     {"type":"frame","matchId":"...","frame":12345,"data":"<base64>"}
//     Sent by a registered publisher. Relayed byte-for-byte (same JSON,
//     just re-marshaled) to every registered subscriber of matchId. The
//     "data" payload is opaque to the relay — it's whatever the FBNeo
//     client's publisher path put there.
//
//   - TCP (SPECTATE_TCP_PORT): the one-shot state-snapshot handoff for
//     mid-match join. A publisher holds ONE persistent connection per
//     match; many spectators can each request a snapshot against it
//     without needing their own publisher connection. Every message on
//     either side of this protocol is:
//
//     [4-byte big-endian header length][header JSON bytes][optional payload]
//
//     Publisher, on connect, sends:
//       {"role":"publisher","matchId":"..."}
//     and then just keeps the connection open, reading further headers.
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
//     and then reads exactly one response back from the relay: either
//       {"cmd":"snapshot-response","frame":12345,"payloadSize":N} + N bytes
//     or
//       {"cmd":"error","reason":"..."}
//     after which the relay closes the connection.

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
// UDP: live frame fan-out
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
	Frame    int64  `json:"frame,omitempty"`
	Data     string `json:"data,omitempty"`
	UserName string `json:"userName,omitempty"`
	Text     string `json:"text,omitempty"`
	Count    int    `json:"count,omitempty"`
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
		publishers[msg.MatchID] = udpRegistration{addr: remote, uid: msg.UID, lastSeen: time.Now()}
		udpMu.Unlock()

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

	case "frame":
		udpMu.Lock()
		pub, ok := publishers[msg.MatchID]
		// Only relay frames from the currently-registered publisher's address,
		// so a stale/duplicate publisher can't inject data into someone else's match.
		if !ok || pub.addr.String() != remote.String() {
			udpMu.Unlock()
			return
		}
		pub.lastSeen = time.Now()
		publishers[msg.MatchID] = pub

		var targets []udpRegistration
		if watchers, ok := subscribers[msg.MatchID]; ok {
			for _, w := range watchers {
				targets = append(targets, w)
			}
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

	case "chat":
		// Spectator-only chat: fans out to this match's other watchers and nothing else --
		// never touches the publishers map, so it can never reach the players. Sender must be
		// a currently-registered watcher of this match (same anti-spoofing check as "frame"
		// above, just against the subscribers map instead of publishers) so a stranger can't
		// inject chat into a match they never joined as a spectator.
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
// TCP: snapshot handoff for mid-match join
// ---------------------------------------------------------------------------

type tcpHeader struct {
	Role        string `json:"role,omitempty"`
	MatchID     string `json:"matchId,omitempty"`
	Cmd         string `json:"cmd,omitempty"`
	RequestID   string `json:"requestId,omitempty"`
	Frame       int64  `json:"frame,omitempty"`
	PayloadSize int    `json:"payloadSize,omitempty"`
	Reason      string `json:"reason,omitempty"`
}

type publisherConn struct {
	conn net.Conn
	w    *bufio.Writer
	mu   sync.Mutex // guards writes to conn, since requests can arrive concurrently
}

type pendingSnapshot struct {
	specConn net.Conn
	done     chan struct{}
}

var (
	tcpMu             sync.Mutex
	matchPublisherTCP = make(map[string]*publisherConn) // matchId -> its publisher's persistent conn
	pendingByRequest  = make(map[string]*pendingSnapshot)
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
		handleSpectatorConn(conn, header.MatchID)
	default:
		conn.Close()
	}
}

func handlePublisherConn(conn net.Conn, reader *bufio.Reader, matchId string) {
	if matchId == "" {
		conn.Close()
		return
	}

	pc := &publisherConn{conn: conn, w: bufio.NewWriter(conn)}

	tcpMu.Lock()
	matchPublisherTCP[matchId] = pc
	tcpMu.Unlock()

	defer func() {
		tcpMu.Lock()
		if matchPublisherTCP[matchId] == pc {
			delete(matchPublisherTCP, matchId)
		}
		tcpMu.Unlock()
		conn.Close()
	}()

	log.Printf("spectate-relay: publisher connected for match %s\n", matchId)

	for {
		header, err := readFramedHeader(reader)
		if err != nil {
			log.Printf("spectate-relay: publisher for match %s disconnected: %v\n", matchId, err)
			return
		}

		if header.Cmd != "snapshot-response" {
			continue
		}
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

		_ = writeFramed(pending.specConn, tcpHeader{
			Cmd:         "snapshot-response",
			Frame:       header.Frame,
			PayloadSize: header.PayloadSize,
		}, payload)
		pending.specConn.Close()
		close(pending.done)
	}
}

func handleSpectatorConn(conn net.Conn, matchId string) {
	defer conn.Close()

	if matchId == "" {
		_ = writeFramed(conn, tcpHeader{Cmd: "error", Reason: "missing matchId"}, nil)
		return
	}

	tcpMu.Lock()
	pc, ok := matchPublisherTCP[matchId]
	tcpMu.Unlock()

	if !ok {
		_ = writeFramed(conn, tcpHeader{Cmd: "error", Reason: "no publisher for match"}, nil)
		return
	}

	requestId := uuid.New().String()
	pending := &pendingSnapshot{specConn: conn, done: make(chan struct{})}

	tcpMu.Lock()
	pendingByRequest[requestId] = pending
	tcpMu.Unlock()

	pc.mu.Lock()
	err := writeFramed(pc.w, tcpHeader{Cmd: "snapshot-request", RequestID: requestId}, nil)
	if err == nil {
		err = pc.w.Flush()
	}
	pc.mu.Unlock()

	if err != nil {
		tcpMu.Lock()
		delete(pendingByRequest, requestId)
		tcpMu.Unlock()
		_ = writeFramed(conn, tcpHeader{Cmd: "error", Reason: "publisher unreachable"}, nil)
		return
	}

	select {
	case <-pending.done:
		// handlePublisherConn already wrote the response and closed conn.
	case <-time.After(snapshotRequestTimeout):
		tcpMu.Lock()
		delete(pendingByRequest, requestId)
		tcpMu.Unlock()
		_ = writeFramed(conn, tcpHeader{Cmd: "error", Reason: "snapshot request timed out"}, nil)
	}
}

// ---------------------------------------------------------------------------

func main() {
	go runUDPRelay()
	runTCPRelay()
}
