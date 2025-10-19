import http from 'http';
import axios from 'axios';
import { WebSocketServer } from 'ws';

import {
    HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_TERMINATE_AFTER_MS,
    SIGNAL_PORT,
} from './config';
import { handleMessage } from './message-handler';
import { connectedUsers, userLobby } from './state';
import { AugmentedWebSocket, MessageContext, SignalMessage } from './types';
import { removeUserFromAllLobbies, broadcastLobbyCounts } from './services/lobby';

const serverInfo = require('../../keys/server');

const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
        const augmented = ws as AugmentedWebSocket;
        augmented.isAlive = true;

        wss.emit('connection', augmented, req);
    });
});

wss.on('connection', (ws, req) => {
    const augmented = ws as AugmentedWebSocket;
    augmented.isAlive = true;

    const ctx: MessageContext = {
        ws: augmented,
        req,
        wss,
        logger: console,
    };

    ws.on('pong', () => {
        augmented.isAlive = true;
        if (augmented.uid) {
            const entry = connectedUsers.get(augmented.uid);
            if (entry) {
                entry.lastHeartbeat = Date.now();
                connectedUsers.set(augmented.uid, entry);
            }
        }
    });

    ws.on('message', async (raw) => {
        let payload: SignalMessage;

        try {
            payload = JSON.parse(raw.toString());
        } catch (error) {
            console.error('Invalid payload received', error);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON payload' }));
            return;
        }

        try {
            await handleMessage(ctx, payload);
        } catch (error) {
            console.error('Failed to handle message', error);
            ws.send(JSON.stringify({ type: 'error', message: 'Internal server error' }));
        }
    });

    ws.on('close', () => {
        if (!augmented.uid) return;

        const stored = connectedUsers.get(augmented.uid);
        connectedUsers.delete(augmented.uid);
        userLobby.delete(augmented.uid);

        removeUserFromAllLobbies(augmented.uid, wss);
        broadcastLobbyCounts(wss);

        if (stored?.email) {
            axios
                .post(
                    `http://${serverInfo.COTURN_IP}:${serverInfo.API_PORT}/log-out-internal`,
                    {
                        idToken: stored.uid,
                        userEmail: stored.email,
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                        },
                    }
                )
                .then(() => {
                    console.log('User logout request completed.');
                })
                .catch((error) => {
                    console.error('Error logging out user:', error.message);
                });
        }
    });
});

const heartbeatTicker = setInterval(() => {
    const now = Date.now();

    wss.clients.forEach((client) => {
        const ws = client as AugmentedWebSocket;

        if (!ws.isAlive) {
            ws.terminate();
            return;
        }

        ws.isAlive = false;
        ws.ping();

        if (ws.uid) {
            const entry = connectedUsers.get(ws.uid);
            if (entry && now - entry.lastHeartbeat > HEARTBEAT_TERMINATE_AFTER_MS) {
                console.warn(`Terminating stale connection ${ws.uid}`);
                ws.terminate();
            }
        }
    });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => {
    clearInterval(heartbeatTicker);
});

server.listen(SIGNAL_PORT, () => {
    console.log(`vNew websocket server listening on port ${SIGNAL_PORT}`);
});

export default wss;
