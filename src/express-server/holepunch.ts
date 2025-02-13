const dgram = require("dgram");

const server = dgram.createSocket("udp4");
const PORT = 7000;

const clients = new Map(); // Store connected clients

server.on("message", (msg, rinfo) => {
    const clientId = msg.toString();
    
    console.log(`Received message from ${rinfo.address}:${rinfo.port} - ID: ${clientId}`);
    
    if (!clients.has(clientId)) {
        clients.set(clientId, rinfo);
    }
    
    // If we have 2 clients, try hole punching
    if (clients.size >= 2) {
        const clientList = Array.from(clients.values());

        if (clientList.length >= 2) {
            const [client1, client2] = clientList;
            
            console.log(`Sending punch details to ${client1.address}:${client1.port} <--> ${client2.address}:${client2.port}`);

            // Send each peer the other's address
            server.send(`${client2.address}:${client2.port}`, client1.port, client1.address);
            server.send(`${client1.address}:${client1.port}`, client2.port, client2.address);
        }
    }
});

server.on("listening", () => {
    console.log(`UDP Server listening on port ${PORT}`);
});

server.bind(PORT);
