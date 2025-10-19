import axios from 'axios';
import WebSocket from 'ws';

import { connectedUsers, lobbyMeta, lobbies, userLobby } from './state';
import { ConnectedUser, MessageContext, SignalMessage } from './types';
import {
    broadcastKillPeer,
    broadcastLobbyCounts,
    broadcastUserList,
    broadcastUserMessage,
    cancelLobbyTimeout,
    disconnectUserFromUsers,
    ensureLobby,
    removeUserFromAllLobbies,
    syncUserToLobby,
} from './services/lobby';
import { DEFAULT_LOBBY_ID } from './config';
import { handleEstimatePing, populateGeoForUser } from './services/ping';

const serverInfo = require('../../keys/server');

function sanitizeUsers() {
    return [...connectedUsers.values()].map(({ ws, ...user }) => user);
}

export async function handleMessage(ctx: MessageContext, message: SignalMessage) {
    switch (message.type) {
        case 'join':
            await handleJoin(ctx, message.user, message.lobbyId);
            break;
        case 'updateSocketState':
            await handleUpdateSocketState(ctx, message.data);
            break;
        case 'createLobby':
            await handleCreateLobby(ctx, message);
            break;
        case 'changeLobby':
            await handleChangeLobby(ctx, message);
            break;
        case 'userDisconnect':
            broadcastKillPeer(message.userUID ?? ctx.ws.uid, ctx.wss);
            break;
        case 'sendMessage':
            await handleSendMessage(message.sender, message.message);
            break;
        case 'matchEnd':
            disconnectUserFromUsers(message.userUID, ctx.wss);
            break;
        case 'webrtc-ping-offer':
        case 'webrtc-ping-answer':
        case 'webrtc-ping-decline':
        case 'webrtc-ping-candidate':
            forwardWebRtc(message);
            break;
        case 'estimate-ping-users':
            await handleEstimatePing(ctx, message.data);
            break;
        default:
            ctx.logger.warn('Unhandled message type', message);
    }
}

async function handleJoin(ctx: MessageContext, user: ConnectedUser['ws'] extends never ? never : any, preferredLobbyId?: string) {
    ctx.ws.uid = user.uid;
    ctx.ws.isAlive = true;

    const now = Date.now();
    const existing = connectedUsers.get(user.uid);
    const connectedUser: ConnectedUser = {
        ...existing,
        ...user,
        ws: ctx.ws,
        joinedAt: existing?.joinedAt ?? now,
        lastHeartbeat: now,
    };

    connectedUsers.set(user.uid, connectedUser);

    const lobbyId = preferredLobbyId ?? user.lobbyId ?? DEFAULT_LOBBY_ID;
    ensureLobby(lobbyId);
    syncUserToLobby(user.uid, lobbyId);
    broadcastUserList(lobbyId);
    broadcastLobbyCounts(ctx.wss);

    ctx.ws.send(
        JSON.stringify({
            type: 'connected-users',
            users: sanitizeUsers(),
        })
    );

    void populateGeoForUser(ctx, connectedUser);
}

async function handleUpdateSocketState(
    ctx: MessageContext,
    data: Extract<SignalMessage, { type: 'updateSocketState' }>['data']
) {
    const userToUpdate = connectedUsers.get(data.uid);
    if (!userToUpdate) {
        ctx.logger.warn(`No user found for UID ${data.uid}`);
        return;
    }

    let updatedUserProps: Record<string, unknown>;

    if (data.stateToUpdate.key === 'winStreak') {
        const currentStreak = userToUpdate.winStreak || 0;
        updatedUserProps = {
            winStreak: data.stateToUpdate.value === 1 ? currentStreak + 1 : 0,
        };
    } else {
        updatedUserProps = {
            [data.stateToUpdate.key]: data.stateToUpdate.value,
        };
    }

    const updatedUser: ConnectedUser = {
        ...userToUpdate,
        ...updatedUserProps,
        ws: userToUpdate.ws,
    };

    connectedUsers.set(data.uid, updatedUser);
    syncUserToLobby(data.uid, data.lobbyId);
    broadcastUserList(data.lobbyId);

    try {
        await axios.post(
            `http://${serverInfo.COTURN_IP}:${serverInfo.API_PORT}/update-user-data-socket`,
            {
                userData: updatedUserProps,
                uid: data.uid,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${serverInfo.SERVER_SECRET}`,
                },
            }
        );
    } catch (err) {
        ctx.logger.error('Failed to update user from socket server:', err);
    }
}

async function handleCreateLobby(
    ctx: MessageContext,
    message: Extract<SignalMessage, { type: 'createLobby' }>
) {
    const { lobbyId, pass, user, isPrivate } = message;

    if (lobbies.has(lobbyId)) {
        ctx.ws.send(JSON.stringify({ type: 'error', message: 'Lobby already exists' }));
        return;
    }

    removeUserFromAllLobbies(user.uid, ctx.wss);
    cancelLobbyTimeout(lobbyId);

    const lobby = ensureLobby(lobbyId);
    const connectedUser = connectedUsers.get(user.uid) ?? {
        ...user,
        ws: ctx.ws,
        joinedAt: Date.now(),
        lastHeartbeat: Date.now(),
    };

    connectedUsers.set(user.uid, { ...connectedUser, ws: ctx.ws });
    lobby.set(user.uid, { ...connectedUser, ws: ctx.ws });
    lobbyMeta.set(lobbyId, { pass, isPrivate, ownerUid: user.uid });
    userLobby.set(user.uid, lobbyId);

    broadcastUserList(lobbyId);
    ctx.ws.send(JSON.stringify({ type: 'lobby-joined', lobbyId }));
    broadcastLobbyCounts(ctx.wss);
}

async function handleChangeLobby(
    ctx: MessageContext,
    message: Extract<SignalMessage, { type: 'changeLobby' }>
) {
    const { newLobbyId, pass, user } = message;
    if (!user) return;

    const meta = lobbyMeta.get(newLobbyId);
    if (meta && meta.pass !== pass) {
        ctx.ws.send(JSON.stringify({ type: 'error', message: 'Invalid password for lobby' }));
        return;
    }

    removeUserFromAllLobbies(user.uid, ctx.wss);
    cancelLobbyTimeout(newLobbyId);

    const lobby = ensureLobby(newLobbyId);
    const connectedUser = connectedUsers.get(user.uid);
    if (connectedUser) {
        lobby.set(user.uid, { ...connectedUser });
    } else {
        lobby.set(user.uid, {
            ...user,
            ws: ctx.ws,
            joinedAt: Date.now(),
            lastHeartbeat: Date.now(),
        } as ConnectedUser);
    }

    userLobby.set(user.uid, newLobbyId);

    broadcastUserList(newLobbyId);
    broadcastLobbyCounts(ctx.wss);
}

async function handleSendMessage(sender: any, message: string) {
    const connectedSender = connectedUsers.get(sender.uid);
    if (!connectedSender?.lobbyId) return;

    broadcastUserMessage(connectedSender.lobbyId, message, connectedSender);
}

function forwardWebRtc(message: Extract<
    SignalMessage,
    {
        type:
        | 'webrtc-ping-offer'
        | 'webrtc-ping-answer'
        | 'webrtc-ping-decline'
        | 'webrtc-ping-candidate';
    }
>) {
    if (message.to === message.from) return;

    const targetUser = connectedUsers.get(message.to);
    if (!targetUser) return;

    if (targetUser.ws.readyState !== WebSocket.OPEN) return;

    targetUser.ws.send(JSON.stringify(message));
}
