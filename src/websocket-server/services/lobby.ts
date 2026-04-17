import WebSocket, { WebSocketServer } from 'ws';
import { connectedUsers, lobbies, lobbyMeta, lobbyTimeouts, userLobby, userSubscriptions } from '../state';
import { ConnectedUser } from '../types';
import { DEFAULT_LOBBY_ID, LOBBY_IDLE_TIMEOUT_MS } from '../config';

export function ensureLobby(lobbyId: string): Map<string, ConnectedUser> {
    if (!lobbies.has(lobbyId)) {
        lobbies.set(lobbyId, new Map());
    }
    return lobbies.get(lobbyId)!;
}

function toPublicUser(user: ConnectedUser) {
    const { ws: _ws, ...rest } = user;
    return rest;
}

export function syncUserToLobby(uid: string, lobbyId: string) {
    if (!uid || !lobbyId) return;

    const user = connectedUsers.get(uid);
    if (!user) return;

    const lobby = ensureLobby(lobbyId);
    lobby.set(uid, { ...user });
    userLobby.set(uid, lobbyId);
}

export function broadcastUserList(lobbyId: string) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    const users = [...lobby.keys()]
        .map((uid) => {
            const entry = connectedUsers.get(uid);
            if (!entry) return null;
            const publicUser = toPublicUser(entry);
            return publicUser.uid ? publicUser : null;
        })
        .filter(Boolean);

    // Send to every user subscribed to this lobby (not just members present)
    const subscribers = new Set<string>();
    for (const [uid, subs] of userSubscriptions.entries()) {
        if (subs.has(lobbyId)) subscribers.add(uid);
    }
    // Also send to lobby members directly (covers users not yet in userSubscriptions)
    for (const uid of lobby.keys()) subscribers.add(uid);

    for (const uid of subscribers) {
        const member = connectedUsers.get(uid);
        if (!member?.ws || member.ws.readyState !== WebSocket.OPEN) continue;

        member.ws.send(
            JSON.stringify({
                type: 'connected-users',
                lobbyId,
                users,
                count: users.length,
            })
        );
    }
}

/** Add a user to a lobby without removing them from any other lobby. */
export function subscribeUserToLobby(uid: string, lobbyId: string) {
    const user = connectedUsers.get(uid);
    if (!user) return;

    const lobby = ensureLobby(lobbyId);
    lobby.set(uid, { ...user });

    let subs = userSubscriptions.get(uid);
    if (!subs) {
        subs = new Set();
        userSubscriptions.set(uid, subs);
    }
    subs.add(lobbyId);
    userLobby.set(uid, lobbyId);
}

/** Remove a user from one specific lobby only. */
export function removeUserFromLobby(uid: string, lobbyId: string, wss?: WebSocketServer) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby || !lobby.has(uid)) return;

    lobby.delete(uid);

    const subs = userSubscriptions.get(uid);
    if (subs) subs.delete(lobbyId);

    // If this was their primary lobby, update primary to another subscription
    if (userLobby.get(uid) === lobbyId) {
        const remaining = subs ? [...subs] : [];
        if (remaining.length > 0) {
            userLobby.set(uid, remaining[0]);
        } else {
            userLobby.delete(uid);
        }
    }

    if (lobby.size === 0 && lobbyId !== DEFAULT_LOBBY_ID && wss) {
        if (!lobbyTimeouts.has(lobbyId)) {
            const timeout = setTimeout(() => {
                lobbies.delete(lobbyId);
                lobbyTimeouts.delete(lobbyId);
                lobbyMeta.delete(lobbyId);
                broadcastLobbyRemoved(lobbyId, wss);
                broadcastLobbyCounts(wss);
            }, LOBBY_IDLE_TIMEOUT_MS);
            lobbyTimeouts.set(lobbyId, timeout);
        }
    } else {
        broadcastUserList(lobbyId);
    }
}

export function broadcastLobbyCounts(wss: WebSocketServer) {
    const updates = [...lobbies.entries()].map(([lobbyId, members]) => {
        const meta = lobbyMeta.get(lobbyId);
        return {
            name: lobbyId,
            users: members.size,
            pass: meta?.pass ?? '',
            isPrivate: meta?.isPrivate ?? false,
            gameName: meta?.gameName ?? '',
            ownerUid: meta?.ownerUid ?? '',
        };
    });

    const payload = JSON.stringify({
        type: 'lobby-user-counts',
        updates,
    });

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

export function broadcastLobbyRemoved(lobbyId: string, wss: WebSocketServer) {
    const payload = JSON.stringify({
        type: 'lobby-closed',
        lobbyId,
    });

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

export function removeUserFromAllLobbies(uid: string, wss: WebSocketServer) {
    if (!uid) return;

    userSubscriptions.delete(uid);

    for (const [lobbyId, members] of lobbies.entries()) {
        if (!members.has(uid)) continue;

        members.delete(uid);
        userLobby.delete(uid);

        if (members.size === 0 && lobbyId !== DEFAULT_LOBBY_ID) {
            if (!lobbyTimeouts.has(lobbyId)) {
                const timeout = setTimeout(() => {
                    lobbies.delete(lobbyId);
                    lobbyTimeouts.delete(lobbyId);
                    lobbyMeta.delete(lobbyId);

                    broadcastLobbyRemoved(lobbyId, wss);
                    broadcastLobbyCounts(wss);
                }, LOBBY_IDLE_TIMEOUT_MS);

                lobbyTimeouts.set(lobbyId, timeout);
            }
        } else {
            broadcastUserList(lobbyId);
        }
    }
}

export function cancelLobbyTimeout(lobbyId: string) {
    const timeout = lobbyTimeouts.get(lobbyId);
    if (timeout) {
        clearTimeout(timeout);
        lobbyTimeouts.delete(lobbyId);
    }
}

export function broadcastUserMessage(
    lobbyId: string,
    message: string,
    sender: ConnectedUser,
    messageId?: string
) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    const now = Date.now();
    const publicSender = toPublicUser(sender);

    const payload = JSON.stringify({
        type: 'getRoomMessage',
        id: messageId ?? `${publicSender.uid ?? 'message'}-${now}`,
        timeStamp: now,
        message,
        sender: publicSender,
    });

    for (const user of lobby.values()) {
        if (user.ws.readyState === WebSocket.OPEN) {
            user.ws.send(payload);
        }
    }
}

export function broadcastKillPeer(userUID: string | undefined, wss: WebSocketServer) {
    if (!userUID) return;

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(
                JSON.stringify({
                    type: 'userDisconnect',
                    userUID,
                })
            );
        }
    });
}

export function disconnectUserFromUsers(userUID: string, wss: WebSocketServer) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(
                JSON.stringify({
                    type: 'matchEndedClose',
                    userUID,
                })
            );
        }
    });
}
