import axios from 'axios';
import dgram from 'dgram';
import { randomUUID } from 'crypto';
import WebSocket, { WebSocketServer } from 'ws';

import { connectedUsers, lobbyMeta, lobbies, userLobby, activeMatches } from './state';
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
const HOLEPUNCH_PORT = Number(serverInfo.PUNCH_PORT ?? 33334);
const HOLEPUNCH_HOST = serverInfo.COTURN_IP ?? '127.0.0.1';
const holePunchSocket = dgram.createSocket('udp4');
holePunchSocket.unref();
const DEFAULT_RPS_ELO = 1200;
const RPS_INVITE_WINDOW_MS = 30_000;
const RPS_CHOICE_WINDOW_MS = 10_000;
const RPS_COOLDOWN_MS = 60_000;
type MiniGameChoice = 'rock' | 'paper' | 'scissors';

type MiniGameSession = {
    id: string;
    challengerId: string;
    opponentId: string;
    createdAt: number;
    expiresAt: number;
    gameType: 'rps';
    phase: 'invite' | 'active';
    choices: Record<string, MiniGameChoice>;
    timeout?: NodeJS.Timeout;
};

const miniGameSessions = new Map<string, MiniGameSession>();
const miniGamePairIndex = new Map<string, string>();
const rpsChallengeCooldowns = new Map<string, number>();

const getPairKey = (a: string, b: string) => [a, b].sort().join('::');
const getDirectionalKey = (challengerId: string, opponentId: string) => `${challengerId}->${opponentId}`;

function getUserRpsElo(uid: string) {
    const entry = connectedUsers.get(uid);
    return typeof entry?.rpsElo === 'number' ? entry.rpsElo : DEFAULT_RPS_ELO;
}

function sanitizeUsers() {
    return [...connectedUsers.values()].map(({ ws, ...user }) => user);
}

function sendToUser(uid: string, payload: unknown) {
    const target = connectedUsers.get(uid);
    if (!target?.ws || target.ws.readyState !== WebSocket.OPEN) return;
    target.ws.send(JSON.stringify(payload));
}

type SerializedMatch = {
    id: string;
    lobbyId: string;
    startedAt: number;
    gameName?: string | null;
    players: Array<{
        uid: string;
        userName?: string;
        userProfilePic?: string;
        countryCode?: string;
        userTitle?: ConnectedUser['userTitle'];
        accountElo?: number;
        playerSlot: 0 | 1;
    }>;
};

function buildMatchListPayload(): { type: 'match-list'; matches: SerializedMatch[] } {
    const matches = [...activeMatches.values()].map((match) => ({
        ...match,
        players: match.players.map((player) => {
            const source = connectedUsers.get(player.uid);
            return {
                uid: player.uid,
                playerSlot: player.playerSlot,
                userName: source?.userName ?? player.userName,
                userProfilePic: source?.userProfilePic ?? player.userProfilePic,
                countryCode: source?.countryCode ?? player.countryCode,
                userTitle: source?.userTitle ?? player.userTitle,
                accountElo:
                    typeof source?.accountElo === 'number' ? source.accountElo : player.accountElo,
            };
        }),
    }));

    return {
        type: 'match-list',
        matches,
    };
}

function sendMatchListSnapshot(ws: WebSocket | undefined) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(buildMatchListPayload()));
}

function broadcastMatchListSnapshot(wss: WebSocketServer) {
    const payload = JSON.stringify(buildMatchListPayload());
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

function buildMatchPlayerEntry(user: ConnectedUser, playerSlot: 0 | 1) {
    return {
        uid: user.uid,
        playerSlot,
        userName: user.userName,
        userProfilePic: user.userProfilePic,
        countryCode: user.countryCode,
        userTitle: user.userTitle,
        accountElo: typeof user.accountElo === 'number' ? user.accountElo : undefined,
    };
}

function notifyHolePunchKill(uid: string, peerUid?: string, matchId?: string) {
    if (!uid || !peerUid) return;
    const payload = Buffer.from(
        JSON.stringify({
            uid,
            peerUid,
            kill: true,
            matchId,
        })
    );

    holePunchSocket.send(payload, HOLEPUNCH_PORT, HOLEPUNCH_HOST, (err) => {
        if (err) {
            console.error('Failed to notify hole punching server about match close', err);
        }
    });
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
            forceCloseMatchForUser(message.userUID ?? ctx.ws.uid, ctx.wss, 'user-disconnected');
            break;
        case 'sendMessage':
            await handleSendMessage(message.sender, message.message, message.messageId);
            break;
        case 'matchEnd':
            disconnectUserFromUsers(message.userUID, ctx.wss);
            forceCloseMatchForUser(message.userUID ?? ctx.ws.uid, ctx.wss, 'match-end-event');
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
        case 'mini-game-accept':
            await handleMiniGameAccept(ctx, message);
            break;
        case 'mini-game-side-lock':
            await handleMiniGameSideLock(ctx, message);
            break;
        case 'match-status':
            await handleMatchStatus(ctx, message);
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

    sendMatchListSnapshot(ctx.ws);
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

    if (challenger?.currentMatchId) {
        ctx.logger.warn(
            `Challenger ${challengerId} still had active match ${challenger.currentMatchId}; forcing cleanup`
        );
        forceCloseMatchForUser(challengerId, ctx.wss, 'stale-current-match');
    }
    if (opponent?.currentMatchId) {
        ctx.logger.warn(
            `Opponent ${opponentId} still had active match ${opponent.currentMatchId}; forcing cleanup`
        );
        forceCloseMatchForUser(opponentId, ctx.wss, 'stale-current-match');
    }

    const resolvedChallenger = connectedUsers.get(challengerId);
    const resolvedOpponent = connectedUsers.get(opponentId);

    if (!resolvedChallenger || !resolvedOpponent) {
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

    sendMatchStart(resolvedChallenger, challengerSlot, opponentId);
    sendMatchStart(resolvedOpponent, opponentSlot, challengerId);

    const now = Date.now();
    activeMatches.set(matchId, {
        id: matchId,
        lobbyId: resolvedLobbyId,
        startedAt: now,
        gameName: gameName ?? null,
        players: [
            buildMatchPlayerEntry(resolvedChallenger, challengerSlot),
            buildMatchPlayerEntry(resolvedOpponent, opponentSlot),
        ],
    });

    connectedUsers.set(challengerId, { ...resolvedChallenger, currentMatchId: matchId });
    connectedUsers.set(opponentId, { ...resolvedOpponent, currentMatchId: matchId });

    broadcastUserList(resolvedLobbyId);
    broadcastMatchListSnapshot(ctx.wss);
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

    const now = Date.now();
    if (Array.isArray(opponent.mutedUsers) && opponent.mutedUsers.includes(challengerId)) {
        sendToUser(challengerId, {
            type: 'mini-game-challenge-denied',
            reason: 'muted',
            opponentId,
            challengerId,
        });
        return;
    }

    const pairKey = getPairKey(challengerId, opponentId);
    const activeSessionId = miniGamePairIndex.get(pairKey);
    if (activeSessionId && miniGameSessions.has(activeSessionId)) {
        sendToUser(challengerId, {
            type: 'mini-game-challenge-denied',
            reason: 'pending',
            opponentId,
            challengerId,
        });
        return;
    }

    const cooldownKey = getDirectionalKey(challengerId, opponentId);
    const lastChallengeAt = rpsChallengeCooldowns.get(cooldownKey);
    if (lastChallengeAt) {
        const elapsed = now - lastChallengeAt;
        if (elapsed < RPS_COOLDOWN_MS) {
            sendToUser(challengerId, {
                type: 'mini-game-challenge-denied',
                reason: 'cooldown',
                opponentId,
                retryInMs: RPS_COOLDOWN_MS - elapsed,
                challengerId,
            });
            return;
        }
    }

    const id = message.sessionId || randomUUID();
    const expiresAt = now + RPS_INVITE_WINDOW_MS;
    const session: MiniGameSession = {
        id,
        challengerId,
        opponentId,
        createdAt: now,
        expiresAt,
        gameType: 'rps',
        phase: 'invite',
        choices: {},
    };
    session.timeout = setTimeout(() => {
        finalizeMiniGameSession(id, 'timeout');
    }, expiresAt - now + 100);
    miniGameSessions.set(id, session);
    miniGamePairIndex.set(pairKey, id);
    const payload = {
        type: 'mini-game-challenge',
        sessionId: id,
        challengerId,
        opponentId,
        gameType: 'rps',
        expiresAt,
        phase: 'invite',
    };
    sendToUser(challengerId, payload);
    sendToUser(opponentId, payload);
}

async function handleMiniGameChoice(message: Extract<SignalMessage, { type: 'mini-game-choice' }>) {
    const session = miniGameSessions.get(message.sessionId);
    if (!session) return;
    if (![session.challengerId, session.opponentId].includes(message.playerId)) return;
    if (session.phase !== 'active') {
        return;
    }
    if (Date.now() > session.expiresAt) {
        finalizeMiniGameSession(session.id, 'timeout');
        return;
    }
    session.choices[message.playerId] = message.choice;
    if (session.choices[session.challengerId] && session.choices[session.opponentId]) {
        finalizeMiniGameSession(session.id, 'complete');
    }
}

async function handleMiniGameAccept(
    ctx: MessageContext,
    message: Extract<SignalMessage, { type: 'mini-game-accept' }>
) {
    const session = miniGameSessions.get(message.sessionId);
    if (!session) return;
    const requesterUid = ctx.ws.uid || message.playerId;
    if (!requesterUid || requesterUid !== session.opponentId) {
        return;
    }
    if (session.phase !== 'invite') {
        return;
    }
    if (Date.now() > session.expiresAt) {
        finalizeMiniGameSession(session.id, 'timeout');
        return;
    }
    session.phase = 'active';
    session.expiresAt = Date.now() + RPS_CHOICE_WINDOW_MS;
    if (session.timeout) {
        clearTimeout(session.timeout);
    }
    session.timeout = setTimeout(() => {
        finalizeMiniGameSession(session.id, 'timeout');
    }, RPS_CHOICE_WINDOW_MS + 100);
    const payload = {
        type: 'mini-game-challenge',
        sessionId: session.id,
        challengerId: session.challengerId,
        opponentId: session.opponentId,
        gameType: session.gameType,
        expiresAt: session.expiresAt,
        phase: session.phase,
    };
    sendToUser(session.challengerId, payload);
    sendToUser(session.opponentId, payload);
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
    miniGamePairIndex.delete(getPairKey(session.challengerId, session.opponentId));
    rpsChallengeCooldowns.set(getDirectionalKey(session.challengerId, session.opponentId), Date.now());

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
    if (reason === 'timeout' && session.phase === 'invite') {
        outcome = 'declined';
        actorId = actorId ?? session.opponentId;
    }

    const previousRatings: Record<string, number> = {
        [session.challengerId]: getUserRpsElo(session.challengerId),
        [session.opponentId]: getUserRpsElo(session.opponentId),
    };

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
            const nextRatings = result?.data?.ratings;
            if (nextRatings) {
                basePayload.ratings = nextRatings;
                const ratingChanges: Record<string, number> = {};
                Object.entries(nextRatings).forEach(([uid, rating]) => {
                    const numericRating = typeof rating === 'number' ? rating : DEFAULT_RPS_ELO;
                    const delta = numericRating - (previousRatings[uid] ?? DEFAULT_RPS_ELO);
                    ratingChanges[uid] = delta;
                    const connected = connectedUsers.get(uid);
                    if (connected) {
                        connectedUsers.set(uid, { ...connected, rpsElo: numericRating });
                    }
                });
                basePayload.ratingChanges = ratingChanges;
            }
        } catch (error) {
            console.error('Failed to sync RPS elo', error);
        }
    }

    sendToUser(session.challengerId, basePayload);
    sendToUser(session.opponentId, basePayload);
}

async function handleMiniGameSideLock(
    ctx: MessageContext,
    message: Extract<SignalMessage, { type: 'mini-game-side-lock' }>
) {
    const requesterUid = ctx.ws.uid;
    if (!requesterUid) return;
    const { ownerEntry, opponentEntry } = message;
    if (!ownerEntry) return;
    if (ownerEntry.ownerUid !== requesterUid) {
        return;
    }
    const payload = {
        type: 'mini-game-side-lock',
        ownerEntry,
        opponentEntry,
    };
    sendToUser(ownerEntry.ownerUid, payload);
    if (ownerEntry.opponentUid) {
        sendToUser(ownerEntry.opponentUid, payload);
    }
}

async function handleMatchStatus(
    ctx: MessageContext,
    message: Extract<SignalMessage, { type: 'match-status' }>
) {
    if (message.status !== 'end') {
        return;
    }
    const viewerId = ctx.ws.uid;
    if (!viewerId) {
        return;
    }
    forceCloseMatchForUser(viewerId, ctx.wss, 'match-complete');
}

export function forceCloseMatchForUser(
    uid: string | undefined,
    wss: WebSocketServer,
    reason?: string
) {
    if (!uid) return;
    const user = connectedUsers.get(uid);
    const matchId = user?.currentMatchId;
    if (!matchId) {
        return;
    }
    const match = activeMatches.get(matchId);
    activeMatches.delete(matchId);

    const lobbyId = match?.lobbyId ?? userLobby.get(uid) ?? DEFAULT_LOBBY_ID;
    const participants = match?.players ?? [{ uid, playerSlot: 0 as 0 | 1 }];

    participants.forEach((player) => {
        const entry = connectedUsers.get(player.uid);
        if (entry) {
            connectedUsers.set(player.uid, { ...entry, currentMatchId: undefined });
            if (player.uid !== uid && entry.ws?.readyState === WebSocket.OPEN) {
                entry.ws.send(
                    JSON.stringify({
                        type: 'match-force-close',
                        matchId,
                        opponentId: uid,
                        reason: reason ?? 'match-ended',
                    })
                );
            }
        }
    });

    if (participants.length > 1) {
        participants.forEach((player) => {
            const opponent = participants.find((target) => target.uid !== player.uid);
            if (opponent) {
                notifyHolePunchKill(player.uid, opponent.uid, matchId);
            }
        });
    }

    broadcastUserList(lobbyId);
    broadcastMatchListSnapshot(wss);
}
