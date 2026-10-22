/**
 * 渲染层唯一能看到的主进程能力。
 *
 * 只暴露具体方法，不暴露 ipcRenderer 本身——否则渲染层可以往任意通道发消息，
 * 这一层就白设了。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { CH, EVENT_CHANNEL, type AssistantAPI, type VoiceEvent } from '@shared/contract'

const api: AssistantAPI = {
  voice: {
    start: () => ipcRenderer.invoke(CH.voiceStart),
    sendAudio: (chunk) => ipcRenderer.invoke(CH.voiceAudio, chunk),
    commit: () => ipcRenderer.invoke(CH.voiceCommit),
    interrupt: () => ipcRenderer.invoke(CH.voiceInterrupt),
    say: (text) => ipcRenderer.invoke(CH.voiceSay, { text }),
    stop: () => ipcRenderer.invoke(CH.voiceStop)
  },
  vidu: {
    start: () => ipcRenderer.invoke(CH.viduStart),
    stop: () => ipcRenderer.invoke(CH.viduStop)
  },
  wake: {
    start: () => ipcRenderer.invoke(CH.wakeStart),
    stop: () => ipcRenderer.invoke(CH.wakeStop),
    sendAudio: (samples) => ipcRenderer.invoke(CH.wakeAudio, samples)
  },
  tasks: {
    list: () => ipcRenderer.invoke(CH.tasksList),
    detail: (taskId) => ipcRenderer.invoke(CH.tasksDetail, { taskId }),
    cancel: (taskId) => ipcRenderer.invoke(CH.tasksCancel, { taskId })
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
    update: (patch) => ipcRenderer.invoke(CH.settingsUpdate, { patch }),
    saveDoubaoKey: (key) => ipcRenderer.invoke(CH.settingsSaveKey, { key }),
    clearDoubaoKey: () => ipcRenderer.invoke(CH.settingsClearKey),
    saveViduKey: (key) => ipcRenderer.invoke(CH.settingsSaveViduKey, { key }),
    clearViduKey: () => ipcRenderer.invoke(CH.settingsClearViduKey),
    saveRtcAppKey: (key) => ipcRenderer.invoke(CH.settingsSaveRtcAppKey, { key }),
    clearRtcAppKey: () => ipcRenderer.invoke(CH.settingsClearRtcAppKey),
    pickWorkspaceRoot: () => ipcRenderer.invoke(CH.settingsPickRoot),
    removeWorkspaceRoot: (id) => ipcRenderer.invoke(CH.settingsRemoveRoot, { id })
  },
  confirmAnswer: (id, approved, remember) => ipcRenderer.invoke(CH.confirmAnswer, { id, approved, remember }),
  openExternal: (url) => ipcRenderer.invoke(CH.openExternal, { url }),
  log: (scope, message, detail) => {
    void ipcRenderer.invoke(CH.appLog, { scope, message, detail: detail === undefined ? null : JSON.stringify(detail) })
  },
  onEvent: (listener) => {
    const wrapped = (_event: unknown, payload: VoiceEvent): void => listener(payload)
    ipcRenderer.on(EVENT_CHANNEL, wrapped)
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, wrapped)
  }
}

contextBridge.exposeInMainWorld('assistant', api)
