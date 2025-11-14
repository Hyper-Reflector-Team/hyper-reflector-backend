import { IncomingMessage } from 'http';
import WebSocket, { WebSocketServer } from 'ws';

export interface SocketUser {
    uid: string;
    email?: string;
    displayName?: string;
    userName?: string;
    userProfilePic?: string;
    lobbyId?: string;
    winStreak?: number;
    stability?: boolean;
    mutedUsers?: string[];
    currentMatchId?: string;
    accountElo?: number;
    countryCode?: string;
    userTitle?: unknown;
    [key: string]: unknown;
}

export type SidePreferenceEntry = {
    side: 'player1' | 'player2';
    ownerUid: string;
    opponentUid: string;
    expiresAt: number;
};

export interface ConnectedUser extends SocketUser {
    ws: AugmentedWebSocket;
    joinedAt: number;
    lastHeartbeat: number;
    ip?: string;
    pingLat?: number;
    pingLon?: number;
    countryCode?: string;
    lastKnownPings?: Array<{ id: string; ping: number | string; isUnstable?: boolean }>;
}

export interface LobbyMeta {
    pass?: string;
    isPrivate?: boolean;
    ownerUid?: string;
}

export type UpdateSocketStatePayload = {
    uid: string;
    lobbyId: string;
    stateToUpdate: {
        key: string;
        value: any;
    };
};

export type EstimatePingUsersPayload = {
    userA: { id: string; stability?: boolean };
    userB: { id: string; stability?: boolean };
    __tries?: number;
};

export type SignalMessage =
    | { type: 'join'; user: SocketUser; lobbyId?: string }
    | { type: 'updateSocketState'; data: UpdateSocketStatePayload }
    | { type: 'createLobby'; lobbyId: string; pass?: string; user: SocketUser; isPrivate?: boolean }
    | { type: 'changeLobby'; newLobbyId: string; pass?: string; user: SocketUser }
    | {
          type: 'request-match';
          challengerId: string;
          opponentId: string;
          requestedBy: string;
          lobbyId?: string;
          gameName?: string;
          preferredSlot?: 0 | 1;
      }
    | { type: 'userDisconnect'; userUID?: string }
    | { type: 'sendMessage'; sender: SocketUser; message: string; messageId?: string }
    | { type: 'matchEnd'; userUID: string }
    | { type: 'webrtc-ping-offer'; to: string; from: string; offer: unknown }
    | { type: 'webrtc-ping-answer'; to: string; from: string; answer: unknown }
    | { type: 'webrtc-ping-decline'; to: string; from: string }
    | { type: 'webrtc-ping-candidate'; to: string; from: string; candidate: unknown }
    | { type: 'estimate-ping-users'; data: EstimatePingUsersPayload }
    | {
          type: 'peer-latency-offer';
          to: string;
          from: string;
          measurementId: string;
          offer: unknown;
      }
    | {
          type: 'peer-latency-answer';
          to: string;
          from: string;
          measurementId: string;
          answer: unknown;
      }
    | {
          type: 'peer-latency-candidate';
          to: string;
          from: string;
          measurementId: string;
          candidate: unknown;
      }
    | {
          type: 'peer-latency-decline';
          to: string;
          from: string;
          measurementId: string;
          reason?: string;
      }
    | {
          type: 'mini-game-challenge';
          challengerId: string;
          opponentId: string;
          gameType: 'rps';
          sessionId?: string;
      }
    | {
          type: 'mini-game-choice';
          sessionId: string;
          choice: 'rock' | 'paper' | 'scissors';
          playerId: string;
      }
    | {
          type: 'mini-game-decline';
          sessionId: string;
          playerId: string;
          reason?: string;
      }
    | {
          type: 'mini-game-accept';
          sessionId: string;
          playerId: string;
      }
    | {
          type: 'mini-game-side-lock';
          ownerEntry: SidePreferenceEntry;
          opponentEntry?: SidePreferenceEntry;
      }
    | {
          type: 'match-status';
          status: 'start' | 'end';
          matchId: string;
          opponentId?: string;
          lobbyId?: string;
      };

export type MessageHandler = (ctx: MessageContext, message: SignalMessage) => Promise<void> | void;

export type AugmentedWebSocket = WebSocket & {
    uid?: string;
    isAlive?: boolean;
};

export interface MessageContext {
    ws: AugmentedWebSocket;
    req: IncomingMessage;
    wss: WebSocketServer;
    logger: typeof console;
}
