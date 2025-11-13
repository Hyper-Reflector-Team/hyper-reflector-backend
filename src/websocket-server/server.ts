import http from 'http';
import axios from 'axios';
import { WebSocketServer } from 'ws';
import {
    HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_TERMINATE_AFTER_MS,
    SIGNAL_PORT,
    DEFAULT_LOBBY_ID,
} from './config';
import { handleMessage } from './message-handler';
import { connectedUsers, userLobby } from './state';
import { AugmentedWebSocket, MessageContext, SignalMessage } from './types';
import {
    removeUserFromAllLobbies,
    broadcastLobbyCounts,
    broadcastUserList,
    syncUserToLobby,
} from './services/lobby';

const serverInfo = require('../../keys/server');

const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });

function readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

async function handleInternalWinStreakUpdate(req: http.IncomingMessage, res: http.ServerResponse) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token !== serverInfo.SERVER_SECRET) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
    }

    try {
        const rawBody = await readRequestBody(req);
        const payload = rawBody ? JSON.parse(rawBody) : {};
        const { uid, winStreak } = payload as { uid?: string; winStreak?: number };
        if (!uid || typeof winStreak !== 'number') {
            res.statusCode = 400;
            res.end('Invalid payload');
            return;
        }

        const user = connectedUsers.get(uid);
        if (!user) {
            res.statusCode = 200;
            res.end(JSON.stringify({ updated: false }));
            return;
        }

        const updatedUser = {
            ...user,
            winStreak,
        };
        connectedUsers.set(uid, updatedUser);

        const lobbyId = userLobby.get(uid) ?? user.lobbyId ?? DEFAULT_LOBBY_ID;
        syncUserToLobby(uid, lobbyId);
        broadcastUserList(lobbyId);

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ updated: true }));
    } catch (error) {
        console.error('Failed to process internal win streak update', error);
        res.statusCode = 500;
        res.end('Internal error');
    }
}

server.on('request', (req, res) => {
    if (req.method === 'POST' && req.url === '/internal/win-streak') {
        void handleInternalWinStreakUpdate(req, res);
        return;
    }

    res.statusCode = 404;
    res.end('Not found');
});

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

        if (ws.readyState !== ws.OPEN) {
            return;
        }

        if (!ws.isAlive) {
            ws.terminate();
            return;
        }

        ws.isAlive = false;

        try {
            ws.ping();
        } catch (err) {
            console.warn('Failed to send ping; terminating socket', err);
            ws.terminate();
            return;
        }

        if (!ws.uid) return;

        const entry = connectedUsers.get(ws.uid);
        if (!entry) return;

        const elapsed = now - entry.lastHeartbeat;
        const gracePeriodMs = HEARTBEAT_INTERVAL_MS * 2;
        const terminateThreshold = Math.max(HEARTBEAT_TERMINATE_AFTER_MS, HEARTBEAT_INTERVAL_MS + gracePeriodMs);

        if (elapsed > terminateThreshold) {
            console.warn(
                `Terminating stale connection ${ws.uid}; idle for ${elapsed}ms (threshold ${terminateThreshold}ms)`
            );
            ws.terminate();
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
