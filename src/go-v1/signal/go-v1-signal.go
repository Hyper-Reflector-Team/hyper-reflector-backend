// This is a work in progress
package main

import (
	"fmt"
	"net/http"

	"github.com/gorilla/websocket"
)

// Upgrade HTTP connection to WebSocket
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all connections (adjust as needed)
	},
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		fmt.Println("Upgrade error:", err)
		return
	}
	defer conn.Close()

	for {
		// Read message from client
		_, msg, err := conn.ReadMessage()
		if err != nil {
			fmt.Println("Read error:", err)
			break
		}
		fmt.Printf("Received: %s\n", msg)

		// Echo message back
		if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			fmt.Println("Write error:", err)
			break
		}
	}
}

func main() {
	http.HandleFunc("/ws", handleWebSocket)
	fmt.Println("Server listening on :8890")
	http.ListenAndServe(":8890", nil)
}
