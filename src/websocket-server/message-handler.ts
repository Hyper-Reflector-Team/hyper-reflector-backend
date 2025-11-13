import axios from 'axios';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';

import { connectedUsers, lobbyMeta, lobbies, userLobby } from './state';
import { ConnectedUser, MessageContext, SignalMessage, SocketUser } from './types';
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
type MiniGameChoice = 'rock' | 'paper' | 'scissors';

type MiniGameSession = {
    id: string;
    challengerId: string;
    opponentId: string;
    createdAt: number;
    expiresAt: number;
    gameType: 'rps';
    choices: Record<string, MiniGameChoice>;
    timeout?: NodeJS.Timeout;
};

const miniGameSessions = new Map<string, MiniGameSession>();

function sanitizeUsers() {
    return [...connectedUsers.values()].map(({ ws, ...user }) => user);
}

function sendToUser(uid: string, payload: unknown) {
    const target = connectedUsers.get(uid);
    if (!target?.ws || target.ws.readyState !== WebSocket.OPEN) return;
    target.ws.send(JSON.stringify(payload));
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
        case 'request-match':
            await handleRequestMatch(ctx, message);
            break;
        case 'userDisconnect':
            broadcastKillPeer(message.userUID ?? ctx.ws.uid, ctx.wss);
            break;
        case 'sendMessage':
            await handleSendMessage(message.sender, message.message, message.messageId);
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
        case 'peer-latency-offer':
        case 'peer-latency-answer':
        case 'peer-latency-decline':
        case 'peer-latency-candidate':
            forwardWebRtc(message);
            break;
        case 'estimate-ping-users':
            await handleEstimatePing(ctx, message.data);
            break;
        case 'mini-game-challenge':
            await handleMiniGameChallenge(message);
            break;
        case 'mini-game-choice':
            await handleMiniGameChoice(message);
            break;
        case 'mini-game-decline':
            await handleMiniGameDecline(message);
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
        const rawValue = data.stateToUpdate.value as number | string | undefined;
        const nextValue =
            typeof rawValue === 'number'
                ? rawValue
                : typeof rawValue === 'string'
                    ? Number(rawValue)
                    : 0;
        const safeValue = Number.isFinite(nextValue) ? Math.max(0, nextValue) : 0;
        updatedUserProps = {
            winStreak: safeValue,
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
        const updatedUser: ConnectedUser = {
            ...connectedUser,
            lobbyId: newLobbyId,
        };

        connectedUsers.set(user.uid, updatedUser);
        lobby.set(user.uid, { ...updatedUser });
    } else {
        const hydratedUser: ConnectedUser = {
            ...user,
            ws: ctx.ws,
            joinedAt: Date.now(),
            lastHeartbeat: Date.now(),
            lobbyId: newLobbyId,
        } as ConnectedUser;

        connectedUsers.set(user.uid, hydratedUser);
        lobby.set(user.uid, { ...hydratedUser });
    }

    userLobby.set(user.uid, newLobbyId);

    broadcastUserList(newLobbyId);
    broadcastLobbyCounts(ctx.wss);
}

async function handleRequestMatch(
    ctx: MessageContext,
    message: Extract<SignalMessage, { type: 'request-match' }>
) {
    const { challengerId, opponentId, requestedBy, lobbyId, gameName, preferredSlot } = message;

    if (!challengerId || !opponentId) {
        return;
    }

    const challenger = connectedUsers.get(challengerId);
    const opponent = connectedUsers.get(opponentId);

        if (!challenger || !opponent) {
            if (ctx.ws.readyState === WebSocket.OPEN) {
                ctx.ws.send(
                    JSON.stringify({
                        type: 'match-start-error',
                        challengerId,
                        opponentId,
                        reason: 'Opponent is no longer online.',
                    })
                );
            }
            return;
        }

    const matchId = randomUUID();
    const resolvedLobbyId =
        lobbyId ??
        userLobby.get(challengerId) ??
        userLobby.get(opponentId) ??
        DEFAULT_LOBBY_ID;
    const serverPort = Number(serverInfo.PUNCH_PORT ?? 0) || 33334;
    const basePayload = {
        type: 'match-start',
        matchId,
        lobbyId: resolvedLobbyId,
        gameName: gameName ?? null,
        serverHost: serverInfo.COTURN_IP,
        serverPort,
        requestedBy,
    };

    const sendMatchStart = (recipient: ConnectedUser, playerSlot: 0 | 1, opponentUid: string) => {
        if (!recipient.ws || recipient.ws.readyState !== WebSocket.OPEN) {
            return;
        }

        recipient.ws.send(
            JSON.stringify({
                ...basePayload,
                playerSlot,
                opponentUid,
            })
        );
    };

    const challengerSlot = preferredSlot === 1 ? 1 : 0;
    const opponentSlot = challengerSlot === 0 ? 1 : 0;

    sendMatchStart(challenger, challengerSlot, opponentId);
    sendMatchStart(opponent, opponentSlot, challengerId);
}

async function handleSendMessage(sender: SocketUser | undefined, message: string, messageId?: string) {
    if (!sender?.uid || typeof message !== 'string') {
        return;
    }

    const connectedSender = connectedUsers.get(sender.uid);
    if (!connectedSender) return;

    const lobbyId =
        userLobby.get(connectedSender.uid) ??
        connectedSender.lobbyId ??
        DEFAULT_LOBBY_ID;
    const trimmedMessage = message.trim();
    if (!trimmedMessage.length) return;

    broadcastUserMessage(lobbyId, trimmedMessage, connectedSender, messageId);
}

function forwardWebRtc(message: Extract<
    SignalMessage,
    {
        type:
            | 'webrtc-ping-offer'
            | 'webrtc-ping-answer'
            | 'webrtc-ping-decline'
            | 'webrtc-ping-candidate'
            | 'peer-latency-offer'
            | 'peer-latency-answer'
            | 'peer-latency-decline'
            | 'peer-latency-candidate';
    }
>) {
    if (message.to === message.from) return;

    const targetUser = connectedUsers.get(message.to);
    if (!targetUser) return;

    if (targetUser.ws.readyState !== WebSocket.OPEN) return;

    targetUser.ws.send(JSON.stringify(message));
}

const RPS_RULES: Record<MiniGameChoice, MiniGameChoice> = {
    rock: 'scissors',
    paper: 'rock',
    scissors: 'paper',
};

async function handleMiniGameChallenge(message: Extract<SignalMessage, { type: 'mini-game-challenge' }>) {
    const { challengerId, opponentId, gameType } = message;
    if (gameType !== 'rps') return;
    if (!challengerId || !opponentId || challengerId === opponentId) return;
    const challenger = connectedUsers.get(challengerId);
    const opponent = connectedUsers.get(opponentId);
    if (!challenger || !opponent) return;

    const id = message.sessionId || randomUUID();
    const now = Date.now();
    const expiresAt = now + 10_000;
    const session: MiniGameSession = {
        id,
        challengerId,
        opponentId,
        createdAt: now,
        expiresAt,
        gameType: 'rps',
        choices: {},
    };
    session.timeout = setTimeout(() => {
        finalizeMiniGameSession(id, 'timeout');
    }, expiresAt - now + 100);
    miniGameSessions.set(id, session);
    const payload = {
        type: 'mini-game-challenge',
        sessionId: id,
        challengerId,
        opponentId,
        gameType: 'rps',
        expiresAt,
    };
    sendToUser(challengerId, payload);
    sendToUser(opponentId, payload);
}

async function handleMiniGameChoice(message: Extract<SignalMessage, { type: 'mini-game-choice' }>) {
    const session = miniGameSessions.get(message.sessionId);
    if (!session) return;
    if (![session.challengerId, session.opponentId].includes(message.playerId)) return;
    if (Date.now() > session.expiresAt) {
        finalizeMiniGameSession(session.id, 'timeout');
        return;
    }
    session.choices[message.playerId] = message.choice;
    if (session.choices[session.challengerId] && session.choices[session.opponentId]) {
        finalizeMiniGameSession(session.id, 'complete');
    }
}

async function handleMiniGameDecline(message: Extract<SignalMessage, { type: 'mini-game-decline' }>) {
    const session = miniGameSessions.get(message.sessionId);
    if (!session) return;
    finalizeMiniGameSession(session.id, 'declined', message.playerId);
}

function evaluateRpsChoices(
    challengerChoice?: MiniGameChoice,
    opponentChoice?: MiniGameChoice
): { winnerUid?: string; loserUid?: string; outcome: 'win' | 'draw' | 'forfeit' } {
    if (!challengerChoice && !opponentChoice) {
        return { outcome: 'draw' };
    }
    if (challengerChoice && !opponentChoice) {
        return { winnerUid: 'challenger', loserUid: 'opponent', outcome: 'forfeit' };
    }
    if (!challengerChoice && opponentChoice) {
        return { winnerUid: 'opponent', loserUid: 'challenger', outcome: 'forfeit' };
    }
    if (!challengerChoice || !opponentChoice) {
        return { outcome: 'draw' };
    }
    if (challengerChoice === opponentChoice) {
        return { outcome: 'draw' };
    }
    const challengerWins = RPS_RULES[challengerChoice] === opponentChoice;
    return challengerWins
        ? { winnerUid: 'challenger', loserUid: 'opponent', outcome: 'win' }
        : { winnerUid: 'opponent', loserUid: 'challenger', outcome: 'win' };
}

async function finalizeMiniGameSession(
    sessionId: string,
    reason: 'complete' | 'timeout' | 'declined',
    actorId?: string
) {
    const session = miniGameSessions.get(sessionId);
    if (!session) return;
    if (session.timeout) {
        clearTimeout(session.timeout);
    }
    miniGameSessions.delete(sessionId);

    const challengerChoice = session.choices[session.challengerId];
    const opponentChoice = session.choices[session.opponentId];
    let winnerUid: string | undefined;
    let loserUid: string | undefined;
    let outcome: 'win' | 'draw' | 'forfeit' | 'declined' = 'draw';

    if (reason === 'declined') {
        outcome = 'declined';
    } else {
        const evaluation = evaluateRpsChoices(challengerChoice, opponentChoice);
        outcome = evaluation.outcome;
        if (evaluation.winnerUid === 'challenger') {
            winnerUid = session.challengerId;
            loserUid = session.opponentId;
        } else if (evaluation.winnerUid === 'opponent') {
            winnerUid = session.opponentId;
            loserUid = session.challengerId;
        }
    }

    const basePayload: any = {
        type: 'mini-game-result',
        sessionId: session.id,
        challengerId: session.challengerId,
        opponentId: session.opponentId,
        gameType: session.gameType,
        choices: {
            [session.challengerId]: challengerChoice || null,
            [session.opponentId]: opponentChoice || null,
        },
        winnerUid: reason === 'declined' ? undefined : winnerUid,
        loserUid: reason === 'declined' ? undefined : loserUid,
        outcome,
        actorId,
    };

    if (winnerUid && loserUid && outcome !== 'draw') {
        try {
            const result = await axios.post(
                `http://${serverInfo.COTURN_IP}:${serverInfo.API_PORT}/mini-game/rps-result`,
                {
                    challengerUid: session.challengerId,
                    opponentUid: session.opponentId,
                    winnerUid,
                },
                {
                    headers: {
                        Authorization: `Bearer ${serverInfo.SERVER_SECRET}`,
                    },
                }
            );
            if (result?.data?.ratings) {
                basePayload.ratings = result.data.ratings;
            }
        } catch (error) {
            console.error('Failed to sync RPS elo', error);
        }
    }

    sendToUser(session.challengerId, basePayload);
    sendToUser(session.opponentId, basePayload);
}
