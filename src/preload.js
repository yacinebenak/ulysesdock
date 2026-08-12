'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workdock', {
  getSnapshot: () => ipcRenderer.invoke('snapshot:get'),
  onSnapshot: (cb) => {
    ipcRenderer.on('snapshot:update', (_e, snap) => cb(snap));
  },
  dismiss: (id) => ipcRenderer.invoke('notif:dismiss', id),
  dismissAll: () => ipcRenderer.invoke('notif:dismissAll'),
  refresh: () => ipcRenderer.invoke('poll:refresh'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  setCollapsed: (v) => ipcRenderer.invoke('window:setCollapsed', !!v),
  quit: () => ipcRenderer.invoke('app:quit'),
  ticketDetail: (key) => ipcRenderer.invoke('ticket:detail', key),
  postComment: (key, text) => ipcRenderer.invoke('ticket:comment', key, text),
  getStandup: () => ipcRenderer.invoke('standup:get'),
  copyText: (text) => ipcRenderer.invoke('clipboard:copy', text),
  setupSave: (payload) => ipcRenderer.invoke('setup:save', payload),
  getBacklog: () => ipcRenderer.invoke('backlog:get'),
  assignToMe: (key) => ipcRenderer.invoke('backlog:assign', key),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),
});
