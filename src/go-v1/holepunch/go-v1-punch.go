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

// Message represents incoming JSON message
type Message struct {
	UID     string `json:"uid"`
	PeerUID string `json:"peerUid"`
	Kill    bool   `json:"kill"`
}

// MatchPayload is sent to both peers
type MatchPayload struct {
	Peer    Peer   `json:"peer"`
	MatchID string `json:"matchId"`
}

const HOLE_PUNCH_SERVER_PORT int = 33334

var (
	users = make(map[string]Peer)
	mu    sync.Mutex
)

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
		if msg.UID != "" {
			delete(users, msg.UID)
		}
		if msg.PeerUID != "" {
			delete(users, msg.PeerUID)
		}
		log.Printf("Kill processed. Remaining users: %d\n", len(users))
		return
	}

	if msg.UID == "" || msg.PeerUID == "" {
		log.Println("Invalid message format (missing uid/peerUid)")
		return
	}

	users[msg.UID] = Peer{
		UID:     msg.UID,
		Address: remote.IP.String(),
		Port:    remote.Port,
	}

	log.Printf("Stored %s at %s:%d\n", msg.UID, remote.IP, remote.Port)

	if peer, exists := users[msg.PeerUID]; exists {
		sendMatchData(conn, users[msg.UID], peer)
	}
}

func sendMatchData(conn *net.UDPConn, a, b Peer) {
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
