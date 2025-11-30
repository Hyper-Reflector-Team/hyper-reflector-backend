package main

import (
	"encoding/json"
	"log"
	"net"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Peer represents a connected client
type Peer struct {
	UID     string `json:"uid"`
	Address string `json:"address"`
	Port    int    `json:"port"`
}

type peerRecord struct {
	Peer     Peer
	LastSeen time.Time
}

// Message represents incoming JSON message
type Message struct {
	UID     string `json:"uid"`
	PeerUID string `json:"peerUid"`
	Kill    bool   `json:"kill"`
	MatchID string `json:"matchId,omitempty"`
}

// MatchPayload is sent to both peers
type MatchPayload struct {
	Peer    Peer   `json:"peer"`
	MatchID string `json:"matchId"`
}

type ControlPayload struct {
	Kill        bool   `json:"kill"`
	OpponentUID string `json:"opponentUid,omitempty"`
	Reason      string `json:"reason,omitempty"`
	MatchID     string `json:"matchId,omitempty"`
}

const HOLE_PUNCH_SERVER_PORT int = 33334

var (
	users          = make(map[string]peerRecord)
	activePeers    = make(map[string]peerRecord)
	currentMatchID = make(map[string]string)
	mu             sync.Mutex
)

const peerTimeout = 30 * time.Second
const cleanupInterval = 30 * time.Second

func main() {
	addr := net.UDPAddr{
		Port: HOLE_PUNCH_SERVER_PORT,
		IP:   net.ParseIP("0.0.0.0"),
	}

	conn, err := net.ListenUDP("udp", &addr)
	if err != nil {
		log.Fatal("UDP listen error:", err)
	}
	defer conn.Close()

	log.Println("UDP server listening on", addr.String())

	buf := make([]byte, 2048)

	go func() {
		ticker := time.NewTicker(cleanupInterval)
		defer ticker.Stop()
		for range ticker.C {
			pruneStalePeers()
		}
	}()

	// for {
	// 	n, remoteAddr, err := conn.ReadFromUDP(buf)
	// 	if err != nil {
	// 		log.Println("Read error:", err)
	// 		continue
	// 	}

	// 	go handleMessage(conn, buf[:n], remoteAddr)
	// }
	// test fix to see if the copy helps
	for {
		n, remoteAddr, err := conn.ReadFromUDP(buf)
		if err != nil {
			log.Println("Read error:", err)
			continue
		}
		dataCopy := make([]byte, n)
		copy(dataCopy, buf[:n])
		go handleMessage(conn, dataCopy, remoteAddr)
	}
}

func handleMessage(conn *net.UDPConn, data []byte, remote *net.UDPAddr) {
	var msg Message
	log.Println("server got a message")
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Println("Invalid JSON:", err)
		return
	}

	if msg.UID == "" || msg.PeerUID == "" {
		log.Println("Invalid message format")
		return
	}

	mu.Lock()
	defer mu.Unlock()

	// if msg.Kill {
	// 	log.Printf("Removing users: %s & %s\n", msg.UID, msg.PeerUID)
	// 	delete(users, msg.UID)
	// 	delete(users, msg.PeerUID)
	// 	return
	// }

	// more robust kill code
	if msg.Kill {
		handleKillMessage(conn, msg)
		log.Printf("Kill processed. Remaining users: %d\n", len(users))
		return
	}

	if msg.UID == "" || msg.PeerUID == "" {
		log.Println("Invalid message format (missing uid/peerUid)")
		return
	}

	currentPeer := Peer{
		UID:     msg.UID,
		Address: remote.IP.String(),
		Port:    remote.Port,
	}
	users[msg.UID] = peerRecord{Peer: currentPeer, LastSeen: time.Now()}
	activePeers[msg.UID] = peerRecord{Peer: currentPeer, LastSeen: time.Now()}

	log.Printf("Stored %s at %s:%d\n", msg.UID, remote.IP, remote.Port)

	if peer, exists := users[msg.PeerUID]; exists {
		matchID := sendMatchData(conn, currentPeer, peer.Peer)
		currentMatchID[msg.UID] = matchID
		currentMatchID[msg.PeerUID] = matchID
		delete(users, msg.UID)
		delete(users, msg.PeerUID)
	}
}

func sendMatchData(conn *net.UDPConn, a, b Peer) string {
	start := time.Now()

	matchID := uuid.New().String()

	msgToA, _ := json.Marshal(MatchPayload{
		Peer:    b,
		MatchID: matchID,
	})

	msgToB, _ := json.Marshal(MatchPayload{
		Peer:    a,
		MatchID: matchID,
	})

	send(conn, msgToA, a)
	send(conn, msgToB, b)

	duration := time.Since(start)
	log.Printf("Match data sent to %s and %s in %s\n", a.UID, b.UID, duration)
	return matchID
}

func handleKillMessage(conn *net.UDPConn, msg Message) {
	matchID := currentMatchID[msg.UID]
	if matchID == "" {
		matchID = currentMatchID[msg.PeerUID]
	}
	if msg.MatchID != "" && matchID != "" && matchID != msg.MatchID {
		log.Printf("Ignoring kill from %s with stale matchId %s (current %s)\n", msg.UID, msg.MatchID, matchID)
		return
	}

	var peer Peer
	peerExists := false
	if msg.PeerUID != "" {
		if storedPeer, ok := activePeers[msg.PeerUID]; ok {
			peer = storedPeer.Peer
			peerExists = true
		}
	}

	if msg.UID != "" {
		delete(activePeers, msg.UID)
	}
	if msg.PeerUID != "" {
		delete(activePeers, msg.PeerUID)
	}

	if !peerExists {
		return
	}

	payload := ControlPayload{
		Kill:        true,
		OpponentUID: msg.UID,
		Reason:      "peer-disconnected",
		MatchID:     matchID,
	}
	msgBytes, err := json.Marshal(payload)
	if err != nil {
		log.Println("Failed to marshal kill payload:", err)
		return
	}
	send(conn, msgBytes, peer)

	if msg.UID != "" {
		delete(currentMatchID, msg.UID)
	}
	if msg.PeerUID != "" {
		delete(currentMatchID, msg.PeerUID)
	}
}

func send(conn *net.UDPConn, msg []byte, peer Peer) {
	addr := net.UDPAddr{
		IP:   net.ParseIP(peer.Address),
		Port: peer.Port,
	}
	_, err := conn.WriteToUDP(msg, &addr)
	if err != nil {
		log.Printf("Error sending to %s: %v\n", peer.UID, err)
	} else {
		log.Printf("Sent peer info to %s\n", peer.UID)
	}
}

func pruneStalePeers() {
	now := time.Now()
	mu.Lock()
	defer mu.Unlock()

	for uid, record := range users {
		if now.Sub(record.LastSeen) > peerTimeout {
			delete(users, uid)
			log.Printf("Removed stale waiting peer %s\n", uid)
		}
	}

	for uid, record := range activePeers {
		if now.Sub(record.LastSeen) > peerTimeout {
			delete(activePeers, uid)
			log.Printf("Removed stale active peer %s\n", uid)
		}
	}
}
