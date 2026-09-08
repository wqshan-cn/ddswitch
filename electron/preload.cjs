const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ddswitch', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  doctor: () => ipcRenderer.invoke('doctor'),
  mcpList: (id) => ipcRenderer.invoke('mcp-list', { id }),
  mcpSync: (payload) => ipcRenderer.invoke('mcp-sync', payload),
  mcpRemove: (payload) => ipcRenderer.invoke('mcp-remove', payload),
  skillsList: (id) => ipcRenderer.invoke('skills-list', { id }),
  skillsDeploy: (payload) => ipcRenderer.invoke('skills-deploy', payload),
  openPath: (value) => ipcRenderer.invoke('open-path', { value }),
});
