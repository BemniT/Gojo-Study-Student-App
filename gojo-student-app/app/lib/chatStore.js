// Lightweight in-memory store to pass chat data between screens
// Use setOpenedChat(params) before navigating to /messages and getOpenedChat() in messages.jsx
let _opened = null;

export function setOpenedChat(obj) {
  _opened = obj || null;
}

export function getOpenedChat() {
  return _opened;
}

export function clearOpenedChat() {
  _opened = null;
}