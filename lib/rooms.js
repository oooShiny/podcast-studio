const crypto = require("crypto");
const { resolveRoleFromToken } = require("./auth");

// Note fields broadcast live over WS; everything else is private per-user.
const SHARED_FIELDS = ["n-shared"];

const rooms = new Map();

// Sends msg to every participant in roomId, optionally skipping one id or
// filtering by a predicate — covers every broadcast-style send the original
// WS switch performed by hand.
function broadcast(roomId, msg, { excludeId, filter } = {}) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(msg);
  for (const p of room) {
    if (excludeId && p.id === excludeId) continue;
    if (filter && !filter(p)) continue;
    p.ws.send(data);
  }
}

// ═══════════════════════════════════════════════
//  WEBSOCKET SIGNALING HANDLERS
// ═══════════════════════════════════════════════
function join(ws, msg, state) {
  const { room, username, token } = msg;
  const verifiedRole = resolveRoleFromToken(token) || "guest";
  state.currentRoom = room;
  state.currentUser = { username, ws, id: crypto.randomUUID(), role: verifiedRole };

  if (!rooms.has(room)) rooms.set(room, []);
  const participants = rooms.get(room);

  const existingUsers = participants.map((p) => ({
    id: p.id,
    username: p.username,
    role: p.role,
  }));

  ws.send(JSON.stringify({
    type: "room-info",
    yourId: state.currentUser.id,
    participants: existingUsers,
  }));

  broadcast(room, {
    type: "peer-joined",
    id: state.currentUser.id,
    username: state.currentUser.username,
    role: state.currentUser.role,
  });

  participants.push(state.currentUser);
  console.log(`${username} (${state.currentUser.role}) joined room "${room}" (${participants.length} participants)`);
}

function signal(ws, msg, state) {
  const { targetId, signal: sig } = msg;
  if (!state.currentRoom || !state.currentUser) return;
  const room = rooms.get(state.currentRoom);
  if (!room) return;
  const target = room.find((p) => p.id === targetId);
  if (target) {
    target.ws.send(JSON.stringify({ type: "signal", fromId: state.currentUser.id, signal: sig }));
  }
}

function chat(ws, msg, state) {
  if (!state.currentRoom || !state.currentUser) return;
  if (!rooms.get(state.currentRoom)) return;
  broadcast(state.currentRoom, {
    type: "chat",
    fromId: state.currentUser.id,
    username: state.currentUser.username,
    text: msg.text,
  });
}

function recordingControl(ws, msg, state) {
  if (!state.currentRoom || !state.currentUser) return;
  if (!rooms.get(state.currentRoom)) return;
  broadcast(state.currentRoom, {
    type: "recording-control",
    action: msg.action,
    fromId: state.currentUser.id,
    username: state.currentUser.username,
    sessionId: msg.sessionId,
  });
}

function gameLoad(ws, msg, state) {
  if (!state.currentRoom || !state.currentUser) return;
  if (!rooms.get(state.currentRoom)) return;
  broadcast(state.currentRoom, {
    type: "game-load",
    season: msg.season,
    week: msg.week,
    gameId: msg.gameId,
    username: state.currentUser.username,
  }, { excludeId: state.currentUser.id });
}

function remoteMute(ws, msg, state) {
  // Host can mute/unmute other participants
  if (!state.currentRoom || !state.currentUser) return;
  if (state.currentUser.role !== "host") return; // only host can do this
  const room = rooms.get(state.currentRoom);
  if (!room) return;
  const target = room.find((p) => p.id === msg.targetId);
  if (target) {
    target.ws.send(JSON.stringify({
      type: "remote-mute",
      muted: msg.muted,
      fromUsername: state.currentUser.username,
    }));
  }
}

function removePeer(ws, msg, state) {
  if (!state.currentRoom || !state.currentUser) return;
  if (state.currentUser.role !== "host") return; // only host can do this
  const room = rooms.get(state.currentRoom);
  if (!room) return;
  const targetIdx = room.findIndex((p) => p.id === msg.targetId);
  if (targetIdx === -1) return;
  const target = room[targetIdx];
  room.splice(targetIdx, 1);
  target.ws.send(JSON.stringify({ type: "you-were-removed" }));
  broadcast(state.currentRoom, { type: "peer-left", id: target.id, username: target.username });
  if (room.length === 0) rooms.delete(state.currentRoom);
  target.ws.terminate();
}

function hostLeft(ws, msg, state) {
  if (!state.currentRoom || !state.currentUser) return;
  if (state.currentUser.role !== "host") return;
  if (!rooms.get(state.currentRoom)) return;
  broadcast(state.currentRoom, { type: "session-ended" }, { excludeId: state.currentUser.id });
}

function clipShareRequest(ws, msg, state) {
  if (!state.currentRoom || !state.currentUser) return;
  if (state.currentUser.role === "host") return; // hosts don't share with themselves
  if (!rooms.get(state.currentRoom)) return;
  broadcast(state.currentRoom, {
    type: "clip-share-request",
    clipName: msg.clipName,
    fromUsername: state.currentUser.username,
    fromId: state.currentUser.id,
    audioData: msg.audioData,
    mimeType: msg.mimeType,
  }, { filter: (p) => p.role === "host" });
}

function prepJoin(ws, msg, state) {
  const { room, username } = msg;
  if (!room || !username) return;

  // Leave previous prep room cleanly
  if (state.currentRoom && state.currentUser) {
    const old = rooms.get(state.currentRoom);
    if (old) {
      const i = old.findIndex((p) => p.id === state.currentUser.id);
      if (i !== -1) old.splice(i, 1);
      broadcast(state.currentRoom, { type: "peer-left", id: state.currentUser.id, username: state.currentUser.username });
      if (!old.length) rooms.delete(state.currentRoom);
    }
  }

  state.currentRoom = room;
  if (!state.currentUser) state.currentUser = { id: crypto.randomUUID(), role: "member", ws };
  state.currentUser.username = username;

  if (!rooms.has(room)) rooms.set(room, []);
  const prepParticipants = rooms.get(room);
  prepParticipants.push(state.currentUser);

  ws.send(JSON.stringify({ type: "prep-room-info", yourId: state.currentUser.id, count: prepParticipants.length }));
  broadcast(room, { type: "peer-joined", id: state.currentUser.id, username: state.currentUser.username }, { excludeId: state.currentUser.id });

  console.log(`[prep] ${username} joined "${room}" (${prepParticipants.length} in room)`);
}

function prepNotesUpdate(ws, msg, state) {
  if (!state.currentRoom || !state.currentUser) return;
  if (!rooms.get(state.currentRoom)) return;
  const { field, content } = msg;
  if (!SHARED_FIELDS.includes(field)) return;
  broadcast(state.currentRoom, {
    type: "prep-notes-update",
    fromId: state.currentUser.id,
    username: state.currentUser.username,
    field,
    content,
  }, { filter: (p) => p.ws !== ws });
}

function onClose(ws, state) {
  if (!state.currentRoom || !state.currentUser) return;
  const room = rooms.get(state.currentRoom);
  if (!room) return;

  const idx = room.findIndex((p) => p.id === state.currentUser.id);
  if (idx === -1) return; // Already removed (e.g., by force-remove)
  room.splice(idx, 1);

  broadcast(state.currentRoom, { type: "peer-left", id: state.currentUser.id, username: state.currentUser.username });

  if (room.length === 0) rooms.delete(state.currentRoom);
  console.log(`${state.currentUser.username} left room "${state.currentRoom}"`);
}

module.exports = {
  routes: [],
  wsHandlers: {
    join,
    signal,
    chat,
    "recording-control": recordingControl,
    "game-load": gameLoad,
    "remote-mute": remoteMute,
    "remove-peer": removePeer,
    "host-left": hostLeft,
    "clip-share-request": clipShareRequest,
    "prep-join": prepJoin,
    "prep-notes-update": prepNotesUpdate,
  },
  onClose,
  rooms,
  broadcast,
  init() {},
};
